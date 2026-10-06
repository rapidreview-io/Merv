import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import {
  WorkspaceDeferred,
  type CodeCommitCommand,
  type WorkspaceDriverFactory,
  type WorkspaceHandle,
} from '@merv/contracts';
import type { MachineRunner } from '@merv/runner';
import {
  ended,
  launchId,
  machine,
  metadata,
  node,
  offer,
  Refusal,
  server,
  until,
  type Body,
} from './fixtures/runner-stand-in.js';

// One settle path: every ended launch is released once, then its checkout is captured,
// reported and closed, and a launch that owes nothing more is never read by a tick again.

const live = 'setInterval(()=>{},1000)';
const counted = ['crash_loop', 'host_failed'];
const codex = {
  name: 'codex',
  harness: 'codex' as const,
  executable: process.execPath,
  isolatedLauncher: process.execPath,
  enabled: true,
  parallelism: 1,
};
/** Hands out each session once, then nothing. */
const once = (...sessions: Body[]) => {
  const queue = [...sessions];
  return () => queue.shift() ?? null;
};
/** An ended launch an earlier controller left owing its release, with its session still live. */
function seed(
  f: ReturnType<typeof machine>,
  fake: ReturnType<typeof server>,
  name: string,
  end: Parameters<typeof ended>[2],
  extra: Body = {},
) {
  const ledger = f.ledger();
  const session: Body = { ...offer(name), runnerId: ledger.runnerId };
  const record = ledger.reserve({
    id: launchId(session.id),
    sessionId: session.id,
    deadline: Date.now() + 3_600_000,
    metadata: { platform: 'a', requestId: `request_${name}`, ...extra },
  });
  ledger.close();
  ended(f.config.directory, record.id, end);
  session.hostRef = record.id;
  fake.sessions.set(session.id, session);
  return session;
}
const open = (f: ReturnType<typeof machine>) => {
  const ledger = f.ledger();
  try {
    return ledger.open().map((record) => record.id);
  } finally {
    ledger.close();
  }
};
/** A driver whose checkouts are the machine's own directory, reporting `result` at capture. */
function driver(root: string, result = attachment) {
  const handles = new Map<string, WorkspaceHandle>();
  const calls: string[] = [];
  const factory: WorkspaceDriverFactory = {
    name: 'code.v2',
    create: () => ({
      get: (id) => handles.get(id),
      prepare: async (launch) => {
        const handle = { path: root, snapshot: attachment, retain: false, readOnly: false };
        handles.set(launch.id, { ...handle, status: 'ready' });
        return handles.get(launch.id)!;
      },
      capture: async (launch) => {
        calls.push('capture');
        Object.assign(handles.get(launch.id)!, { status: 'captured', snapshot: result });
        return result;
      },
      close: async (launch) => {
        calls.push('close');
        handles.get(launch.id)!.status = 'closed';
      },
      dispose: () => {},
    }),
  };
  return { factory, calls, handles };
}
const attachment = {
  repositoryId: 'repository_fixture',
  workspaceId: 'workspace_fixture',
  mode: 'ephemeral' as const,
  branch: null,
  baseOid: '1'.repeat(40),
  headOid: '1'.repeat(40),
  stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
};
const checkout = { mode: 'ephemeral', namespace: 'n', retain: false, driver: 'code.v2' };
const running = (runner: MachineRunner) =>
  until(runner, () => runner.snapshot().launches[0]?.status === 'running', 'a running worker');
const release = (fake: ReturnType<typeof server>, session: Body) =>
  fake.releases(session.id).at(-1)?.body;

test('a session the server no longer knows is stopped once and settled, freeing its capacity', async (t) => {
  const gone = offer('gone');
  const next = offer('next');
  const fake = server(once(gone, next));
  const f = machine(t, [node('a', live)], fake.fetch);
  const runner = f.make();
  await runner.start();
  await running(runner);
  fake.sessions.delete(gone.id);
  await runner.tick();
  assert.equal(runner.snapshot().launches[0].status, 'stopped');
  assert.equal(runner.snapshot().lastError, 'session_not_found');
  await runner.tick();
  assert.equal(fake.releases(gone.id).length, 0, 'nothing is released to a server that forgot it');
  assert.equal(fake.sessions.get(next.id)?.hostRef, launchId(next.id), 'its capacity is free');
  assert.deepEqual(open(f), [launchId(next.id)]);
});

