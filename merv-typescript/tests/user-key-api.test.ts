import { createService } from '@merv/contracts';
import { Context } from 'cordis';
import { SignJWT } from 'jose';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';

import { ApiServer, ToolRegistry } from '@merv/api';
import type { Caller, IssuedUserKey, Project, UserKey } from '@merv/contracts';
import { SupabaseIdentity } from '@merv/identity';
import { ProjectScope } from '@merv/scope';
import { scopeRoutes } from '@merv/scope/api';
import { scopeToolsPlugin } from '@merv/scope/tools';
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
  for (const prefix of ['/account', '/projects'] as const) server.mount(prefix, scopeRoutes(scope));
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
  const owner = await scope.members.acceptVerifiedIdentity(await verify(alice));
  const other = await scope.members.acceptVerifiedIdentity(await verify(bob));
  const project = await scope.members.createProject(owner, {
    name: 'Issuance',
    requestId: 'issuance',
  });
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
  const otherProject = await f.scope.members.createProject(f.other, {
    name: 'Other project',
    requestId: 'other',
  });
  await f.scope.members.addMember(f.other, otherProject.id, { subject: 'alice', role: 'reader' });
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
  assert.deepEqual(projectAccount.body.projects, [{ ...f.project, role: 'operator' }]);
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
  await f.scope.members.changeMemberRole(f.other, otherProject.id, {
    subject: 'alice',
    role: 'producer',
  });
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
    { kind: 'key', key: await f.scope.userKeys.authenticate(accountKey.token) },
    otherProject.id,
  );
  await f.scope.members.removeMember(f.other, otherProject.id, 'alice');
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
  await f.scope.members.addMember(f.other, otherProject.id, { subject: 'alice', role: 'reviewer' });
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
          if (mode === 'revoke') await f.scope.userKeys.revoke(f.owner, key.key.id);
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
