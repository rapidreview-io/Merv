import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';

import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { OAuth, OAuthError } from '@merv/scope/oauth';
import { oauthRoutes } from '@merv/scope/oauth-api';

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
  async function code(owner = person) {
    const id = await oauth.start(params());
    const url = new URL(await oauth.consent(id, owner, true));
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

test('role changes and membership removal immediately restrict an existing grant', async (t) => {
  const f = await fixture(t);
  const reader = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.test',
    subject: 'reader',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await f.scope.members.addMember(f.person, f.project.id, { subject: 'reader', role: 'reader' });
  const id = await f.oauth.start(f.params());
  const redirect = new URL(await f.oauth.consent(id, reader, true));
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
        subject: 'zero-project-browser',
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
      body: JSON.stringify({ allow: true }),
    });
  assert.equal((await consent({ authorization: 'Bearer synthetic.browser.token' })).status, 403);
  assert.equal((await consent({ origin: f.oauth.origin })).status, 401);
  const yes = await consent({
    origin: f.oauth.origin,
    authorization: 'Bearer synthetic.browser.token',
  });
  assert.equal(yes.status, 200);
  assert.equal(yes.headers.get('cache-control'), 'no-store');
  const code = new URL((await yes.json()).redirect).searchParams.get('code');
  assert.ok(code);
  const params = await f.code();
  params.set('code', code);
  const tokens = await f.oauth.exchange(params);
  assert.deepEqual(await f.scope.projects(await f.oauth.authenticate(tokens.access_token)), []);
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

test('genuine code replay revokes its grant; wrong proof, callback or client cannot revoke it', async (t) => {
  const f = await fixture(t);
  const code = await f.code();
  const issued = await f.oauth.exchange(code);
  const other = await f.oauth.register({ redirect_uris: ['http://localhost:9999/callback'] });
  for (const [field, value] of [
    ['code_verifier', 'z'.repeat(43)],
    ['redirect_uri', 'http://localhost:9999/callback'],
    ['client_id', other.client_id],
  ]) {
    const wrong = new URLSearchParams(code);
    wrong.set(field!, value!);
    await assert.rejects(f.oauth.exchange(wrong), refused('invalid_grant'));
    await f.oauth.authenticate(issued.access_token);
  }
  await assert.rejects(f.oauth.exchange(code), refused('invalid_grant'));
  await assert.rejects(f.oauth.authenticate(issued.access_token), { status: 401 });
  await assert.rejects(f.oauth.exchange(f.refresh(issued.refresh_token)), refused('invalid_grant'));
});