test("a user's stop releases the launch it ended with no outcome", async (t) => {
  const work = offer('stop');
  const fake = server(once(work));
  const f = machine(t, [node('a', live)], fake.fetch);
  const runner = f.make();
  await runner.start();
  await running(runner);
  await runner.stop();
  assert.deepEqual(
    fake.releases(work.id).map((call) => call.body),
    [{ runnerId: runner.snapshot().runnerId, reason: 'local_process_controller_stopped' }],
  );
  assert.equal(fake.sessions.get(work.id)?.outcome, 'released');
  assert.equal(fake.sessions.get(work.id)?.closeReason, 'local_process_controller_stopped');
  assert.deepEqual(open(f), []);
});

test('a launch the guardian ended before a stop is released uncounted, even by the next controller', async (t) => {
  let refused = true;
  const fake = server(
    () => null,
    undefined,
    (path) => (refused && path.endsWith('/release') ? new Refusal(503, 'state_busy') : undefined),
  );
  const f = machine(t, [node('a')], fake.fetch);
  const session = seed(f, fake, 'external', { reason: 'external_stop' });
  const first = f.make();
  await first.start();
  await first.stop();
  assert.equal(fake.releases(session.id).length, 2, 'refused while ticking and while stopping');
  assert.equal(metadata(f.config.directory, launchId(session.id)).runnerStopped, true);
  refused = false;
  await f.make().start();
  assert.equal(release(fake, session)?.outcome, undefined);
  assert.equal(release(fake, session)?.reason, 'local_process_external_stop');
});

test("a hosted runner's stop, and an ending that only races a stop, stay counted", async (t) => {
  let refused = true;
  const refuse = (path: string) =>
    refused && path.endsWith('/release') ? new Refusal(503, 'state_busy') : undefined;
  // A clock a minute ahead: these launches did not crash on start.
  const clock = () => Date.now() + 60_000;
  const hosted = server(() => null, undefined, refuse);
  const h = machine(t, [codex], hosted.fetch, {
    config: { workInstanceId: 'instance_evicted', capacity: 1 },
    resetAssignment: async () => {},
    clock,
  });
  const assignments = join(realpathSync(h.root), 'assignments');
  mkdirSync(assignments, { mode: 0o700 });
  h.config.assignmentWorkspaceDirectory = assignments;
  const evicted = seed(
    h,
    hosted,
    'evicted',
    { reason: 'external_stop' },
    { session: offer('evicted') },
  );
  const own = h.make();
  await own.start();
  refused = false;
  await own.stop();
  assert.equal(release(hosted, evicted)?.outcome, 'host_failed');
  assert.equal(metadata(h.config.directory, launchId(evicted.id)).runnerStopped, undefined);

  refused = true;
  const user = server(() => null, undefined, refuse);
  const u = machine(t, [node('a')], user.fetch, { clock });
  const crashed = seed(u, user, 'crashed', { status: 'exited', reason: null, exitCode: 1 });
  const runner = u.make();
  await runner.start();
  refused = false;
  await runner.stop();
  assert.equal(release(user, crashed)?.outcome, 'host_failed');
  assert.equal(release(user, crashed)?.reason, 'local_process_exit_code_1');
});

test('a deadline halt keeps its counted outcome when a stop overtakes its release', async (t) => {
  const work = offer('late');
  let skew = 0,
    offline = false;
  const fake = server(once(work), undefined, (path) =>
    offline && path === '/sessions/runners/heartbeat' ? new Refusal(503, 'state_busy') : undefined,
  );
  const f = machine(t, [node('a', live)], fake.fetch, { clock: () => Date.now() + skew });
  const runner = f.make();
  await runner.start();
  await running(runner);
  skew = 2 * 3_600_000;
  offline = true;
  await runner.tick();
  assert.equal(runner.snapshot().state, 'offline');
  assert.equal(runner.snapshot().launches[0].status, 'stopped');
  await runner.stop();
  assert.equal(release(fake, work)?.outcome, 'host_failed');
  assert.equal(release(fake, work)?.reason, 'local_process_controller_stopped');
});

