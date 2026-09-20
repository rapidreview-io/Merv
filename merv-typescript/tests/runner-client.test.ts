import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutomaticLease, RunnerHeartbeat } from '@merv/sessions/types';
import { RunnerClient, RunnerControlError } from '../packages/runner/src/client.js';

const bearer = `mk_${'k'.repeat(43)}`;
const heartbeat: RunnerHeartbeat = {
  runnerId: 'runner_fixture',
  machine: { hostname: 'fixture', system: 'linux', architecture: 'x64' },
  platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
  capacity: 1,
};
const lease: AutomaticLease = {
  runnerId: heartbeat.runnerId,
  requestId: 'request_fixture',
  secret: `ms_${'s'.repeat(43)}`,
  platform: { name: 'codex', harness: 'codex' },
};
const desired = {
  name: 'codex',
  enabled: true,
  parallelism: 2,
  model: 'configured-model',
  effort: 'high',
};
const presence = (platforms: unknown = [desired], extra: Record<string, unknown> = {}) => ({
  runner: {
    ...heartbeat,
    id: 'presence_fixture',
    live: true,
    lastSeenAt: '2026-09-15T00:00:00Z',
    desiredVersion: 1,
    desiredSettings: { platforms },
    ...extra,
  },
});
const session = (patch: Record<string, unknown> = {}) => ({
  id: 'session_fixture',
  projectId: 'project_fixture',
  instanceId: 'instance_fixture',
  runnerId: heartbeat.runnerId,
  hostRef: 'launch_fixture',
  expectedRevision: 3,
  status: 'active',
  expiresAt: '2026-09-15T01:00:00Z',
  hardDeadline: '2026-09-15T04:00:00Z',
  assignment: { label: 'Frozen work', brief: 'Inspect the task.' },
  execution: { policy: { readOnly: false, tools: [] } },
  ...patch,
});
const client = (value: unknown) =>
  new RunnerClient('https://merv.example', 'project_fixture', bearer, async () =>
    Response.json(value),
  );
const invalid = { code: 'invalid_control_response', status: 0 };

test('runner presence accepts only closed bounded tuning settings', async () => {
  const result = await client(presence()).presence(heartbeat);
  assert.deepEqual(result.desiredSettings, { platforms: [desired] });
  assert.equal(result.desiredVersion, 1);
  assert.deepEqual((await client(presence([])).presence(heartbeat)).desiredSettings, {
    platforms: [],
  });
  const bad = [
    [{ ...desired, executable: '/bin/evil' }],
    [{ ...desired, harness: 'command' }],
    [{ ...desired, args: ['remote command'] }],
    [{ ...desired, env: {} }],
    [desired, desired],
    [{ ...desired, name: '../outside' }],
    [{ ...desired, parallelism: 0 }],
    [{ ...desired, parallelism: 33 }],
    [{ ...desired, enabled: 'true' }],
    [{ ...desired, model: 'x'.repeat(201) }],
    [{ ...desired, effort: 'high\nextra' }],
    Array.from({ length: 33 }, (_, i) => ({ ...desired, name: `p${i}` })),
    null,
    {},
    [null],
  ];
  for (const platforms of bad)
    await assert.rejects(async () => client(presence(platforms)).presence(heartbeat), invalid);
  for (const extra of [
    { desiredVersion: -1 },
    { desiredVersion: Number.MAX_SAFE_INTEGER + 1 },
    { runnerId: 'different_runner' },
    { desiredSettings: { platforms: [desired], executable: '/bin/evil' } },
  ])
    await assert.rejects(
      async () => client(presence([desired], extra)).presence(heartbeat),
      invalid,
    );
});

