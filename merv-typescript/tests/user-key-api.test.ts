import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from 'cordis';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ProjectScope } from '@merv/scope';
import { scopeToolsPlugin } from '@merv/scope/tools';
import { SupabaseIdentity } from '@merv/identity';
import { ApiServer, ToolRegistry } from '@merv/api';
import type { Caller, IssuedUserKey, Project, UserKey } from '@merv/contracts';
import { openState } from './fixtures/state.js';

const issuer = 'https://key-api.example/auth/v1';
const secret = 'synthetic-merv-user-key-api-secret-at-least-32-bytes';

async function fixture(t: TestContext) {
  let time = Date.now();
  const env = `MERV_USER_KEY_API_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = secret;
  const identity = new SupabaseIdentity(
    { supabaseUrl: 'https://key-api.example', mode: 'hs256', secretEnv: env },
    { clock: () => time },
  );
  const routing = { jwt: 0, actor: 0 };
  const verify = identity.verify.bind(identity);
  identity.verify = async (token) => {
    routing.jwt++;
    return verify(token);
  };
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state, () => time));
  const authenticate = scope.authenticate.bind(scope);
  scope.authenticate = async (token) => {
    routing.actor++;
    return await authenticate(token);
  };
  const access = scope.toolPolicy;
  const tools = new ToolRegistry(scope, access);
  const ctx = new Context();
  ctx.provide('scope', scope);
  ctx.provide('tools', tools);
  await ctx.plugin(scopeToolsPlugin);
  tools.register({
    name: 'read',
    description: 'Inspect the bound authority',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: async (caller) => ({ caller, actor: await scope.require(caller, 'read') }),
  });
  tools.register({
    name: 'write',
    description: 'Require current project write permission',
    inputSchema: z.object({}).strict(),
    handler: async (caller) => await scope.require(caller, 'write'),
  });
  const server = new ApiServer(scope, tools, {}, identity);
  const url = await server.start();
  t.after(async () => {
    await server.stop();
    await ctx.fiber.dispose();
    await tools.close();
    await state.close();
    delete process.env[env];
  });
  const bearer = (subject: string) =>
    new SignJWT({ role: 'authenticated', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setExpirationTime(Math.floor(time / 1000) + 3600)
      .sign(new TextEncoder().encode(secret));
  const alice = await bearer('alice');
  const bob = await bearer('bob');
  const owner = await scope.acceptVerifiedIdentity(await verify(alice));
  const other = await scope.acceptVerifiedIdentity(await verify(bob));
  const project = await scope.createProject(owner, { name: 'Issuance', requestId: 'issuance' });
  async function request<T = { error: { code: string; message: string } }>(
    path: string,
    options: {
      token?: string;
      method?: string;
      body?: unknown;
      projectId?: string;
    } = {},
  ) {
    const response = await fetch(`${url}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${options.token ?? alice}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.projectId === undefined ? {} : { 'x-merv-project-id': options.projectId }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  async function issue(input: Record<string, unknown> = {}, token = alice) {
    const result = await request<IssuedUserKey>('/account/keys', {
      token,
      body: { projectId: project.id, ...input },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.match(result.body.token, /^mk_/);
    return result.body;
  }
  return {
    scope,
    state,
    tools,
    access,
    server,
    identity,
    ctx,
    url,
    request,
    issue,
    owner,
    other,
    alice,
    bob,
    project,
    routing,
    time: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('only the verified owner manages key metadata, rotation lineage and strict issuance inputs', async (t) => {
  const f = await fixture(t);
  await f.scope.addMember(f.owner, f.project.id, { subject: 'bob', role: 'operator' });
  const issued = await f.issue({
    label: 'CLI',
    expiresAt: new Date(f.time() + 60_000).toISOString(),
  });
  const otherKey = await f.issue({ label: 'Bob key' }, f.bob);
  assert.deepEqual(issued.key.owner, { issuer, subject: 'alice' });
  assert.equal(issued.key.grantScope, 'project');
  const listed = await f.request<{ keys: UserKey[] }>('/account/keys');
  assert.deepEqual(
    listed.body.keys.map((key) => key.id),
    [issued.key.id],
  );
  assert.equal(JSON.stringify(listed.body).includes(issued.token), false);
  assert.equal(JSON.stringify(listed.body).includes('token_hash'), false);
  const filtered = await f.request<{ keys: UserKey[] }>(`/account/keys?projectId=${f.project.id}`);
  assert.deepEqual(filtered.body.keys, listed.body.keys);
  assert.deepEqual(
    (await f.request<{ keys: UserKey[] }>('/account/keys?projectId=absent')).body.keys,
    [],
  );
  assert.deepEqual(
    (await f.request<{ keys: UserKey[] }>('/account/keys', { token: f.bob })).body.keys.map(
      (key) => key.id,
    ),
    [otherKey.key.id],
  );
  for (const query of [
    '?owner=alice',
    '?projectId=',
    '?projectId=a&projectId=b',
    '?projectId=a&unexpected=1',
  ])
    assert.equal((await f.request(`/account/keys${query}`)).status, 400);
  for (const extra of [
    { owner: { issuer, subject: 'bob' } },
    { role: 'operator' },
    { grantScope: 'global' },
    { expiresAt: 123 },
    { issuer },
  ])
    assert.equal(
      (await f.request('/account/keys', { body: { projectId: f.project.id, ...extra } })).status,
      400,
    );
  assert.equal(
    (await f.request('/account/keys?projectId=x', { body: { projectId: f.project.id } })).status,
    400,
  );
  for (const [path, method, body] of [
    [`/account/keys/${issued.key.id}/rotate`, 'POST', {}],
    [`/account/keys/${issued.key.id}`, 'DELETE', undefined],
  ] as const)
    assert.ok([403, 404].includes((await f.request(path, { token: f.bob, method, body })).status));
  const widened = await f.request<{ error: { details: unknown } }>(
    `/account/keys/${issued.key.id}/rotate`,
    { body: { grantScope: 'account' } },
  );
  assert.equal(widened.status, 400);
  assert.deepEqual(widened.body.error.details, [
    { path: [], message: "Unrecognized key(s) in object: 'grantScope'", code: 'unrecognized_keys' },
  ]);
  const rotated = await f.request<IssuedUserKey>(`/account/keys/${issued.key.id}/rotate`, {
    body: {},
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.key.previousId, issued.key.id);
  assert.equal(rotated.body.key.projectId, issued.key.projectId);
  assert.deepEqual(rotated.body.key.owner, issued.key.owner);
  assert.equal(rotated.body.key.expiresAt, issued.key.expiresAt);
  assert.equal((await f.request('/account', { token: issued.token })).status, 401);
  const grandchild = await f.request<IssuedUserKey>(`/account/keys/${rotated.body.key.id}/rotate`, {
    body: {},
  });
  assert.equal(grandchild.status, 200);
  assert.equal(
    (await f.request(`/account/keys/${issued.key.id}`, { method: 'DELETE' })).status,
    200,
  );
  assert.equal(
    (await f.request('/account', { token: grandchild.body.token })).status,
    401,
    'ancestor revocation reaches later rotations',
  );
  assert.equal(
    (await f.request('/account', { token: otherKey.token })).status,
    200,
    'another owner is unaffected',
  );
});

test('project and account keys resolve current owner roles while account keys require explicit project selection', async (t) => {
  const f = await fixture(t);
  const projectKey = await f.issue();
  const accountKey = await f.issue({ grantScope: 'account' });
  const unselected = await f.request('/tools', { token: accountKey.token });
  assert.equal(unselected.status, 400);
  assert.equal(
    unselected.body.error.code,
    'project_required',
    'one membership does not imply an account-key selection',
  );
  const otherProject = await f.scope.createProject(f.other, {
    name: 'Other project',
    requestId: 'other',
  });
  await f.scope.addMember(f.other, otherProject.id, { subject: 'alice', role: 'reader' });
  const account = await f.request<{
    kind: string;
    key: UserKey;
    user?: unknown;
    actor?: unknown;
    projects: Project[];
  }>('/account', { token: accountKey.token });
  assert.equal(account.body.kind, 'key');
  assert.equal(account.body.key.id, accountKey.key.id);
  assert.equal(account.body.user, undefined);
  assert.equal(account.body.actor, undefined);
  assert.deepEqual(
    account.body.projects.map((project) => project.id).sort(),
    [f.project.id, otherProject.id].sort(),
  );
  const projectAccount = await f.request<{ projects: Project[] }>('/account', {
    token: projectKey.token,
  });
  assert.deepEqual(projectAccount.body.projects, [f.project]);
  const bound = await f.request<{ result: { caller: Caller } }>('/tools/read', {
    token: projectKey.token,
    body: {},
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.result.caller.projectId, f.project.id);
  assert.equal(bound.body.result.caller.key?.id, projectKey.key.id);
  assert.equal(bound.body.result.caller.human, undefined);
  assert.equal(bound.body.result.caller.credentialId, undefined);
  assert.equal(
    (
      await f.request('/tools/read', {
        token: projectKey.token,
        projectId: otherProject.id,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request('/tools/read', {
        token: accountKey.token,
        body: { projectId: otherProject.id },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request('/tools/read', {
        token: accountKey.token,
        projectId: f.project.id,
        body: { projectId: otherProject.id },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/tools/write', {
        token: accountKey.token,
        projectId: otherProject.id,
        body: {},
      })
    ).status,
    403,
  );
  await f.scope.changeMemberRole(f.other, otherProject.id, { subject: 'alice', role: 'producer' });
  assert.equal(
    (
      await f.request('/tools/write', {
        token: accountKey.token,
        projectId: otherProject.id,
        body: {},
      })
    ).status,
    200,
  );
  const captured = await f.scope.caller(
    { kind: 'key', key: await f.scope.authenticateKey(accountKey.token) },
    otherProject.id,
  );
  await f.scope.removeMember(f.other, otherProject.id, 'alice');
  assert.equal(
    (
      await f.request('/tools/read', {
        token: accountKey.token,
        projectId: otherProject.id,
        body: {},
      })
    ).status,
    403,
  );
  await f.scope.addMember(f.other, otherProject.id, { subject: 'alice', role: 'reviewer' });
  assert.equal(
    (
      await f.request('/tools/read', {
        token: accountKey.token,
        projectId: otherProject.id,
        body: {},
      })
    ).status,
    200,
  );
  await assert.rejects(async () => await f.scope.require(captured, 'read'), {
    code: 'membership_required',
  });
  const issuanceFilter = await f.request<{ keys: UserKey[] }>(
    `/account/keys?projectId=${otherProject.id}`,
  );
  assert.deepEqual(
    issuanceFilter.body.keys,
    [],
    'filter uses issuance project, not account-key reach',
  );
});

test('HTTP and MCP key catalogs use selected authority and preserve remote project arguments', async (t) => {
  const f = await fixture(t);
  const key = await f.issue({ grantScope: 'account' });
  const elsewhere = await f.scope.createProject(f.owner, {
    name: 'Elsewhere',
    requestId: 'elsewhere',
  });
  const ownerActor = await f.scope.caller(f.owner, f.project.id);
  f.access.replace([
    { actorId: ownerActor.actorId, projectId: f.project.id, mountId: 'nisa', tools: ['search'] },
  ]);
  f.tools.createCatalog('nisa').replace([
    {
      kind: 'mcp',
      name: 'search',
      description: 'Read a remote project',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      handler: async (_caller, input) => ({
        content: [{ type: 'text', text: JSON.stringify(input) }],
      }),
    },
  ]);
  const catalog = await f.request<{ tools: { name: string }[] }>('/tools', {
    token: key.token,
    projectId: f.project.id,
  });
  assert.ok(catalog.body.tools.some((tool) => tool.name === '_nisa.search'));
  const hidden = await f.request<{ tools: { name: string }[] }>('/tools', {
    token: key.token,
    projectId: elsewhere.id,
  });
  assert.ok(!hidden.body.tools.some((tool) => tool.name === '_nisa.search'));
  const remote = await f.request<{ result: { content: { text: string }[] } }>(
    '/tools/_nisa.search',
    { token: key.token, projectId: f.project.id, body: { projectId: 'upstream-id' } },
  );
  assert.deepEqual(JSON.parse(remote.body.result.content[0]!.text), { projectId: 'upstream-id' });
  assert.equal(
    (
      await f.request('/tools/read', {
        token: key.token,
        projectId: f.project.id,
        body: { human: { issuer, subject: 'bob' }, key: { id: 'spoof' } },
      })
    ).status,
    400,
  );
  const client = new Client({ name: 'user-key-mcp-test', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key.token}` } },
    }),
  );
  await assert.rejects(client.listTools(), /explicit project selection/);
  assert.ok(
    (await client.listTools({ _meta: { 'merv/projectId': f.project.id } })).tools.some(
      (tool) => tool.name === '_nisa.search',
    ),
  );
  assert.ok(
    !(await client.listTools({ _meta: { 'merv/projectId': elsewhere.id } })).tools.some(
      (tool) => tool.name === '_nisa.search',
    ),
  );
  const called = await client.callTool({
    name: '_nisa.search',
    arguments: { projectId: 'upstream-id' },
    _meta: { 'merv/projectId': f.project.id },
  });
  assert.equal(called.isError, undefined);
  const headerClient = new Client({ name: 'user-key-header-test', version: '1' });
  t.after(() => headerClient.close());
  await headerClient.connect(
    new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${key.token}`, 'x-merv-project-id': f.project.id },
      },
    }),
  );
  await assert.rejects(
    headerClient.listTools({ _meta: { 'merv/projectId': elsewhere.id } }),
    /Conflicting Merv project selections/,
  );
  assert.equal(
    (
      await headerClient.callTool({
        name: 'read',
        arguments: {},
        _meta: { 'merv/projectId': elsewhere.id },
      })
    ).isError,
    true,
  );
  const fixed = await f.issue();
  const projectClient = new Client({ name: 'project-key-mcp-test', version: '1' });
  t.after(() => projectClient.close());
  await projectClient.connect(
    new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${fixed.token}` } },
    }),
  );
  assert.ok((await projectClient.listTools()).tools.some((tool) => tool.name === '_nisa.search'));
  assert.equal(
    (await projectClient.callTool({ name: 'actor.whoami', arguments: {} })).isError,
    undefined,
  );
  assert.equal(
    (
      await projectClient.callTool({
        name: 'read',
        arguments: {},
        _meta: { 'merv/projectId': elsewhere.id },
      })
    ).isError,
    true,
  );
});

test('keys cannot administer accounts, keys, memberships or independent actor credentials', async (t) => {
  const f = await fixture(t);
  const key = await f.issue({ grantScope: 'account' });
  const operator = await f.scope.caller(f.owner, f.project.id);
  const machine = await f.scope.issueActor(operator, {
    name: 'Independent agent',
    role: 'operator',
  });
  for (const bearer of [key.token, machine.token]) {
    for (const [path, method, body] of [
      ['/account/keys', 'GET', undefined],
      ['/account/keys', 'POST', { projectId: f.project.id }],
      [`/account/keys/${key.key.id}/rotate`, 'POST', {}],
      [`/account/keys/${key.key.id}`, 'DELETE', undefined],
      ['/projects', 'POST', { name: 'Escaped', requestId: 'escape' }],
      [`/projects/${f.project.id}/members`, 'GET', undefined],
      [`/projects/${f.project.id}/members`, 'POST', { subject: 'escape', role: 'operator' }],
    ] as const)
      assert.equal((await f.request(path, { token: bearer, method, body })).status, 403, path);
  }
  for (const [name, body] of [
    ['actor.create', { name: 'Escaped', role: 'operator' }],
    ['actor.issue_token', { actorId: machine.actor.id }],
    ['actor.rotate_token', { credentialId: machine.credential.id }],
    ['actor.revoke_token', { credentialId: machine.credential.id }],
    ['actor.revoke', { actorId: machine.actor.id }],
  ] as const)
    assert.equal(
      (await f.request(`/tools/${name}`, { token: key.token, projectId: f.project.id, body }))
        .status,
      403,
      name,
    );
  assert.equal((await f.scope.authenticate(machine.token)).id, machine.actor.id);
});

test('owners retain metadata and recursive revocation after losing all project memberships', async (t) => {
  const f = await fixture(t);
  const key = await f.issue({ grantScope: 'account' });
  const fixed = await f.issue();
  const elsewhere = await f.scope.createProject(f.other, {
    name: 'Remaining membership',
    requestId: 'remaining',
  });
  await f.scope.addMember(f.other, elsewhere.id, { subject: 'alice', role: 'reader' });
  await f.scope.addMember(f.owner, f.project.id, { subject: 'bob', role: 'operator' });
  await f.scope.removeMember(f.other, f.project.id, 'alice');
  assert.equal(
    (await f.request(`/account/keys/${fixed.key.id}/rotate`, { body: {} })).status,
    403,
    'project rotation still requires issuance membership',
  );
  const rotated = await f.request<IssuedUserKey>(`/account/keys/${key.key.id}/rotate`, {
    body: {},
  });
  assert.equal(rotated.status, 200, 'account key rotation works with another current membership');
  assert.equal(
    rotated.body.key.projectId,
    f.project.id,
    'rotation preserves the original issuance project',
  );
  assert.equal(rotated.body.key.grantScope, 'account');
  assert.equal(
    (
      await f.request('/tools/read', {
        token: rotated.body.token,
        projectId: elsewhere.id,
        body: {},
      })
    ).status,
    200,
  );
  await f.scope.removeMember(f.other, elsewhere.id, 'alice');
  const account = await f.request<{ projects: Project[] }>('/account', {
    token: rotated.body.token,
  });
  assert.equal(account.status, 200);
  assert.deepEqual(account.body.projects, []);
  const human = await f.request<{ projects: Project[] }>('/account');
  assert.deepEqual(human.body.projects, []);
  assert.equal(
    (await f.request('/tools', { token: rotated.body.token, projectId: f.project.id })).status,
    403,
  );
  const list = await f.request<{ keys: UserKey[] }>('/account/keys');
  assert.deepEqual(
    list.body.keys.map((key) => key.id).sort(),
    [key.key.id, fixed.key.id, rotated.body.key.id].sort(),
  );
  assert.equal(
    (await f.request(`/account/keys/${rotated.body.key.id}/rotate`, { body: {} })).status,
    403,
  );
  assert.equal(
    (await f.request('/account/keys', { body: { projectId: f.project.id } })).status,
    403,
  );
  assert.equal((await f.request(`/account/keys/${key.key.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await f.request('/account', { token: rotated.body.token })).status, 401);
});

test('revocation and expiry between admission and dispatch fence key calls, with no authentication fallback', async (t) => {
  const f = await fixture(t);
  for (const mode of ['revoke', 'expire'] as const) {
    const key = await f.issue({ expiresAt: new Date(f.time() + 1000).toISOString() });
    let invoked = false;
    f.tools.register({
      name: `queued_${mode}`,
      description: 'Exercise the queued dispatch boundary',
      inputSchema: z
        .object({})
        .strict()
        .transform(async (value) => {
          if (mode === 'revoke') await f.scope.revokeKey(f.owner, key.key.id);
          else f.advance(2000);
          return value;
        }),
      handler: () => {
        invoked = true;
        return {};
      },
    });
    const result = await f.request(`/tools/queued_${mode}`, { token: key.token, body: {} });
    assert.ok([401, 403].includes(result.status));
    assert.equal(invoked, false);
    f.routing.actor = 0;
    f.routing.jwt = 0;
    assert.equal((await f.request('/account', { token: key.token })).status, 401);
    assert.deepEqual(f.routing, { actor: 0, jwt: 0 });
  }
  assert.equal((await f.request('/account', { token: 'mk_unknown.with.dots' })).status, 401);
  assert.deepEqual(f.routing, { actor: 0, jwt: 0 });
});

test('existing opaque actor tokens can begin with mk_ without becoming user keys', async (t) => {
  const f = await fixture(t);
  const caller = await f.scope.caller(f.owner, f.project.id);
  const legacy = await f.scope.issueActor(caller, { name: 'Legacy actor', role: 'reader' });
  // Legacy tokens are 43 random base64url characters. Their random prefix is not reserved.
  const token = `mk_${'A'.repeat(40)}`;
  const id = `credential_${randomUUID()}`;
  await f.state.transaction(
    async (tx) =>
      await tx.run(
        'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at) VALUES(?,?,?,?,?,?)',
        id,
        legacy.actor.id,
        f.project.id,
        'actor',
        createHash('sha256').update(token).digest('hex'),
        new Date(f.time()).toISOString(),
      ),
  );
  assert.equal((await f.scope.authenticate(token)).id, legacy.actor.id);
  f.routing.actor = 0;
  const account = await f.request<{ kind: string; actor: { id: string } }>('/account', { token });
  assert.equal(account.status, 200);
  assert.equal(account.body.kind, 'actor');
  assert.equal(account.body.actor.id, legacy.actor.id);
  assert.deepEqual(f.routing, { actor: 1, jwt: 0 });
  await f.scope.revokeCredential(caller, id);
  assert.equal((await f.request('/account', { token })).status, 401);
  assert.equal(f.routing.jwt, 0);
});
