import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import type { ApplicationConfig } from '../src/config.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-managed-api-'));
  const env = `MERV_MANAGED_API_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find((entry) => entry.id === 'sessions')!.config = { managedSecretEnv: env };
  const app = await createApp({ directory, port: 0, config });
  t.after(async () => {
    await app.stop();
    delete process.env[env];
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Managed API', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const source = await app.ctx.scope.delegationSource(owner);
  app.ctx.sessions.registerManagedValidator({
    current: async (binding) =>
      binding.allocationId === 'allocation-api' &&
      binding.epoch === 1 &&
      binding.source.actorId === owner.actorId,
    admits: async () => true,
  });
  const enrollment = await app.ctx.sessions.ensureManagedEnrollment({
    allocationId: 'allocation-api',
    epoch: 1,
    source,
    runtimeProfileId: 'codex-profile',
    platform: {
      name: 'codex',
      harness: 'codex',
      model: 'gpt-6-luna',
      enabled: true,
      parallelism: 1,
    },
    capabilities: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const request = async (
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
    projectId?: string,
  ) => {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(projectId ? { 'x-merv-project-id': projectId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    app,
    owner,
    actorToken: boot.token,
    enrollmentToken: enrollment.enrollmentToken,
    projectId: boot.project.id,
    request,
  };
}

test('managed HTTP credentials stay on enrollment and control routes', async (t) => {
  const f = await fixture(t);
  assert.match(f.enrollmentToken, /^me_[0-9a-f]{64}$/);
  const enrolled = await f.request(
    '/sessions/runners/enroll',
    f.enrollmentToken,
    'POST',
    {},
    f.projectId,
  );
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled));
  const token: string = enrolled.body.controlToken;
  assert.match(token, /^mr_[0-9a-f]{64}$/);
  const heartbeat = {
    runnerId: 'managed-api-runner',
    machine: { hostname: 'api-host', system: 'Linux', architecture: 'x64' },
    platforms: [
      { name: 'codex', harness: 'codex', model: 'gpt-6-luna', enabled: true, parallelism: 1 },
    ],
    capacity: 1,
    capabilities: [],
  };
  const active = await f.request(
    '/sessions/runners/heartbeat',
    token,
    'POST',
    heartbeat,
    f.projectId,
  );
  assert.equal(active.status, 200, JSON.stringify(active));
  for (const path of ['/sessions/self', '/tools', '/projects', '/account', '/probe', '/mcp']) {
    const result = await f.request(path, token, 'GET', undefined, f.projectId);
    assert.equal(result.status, 403, `${path}: ${JSON.stringify(result)}`);
    assert.equal(result.body.error?.code, 'managed_runner_forbidden');
  }
  for (const path of ['/sessions/self/assignment', '/tools/task.create', '/mcp']) {
    const result = await f.request(path, token, 'POST', {}, f.projectId);
    assert.equal(result.status, 403, `${path}: ${JSON.stringify(result)}`);
    assert.equal(result.body.error?.code, 'managed_runner_forbidden');
  }
  const mounted = f.app.ctx.api.mount('/probe', (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ reached: true }));
  });
  t.after(mounted);
  assert.equal((await f.request('/probe', token, 'GET')).status, 403);
  assert.equal((await f.request('/probe', f.actorToken, 'GET')).status, 200);
  assert.equal(
    (await f.request('/sessions/status', f.actorToken, 'GET', undefined, f.projectId)).status,
    200,
  );
  assert.equal(
    (await f.request('/sessions/runners/heartbeat', token, 'POST', heartbeat, 'project_other'))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/sessions/runners/heartbeat',
        token,
        'POST',
        { ...heartbeat, actorId: f.owner.actorId },
        f.projectId,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/sessions/runners/heartbeat',
        token,
        'POST',
        { ...heartbeat, managed: { allocationId: 'other' } },
        f.projectId,
      )
    ).status,
    400,
  );
});

test('enrollment rejects spoofed fields and managed caller cannot reach registry or general Scope authority', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request(
        '/sessions/runners/enroll',
        f.enrollmentToken,
        'POST',
        { actorId: f.owner.actorId },
        f.projectId,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/sessions/runners/enroll',
        f.enrollmentToken,
        'POST',
        { projectId: f.projectId },
        f.projectId,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/sessions/runners/enroll', f.enrollmentToken, 'POST', {}, 'project_other'))
      .status,
    400,
  );
  assert.equal((await f.request('/projects', f.enrollmentToken, 'GET')).status, 403);
  const enrolled = await f.request(
    '/sessions/runners/enroll',
    f.enrollmentToken,
    'POST',
    {},
    f.projectId,
  );
  assert.equal(enrolled.status, 200);
  const caller = await f.app.ctx.sessions.authenticateManaged(enrolled.body.controlToken);
  await assert.rejects(f.app.ctx.scope.delegationSource(caller), {
    code: 'managed_runner_forbidden',
  });
  await assert.rejects(f.app.ctx.tools.list(caller), { code: 'managed_runner_forbidden' });
  await assert.rejects(f.app.ctx.tools.describe(caller), { code: 'managed_runner_forbidden' });
  await assert.rejects(f.app.ctx.tools.invoke('task.create', caller, {}), {
    code: 'managed_runner_forbidden',
  });
});
