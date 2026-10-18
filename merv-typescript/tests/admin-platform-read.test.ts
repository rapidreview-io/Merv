/**
 * Platform read: a configured admin, signed in and asking with `x-merv-platform: read`, opens any
 * project's own pages through the real read tools, as a reader that no actor row backs. The
 * registry refuses every other tool before its handler, Scope every other permission, and no
 * other principal, agent path or delegation ever carries the authority.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { createService, type Caller } from '@merv/contracts';
import { ToolRegistry } from '@merv/api';
import { PLATFORM_ACTOR, ProjectScope } from '@merv/scope';
import type { ApplicationConfig } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { deferred } from './fixtures/deferred.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { openState } from './fixtures/state.js';

const supabaseUrl = 'https://platform-read.example';
const issuer = `${supabaseUrl}/auth/v1`;
const secret = 'synthetic-platform-read-secret-for-local-tests-only';
const secretEnv = 'MERV_PLATFORM_READ_TEST_SECRET';

async function fixture(t: TestContext) {
  process.env[secretEnv] = secret;
  const directory = mkdtempSync(join(tmpdir(), 'merv-platform-read-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  const entry = (id: string) => config.plugins.find((plugin) => plugin.id === id)!;
  entry('ui').config = { assets: join(directory, 'unused-assets') };
  entry('identity').config = { supabaseUrl, mode: 'hs256', secretEnv };
  entry('admin').config = { admins: [{ issuer, subject: 'platform-admin' }] };
  const app = await createApp({ directory, config, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
    delete process.env[secretEnv];
  });
  const sign = (subject: string) =>
    new SignJWT({ role: 'authenticated', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setSubject(subject)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));
  const [memberToken, adminToken, strangerToken] = await Promise.all(
    ['member', 'platform-admin', 'stranger'].map(sign),
  );
  const human = async (token: string) =>
    await app.ctx.scope.members.acceptVerifiedIdentity(await app.ctx.identity.verify(token));
  const member = await human(memberToken);
  const project = await app.ctx.scope.members.createProject(member, {
    name: 'Customer research',
    requestId: 'platform-read',
  });
  const owner = await app.ctx.scope.caller(member, project.id);
  await waitForManagedCode(app.ctx.codeWork, owner);
  const request = async (
    path: string,
    bearer: string,
    { body, platform = 'read', projectId = project.id } = {} as {
      body?: unknown;
      platform?: string | null;
      projectId?: string;
    },
  ) => {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-merv-project-id': projectId,
        ...(platform === null ? {} : { 'x-merv-platform': platform }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const tool = (name: string, input: unknown, bearer = adminToken, options = {}) =>
    request(`/tools/${name}`, bearer, { body: input, ...options });
  return { app, project, owner, member, human, adminToken, strangerToken, request, tool };
}

test('a platform admin reads a project it is not a member of through its pages, and only reads', async (t) => {
  const f = await fixture(t);
  const experiment = await f.app.ctx.tools.call('experiment.create', f.owner, {
    name: 'held-out-comparison',
    intent: 'Compare two classifiers on held-out data.',
    requestId: 'experiment',
  });
  const task = await f.app.ctx.tasks.create(f.owner, {
    title: 'Prepare the data',
    goal: 'Split the held-out set.',
    checks: ['The split is retained.'],
    requestId: 'task',
  });
  const { id: experimentId } = experiment as { id: string };
  // Without the header the admin is a stranger to the project.
  assert.equal((await f.tool('project.get', {}, f.adminToken, { platform: null })).status, 403);

  const project = await f.tool('project.get', {});
  assert.equal(project.status, 200, JSON.stringify(project.body));
  assert.equal(project.body.result.id, f.project.id);
  const whoami = (await f.tool('actor.whoami', {})).body.result;
  assert.deepEqual([whoami.id, whoami.role], [PLATFORM_ACTOR, 'reader']);
  const shell = await f.tool('ui.shell', {});
  assert.equal(shell.status, 200, JSON.stringify(shell.body));
  assert.equal(shell.body.result.project.id, f.project.id);
  for (const [rowId, id] of [
    ['experiments', experimentId],
    ['tasks', task.id],
  ]) {
    const page = await f.tool('ui.read', { rowId, params: { id } });
    assert.equal(page.status, 200, `${rowId}: ${JSON.stringify(page.body)}`);
    assert.ok(JSON.stringify(page.body.result).includes(id));
  }
  assert.deepEqual(
    (await f.tool('experiment.list', {})).body.result.map((e: { id: string }) => e.id),
    [experimentId],
  );
  // The listing offers read-only native tools alone.
  const listed = (await f.request('/tools', f.adminToken)).body.tools as {
    name: string;
    annotations: { readOnlyHint: boolean };
  }[];
  assert.ok(listed.some((entry) => entry.name === 'ui.shell'));
  assert.ok(listed.every((entry) => entry.annotations.readOnlyHint));

  // Every write is refused by the registry before its handler runs: an empty input would
  // otherwise fail its schema, and the probe's handler would run.
  let ran = false;
  const withdraw = f.app.ctx.tools.register({
    name: 'test.platform_write',
    description: 'Probe whether a platform caller reaches a write handler',
    inputSchema: z.object({}).strict(),
    handler: () => (ran = true),
  });
  t.after(withdraw);
  const write = await f.tool('test.platform_write', {});
  assert.deepEqual([write.status, write.body.error.code, ran], [403, 'platform_read_only', false]);
  assert.equal(
    (await f.tool('experiment.create', { name: 'x', intent: 'y', requestId: 'z' })).status,
    403,
  );
  const admin = await f.human(f.adminToken);
  const caller = await f.app.ctx.scope.platformCaller(admin, f.project.id);
  const writes = (await f.app.ctx.tools.list()).filter(
    (entry) => !('readOnly' in entry && entry.readOnly),
  );
  assert.ok(writes.length > 20);
  for (const { name } of writes)
    await assert.rejects(f.app.ctx.tools.invoke(name, caller, {}), { code: 'platform_read_only' });
  for (const permission of ['write', 'review', 'admin'] as const)
    await assert.rejects(f.app.ctx.scope.require(caller, permission), {
      code: 'platform_read_only',
    });
  // It never starts work: no delegation, so no session, conversation or lease.
  await assert.rejects(f.app.ctx.scope.delegationSource(caller), { code: 'platform_forbidden' });
  await assert.rejects(
    f.app.ctx.sessions.offer(caller, {
      instanceId: task.id,
      expectedRevision: 0,
      runnerId: 'platform-runner',
      requestId: 'platform-offer',
      secret: `ms_${randomBytes(32).toString('base64url')}`,
    }),
    { code: 'platform_forbidden' },
  );

  // Reading is audited once an hour per admin and project, however often the admin reads.
  const audited = () =>
    f.app.ctx.state.read((sql) =>
      sql.all<{ subject: string; target: string }>(
        "SELECT subject,target FROM admin_audit WHERE action='project.read'",
      ),
    );
  for (let tries = 0; !(await audited()).length && tries < 200; tries++) await delay(10);
  await f.tool('project.get', {});
  await delay(50);
  assert.deepEqual(await audited(), [{ subject: 'platform-admin', target: f.project.id }]);

  const picker = await f.request('/admin/projects', f.adminToken, { platform: null });
  assert.equal(picker.status, 200);
  assert.deepEqual(picker.body.projects, [f.project]);
  assert.equal((await f.request('/admin/projects', f.strangerToken)).status, 403);
  // A standalone experiment as its customer sees it, from Customer experiments while installed.
  const standalone = (bearer: string) =>
    f.request('/admin/standalone/ce_request', bearer, { platform: null });
  assert.equal((await standalone(f.adminToken)).status, 503);
  t.after(
    f.app.ctx.provide('customerExperiments', {
      snapshot: async (id: string) => ({ id }),
      customers: async () => [],
    }),
  );
  assert.deepEqual((await standalone(f.adminToken)).body, { id: 'ce_request' });
  assert.equal((await standalone(f.strangerToken)).status, 403);
});

test('no other principal or agent path carries platform read, and it fails closed without its provider', async (t) => {
  const f = await fixture(t);
  // A person who is not an administrator learns nothing, not even whether a project exists.
  for (const projectId of [f.project.id, 'project_missing']) {
    const refused = await f.tool('project.get', {}, f.strangerToken, { projectId });
    assert.deepEqual([refused.status, refused.body.error.code], [403, 'forbidden']);
  }
  assert.equal((await f.request('/tools', f.strangerToken)).status, 403);
  assert.equal((await f.tool('project.get', {}, f.adminToken, { projectId: 'nope' })).status, 404);
  assert.equal((await f.tool('project.get', {}, f.adminToken, { platform: 'write' })).status, 403);

  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Machines',
    actorName: 'Runner owner',
  });
  const source = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(f.app.ctx.codeWork, source);
  await f.app.ctx.sessions.dispatch.heartbeatRunner(source, {
    runnerId: 'platform-runner',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  const task = await f.app.ctx.tasks.create(source, {
    title: 'Session work',
    goal: 'Hold a session.',
    checks: ['It is held.'],
    requestId: 'session-task',
  });
  const sessionToken = `ms_${randomBytes(32).toString('base64url')}`;
  await f.app.ctx.sessions.offer(source, {
    instanceId: task.id,
    expectedRevision: 0,
    runnerId: 'platform-runner',
    requestId: 'session',
    secret: sessionToken,
  });
  const userKey = await f.app.ctx.scope.userKeys.create(f.member, { projectId: f.project.id });
  const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  for (const [bearer, projectId, path, body] of [
    [boot.token, boot.project.id, '/tools/project.get', {}],
    [userKey.token, f.project.id, '/tools/project.get', {}],
    // A session's bearer speaks MCP alone.
    [sessionToken, boot.project.id, '/mcp', listTools],
    // A person's agent over MCP never acts with platform authority, the admin's own included.
    [f.adminToken, f.project.id, '/mcp', listTools],
  ] as const) {
    const refused = await f.request(path, bearer, { projectId, body });
    assert.deepEqual([refused.status, refused.body.error.code], [403, 'platform_forbidden']);
  }
  // Without the header, the actor token and the user key are their own authority, as ever.
  for (const [bearer, projectId] of [
    [boot.token, boot.project.id],
    [userKey.token, f.project.id],
  ])
    assert.equal(
      (await f.tool('project.get', {}, bearer, { projectId, platform: null })).status,
      200,
    );

  const admin = await f.human(f.adminToken);
  const caller = await f.app.ctx.scope.platformCaller(admin, f.project.id);
  await f.app.setEnabled('admin', false);
  const withdrawn = await f.tool('project.get', {});
  assert.deepEqual([withdrawn.status, withdrawn.body.error.code], [503, 'unavailable']);
  await assert.rejects(f.app.ctx.scope.require(caller, 'read'), { code: 'platform_unavailable' });
});

test('Scope decides a platform caller on its provider alone, fenced, and the registry fails closed without rules', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({ projectName: 'Any', actorName: 'Owner' });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const caller: Caller = {
    actorId: PLATFORM_ACTOR,
    projectId: boot.project.id,
    platform: { issuer, subject: 'platform-admin', expiresAt },
  };
  let vouch: () => boolean | Promise<boolean> = () => true;
  const install = () => scope.registerPlatformAuthority({ vouches: () => vouch() });
  const withdraw = install();
  assert.throws(install, { code: 'platform_authority_registered' });
  assert.equal((await scope.require(caller, 'read')).id, PLATFORM_ACTOR);
  for (const refused of [
    { ...caller, credentialId: boot.credential.id },
    { ...caller, actorId: boot.actor.id },
    { ...caller, platform: { ...caller.platform!, expiresAt: new Date(0).toISOString() } },
  ])
    await assert.rejects(scope.require(refused, 'read'), { code: 'forbidden' });
  await assert.rejects(scope.require({ ...caller, projectId: 'project_missing' }, 'read'), {
    code: 'not_found',
  });
  vouch = () => false;
  await assert.rejects(scope.require(caller, 'read'), { code: 'forbidden' });
  // A decision whose provider was withdrawn and installed again while it waited is refused.
  const pending = deferred<boolean>();
  vouch = () => pending.promise;
  const decision = scope.require(caller, 'read');
  withdraw();
  install();
  pending.resolve(true);
  await assert.rejects(decision, { code: 'platform_unavailable' });

  const tools = new ToolRegistry(scope);
  tools.register({
    name: 'probe.read',
    description: 'Read nothing',
    inputSchema: z.object({}).strict(),
    readOnly: true,
    handler: () => ({}),
  });
  await assert.rejects(tools.call('probe.read', caller, {}), { code: 'unavailable', status: 503 });
});
