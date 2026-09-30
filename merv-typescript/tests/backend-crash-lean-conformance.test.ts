/**
 * Linux/macOS Node SIGKILL + real PostgreSQL, at acknowledged IO boundaries.
 * Checks application-process death, disconnect rollback, writer-lock release, stable-ID
 * restart, and committed data discovery. PostgreSQL itself remains running: this is not
 * a database/power-loss, fsync, network-partition, or exactly-once remote-effect claim.
 * The postcommit cut is at State's API reply, not inside the PostgreSQL wire protocol.
 * Lean supplies selected durable snapshots; this is finite conformance, not refinement.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '@merv/contracts';
import { DurableEvents } from '@merv/domain-events';
import type { PostgresState } from '@merv/state';
import { openState, schemaFor } from './fixtures/state.js';
import { barrierWorker, deadline } from './fixtures/process-barrier.js';
import type {
  CrashEvidence,
  CrashPoint,
  CrashResult,
  CrashRole,
} from './fixtures/backend-crash-worker.js';

const binary = fileURLToPath(
  new URL('../verification/lean/.lake/build/bin/backend_events_model', import.meta.url),
);
const options = {
  skip:
    process.platform === 'win32'
      ? 'Requires POSIX SIGKILL (Linux/macOS)'
      : !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
        ? 'Build backend_events_model'
        : undefined,
  timeout: 30_000,
};
type Command = { kind: string; wanted?: boolean; fromNow?: boolean; ticket?: number };
type Durable = {
  head: number;
  events: number[];
  records: number[];
  effects: number[];
  cursor: number;
  attempts: number;
  retryAt: number;
};
type View = Durable & { external: number[] };
const publish: Command = { kind: 'publish', wanted: true };
const subscribe: Command = { kind: 'subscribe', fromNow: false };
const drain: Command = { kind: 'drain' };
const crash: Command = { kind: 'crash' };

function model(commands: Command[]): View[] {
  // Regular files avoid the macOS synchronous-pipe stalls documented by the existing oracle.
  const directory = mkdtempSync(join(tmpdir(), 'merv-crash-oracle-'));
  writeFileSync(join(directory, 'input.json'), JSON.stringify({ commands }));
  const stdin = openSync(join(directory, 'input.json'), 'r');
  const stdout = openSync(join(directory, 'output.json'), 'w');
  try {
    const child = spawnSync(binary, [], {
      stdio: [stdin, stdout, 'pipe'],
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr || String(child.error ?? child.signal));
    return JSON.parse(readFileSync(join(directory, 'output.json'), 'utf8')).observations;
  } finally {
    closeSync(stdin);
    closeSync(stdout);
    rmSync(directory, { recursive: true, force: true });
  }
}
function project(view: View): Durable {
  const { head, events, records, effects, cursor, attempts, retryAt } = view;
  return { head, events, records, effects, cursor, attempts, retryAt };
}
async function durable(state: PostgresState): Promise<Durable> {
  return state.snapshot(async () => {
    const ids = async (table: string, column: string) =>
      (
        await state.read((sql) =>
          sql.all<{ id: number }>(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`),
        )
      ).map((row) => row.id);
    const progress = await state.read((sql) =>
      sql.get<{ cursor: number; attempts: number; retryAt: number }>(
        'SELECT cursor, attempts, retry_at AS "retryAt" FROM event_consumers WHERE id=\'worker\'',
      ),
    );
    return {
      head: await state.eventHead(),
      events: await ids('events', 'id'),
      records: await ids('publisher_rows', 'event'),
      effects: await ids('local_effects', 'event'),
      cursor: progress?.cursor ?? 0,
      attempts: progress?.attempts ?? 0,
      retryAt: progress?.retryAt ?? 0,
    };
  });
}
async function fixture(t: TestContext) {
  const schema = schemaFor();
  // Every observation uses a pool independent of the child. All fixture DDL uses real migrations.
  const observer = await openState(':memory:', {
    schema,
    maxConnections: 1,
    readConnections: 1,
    connectionTimeoutMs: 5000,
    statementTimeoutMs: 5000,
    lockTimeoutMs: 5000,
  });
  t.after(() => deadline(observer.close(), 'observer pool cleanup', 5000));
  await observer.migrate('crash_probe', [
    {
      version: 1,
      // No uniqueness guard: a repeated local effect must show up as an extra row.
      sql: 'CREATE TABLE publisher_rows(event BIGINT); CREATE TABLE local_effects(event BIGINT);',
    },
  ]);
  const events = await createService(new DurableEvents(observer));
  await events.close();
  return {
    observer,
    worker(role: CrashRole, point: CrashPoint = 'none') {
      return barrierWorker<CrashEvidence, CrashResult>(
        t,
        new URL('./fixtures/backend-crash-worker.ts', import.meta.url),
        [schema, role, point],
      );
    },
  };
}

async function activity(state: PostgresState, pid: number) {
  return state.read((sql) =>
    sql.get<{ state: string; inTransaction: boolean; wait: string | null }>(
      `SELECT state, xact_start IS NOT NULL AS "inTransaction", wait_event AS wait
       FROM pg_catalog.pg_stat_activity WHERE pid=?`,
      pid,
    ),
  );
}
async function assertBarrier(
  observer: PostgresState,
  evidence: CrashEvidence,
  role: CrashRole,
  point: CrashPoint,
  pid: number | undefined,
) {
  assert.equal(evidence.pid, pid);
  assert.equal(evidence.role, role);
  assert.equal(evidence.point, point);
  assert.equal(evidence.eventId, 1);
  assert.equal(evidence.records, 1, 'worker read its actual publisher INSERT');
  assert.equal(
    evidence.effects,
    role === 'consume' ? 1 : 0,
    'worker read its actual effect INSERT',
  );
  assert.equal(evidence.cursor, 0, 'the staged read precedes the dispatcher cursor update');
  assert.deepEqual(
    await activity(observer, evidence.backendPid),
    {
      state: point === 'before-commit' ? 'idle in transaction' : 'idle',
      inTransaction: point === 'before-commit',
      wait: 'ClientRead',
    },
    'PostgreSQL confirms the held transaction or completed COMMIT before SIGKILL',
  );
}
async function poll(check: () => Promise<boolean>, label: string) {
  // A delay only paces observation; successful SQL predicates, never elapsed time, order the test.
  const stop = Date.now() + 5000;
  do {
    if (await check()) return;
    await delay(20);
  } while (Date.now() < stop);
  assert.fail(`Timed out polling ${label}`);
}
async function disconnected(observer: PostgresState, evidence: CrashEvidence) {
  await poll(
    async () => !(await activity(observer, evidence.backendPid)),
    'killed child backend removal',
  );
}

for (const point of ['before-commit', 'after-commit'] as const) {
  test(
    `backend crash: SIGKILL publisher ${point} preserves Lean publication atomicity`,
    options,
    async (t) => {
      const f = await fixture(t);
      const worker = f.worker('publish', point);
      const evidence = await worker.barrier();
      await assertBarrier(f.observer, evidence, 'publish', point, worker.pid);
      const prefix: Command[] = [{ kind: 'beginPublish', wanted: true }];
      if (point === 'after-commit') prefix.push({ kind: 'commit', ticket: 1 });
      assert.deepEqual(await durable(f.observer), project(model(prefix).at(-1)!));
      await worker.kill();
      await disconnected(f.observer, evidence);
      prefix.push(crash);
      assert.deepEqual(await durable(f.observer), project(model(prefix).at(-1)!));

      // A new process acquires the released writer lock; an aborted allocation leaves a real gap.
      const next = await f.worker('publish').completed();
      assert.deepEqual(next.published, [2]);
      const recovered = await f.worker('consume').completed();
      const expected = model([...prefix, publish, subscribe, drain]).at(-1)!;
      assert.deepEqual(await durable(f.observer), project(expected));
      assert.deepEqual(recovered.handled, expected.external);
      assert.deepEqual((await f.worker('consume').completed()).handled, []);
      assert.deepEqual(await durable(f.observer), project(expected));
    },
  );

  test(
    `backend crash: SIGKILL consumer ${point} recovers exactly one local durable effect`,
    options,
    async (t) => {
      const f = await fixture(t);
      assert.deepEqual((await f.worker('publish').completed()).published, [1]);
      const worker = f.worker('consume', point);
      const evidence = await worker.barrier();
      await assertBarrier(f.observer, evidence, 'consume', point, worker.pid);
      const prefix: Command[] = [publish, subscribe, { kind: 'beginDelivery' }];
      if (point === 'after-commit') prefix.push({ kind: 'commit', ticket: 2 });
      assert.deepEqual(await durable(f.observer), project(model(prefix).at(-1)!));
      await worker.kill();
      await disconnected(f.observer, evidence);
      prefix.push(crash);
      assert.deepEqual(await durable(f.observer), project(model(prefix).at(-1)!));

      const recovered = await f.worker('consume').completed();
      const expected = model([...prefix, subscribe, drain]).at(-1)!;
      assert.deepEqual(recovered.handled, point === 'before-commit' ? [1] : []);
      assert.deepEqual([evidence.eventId, ...recovered.handled], expected.external);
      assert.deepEqual(await durable(f.observer), project(expected));
      // Prove the restarted dispatcher can do new work, not merely skip everything.
      await f.worker('publish').completed();
      assert.deepEqual((await f.worker('consume').completed()).handled, [2]);
      const continued = model([...prefix, subscribe, drain, publish, drain]).at(-1)!;
      assert.deepEqual(await durable(f.observer), project(continued));
      assert.deepEqual((await f.worker('consume').completed()).handled, []);
      assert.deepEqual(await durable(f.observer), project(continued));
    },
  );

  test(
    `backend crash control: ${point} barriers permit normal publisher and consumer completion`,
    options,
    async (t) => {
      const f = await fixture(t);
      for (const role of ['publish', 'consume'] as const) {
        const worker = f.worker(role, point);
        await assertBarrier(f.observer, await worker.barrier(), role, point, worker.pid);
        assert.deepEqual(await worker.resume(), {
          published: role === 'publish' ? [1] : [],
          handled: role === 'consume' ? [1] : [],
        });
        assert.deepEqual(
          await durable(f.observer),
          project(model(role === 'publish' ? [publish] : [publish, subscribe, drain]).at(-1)!),
        );
      }
    },
  );
}

test(
  'backend crash: independent dispatcher polling discovers publication after the publisher dies before reply',
  options,
  async (t) => {
    const f = await fixture(t);
    const publisher = f.worker('publish', 'after-commit');
    const evidence = await publisher.barrier();
    await assertBarrier(f.observer, evidence, 'publish', 'after-commit', publisher.pid);
    await publisher.kill();
    await disconnected(f.observer, evidence);

    const events = await createService(new DurableEvents(f.observer));
    t.after(() => deadline(events.close(), 'polling dispatcher cleanup'));
    await events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(event, tx) {
        await tx.run('INSERT INTO local_effects VALUES(?)', event.id);
      },
    });
    await events.drain();
    assert.deepEqual(
      await durable(f.observer),
      project(model([publish, crash, subscribe, drain]).at(-1)!),
    );

    // No local State notification: the real 100ms safety timer must discover this other process.
    await f.worker('publish').completed();
    await poll(async () => (await durable(f.observer)).cursor === 2, 'independent safety poll');
    assert.deepEqual(
      await durable(f.observer),
      project(model([publish, crash, subscribe, drain, publish, drain]).at(-1)!),
    );
    await events.close();
  },
);