test('lease replies bind the server-selected session to this project and runner, including replayed closed leases', async () => {
  assert.equal(
    (await client({ session: session(), reason: 'leased' }).lease(lease)).session?.id,
    'session_fixture',
  );
  assert.deepEqual(await client({ session: null, reason: 'no_candidates' }).lease(lease), {
    session: null,
    reason: 'no_candidates',
  });
  assert.equal(
    (await client({ session: session({ status: 'released' }), reason: 'replayed' }).lease(lease))
      .session?.status,
    'released',
  );
  for (const patch of [
    { runnerId: 'other_runner' },
    { projectId: 'other_project' },
    { id: 'invalid/id' },
    { hardDeadline: 'invalid' },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await assert.rejects(
      async () => client({ session: session(patch), reason: 'leased' }).lease(lease),
      invalid,
    );
  for (const body of [
    null,
    1,
    'text',
    [],
    {},
    { reason: 'no_candidates' },
    { session: null },
    { session: null, reason: 'empty', unexpected: true },
  ])
    await assert.rejects(async () => client(body).lease(lease), invalid);
});

test('get rejects a same-project response for any different session or runner', async () => {
  assert.equal(
    (await client({ session: session() }).get('session_fixture', heartbeat.runnerId)).id,
    'session_fixture',
  );
  for (const patch of [
    { id: 'session_other' },
    { runnerId: 'other_runner' },
    { projectId: 'other_project' },
  ])
    await assert.rejects(
      async () => client({ session: session(patch) }).get('session_fixture', heartbeat.runnerId),
      invalid,
    );
  await assert.rejects(
    async () => client(null).get('session_fixture', heartbeat.runnerId),
    invalid,
  );
});

test('attach requires the requested session, runner and immutable host reference', async () => {
  assert.equal(
    (
      await client({ session: session({ status: 'offered' }) }).attach(
        'session_fixture',
        heartbeat.runnerId,
        'launch_fixture',
      )
    ).status,
    'offered',
  );
  for (const patch of [
    { id: 'session_other' },
    { runnerId: 'other_runner' },
    { projectId: 'other_project' },
    { hostRef: 'launch_other' },
    { hostRef: null },
    { status: 'released' },
    { status: 'expired' },
  ])
    await assert.rejects(
      async () =>
        client({ session: session(patch) }).attach(
          'session_fixture',
          heartbeat.runnerId,
          'launch_fixture',
        ),
      invalid,
    );
});

test('only an active matching heartbeat can renew a watchdog; release must acknowledge closure', async () => {
  assert.equal(
    (await client({ session: session() }).heartbeat('session_fixture', heartbeat.runnerId)).status,
    'active',
  );
  for (const patch of [
    { status: 'offered' },
    { status: 'released' },
    { status: 'expired' },
    { id: 'session_other' },
    { runnerId: 'other_runner' },
  ])
    await assert.rejects(
      async () =>
        client({ session: session(patch) }).heartbeat('session_fixture', heartbeat.runnerId),
      invalid,
    );
  for (const status of ['released', 'expired'])
    assert.equal(
      (
        await client({ session: session({ status }) }).release(
          'session_fixture',
          heartbeat.runnerId,
          'crash_loop',
          'premature_exit',
        )
      ).status,
      status,
    );
  for (const patch of [
    { status: 'offered' },
    { status: 'active' },
    { status: 'released', id: 'session_other' },
    { status: 'released', runnerId: 'other_runner' },
  ])
    await assert.rejects(
      async () =>
        client({ session: session(patch) }).release(
          'session_fixture',
          heartbeat.runnerId,
          'completed',
          'finished',
        ),
      invalid,
    );
});

test('malformed definitive 401 and 403 responses remain authentication failures', async () => {
  for (const status of [401, 403]) {
    const responses = [
      () => new Response('not-json-sensitive-body', { status }),
      () => new Response(null, { status }),
      () => new Response('x'.repeat(1024 * 1024 + 1), { status }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('sensitive stream failure'));
            },
          }),
          { status },
        ),
    ];
    for (const response of responses) {
      const connection = new RunnerClient(
        'https://merv.example',
        'project_fixture',
        bearer,
        async () => response(),
      );
      await assert.rejects(
        async () => connection.presence(heartbeat),
        (error: unknown) => {
          assert(error instanceof RunnerControlError);
          assert.equal(error.status, status);
          assert.equal(error.unavailable, false);
          assert.equal(error.code, 'invalid_control_response');
          assert.equal(error.message.includes('sensitive'), false);
          return true;
        },
      );
    }
  }
});

test('safe refusal codes retain HTTP status while secrets and remote messages never become diagnostics', async () => {
  for (const code of [bearer, lease.secret, 'unsafe error text']) {
    const connection = new RunnerClient(
      'https://merv.example',
      'project_fixture',
      bearer,
      async () => Response.json({ error: { code, message: `Secret ${bearer}` } }, { status: 403 }),
    );
    await assert.rejects(async () => connection.presence(heartbeat), {
      code: 'control_request_failed',
      status: 403,
    });
  }
  const connection = new RunnerClient('https://merv.example', 'project_fixture', bearer, async () =>
    Response.json(
      { error: { code: 'membership_required', message: 'Private explanation' } },
      { status: 403 },
    ),
  );
  await assert.rejects(async () => connection.presence(heartbeat), {
    code: 'membership_required',
    message: 'membership_required',
    status: 403,
  });
});

test('control transport keeps the source bearer in its authorization header and refuses redirects', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const connection = new RunnerClient(
    'https://merv.example',
    'project_fixture',
    bearer,
    async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ session: session({ status: 'released' }) });
    },
  );
  await connection.release('session_fixture', heartbeat.runnerId, 'crash_loop', 'premature_exit');
  assert.equal(calls[0].url, 'https://merv.example/sessions/session_fixture/release');
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${bearer}`);
  assert.equal(headers.get('x-merv-project-id'), 'project_fixture');
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(calls[0].init?.credentials, 'omit');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    runnerId: heartbeat.runnerId,
    outcome: 'crash_loop',
    reason: 'premature_exit',
  });
  assert.equal(String(calls[0].init?.body).includes(bearer), false);
});

test('control replies exceeding four MiB are cancelled before unbounded buffering', async () => {
  let cancelled = false;
  const connection = new RunnerClient(
    'https://merv.example',
    'project_fixture',
    bearer,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(connection.presence(heartbeat), invalid);
  assert.equal(cancelled, true);
});
