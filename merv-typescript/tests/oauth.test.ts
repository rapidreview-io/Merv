import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { OAuth, OAuthError } from '@merv/scope/oauth';
import { oauthRoutes } from '@merv/scope/oauth-api';
import { setupRoutes } from '@merv/scope/setup';
import { ApiServer, ToolRegistry } from '@merv/api';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const state = await openState();
  let now = Date.now();
  const scope = await createService(new ProjectScope(state, () => now));
  const person = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.test',
    subject: 'ada',
    expiresAt: new Date(now + 86400000).toISOString(),
  });
  const project = await scope.members.createProject(person, {
    name: 'No Git required',
    requestId: 'p',
  });
  const other = await scope.members.createProject(person, {
    name: 'Other project',
    requestId: 'q',
  });
  const oauth = new OAuth(state, scope, 'https://merv.example', () => now);
  await oauth.initialize();
  t.after(() => state.close());
  const client = await oauth.register({
    client_name: 'Test client',
    redirect_uris: ['http://127.0.0.1:7777/callback'],
  });
  const verifier = randomBytes(32).toString('base64url');
  const params = () =>
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0]!,
      resource: oauth.resource,
      response_type: 'code',
      state: 'opaque-client-state',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
  async function code() {
    const id = await oauth.start(params());
    const url = new URL(await oauth.consent(id, person, project.id, true));
    assert.equal(url.searchParams.get('state'), 'opaque-client-state');
    assert.equal(url.searchParams.get('iss'), oauth.origin);
    return new URLSearchParams({
      grant_type: 'authorization_code',
      code: url.searchParams.get('code')!,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0]!,
      resource: oauth.resource,
    });
  }
  const grant = async () => oauth.exchange(await code());
  const refresh = (token: string) =>
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: client.client_id,
      resource: oauth.resource,
    });
  return {
    state,
    scope,
    person,
    project,
    other,
    oauth,
    client,
    params,
    code,
    grant,
    refresh,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const refused = (code: string) => (e: unknown) => e instanceof OAuthError && e.error === code;

test('PKCE, exact callback, scope and resource binding; one-use authorization codes', async (t) => {
  const f = await fixture(t);
  for (const [key, value, error] of [
    ['redirect_uri', 'https://attacker.example/callback', 'invalid_request'],
    ['resource', 'https://other/mcp', 'invalid_target'],
    ['code_challenge_method', 'plain', 'invalid_request'],
    ['scope', 'admin', 'invalid_scope'],
  ]) {
    const p = f.params();
    p.set(key!, value!);
    await assert.rejects(f.oauth.start(p), refused(error!));
  }
  await assert.rejects(
    f.oauth.register({ redirect_uris: ['http://attacker.example/callback'] }),
    refused('invalid_redirect_uri'),
  );
  await assert.rejects(
    f.oauth.register({ redirect_uris: ['https://user:pass@example.com/callback'] }),
    refused('invalid_redirect_uri'),
  );
  const p = await f.code();
  const bad = new URLSearchParams(p);
  bad.set('code_verifier', 'z'.repeat(43));
  await assert.rejects(f.oauth.exchange(bad), refused('invalid_grant'));
  const wrong = new URLSearchParams(p);
  wrong.set('resource', 'https://other/mcp');
  await assert.rejects(f.oauth.exchange(wrong), refused('invalid_target'));
  const tokens = await f.oauth.exchange(p);
  assert.equal((await f.oauth.authenticate(tokens.access_token)).kind, 'key');
  await assert.rejects(f.oauth.exchange(p), refused('invalid_grant'));
  const rows = await f.state.read((sql) =>
    sql.all<{ hash: string }>('SELECT hash FROM oauth_tokens'),
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash)));
});

test('expiry, refresh rotation and replay revoke the entire grant; restart keeps state', async (t) => {
  const f = await fixture(t);
  const first = await f.grant();
  f.advance(3600001);
  await assert.rejects(f.oauth.authenticate(first.access_token), { status: 401 });
  const second = await f.oauth.exchange(f.refresh(first.refresh_token));
  const restarted = new OAuth(f.state, f.scope, f.oauth.origin, f.oauth.clock);
  await restarted.initialize();
  await restarted.authenticate(second.access_token);
  await assert.rejects(
    restarted.exchange(f.refresh(first.refresh_token)),
    refused('invalid_grant'),
  );
  await assert.rejects(restarted.authenticate(second.access_token), { status: 401 });
  await assert.rejects(
    restarted.exchange(f.refresh(second.refresh_token)),
    refused('invalid_grant'),
  );
});

