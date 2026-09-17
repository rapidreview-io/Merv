import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-dispatch-api-'));
  const assets = join(directory, 'bundle');
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Sessions</title>');
  const env = `MERV_DISPATCH_IDENTITY_${randomUUID().replaceAll('-', '')}`;
  const signingSecret = 'synthetic-dispatch-identity-secret-at-least-32-characters';
  process.env[env] = signingSecret;
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find((entry) => entry.id === 'identity')!.config = {
    supabaseUrl: 'https://dispatch.example.test',
    mode: 'hs256',
    secretEnv: env,
  };
  config.plugins.find((entry) => entry.id === 'ui')!.config = { assets };
  const app = await createApp({ directory: join(directory, 'data'), config, port: 0 });
  t.after(async () => {
    await app.stop();
    delete process.env[env];
    rmSync(directory, { recursive: true, force: true });
  });
  const token = (subject: string) =>
    new SignJWT({ role: 'authenticated', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://dispatch.example.test/auth/v1')
      .setSubject(subject)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(signingSecret));
  const operator = await token('operator'),
    reader = await token('reader');
  async function http(
    path: string,
    bearer = operator,
    body?: unknown,
    projectId?: string,
    method?: string,
  ) {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(path === '/mcp' ? { accept: 'application/json, text/event-stream' } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(projectId ? { 'x-merv-project-id': projectId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  const created = await http('/projects', operator, { name: 'Dispatch A', requestId: 'project-a' });
  assert.equal(created.status, 200);
  const project = created.body.project;
  const other = (await http('/projects', operator, { name: 'Dispatch B', requestId: 'project-b' }))
    .body.project;
  assert.equal(
    (await http(`/projects/${project.id}/members`, operator, { subject: 'reader', role: 'reader' }))
      .status,
    200,
  );
  const key = (await http('/account/keys', operator, { projectId: project.id })).body;
  const readerKey = (await http('/account/keys', reader, { projectId: project.id })).body;
  const createTask = async (requestId: string) => {
    const result = await http(
      '/tools/task.create',
      key.token,
      {
        title: 'Bounded scheduled work',
        goal: 'Produce evidence',
        checks: ['Evidence is independently verifiable.'],
        requestId,
      },
      project.id,
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.body.result;
  };
  const task = await createTask('first-task');
  const heartbeat = {
    runnerId: 'machine-local-id',
    machine: { hostname: 'Test host', system: 'Darwin', architecture: 'arm64' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 2 }],
    capacity: 2,
  };
  const leaseInput = () => ({
    runnerId: heartbeat.runnerId,
    requestId: randomUUID(),
    secret: secret(),
    platform: { name: 'codex', harness: 'codex' },
  });
  return {
    app,
    http,
    operator,
    reader,
    key,
    readerKey,
    project,
    other,
    task,
    createTask,
    heartbeat,
    leaseInput,
  };
}

test('automatic dispatch is off by default; operator UI sees machine-key sessions and pause differs from halt', async (t) => {
  const f = await fixture(t);
  let status = await f.http('/sessions/status', f.operator, undefined, f.project.id);
  assert.equal(status.status, 200, JSON.stringify(status));
  assert.equal(status.body.dispatch.enabled, false);
  assert.equal(status.body.canManage, true);
  assert.ok(
    status.body.queue.some(
      (candidate: { instanceId: string }) => candidate.instanceId === f.task.id,
    ),
  );
  const presence = await f.http(
    '/sessions/runners/heartbeat',
    f.key.token,
    f.heartbeat,
    f.project.id,
  );
  assert.equal(presence.status, 200, JSON.stringify(presence));
  const input = f.leaseInput();
  const disabled = await f.http('/sessions/lease', f.key.token, input, f.project.id);
  assert.equal(disabled.status, 200, JSON.stringify(disabled));
  assert.equal(disabled.body.session, null);
  assert.match(disabled.body.reason, /disabled/);
  assert.equal(
    (await f.http('/sessions/dispatch', f.operator, { enabled: true }, f.project.id, 'PUT')).body
      .dispatch.enabled,
    true,
  );
  const offered = await f.http('/sessions/lease', f.key.token, input, f.project.id);
  assert.equal(offered.status, 200, JSON.stringify(offered));
  assert.equal(offered.body.session.status, 'offered');
  const session = offered.body.session;
  const replay = await f.http('/sessions/lease', f.key.token, input, f.project.id);
  assert.equal(replay.body.session.id, session.id);
  status = await f.http('/sessions/status', f.operator, undefined, f.project.id);
  assert.equal(status.body.liveSessionCount, 1);
  assert.equal(status.body.sessionTotal, 1);
  const summary = status.body.sessions.find((row: { id: string }) => row.id === session.id);
  assert.ok(
    summary,
    'The human operator can inspect a machine-key-owned lease without impersonating its source',
  );
  for (const forbidden of [
    'source',
    'assignment',
    'execution',
    'lease',
    'secret',
    'token',
    'tokenHash',
  ])
    assert.equal(Object.hasOwn(summary, forbidden), false, forbidden);
  assert.ok(!JSON.stringify(status.body).includes(f.key.key.id));
  assert.ok(!JSON.stringify(status.body).includes(input.secret));
  assert.ok(!JSON.stringify(status.body).includes(f.task.briefId));
  assert.equal(
    (await f.http(`/sessions/${session.id}`, f.operator, undefined, f.project.id)).status,
    403,
    'Source-owned detailed control is still distinct from project summaries',
  );

  const shell = await f.http('/tools/ui.shell', f.operator, {}, f.project.id);
  const row = shell.body.result.rows.find((entry: { id: string }) => entry.id === 'sessions');
  assert.equal(row.readable, true);
  const ui = await f.http('/tools/ui.read', f.operator, { rowId: 'sessions' }, f.project.id);
  assert.equal(ui.status, 200);
  assert.equal(ui.body.result.sessions[0].id, session.id);
  assert.equal(ui.body.result.canManage, true);

  await f.http('/sessions/dispatch', f.operator, { enabled: false }, f.project.id, 'PUT');
  const initialize = await f.http('/mcp', input.secret, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'paused-worker', version: '1' },
    },
  });
  assert.equal(
    initialize.status,
    200,
    'Pausing dispatch does not revoke an existing offered lease',
  );
  assert.equal(
    (await f.http('/sessions/lease', f.key.token, f.leaseInput(), f.project.id)).body.session,
    null,
  );
  assert.equal(
    (await f.http(`/sessions/${session.id}/halt`, f.operator, {}, f.project.id)).body.halted,
    1,
  );
  assert.equal(
    (await f.http('/sessions/status', f.operator, undefined, f.project.id)).body.dispatch.enabled,
    false,
  );
  const stopped = await f.http('/mcp', input.secret, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  assert.ok([401, 403, 409].includes(stopped.status));

  await f.createTask('second-task');
  await f.http('/sessions/dispatch', f.operator, { enabled: true }, f.project.id, 'PUT');
  const second = await f.http('/sessions/lease', f.key.token, f.leaseInput(), f.project.id);
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.ok(second.body.session);
  const halted = await f.http('/sessions/halt', f.operator, {}, f.project.id);
  assert.ok(halted.body.halted >= 1);
  const final = await f.http('/sessions/status', f.operator, undefined, f.project.id);
  assert.equal(final.body.dispatch.enabled, false);
  assert.ok(
    final.body.sessions.every(
      (row: { status: string }) => !['offered', 'active'].includes(row.status),
    ),
  );
});

test('project reads are sanitized; reader, worker, foreign project, and executable settings are rejected at HTTP boundaries', async (t) => {
  const f = await fixture(t);
  const presence = await f.http(
    '/sessions/runners/heartbeat',
    f.key.token,
    f.heartbeat,
    f.project.id,
  );
  assert.equal(presence.status, 200, JSON.stringify(presence));
  const runnerId = presence.body.runner.id;
  const readerStatus = await f.http('/sessions/status', f.reader, undefined, f.project.id);
  assert.equal(readerStatus.status, 200);
  assert.equal(readerStatus.body.canManage, false);
  const readerUi = await f.http('/tools/ui.read', f.reader, { rowId: 'sessions' }, f.project.id);
  assert.equal(readerUi.status, 200);
  assert.equal(readerUi.body.result.canManage, false);
  for (const [path, body, method] of [
    ['/sessions/dispatch', { enabled: true }, 'PUT'],
    ['/sessions/halt', {}, 'POST'],
    [`/sessions/runners/${runnerId}/settings`, { settings: { platforms: [] } }, 'PUT'],
  ] as const)
    assert.equal((await f.http(path, f.reader, body, f.project.id, method)).status, 403, path);
  assert.equal((await f.http('/sessions/status', f.reader, undefined, f.other.id)).status, 403);
  assert.equal((await f.http('/sessions/status', f.key.token, undefined, f.other.id)).status, 403);
  assert.equal(
    (await f.http('/sessions/status?projectId=ignored', f.operator, undefined, f.project.id))
      .status,
    400,
  );
  assert.equal(
    (
      await f.http(
        '/sessions/dispatch',
        f.operator,
        { enabled: true, command: ['bad'] },
        f.project.id,
        'PUT',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.http(
        '/sessions/runners/heartbeat',
        f.key.token,
        { ...f.heartbeat, command: ['bad'] },
        f.project.id,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.http(
        '/sessions/runners/heartbeat',
        f.key.token,
        { ...f.heartbeat, platforms: [{ ...f.heartbeat.platforms[0], command: ['bad'] }] },
        f.project.id,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.http(
        `/sessions/runners/${runnerId}/settings`,
        f.operator,
        {
          settings: {
            platforms: [{ name: 'codex', enabled: true, parallelism: 1, argv: ['bad'] }],
          },
        },
        f.project.id,
        'PUT',
      )
    ).status,
    400,
  );
  const tuning = await f.http(
    `/sessions/runners/${runnerId}/settings`,
    f.operator,
    {
      settings: {
        platforms: [{ name: 'codex', enabled: true, parallelism: 1, model: 'test-model' }],
      },
    },
    f.project.id,
    'PUT',
  );
  assert.equal(tuning.status, 200, JSON.stringify(tuning));
  assert.ok(tuning.body.runner.desiredVersion > 0);
  const pulled = await f.http(
    '/sessions/runners/heartbeat',
    f.key.token,
    f.heartbeat,
    f.project.id,
  );
  assert.equal(pulled.body.runner.desiredSettings.platforms[0].model, 'test-model');
  const manual = await f.http(
    '/sessions/offer',
    f.key.token,
    {
      instanceId: f.task.id,
      expectedRevision: f.task.workflow.revision,
      runnerId: 'manual',
      requestId: 'manual',
      secret: secret(),
    },
    f.project.id,
  );
  assert.equal(manual.status, 200, JSON.stringify(manual));
  const workerSecret = secret();
  await f.http(`/sessions/${manual.body.session.id}/halt`, f.operator, {}, f.project.id);
  const live = await f.http(
    '/sessions/offer',
    f.key.token,
    {
      instanceId: f.task.id,
      expectedRevision: f.task.workflow.revision,
      runnerId: 'manual',
      requestId: 'manual-next',
      secret: workerSecret,
    },
    f.project.id,
  );
  assert.equal(live.status, 200, JSON.stringify(live));
  for (const path of [
    '/sessions/status',
    '/sessions/dispatch',
    '/sessions/lease',
    '/sessions/halt',
    '/sessions/runners/heartbeat',
  ]) {
    assert.equal(
      (
        await f.http(
          path,
          workerSecret,
          path === '/sessions/status' ? undefined : {},
          f.project.id,
          path === '/sessions/dispatch' ? 'PUT' : undefined,
        )
      ).status,
      403,
      path,
    );
  }
  assert.equal(
    (
      await f.http(
        `/sessions/${live.body.session.id}/release`,
        f.key.token,
        { runnerId: 'manual', outcome: 'arbitrary-policy-value' },
        f.project.id,
      )
    ).status,
    400,
  );
  const released = await f.http(
    `/sessions/${live.body.session.id}/release`,
    f.key.token,
    { runnerId: 'manual', outcome: 'launch_failed', reason: 'A bounded launch annotation.' },
    f.project.id,
  );
  assert.equal(released.status, 200, JSON.stringify(released));
  assert.equal(released.body.session.outcome, 'launch_failed');
  const summarized = await f.http('/sessions/status', f.operator, undefined, f.project.id);
  assert.equal(
    summarized.body.sessions.find((item: { id: string }) => item.id === live.body.session.id)
      .outcome,
    'launch_failed',
  );
  await f.app.setEnabled('sessions-ui', false);
  const after = await f.http('/tools/ui.shell', f.operator, {}, f.project.id);
  assert.equal(
    after.body.result.rows.some((entry: { id: string }) => entry.id === 'sessions'),
    false,
  );
  assert.equal(
    (await f.http('/tools/ui.read', f.operator, { rowId: 'sessions' }, f.project.id)).status,
    404,
  );
  assert.equal(
    (await f.http('/sessions/status', f.operator, undefined, f.project.id)).status,
    200,
    'UI adapter unloading leaves Sessions controls available',
  );
});

test('status states its own clock and its own limits, and the rail costs one count', async (t) => {
  const f = await fixture(t);
  await f.http('/sessions/runners/heartbeat', f.key.token, f.heartbeat, f.project.id);
  const before = Date.now();
  const status = await f.http('/sessions/status', f.operator, undefined, f.project.id);
  assert.equal(status.status, 200, JSON.stringify(status));
  const observed = Date.parse(status.body.observedAt);
  assert.ok(
    observed >= before - 5_000 && observed <= Date.now() + 5_000,
    `observedAt must be the server's own clock, got ${status.body.observedAt}`,
  );
  assert.equal(status.body.runnerTotal, status.body.runners.length);
  // The agents array is read inside the dispatcher's transaction, so one payload
  // cannot report an agent on a lease the same payload's sessions do not hold.
  const ui = await f.http('/tools/ui.read', f.operator, { rowId: 'sessions' }, f.project.id);
  const held = new Set(ui.body.result.sessions.map((row: { id: string }) => row.id));
  for (const agent of ui.body.result.agents)
    if (agent.currentExecutionId) assert.ok(held.has(agent.currentExecutionId), agent.id);
  assert.equal(typeof ui.body.result.observedAt, 'string');
  assert.equal(typeof ui.body.result.runnerTotal, 'number');

  // The rail's integer must not pay for a whole status: no candidate enumeration.
  const workflows = f.app.ctx.workflows as unknown as {
    dispatchCandidates: (...args: unknown[]) => Promise<unknown>;
  };
  const enumerate = workflows.dispatchCandidates.bind(workflows);
  let enumerations = 0;
  workflows.dispatchCandidates = async (...args: unknown[]) => {
    enumerations++;
    return await enumerate(...args);
  };
  t.after(() => {
    workflows.dispatchCandidates = enumerate;
  });
  const shell = await f.http('/tools/ui.shell', f.operator, {}, f.project.id);
  assert.equal(
    shell.body.result.rows.find((entry: { id: string }) => entry.id === 'sessions').status.count,
    0,
  );
  assert.equal(enumerations, 0, 'ui.shell must not enumerate dispatch candidates for a count');
  await f.http('/tools/ui.read', f.operator, { rowId: 'sessions' }, f.project.id);
  assert.ok(enumerations >= 1, 'the page itself still reads the queue');
});

test('a runner reports the answer its last lease request received', async (t) => {
  const f = await fixture(t);
  await f.http('/sessions/runners/heartbeat', f.key.token, f.heartbeat, f.project.id);
  const runnerRow = async () =>
    (await f.http('/sessions/status', f.operator, undefined, f.project.id)).body.runners[0];
  assert.equal((await runnerRow()).lastDecision, null, 'a runner that never asked decides nothing');

  await f.http('/sessions/lease', f.key.token, f.leaseInput(), f.project.id);
  let runner = await runnerRow();
  assert.equal(runner.lastDecision, 'dispatch_disabled');
  assert.ok(Date.parse(runner.lastDecisionAt) <= Date.now() + 5_000);

  await f.http('/sessions/dispatch', f.operator, { enabled: true }, f.project.id, 'PUT');
  const offered = await f.http('/sessions/lease', f.key.token, f.leaseInput(), f.project.id);
  assert.ok(offered.body.session, JSON.stringify(offered));
  assert.equal((await runnerRow()).lastDecision, 'offered');

  // The runner's own settings were re-published and not yet acknowledged: every
  // further lease is refused, and the page can now say which refusal it was.
  const settings = await f.http(
    `/sessions/runners/${(await runnerRow()).id}/settings`,
    f.operator,
    { settings: { platforms: [{ name: 'codex', enabled: true, parallelism: 2 }] } },
    f.project.id,
    'PUT',
  );
  assert.equal(settings.status, 200, JSON.stringify(settings));
  const pending = await f.http('/sessions/lease', f.key.token, f.leaseInput(), f.project.id);
  assert.equal(pending.body.session, null);
  assert.equal(pending.body.reason, 'settings_pending');
  runner = await runnerRow();
  assert.equal(runner.lastDecision, 'settings_pending');
  assert.equal(runner.desiredVersion > (runner.appliedVersion ?? 0), true);

  // Acknowledged, with the one seat this runner has already taken: capacity.
  await f.http(
    '/sessions/runners/heartbeat',
    f.key.token,
    { ...f.heartbeat, capacity: 1, appliedVersion: runner.desiredVersion },
    f.project.id,
  );
  const full = await f.http('/sessions/lease', f.key.token, f.leaseInput(), f.project.id);
  assert.equal(full.body.session, null);
  assert.equal(full.body.reason, 'capacity_full');
  assert.equal((await runnerRow()).lastDecision, 'capacity_full');
});
