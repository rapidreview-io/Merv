import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';

import { ApiServer, ToolRegistry } from '@merv/api';
import { createService, type IssuedUserKey, type Project } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { scopeRoutes } from '@merv/scope/api';
import { OAuth } from '@merv/scope/oauth';
import { openState } from './fixtures/state.js';

const DAY = 86400000;

/** An app's OAuth connection over HTTP: Scope's account routes and Merv's OAuth, as served. */
async function fixture(t: TestContext) {
  let now = Date.now();
  const state = await openState();
  const scope = await createService(new ProjectScope(state, () => now));
  const person = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.test',
    subject: 'ada',
    expiresAt: new Date(now + 60 * DAY).toISOString(),
  });
  const stranger = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.test',
    subject: 'grace',
    expiresAt: new Date(now + 60 * DAY).toISOString(),
  });
  const mine = await scope.members.createProject(person, { name: 'Mine', requestId: 'mine' });
  const theirs = await scope.members.createProject(stranger, {
    name: 'Theirs',
    requestId: 'theirs',
  });
  const oauth = new OAuth(state, scope, 'https://merv.example', () => now);
  await oauth.initialize();
  const uninstall = scope.members.installGrants(oauth.grants);
  const tools = new ToolRegistry(scope, scope.toolPolicy);
  tools.register({
    name: 'read',
    description: 'Inspect the bound authority',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: async (caller) => ({ projectId: caller.projectId }),
  });
  const identity = {
    configuration: () => ({ enabled: true }),
    verify: async () => {
      throw new Error('No browser sign-in in this test');
    },
  };
  const api = new ApiServer(scope, tools, {}, identity);
  for (const prefix of ['/account', '/projects'] as const) api.mount(prefix, scopeRoutes(scope));
  api.oauth({
    metadataUrl: `${oauth.origin}/.well-known/oauth-protected-resource/mcp`,
    authenticate: (token) => oauth.authenticate(token),
  });
  const url = await api.start();
  t.after(async () => {
    uninstall();
    await api.stop();
    await tools.close();
    await state.close();
  });
  const client = await oauth.register({
    client_name: 'Merv Research',
    redirect_uris: ['http://127.0.0.1:7777/callback'],
  });
  /** The person's consent and the code's exchange, as the app's browser sign-in ends. */
  async function connect(owner = person) {
    const verifier = randomBytes(32).toString('base64url');
    const id = await oauth.start(
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0]!,
        resource: oauth.resource,
        response_type: 'code',
        state: 's',
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }),
    );
    const code = new URL(await oauth.consent(id, owner, true)).searchParams.get('code')!;
    return await oauth.exchange(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0]!,
        resource: oauth.resource,
      }),
    );
  }
  async function request<T = { error: { code: string; message: string } }>(
    token: string,
    path: string,
    options: { method?: string; body?: unknown; projectId?: string } = {},
  ) {
    const response = await fetch(`${url}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.projectId === undefined ? {} : { 'x-merv-project-id': options.projectId }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  return {
    scope,
    oauth,
    client,
    person,
    stranger,
    mine,
    theirs,
    connect,
    request,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a live grant reads its account and projects, creates a project and mints its key', async (t) => {
  const f = await fixture(t);
  const { access_token: token } = await f.connect();
  const account = await f.request<{ kind: string; projects: Project[] }>(token, '/account');
  assert.equal(account.status, 200);
  assert.equal(account.body.kind, 'key');
  assert.deepEqual(
    account.body.projects.map((p) => p.id),
    [f.mine.id],
  );
  const made = await f.request<{ project: Project }>(token, '/projects', {
    body: { name: 'ml-sweep', requestId: 'folder-1' },
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  // The same request id names the same project: an app's retry creates nothing new.
  const again = await f.request<{ project: Project }>(token, '/projects', {
    body: { name: 'ml-sweep', requestId: 'folder-1' },
  });
  assert.equal(again.body.project.id, made.body.project.id);
  const listed = await f.request<{ projects: (Project & { role: string })[] }>(token, '/projects');
  assert.deepEqual(
    listed.body.projects.map((p) => [p.id, p.role]),
    [
      [f.mine.id, 'operator'],
      [made.body.project.id, 'operator'],
    ],
  );
  // The grant's person is the new project's operator, as if they had made it on the website.
  const members = await f.scope.members.memberships(f.person, made.body.project.id);
  assert.equal(members.admin?.subject, 'ada');
  const key = await f.request<IssuedUserKey>(token, '/account/keys', {
    body: { projectId: made.body.project.id, grantScope: 'project', label: 'Merv Research' },
  });
  assert.equal(key.status, 200, JSON.stringify(key.body));
  assert.match(key.body.token, /^mk_/);
  assert.equal(key.body.key.grantScope, 'project');
  assert.equal(key.body.key.projectId, made.body.project.id);
  // With no expiry asked for, the key ends with the grant, never later.
  const grantEnd = new Date(f.now() + 30 * DAY).toISOString();
  assert.ok(key.body.key.expiresAt && key.body.key.expiresAt <= grantEnd);
  const used = await f.request<{ result: { projectId: string } }>(key.body.token, '/tools/read', {
    body: {},
    projectId: made.body.project.id,
  });
  assert.equal(used.status, 200, JSON.stringify(used.body));
  assert.equal(used.body.result.projectId, made.body.project.id);
});

test('an OAuth access token is still refused on every other route', async (t) => {
  const f = await fixture(t);
  const { access_token: token } = await f.connect();
  const issued = await f.request<IssuedUserKey>(token, '/account/keys', {
    body: { projectId: f.mine.id },
  });
  assert.equal(issued.status, 200);
  for (const [method, path, body] of [
    ['GET', '/account/keys'],
    ['GET', '/account/invitations'],
    ['DELETE', '/account/key'],
    ['DELETE', `/account/keys/${issued.body.key.id}`],
    ['POST', `/account/keys/${issued.body.key.id}/rotate`, {}],
    ['POST', '/account/invitations/x/accept', {}],
    ['GET', `/projects/${f.mine.id}/members`],
    ['POST', `/projects/${f.mine.id}/invitations`, { email: 'a@b.test', role: 'reader' }],
    ['PATCH', `/projects/${f.mine.id}/admin`, { issuer: 'https://identity.test', subject: 'ada' }],
    ['DELETE', '/projects'],
    ['POST', '/account', {}],
    ['POST', '/tools/read', {}],
    ['GET', '/tools'],
  ] as const) {
    const response = await f.request(token, path, {
      method,
      ...(body === undefined ? {} : { body }),
      projectId: f.mine.id,
    });
    assert.equal(response.status, 401, `${method} ${path}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'unauthorized');
  }
});