test('concurrent code exchanges issue once; concurrent refresh replay fails closed', async (t) => {
  const f = await fixture(t);
  const p = await f.code();
  const results = await Promise.allSettled([f.oauth.exchange(p), f.oauth.exchange(p)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const first = results.find((r) => r.status === 'fulfilled')!;
  if (first.status !== 'fulfilled') return;
  const rs = await Promise.allSettled([
    f.oauth.exchange(f.refresh(first.value.refresh_token)),
    f.oauth.exchange(f.refresh(first.value.refresh_token)),
  ]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of rs)
    if (r.status === 'fulfilled')
      await assert.rejects(f.oauth.authenticate(r.value.access_token), { status: 401 });
});

test('OAuth delegates live memberships and revokes independently from Git/CI keys', async (t) => {
  const f = await fixture(t);
  const machine = await f.scope.userKeys.create(f.person, { projectId: f.project.id, label: 'CI' });
  const tokens = await f.grant();
  const principal = await f.oauth.authenticate(tokens.access_token);
  assert.deepEqual(
    (await f.scope.projects(principal)).map((p) => p.id).sort(),
    [f.project.id, f.other.id].sort(),
  );
  const caller = await f.scope.caller(principal, f.project.id);
  assert.equal(caller.actorId, (await f.scope.caller(f.person, f.project.id)).actorId);
  await f.scope.require(caller, 'write');
  await assert.rejects(f.scope.caller(principal, 'unknown'), { status: 403 });
  const revoke = new URLSearchParams({
    client_id: f.client.client_id,
    token: tokens.refresh_token,
  });
  await f.oauth.revoke(revoke);
  await f.oauth.revoke(revoke);
  await assert.rejects(f.oauth.authenticate(tokens.access_token), { status: 401 });
  await assert.rejects(f.scope.require(caller, 'write'), { status: 403 });
  await f.scope.userKeys.authenticate(machine.token);
});

test('cancel and expiration cannot issue grants; account keys cannot grant OAuth', async (t) => {
  const f = await fixture(t);
  const id = await f.oauth.start(f.params());
  const denied = new URL(await f.oauth.consent(id, f.person, f.project.id, false));
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  await assert.rejects(f.oauth.consent(id, f.person, f.project.id, true), refused('invalid_grant'));
  const key = await f.scope.userKeys.create(f.person, { projectId: f.project.id });
  await assert.rejects(
    f.oauth.consent(
      await f.oauth.start(f.params()),
      { kind: 'key', key: key.key },
      f.project.id,
      true,
    ),
    refused('access_denied'),
  );
  const pending = await f.oauth.start(f.params());
  f.advance(600001);
  await assert.rejects(f.oauth.details(pending), refused('invalid_grant'));
});

test('HTTP discovery/challenge, legacy retirement and real MCP reversible write', async (t) => {
  const f = await fixture(t);
  const tools = new ToolRegistry(f.scope, f.scope.toolPolicy);
  await f.state.migrate('oauth_test', {
    1: 'CREATE TABLE oauth_test_note (id TEXT PRIMARY KEY, body TEXT NOT NULL);',
  });
  tools.register({
    name: 'test.note',
    description: 'Reversible isolated note',
    inputSchema: z.object({ body: z.string() }),
    handler: async (caller, input) =>
      f.state.transaction(async (tx) => {
        await f.scope.require(caller, 'write', tx);
        await tx.run(
          "INSERT INTO oauth_test_note(id,body) VALUES('test',?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
          input.body,
        );
        return { body: input.body };
      }),
  });
  const identity = {
    configuration: () => ({ enabled: true }),
    verify: async () => {
      throw new Error('No mock browser sign-in in HTTP test');
    },
  };
  const server = new ApiServer(f.scope, tools, {}, identity);
  const route = oauthRoutes(f.oauth, identity);
  server.mount('/oauth', route, { public: true });
  server.mount('/.well-known', route, { public: true });
  server.mount('/connect', setupRoutes(f.oauth.origin), { public: true });
  server.oauth({
    metadataUrl: `${f.oauth.origin}/.well-known/oauth-protected-resource/mcp`,
    authenticate: (token) => f.oauth.authenticate(token),
  });
  const url = await server.start();
  t.after(() => server.stop());
  t.after(() => tools.close());
  const challenge = await fetch(`${url}/mcp`, { method: 'POST' });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get('www-authenticate')!, /resource_metadata=/);
  const metadata = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, f.oauth.resource);
  assert.equal((await fetch(`${url}/connect/login`, { method: 'POST' })).status, 410);
  assert.equal((await fetch(`${url}/connect/install.sh`)).status, 410);
  const tokens = await f.grant();
  const call = (body: string) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test.note', arguments: { projectId: f.project.id, body } },
      }),
    });
  for (const body of ['controlled test', '']) {
    const response = await call(body);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse((await response.json()).result.content[0].text).body, body);
    assert.equal(
      (
        await f.state.read((sql) =>
          sql.get<{ body: string }>("SELECT body FROM oauth_test_note WHERE id='test'"),
        )
      )?.body,
      body,
    );
  }
  assert.equal(
    (await fetch(`${url}/account`, { headers: { authorization: `Bearer ${tokens.access_token}` } }))
      .status,
    503,
  ); // not mounted
  f.advance(3600001);
  assert.equal((await call('must not write')).status, 401);
});

