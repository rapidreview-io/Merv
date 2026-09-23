import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ProjectScope } from '@merv/scope';
import { SupabaseIdentity } from '@merv/identity';
import { ApiServer, ToolRegistry } from '@merv/api';
import type { Caller, Project, ProjectMembership } from '@merv/contracts';
import { openState } from './fixtures/state.js';

const authUrl = 'https://shared-auth.example';
const issuer = `${authUrl}/auth/v1`;
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const secret = new TextEncoder().encode(
  'synthetic-shared-identity-api-test-secret-at-least-32-bytes',
);

async function token(subject: string, overrides: Record<string, unknown> = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: 'authenticated',
    sub: subject,
    exp: seconds + 3600,
    iat: seconds,
    role: 'authenticated',
    is_anonymous: false,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secret);
}

async function fixture(t: TestContext, database = ':memory:') {
  const env = `MERV_IDENTITY_API_TEST_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = new TextDecoder().decode(secret);
  const identity = new SupabaseIdentity({ supabaseUrl: authUrl, mode: 'hs256', secretEnv: env });
  const state = await openState(database);
  const scope = await createService(new ProjectScope(state));
  const access = scope.toolPolicy;
  const tools = new ToolRegistry(scope, access);
  tools.register({
    name: 'read',
    description: 'Return the server-derived project authority',
    inputSchema: z.object({}).strict(),
    readOnly: true,
    handler: async (caller) => ({ caller, actor: await scope.require(caller, 'read') }),
  });
  tools.register({
    name: 'write',
    description: 'Require project write authority',
    inputSchema: z.object({}).strict(),
    handler: async (caller) => await scope.require(caller, 'write'),
  });
  const server = new ApiServer(scope, tools, {}, identity);
  const url = await server.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.stop();
    await tools.close();
    await state.close();
    delete process.env[env];
  };
  t.after(close);
  const aliceToken = await token(alice);
  const bobToken = await token(bob);
  async function request<T = Record<string, unknown>>(
    path: string,
    options: { token?: string; method?: string; body?: unknown; projectId?: string } = {},
  ) {
    const response = await fetch(`${url}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${options.token ?? aliceToken}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.projectId === undefined ? {} : { 'x-merv-project-id': options.projectId }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = (await response.json()) as T;
    return { status: response.status, body };
  }
  async function create(name: string, bearer = aliceToken) {
    const response = await request<{ project: Project }>('/projects', {
      token: bearer,
      body: { name, requestId: `create-${name}` },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.project;
  }
  return {
    scope,
    state,
    access,
    tools,
    server,
    identity,
    url,
    request,
    create,
    close,
    aliceToken,
    bobToken,
  };
}

test('verified users discover two projects, administer memberships, and retain project identity across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-shared-identity-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = directory;
  const f = await fixture(t, database);
  const account = await f.request<{
    kind: string;
    user: { issuer: string; subject: string };
    projects: Project[];
  }>('/account');
  assert.equal(account.body.kind, 'user');
  assert.deepEqual(
    { issuer: account.body.user.issuer, subject: account.body.user.subject },
    { issuer, subject: alice },
  );
  assert.deepEqual(account.body.projects, []);
  const a = await f.create('Research A');
  const b = await f.create('Research B');
  assert.deepEqual(await f.create('Research A'), a, 'project creation is replayable');
  const conflict = await f.request('/projects', {
    body: { name: 'Changed', requestId: 'create-Research A' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    (
      await f.request('/projects', {
        body: { name: 'Spoofed', requestId: 'spoof', issuer: 'evil', subject: bob },
      })
    ).status,
    400,
  );
  assert.equal((await f.request('/account', { token: f.bobToken })).status, 200);
  const add = await f.request<{ membership: ProjectMembership }>(`/projects/${a.id}/members`, {
    body: { subject: bob, role: 'reader' },
  });
  assert.equal(add.status, 200);
  assert.equal(add.body.membership.issuer, issuer);
  assert.equal((await f.request(`/projects/${b.id}/members`, { token: f.bobToken })).status, 403);
  assert.equal(
    (
      await f.request(`/projects/${a.id}/members`, {
        token: f.bobToken,
        body: { subject: alice, role: 'operator' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request('/tools/write', { token: f.bobToken, projectId: a.id, body: {} })).status,
    403,
  );
  const changed = await f.request<{ membership: ProjectMembership }>(
    `/projects/${a.id}/members/${bob}`,
    {
      method: 'PATCH',
      body: { role: 'producer' },
    },
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.body.membership.actorId, add.body.membership.actorId);
  assert.notEqual(
    changed.body.membership.id,
    add.body.membership.id,
    'role changes replace the authority epoch',
  );
  assert.equal(
    (await f.request('/tools/write', { token: f.bobToken, projectId: a.id, body: {} })).status,
    200,
  );
  assert.equal(
    (await f.request(`/projects/${a.id}/members/${alice}`, { method: 'DELETE' })).status,
    409,
    'last operator stays protected',
  );
  const before = await f.request<{ result: { caller: Caller } }>('/tools/read', {
    projectId: b.id,
    body: {},
  });
  await f.close();
  const restarted = await fixture(t, database);
  const projects = await restarted.request<{ projects: Project[] }>('/projects');
  assert.deepEqual(projects.body.projects.map((project) => project.id).sort(), [a.id, b.id].sort());
  const after = await restarted.request<{ result: { caller: Caller } }>('/tools/read', {
    projectId: b.id,
    body: {},
  });
  assert.equal(after.body.result.caller.actorId, before.body.result.caller.actorId);
  assert.equal(
    (
      await restarted.request('/tools/write', {
        token: restarted.bobToken,
        projectId: a.id,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await restarted.request(`/projects/${a.id}/members/${bob}`, { method: 'DELETE' })).status,
    200,
  );
  assert.equal(
    (
      await restarted.request('/tools/read', {
        token: restarted.bobToken,
        projectId: a.id,
        body: {},
      })
    ).status,
    403,
  );
});

test('HTTP and MCP select membership for both catalogs and calls without rewriting remote arguments', async (t) => {
  const f = await fixture(t);
  const a = await f.create('Catalog A');
  const b = await f.create('Catalog B');
  const principal = await f.scope.acceptVerifiedIdentity(await f.identity.verify(f.aliceToken));
  const callerA = await f.scope.caller(principal, a.id);
  f.access.replace([
    { projectId: a.id, actorId: callerA.actorId, mountId: 'nisa', tools: ['search'] },
  ]);
  f.tools.createCatalog('nisa').replace([
    {
      kind: 'mcp',
      name: 'search',
      description: 'Echo upstream arguments',
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
  for (const path of ['/tools', '/tools/read']) {
    const missing = await f.request<{ error: { code: string } }>(
      path,
      path === '/tools' ? {} : { body: {} },
    );
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'project_required');
  }
  const catalogA = await f.request<{ tools: { name: string }[] }>('/tools', { projectId: a.id });
  const catalogB = await f.request<{ tools: { name: string }[] }>('/tools', { projectId: b.id });
  assert.ok(catalogA.body.tools.some((tool) => tool.name === '_nisa.search'));
  assert.ok(!catalogB.body.tools.some((tool) => tool.name === '_nisa.search'));
  assert.equal(
    (await f.request('/tools/read', { projectId: a.id, body: { projectId: b.id } })).status,
    400,
  );
  assert.equal((await f.request('/tools/read', { body: { projectId: b.id } })).status, 200);
  assert.equal(
    (await f.request('/tools/read', { projectId: a.id, body: { human: { issuer, subject: bob } } }))
      .status,
    400,
  );
  const remote = await f.request<{ result: { content: { text: string }[] } }>(
    '/tools/_nisa.search',
    { projectId: a.id, body: { projectId: 'upstream-project' } },
  );
  assert.deepEqual(JSON.parse(remote.body.result.content[0]!.text), {
    projectId: 'upstream-project',
  });
  assert.equal(
    (
      await f.request('/tools/_nisa.search', {
        projectId: b.id,
        body: { projectId: 'upstream-project' },
      })
    ).status,
    403,
  );
  const client = new Client({ name: 'human-identity-test', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${f.aliceToken}` } },
    }),
  );
  await assert.rejects(client.listTools(), /Select a project/);
  assert.ok(
    (await client.listTools({ _meta: { 'merv/projectId': a.id } })).tools.some(
      (tool) => tool.name === '_nisa.search',
    ),
  );
  assert.ok(
    !(await client.listTools({ _meta: { 'merv/projectId': b.id } })).tools.some(
      (tool) => tool.name === '_nisa.search',
    ),
  );
  assert.equal(
    (await client.callTool({ name: 'read', arguments: {}, _meta: { 'merv/projectId': b.id } }))
      .isError,
    undefined,
  );
  const headerClient = new Client({ name: 'human-header-identity-test', version: '1' });
  t.after(() => headerClient.close());
  await headerClient.connect(
    new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${f.aliceToken}`, 'x-merv-project-id': a.id },
      },
    }),
  );
  assert.ok((await headerClient.listTools()).tools.some((tool) => tool.name === '_nisa.search'));
  await assert.rejects(
    headerClient.listTools({ _meta: { 'merv/projectId': b.id } }),
    /Conflicting Merv project selections/,
  );
  assert.equal(
    (
      await headerClient.callTool({
        name: 'read',
        arguments: {},
        _meta: { 'merv/projectId': b.id },
      })
    ).isError,
    true,
  );
  assert.equal(
    (await headerClient.callTool({ name: 'read', arguments: { projectId: b.id } })).isError,
    true,
  );
});

test('actor credentials keep one project and cannot manage human membership or fall back to JWT verification', async (t) => {
  const f = await fixture(t);
  const humanProject = await f.create('Human project');
  const machine = await f.scope.bootstrap({
    projectName: 'Machine project',
    actorName: 'Operator',
  });
  const account = await f.request<{ kind: string; projects: Project[] }>('/account', {
    token: machine.token,
  });
  assert.equal(account.body.kind, 'actor');
  assert.deepEqual(account.body.projects, [machine.project]);
  assert.equal((await f.request('/tools/read', { token: machine.token, body: {} })).status, 200);
  assert.equal(
    (await f.request('/tools/read', { token: machine.token, projectId: humanProject.id, body: {} }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.request('/projects', {
        token: machine.token,
        body: { name: 'Forbidden', requestId: 'machine' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request(`/projects/${machine.project.id}/members`, { token: machine.token })).status,
    403,
  );
  assert.equal(
    (
      await f.request(`/projects/${machine.project.id}/members`, {
        token: machine.token,
        body: { subject: alice, role: 'operator' },
      })
    ).status,
    403,
  );
  let externalVerifications = 0;
  const actorOnlyServer = new ApiServer(
    f.scope,
    f.tools,
    {},
    {
      configuration: () => ({ enabled: true }),
      verify: async () => {
        externalVerifications++;
        throw new Error('Opaque credentials must never reach the verifier');
      },
    },
  );
  const actorUrl = await actorOnlyServer.start();
  t.after(() => actorOnlyServer.stop());
  const operator = await f.scope.caller({
    kind: 'actor',
    actor: await f.scope.authenticate(machine.token),
  });
  const replacement = await f.scope.issueActorCredential(operator, { actorId: machine.actor.id });
  const newOperator = await f.scope.caller({
    kind: 'actor',
    actor: await f.scope.authenticate(replacement.token),
  });
  await f.scope.revokeCredential(newOperator, machine.credential.id);
  const revoked = await fetch(`${actorUrl}/account`, {
    headers: { authorization: `Bearer ${machine.token}` },
  });
  assert.equal(revoked.status, 401);
  assert.equal(externalVerifications, 0);
});

test('JWT validation rejects untrusted claims and public configuration cannot be shadowed by mounts', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(`${f.url}/auth/config`)).json(), { enabled: true });
  for (const prefix of ['/auth', '/account', '/projects'])
    assert.throws(() => f.server.mount(prefix, async () => {}), { code: 'invalid_mount' });
  for (const overrides of [
    { iss: 'https://other.example/auth/v1' },
    { aud: 'other' },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { role: 'service_role' },
    { is_anonymous: true },
  ])
    assert.equal(
      (await f.request('/account', { token: await token(alice, overrides) })).status,
      401,
    );
  const forged = await new SignJWT({
    iss: issuer,
    sub: alice,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    role: 'authenticated',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode('a-different-untrusted-signing-secret-at-least-32-bytes'));
  assert.equal((await f.request('/account', { token: forged })).status, 401);
  assert.equal((await f.request('/account', { token: 'malformed.jwt.token' })).status, 401);
  const project = await f.create('Strict routes');
  assert.equal(
    (
      await f.request(`/projects/${project.id}/members`, {
        body: { subject: bob, role: 'reader', issuer: 'https://evil' },
      })
    ).status,
    400,
  );
  assert.equal((await f.request(`/projects/${project.id}/adopt`, { body: {} })).status, 404);
});

test('membership removal after admission blocks queued dispatch and expires captured authority', async (t) => {
  const f = await fixture(t);
  const project = await f.create('Queued work');
  await f.request(`/projects/${project.id}/members`, { body: { subject: bob, role: 'producer' } });
  const owner = await f.scope.acceptVerifiedIdentity(await f.identity.verify(f.aliceToken));
  let ran = false;
  f.tools.register({
    name: 'queued',
    description: 'Test authority at the dispatch boundary',
    inputSchema: z
      .object({})
      .strict()
      .transform(async (value) => {
        await f.scope.removeMember(owner, project.id, bob);
        return value;
      }),
    handler: () => {
      ran = true;
      return {};
    },
  });
  const result = await f.request<{ error: { code: string } }>('/tools/queued', {
    token: f.bobToken,
    projectId: project.id,
    body: {},
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'membership_required');
  assert.equal(ran, false);
  assert.equal(
    (await f.request('/tools', { token: f.bobToken, projectId: project.id })).status,
    403,
  );
});