test('a grant mints project keys only, for its person’s own projects, ending with it', async (t) => {
  const f = await fixture(t);
  const { access_token: token } = await f.connect();
  const account = await f.request(token, '/account/keys', {
    body: { projectId: f.mine.id, grantScope: 'account' },
  });
  assert.equal(account.status, 403);
  assert.equal(account.body.error.code, 'forbidden');
  const foreign = await f.request(token, '/account/keys', { body: { projectId: f.theirs.id } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.code, 'membership_required');
  const late = await f.request(token, '/account/keys', {
    body: { projectId: f.mine.id, expiresAt: new Date(f.now() + 31 * DAY).toISOString() },
  });
  assert.equal(late.status, 400);
  assert.equal(late.body.error.code, 'invalid_expiry');
  const soon = new Date(f.now() + DAY).toISOString();
  const early = await f.request<IssuedUserKey>(token, '/account/keys', {
    body: { projectId: f.mine.id, expiresAt: soon },
  });
  assert.equal(early.status, 200);
  assert.equal(early.body.key.expiresAt, soon);
  // A person still mints keys as before: a project key with no expiry, or an account key.
  const own = await f.scope.userKeys.create(f.person, { projectId: f.mine.id });
  assert.equal(own.key.expiresAt, null);
});

test('an account key, a project key and a person’s other credentials still cannot create projects', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const account = await f.scope.userKeys.create(f.person, {
    projectId: f.mine.id,
    grantScope: 'account',
    label: 'OAuth: Merv Research',
  });
  const project = await f.scope.userKeys.create(f.person, { projectId: f.mine.id });
  for (const issued of [account, project]) {
    const made = await f.request(issued.token, '/projects', {
      body: { name: 'Nope', requestId: 'nope' },
    });
    assert.equal(made.status, 403, JSON.stringify(made.body));
    const key = await f.request(issued.token, '/account/keys', {
      body: { projectId: f.mine.id },
    });
    assert.equal(key.status, 403, JSON.stringify(key.body));
  }
  const principal = { kind: 'key' as const, key: account.key };
  await assert.rejects(
    f.scope.members.createProject(principal, { name: 'Nope', requestId: 'nope' }),
    { status: 403 },
  );
});

test('an expired or revoked grant is refused, also for a principal authenticated before', async (t) => {
  const f = await fixture(t);
  const first = await f.connect();
  const principal = await f.oauth.authenticate(first.access_token);
  await f.oauth.revoke(
    new URLSearchParams({ token: first.refresh_token, client_id: f.client.client_id }),
  );
  const refused = await f.request(first.access_token, '/projects', {
    body: { name: 'Late', requestId: 'late' },
  });
  assert.equal(refused.status, 401);
  await assert.rejects(
    f.scope.members.createProject(principal, { name: 'Late', requestId: 'late' }),
    { status: 403 },
  );
  await assert.rejects(f.scope.userKeys.create(principal, { projectId: f.mine.id }), {
    status: 403,
  });

  const second = await f.connect();
  const live = await f.oauth.authenticate(second.access_token);
  f.advance(3600001);
  assert.equal((await f.request(second.access_token, '/account')).status, 401);
  f.advance(30 * DAY);
  await assert.rejects(f.scope.members.createProject(live, { name: 'Late', requestId: 'late-2' }), {
    status: 403,
  });
  await assert.rejects(f.scope.userKeys.create(live, { projectId: f.mine.id }), {
    status: 403,
  });
});