test('role changes and membership removal immediately restrict an existing grant', async (t) => {
  const f = await fixture(t);
  const reader = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.test',
    subject: 'reader',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await f.scope.members.addMember(f.person, f.project.id, { subject: 'reader', role: 'reader' });
  const id = await f.oauth.start(f.params());
  const redirect = new URL(await f.oauth.consent(id, reader, f.project.id, true));
  const p = await f.code();
  p.set('code', redirect.searchParams.get('code')!);
  const tokens = await f.oauth.exchange(p);
  const principal = await f.oauth.authenticate(tokens.access_token);
  const caller = await f.scope.caller(principal, f.project.id);
  await f.scope.require(caller, 'read');
  await assert.rejects(f.scope.require(caller, 'write'), { status: 403 });
  await assert.rejects(f.scope.userKeys.create(principal, { projectId: f.project.id }), {
    status: 403,
  });
  await f.scope.members.removeMember(f.person, f.project.id, 'reader');
  await assert.rejects(f.scope.require(caller, 'read'), { status: 403 });
  assert.deepEqual(await f.scope.projects(principal), []);
});

test('HTTP consent requires a human bearer and same-origin POST; token errors are OAuth errors', async (t) => {
  const f = await fixture(t);
  const tools = new ToolRegistry(f.scope, f.scope.toolPolicy);
  const identity = {
    configuration: () => ({ enabled: true }),
    verify: async (token: string) => {
      assert.equal(token, 'synthetic.browser.token');
      return {
        issuer: 'https://identity.test',
        subject: 'ada',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    },
  };
  const api = new ApiServer(f.scope, tools, { allowedOrigins: [f.oauth.origin] }, identity);
  api.mount('/oauth', oauthRoutes(f.oauth, identity), { public: true });
  const base = await api.start();
  t.after(() => api.stop());
  t.after(() => tools.close());
  const id = await f.oauth.start(f.params());
  const consent = (headers: Record<string, string>) =>
    fetch(`${base}/oauth/requests/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ projectId: f.project.id, allow: true }),
    });
  assert.equal((await consent({ authorization: 'Bearer synthetic.browser.token' })).status, 403);
  assert.equal((await consent({ origin: f.oauth.origin })).status, 401);
  const yes = await consent({
    origin: f.oauth.origin,
    authorization: 'Bearer synthetic.browser.token',
  });
  assert.equal(yes.status, 200);
  assert.equal(yes.headers.get('cache-control'), 'no-store');
  assert.ok(new URL((await yes.json()).redirect).searchParams.has('code'));
  const invalid = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'invalid',
      client_id: f.client.client_id,
      resource: f.oauth.resource,
    }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_grant');
});

test('refresh is client-bound and absolute grant expiry requires new consent', async (t) => {
  const f = await fixture(t);
  const tokens = await f.grant();
  const other = await f.oauth.register({ redirect_uris: ['http://localhost:9876/callback'] });
  const wrong = f.refresh(tokens.refresh_token);
  wrong.set('client_id', other.client_id);
  await assert.rejects(f.oauth.exchange(wrong), refused('invalid_grant'));
  await f.oauth.authenticate(tokens.access_token);
  f.advance(31 * 86400000);
  await assert.rejects(f.oauth.exchange(f.refresh(tokens.refresh_token)), refused('invalid_grant'));
  await assert.rejects(f.oauth.authenticate(tokens.access_token), { status: 401 });
});

test('stored grants cannot be used at a different resource sharing the same database', async (t) => {
  const f = await fixture(t);
  const tokens = await f.grant();
  const other = new OAuth(f.state, f.scope, 'https://other.example', f.oauth.clock);
  await assert.rejects(other.authenticate(tokens.access_token), { status: 401 });
  const refresh = f.refresh(tokens.refresh_token);
  refresh.set('resource', other.resource);
  await assert.rejects(other.exchange(refresh), refused('invalid_grant'));
  await f.oauth.authenticate(tokens.access_token);
});