test('presence and lease 401 halts stay counted', async (t) => {
  for (const route of ['/sessions/runners/heartbeat', '/sessions/lease']) {
    const work = offer(route.endsWith('lease') ? 'lease' : 'presence');
    let revoked = false;
    const fake = server(
      (body) => (body.platform.name === 'a' ? work : null),
      undefined,
      (path, body) =>
        revoked && path === route && (route.endsWith('heartbeat') || body?.platform.name === 'b')
          ? new Refusal(401, 'unauthorized')
          : undefined,
    );
    let skew = 60_000;
    const f = machine(t, [node('a', live), node('b')], fake.fetch, {
      config: { capacity: 2 },
      clock: () => Date.now() + skew,
    });
    const runner = f.make();
    await runner.start();
    await running(runner);
    revoked = true;
    skew += 15_000; // presence is due again, and b's decline is backed off no longer
    await runner.tick();
    assert.equal(runner.snapshot().state, 'unauthorized', route);
    assert.equal(runner.snapshot().launches[0].status, 'stopped', route);
    revoked = false;
    await runner.tick();
    assert.equal(release(fake, work)?.outcome, 'host_failed', route);
    assert.equal(release(fake, work)?.reason, 'local_process_controller_stopped', route);
  }
});

test('a release is retried until answered, and a final refusal is recorded once', async (t) => {
  const work = offer('refused');
  const answers: (Refusal | Error)[] = [
    new Refusal(503, 'state_busy'),
    new Refusal(429, 'rate_limited'),
    new TypeError('lost'),
    new Refusal(409, 'transaction_conflict'),
    new Refusal(400, 'invalid_release'),
  ];
  const fake = server(once(work), undefined, (path) => {
    if (!path.endsWith('/release')) return undefined;
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const f = machine(t, [node('a')], fake.fetch);
  const runner = f.make();
  await runner.start();
  await until(runner, () => fake.releases(work.id).length === 1, 'the first release');
  for (let i = 2; i <= 5; i++) {
    await runner.tick();
    assert.equal(fake.releases(work.id).length, i);
  }
  assert.equal(runner.snapshot().lastError, 'invalid_release');
  assert.deepEqual(open(f), []);
  await runner.tick();
  assert.equal(fake.releases(work.id).length, 5, 'never replayed');
});

test('a failed writer is released first, then its result is reported and its checkout closed', async (t) => {
  const work = offer('writer', { workspace: checkout });
  let failing = true;
  const fake = server(once(work), undefined, (path) =>
    failing && path.endsWith('/workspace-result') ? new Refusal(503, 'state_busy') : undefined,
  );
  const f = machine(t, [node('a', 'process.exit(1)')], fake.fetch);
  const stub = driver(f.root, { ...attachment, headOid: '2'.repeat(40) });
  const runner = f.make([stub.factory]);
  await runner.start();
  await until(runner, () => fake.releases(work.id).length === 1, 'the release');
  await runner.tick();
  const paths = fake.calls.map((call) => call.path);
  assert.ok(
    paths.indexOf(`/sessions/${work.id}/release`) <
      paths.indexOf(`/sessions/${work.id}/workspace-result`),
    'released before the result',
  );
  assert.equal(release(fake, work)?.outcome, 'crash_loop');
  // A hosted supervisor keeps waiting while the result is owed.
  const [launch] = runner.snapshot().launches;
  assert.equal(launch.releasePending, false);
  assert.deepEqual(launch.workspace, {
    status: 'captured',
    headOid: '2'.repeat(40),
    capturePending: true,
  });
  failing = false;
  await runner.tick();
  assert.equal(fake.sessions.get(work.id)?.workspace.result.headOid, '2'.repeat(40));
  assert.equal(runner.snapshot().launches[0].workspace?.capturePending, false);
  assert.deepEqual(stub.calls.slice(-1), ['close']);
  assert.deepEqual(open(f), []);
});

test('a workspace result refused for good is recorded once and the checkout still closes', async (t) => {
  const work = offer('conflict', { workspace: checkout });
  const fake = server(once(work), undefined, (path) =>
    path.endsWith('/workspace-result') ? new Refusal(409, 'workspace_result_conflict') : undefined,
  );
  const f = machine(t, [node('a')], fake.fetch);
  const stub = driver(f.root);
  const runner = f.make([stub.factory]);
  await runner.start();
  await until(runner, () => stub.calls.includes('close'), 'the closed checkout');
  assert.equal(runner.snapshot().lastError, 'workspace_result_conflict');
  const results = () => fake.calls.filter((call) => call.path.endsWith('/workspace-result'));
  assert.equal(results().length, 1);
  await runner.tick();
  assert.equal(results().length, 1, 'never replayed');
});

test('a deferral in words the release route refuses is released as the default deferral', async (t) => {
  const work = offer('deferred', { workspace: checkout });
  const fake = server(once(work));
  const f = machine(t, [node('a')], fake.fetch);
  const stub = driver(f.root);
  const factory: WorkspaceDriverFactory = {
    name: 'code.v2',
    create: (host, transport) => ({
      ...stub.factory.create(host, transport),
      prepare: async () => {
        throw new WorkspaceDeferred('Store Busy', 'code-store-full');
      },
    }),
  };
  const runner = f.make([factory]);
  await runner.start();
  assert.equal(release(fake, work)?.outcome, 'preparation_deferred');
  assert.deepEqual(release(fake, work)?.deferral, {
    cause: 'code_unavailable',
    code: 'workspace_deferred',
  });
});

test('a launch whose driver is not composed is released but settles only once it is back', async (t) => {
  const fake = server(() => null);
  const f = machine(t, [node('a')], fake.fetch);
  const session = seed(f, fake, 'driverless', {}, { workspaceDriver: 'code.v2' });
  const first = f.make();
  await first.start();
  assert.equal(fake.releases(session.id).length, 1);
  assert.equal(first.snapshot().state, 'degraded');
  assert.equal(first.snapshot().lastError, 'workspace_driver_missing');
  await first.tick();
  assert.equal(fake.releases(session.id).length, 1, 'released once');
  await first.stop();
  assert.deepEqual(open(f), [launchId(session.id)]);
  const back = f.make([driver(f.root).factory]);
  await back.start();
  assert.equal(back.snapshot().state, 'idle');
  assert.deepEqual(open(f), []);
  assert.equal(fake.releases(session.id).length, 1);
});

test('a Code receipt refused with a retried code is kept and replayed on the next tick', async (t) => {
  let settled = false;
  const fake = server(
    () => null,
    undefined,
    (path) =>
      !settled && path === '/code/commands/complete'
        ? new Refusal(409, 'transaction_conflict')
        : undefined,
  );
  const acknowledged: string[] = [];
  let command: CodeCommitCommand | undefined;
  // The stand-in knows no Code route; once settled, it answers the completion as Code would.
  const fetcher: typeof fetch = async (input, init) => {
    const reply = await fake.fetch(input as string, init);
    if (!settled || !String(input).endsWith('/code/commands/complete')) return reply;
    return Response.json({
      operation: { command, status: 'failed', receipt: null, error: 'workspace_stopped' },
    });
  };
  const f = machine(t, [node('a')], fetcher);
  const session = seed(f, fake, 'receipt', {}, { workspaceDriver: 'code.v2' });
  session.workspace = { attachment, result: null };
  const id = launchId(session.id);
  command = {
    id: 'command_receipt',
    projectId: session.projectId,
    sessionId: session.id,
    actorId: session.actorId,
    instanceId: session.instanceId,
    expectedRevision: 0,
    runnerId: session.runnerId,
    hostRef: id,
    workspace: attachment,
    expectedHead: attachment.headOid,
    message: 'Checkpoint',
    createdAt: '2026-09-15T00:00:00.000Z',
  };
  const stub = driver(f.root);
  const handle = { path: f.root, snapshot: attachment, retain: false, readOnly: false };
  stub.handles.set(id, { ...handle, status: 'ready' });
  const factory: WorkspaceDriverFactory = {
    name: 'code.v2',
    create: (host, transport) => ({
      ...stub.factory.create(host, transport),
      checkpointCommit: async () => assert.fail('its outcome is already proven'),
      pendingCommits: () => (acknowledged.length ? [] : [command!]),
      commitOutcome: () => ({ error: 'workspace_stopped' }),
      acknowledgeCommit: (commandId: string) => acknowledged.push(commandId),
    }),
  };
  const completions = () => fake.calls.filter((call) => call.path === '/code/commands/complete');
  const runner = f.make([factory]);
  await runner.start();
  assert.equal(completions().length, 1);
  assert.equal(runner.snapshot().lastError, 'transaction_conflict');
  assert.deepEqual(acknowledged, [], 'a retried refusal is not an answer');
  await runner.tick();
  assert.equal(completions().length, 2, 'replayed on the next tick');
  assert.deepEqual(acknowledged, []);
  assert.deepEqual(open(f), [id]);
  settled = true;
  await runner.tick();
  assert.equal(completions().length, 3);
  assert.deepEqual(acknowledged, ['command_receipt']);
  assert.deepEqual(open(f), []);
});

test('a final presence refusal keeps supervising launches and stops leasing', async (t) => {
  const work = offer('limited');
  let limited = false;
  const fake = server(once(work), undefined, (path) =>
    limited && path === '/sessions/runners/heartbeat'
      ? new Refusal(409, 'runner_limit')
      : undefined,
  );
  let skew = 0;
  const f = machine(t, [node('a', live, 2)], fake.fetch, { clock: () => Date.now() + skew });
  const runner = f.make();
  await runner.start();
  limited = true;
  const before = fake.calls.length;
  fake.sessions.get(work.id)!.status = 'released';
  skew += 15_000; // presence is due again
  await runner.tick();
  const paths = fake.calls.slice(before).map((call) => call.path);
  assert.ok(paths.includes(`/sessions/${work.id}`), 'the launch is reconciled');
  assert.ok(!paths.includes('/sessions/lease'), 'nothing is leased');
  assert.equal(runner.snapshot().launches[0].status, 'stopped');
  assert.equal(runner.snapshot().state, 'degraded');
  assert.equal(runner.snapshot().lastError, 'runner_limit');
});

/** Launch history as an earlier runner left it: `count` ended rows owing nothing. */
function history(t: TestContext, count: number, settled: boolean) {
  const fake = server(() => null);
  const f = machine(t, [node('a')], fake.fetch);
  f.ledger().close();
  const db = new DatabaseSync(join(f.config.directory, 'ledger.sqlite'));
  // A ledger from before the column existed, which the next runner upgrades.
  if (!settled) db.exec('DROP INDEX launches_open; ALTER TABLE launches DROP COLUMN settled');
  const insert = db.prepare(
    `INSERT INTO launches(id,session_id,fingerprint,deadline,metadata_json,status,created_at,updated_at,run_directory${settled ? ',settled' : ''})
     VALUES(?,?,'',?,?,'exited',?,?,?${settled ? ',1' : ''})`,
  );
  const done = JSON.stringify({ remoteClosed: true, usageReported: true });
  db.exec('BEGIN');
  for (let i = 0; i < count; i++)
    insert.run(`launch_${i}`, `session_${i}`, 1, done, i, i, join(f.root, `run_${i}`));
  db.exec('COMMIT');
  db.close();
  return { fake, f };
}

test('open launches are read through an index that skips settled history', async (t) => {
  const { fake, f } = history(t, 1000, true);
  const runner = f.make();
  await runner.start();
  await runner.tick();
  const ledger = f.ledger();
  t.after(() => ledger.close());
  const started = performance.now();
  assert.deepEqual(ledger.open(), []);
  assert.ok(performance.now() - started < 5, 'reading open launches ignores history');
  const db = new DatabaseSync(join(f.config.directory, 'ledger.sqlite'));
  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT * FROM launches WHERE settled=0 ORDER BY created_at,id')
    .all();
  db.close();
  assert.ok(plan.some((row) => String(row.detail).includes('launches_open')));
  assert.equal(
    fake.calls.filter((call) => call.path.startsWith('/sessions/session_')).length,
    0,
    'no tick asks about a settled launch',
  );
  assert.equal(runner.snapshot().launches.length, 1000, 'summaries still list every launch');
});

test('the first tick after an upgrade settles finished history at once', async (t) => {
  const { fake, f } = history(t, 1000, false);
  const runner = f.make();
  await runner.start();
  assert.deepEqual(open(f), []);
  assert.equal(runner.snapshot().state, 'idle');
  assert.equal(
    fake.calls.filter((call) => call.path.startsWith('/sessions/session_')).length,
    0,
    'history that owed nothing is settled without a call',
  );
});
