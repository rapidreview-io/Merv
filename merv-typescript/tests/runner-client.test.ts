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

test('runner presence keeps only bounded tuning settings and ignores fields it does not know', async () => {
  const result = await client(presence()).presence(heartbeat);
  assert.deepEqual(result.desiredSettings, { platforms: [desired] });
  assert.equal(result.desiredVersion, 1);
  assert.deepEqual((await client(presence([])).presence(heartbeat)).desiredSettings, {
    platforms: [],
  });
  // A field a newer server adds is dropped, never applied: no reply can name an executable.
  for (const platforms of [
    [{ ...desired, executable: '/bin/evil' }],
    [{ ...desired, harness: 'command' }],
    [{ ...desired, args: ['remote command'] }],
    [{ ...desired, env: {} }],
  ])
    assert.deepEqual((await client(presence(platforms)).presence(heartbeat)).desiredSettings, {
      platforms: [desired],
    });
  assert.deepEqual(
    (
      await client(
        presence([desired], { desiredSettings: { platforms: [desired], executable: '/bin/evil' } }),
      ).presence(heartbeat)
    ).desiredSettings,
    { platforms: [desired] },
  );
  // A tuned model or effort is validated again as a profile before it is used.
  const model = { ...desired, model: 'x'.repeat(201) };
  assert.deepEqual((await client(presence([model])).presence(heartbeat)).desiredSettings, {
    platforms: [model],
  });
  const bad = [
    [desired, desired],
    [{ ...desired, name: '../outside' }],
    [{ ...desired, parallelism: 0 }],
    [{ ...desired, parallelism: 33 }],
    [{ ...desired, enabled: 'true' }],
    [{ ...desired, model: 1 }],
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
  for (const body of [null, 1, 'text', [], {}, { reason: 'no_candidates' }, { session: null }])
    await assert.rejects(async () => client(body).lease(lease), invalid);
  assert.deepEqual(
    await client({ session: null, reason: 'empty', unexpected: true }).lease(lease),
    { session: null, reason: 'empty' },
    'a field a newer server adds to the envelope is ignored',
  );
});

test('workspace acknowledgements compare against the attachment originally sent', async () => {
  const workspace = {
    repositoryId: 'repository_fixture',
    workspaceId: 'workspace_fixture',
    mode: 'persistent' as const,
    branch: 'codex/work',
    baseOid: '1'.repeat(40),
    headOid: '1'.repeat(40),
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  for (const operation of ['attach', 'workspaceResult'] as const) {
    for (const changedReply of [false, true]) {
      const input = structuredClone(workspace),
        reply = structuredClone(workspace);
      if (changedReply) reply.stats.insertions = 1;
      const pending = client({
        session: session({ workspace: { attachment: reply, result: reply } }),
        prompt: 'Worker prompt.',
      })[operation]('session_fixture', heartbeat.runnerId, 'launch_fixture', input);
      input.stats.insertions = 1;
      if (changedReply) await assert.rejects(pending, invalid);
      else {
        const answer = await pending;
        const read = 'session' in answer ? answer.session : answer;
        assert.deepEqual(read.workspace?.attachment, workspace);
      }
    }
  }
  // The session's workspace record may gain fields; the attachment and result stay closed.
  const tolerated = await client({
    session: session({ workspace: { attachment: workspace, result: null, capturedAt: 'x' } }),
  }).get('session_fixture', heartbeat.runnerId);
  assert.deepEqual(tolerated.workspace, { attachment: workspace, result: null });
  await assert.rejects(
    async () =>
      client({
        session: session({ workspace: { attachment: { ...workspace, extra: 1 }, result: null } }),
      }).get('session_fixture', heartbeat.runnerId),
    invalid,
  );
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

test('attach requires the requested session, runner and immutable host reference, and the worker prompt', async () => {
  assert.deepEqual(
    await client({ session: session({ status: 'offered' }), prompt: 'Worker prompt.' }).attach(
      'session_fixture',
      heartbeat.runnerId,
      'launch_fixture',
    ),
    { session: session({ status: 'offered' }), prompt: 'Worker prompt.' },
  );
  // A server too old to send the prompt launches nothing.
  for (const prompt of [undefined, '', ' ', 7, 'x'.repeat(32_001)])
    await assert.rejects(
      client({ session: session({ status: 'offered' }), prompt }).attach(
        'session_fixture',
        heartbeat.runnerId,
        'launch_fixture',
      ),
      invalid,
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
        client({ session: session(patch), prompt: 'Worker prompt.' }).attach(
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
          { outcome: 'crash_loop', reason: 'premature_exit' },
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
        client({ session: session(patch) }).release('session_fixture', heartbeat.runnerId, {
          outcome: 'completed',
          reason: 'finished',
        }),
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
  await connection.release('session_fixture', heartbeat.runnerId, {
    outcome: 'crash_loop',
    reason: 'premature_exit',
  });
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

test('runner replies reject invalid UTF-8 without changing valid Unicode', async () => {
  let reason = Buffer.from('研究�');
  const connection = new RunnerClient(
    'https://merv.example',
    'project_fixture',
    bearer,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const body = Buffer.concat([
              Buffer.from('{"session":null,"reason":"'),
              reason,
              Buffer.from('"}'),
            ]);
            for (const byte of body) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      ),
  );
  assert.equal((await connection.lease(lease)).reason, '研究�');
  for (const bytes of [[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
    reason = Buffer.from(bytes);
    await assert.rejects(connection.lease(lease), invalid);
  }
});

test('a refusal is final only when asking again cannot change the answer', () => {
  const final = (status: number, code = 'refused') => new RunnerControlError(code, status).final;
  for (const status of [400, 403, 404, 409, 410, 422])
    assert.equal(final(status), true, `${status}`);
  // Authentication, timeouts, rate limits, unreachable or failing servers are asked again.
  for (const status of [0, 401, 408, 429, 500, 503])
    assert.equal(final(status), false, `${status}`);
  for (const code of ['transaction_conflict', 'invalid_control_response'])
    assert.equal(final(409, code), false, code);
});

test('HF runtime fetch binds its host and validates a private nullable response without exposing malformed bytes', async () => {
  const marker = 'hf_' + 'ClientMarker'.repeat(3);
  const seen: { url: string; body: unknown; method: unknown }[] = [];
  const managed = new RunnerClient(
    'https://merv.example',
    'project_fixture',
    'mr_' + 'a'.repeat(64),
    async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)), method: init?.method });
      return Response.json({ access: { token: marker, endpoint: 'https://merv.example/hf' } });
    },
  );
  assert.deepEqual(
    await managed.huggingfaceAccess('session_fixture', 'runner_fixture', 'host_fixture'),
    { token: marker, endpoint: 'https://merv.example/hf' },
  );
  assert.deepEqual(seen, [
    {
      url: 'https://merv.example/sessions/session_fixture/huggingface-access',
      method: 'POST',
      body: { runnerId: 'runner_fixture', hostRef: 'host_fixture' },
    },
  ]);
  assert.equal(
    await client({ access: null }).huggingfaceAccess(
      'session_fixture',
      'runner_fixture',
      'host_fixture',
    ),
    null,
  );
  for (const value of [
    { hfToken: marker, extra: true },
    {},
    { hfToken: marker + '\n' },
    { hfToken: 7 },
    { access: { token: marker, endpoint: 'https://merv.example:8443/hf' } },
    { access: { token: marker, endpoint: 'https://MERV.example/hf' } },
  ]) {
    await assert.rejects(
      client(value).huggingfaceAccess('session_fixture', 'runner_fixture', 'host_fixture'),
      (error: Error) => {
        assert.ok(!String(error).includes(marker));
        return error instanceof RunnerControlError && error.code === 'invalid_control_response';
      },
    );
  }
});

test('private native MCP response is host-bound, validated and separate from public session data', async () => {
  const connection = {
    name: 'sandboxes',
    url: 'https://sandbox.example/mcp',
    bearer: 'sbxt_' + 'PrivateMarker'.repeat(4),
  };
  const seen: unknown[] = [];
  const runner = new RunnerClient(
    'https://merv.example',
    'project_fixture',
    bearer,
    async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json(
        String(url).endsWith('/attach')
          ? { session: session(), launchConnections: true, prompt: 'Worker prompt.' }
          : { connections: [connection] },
      );
    },
  );
  const attached = await runner.attach('session_fixture', heartbeat.runnerId, 'launch_fixture');
  assert.ok(!JSON.stringify(attached).includes(connection.bearer));
  assert.deepEqual(
    await runner.launchConnections('session_fixture', heartbeat.runnerId, 'launch_fixture'),
    [connection],
  );
  assert.deepEqual(seen[1], {
    url: 'https://merv.example/sessions/session_fixture/launch-connections',
    body: { runnerId: heartbeat.runnerId, hostRef: 'launch_fixture' },
  });
  for (const value of [
    { connections: [connection, connection] },
    { connections: [{ ...connection, name: 'merv' }] },
    { connections: [{ ...connection, bearer: connection.bearer + '\n' }] },
    { connections: [], unexpected: connection.bearer },
  ])
    await assert.rejects(
      client(value).launchConnections('session_fixture', heartbeat.runnerId, 'launch_fixture'),
      (error: any) =>
        error.code === 'invalid_control_response' && !String(error).includes(connection.bearer),
    );
});
