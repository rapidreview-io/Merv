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
import { createService, type Transaction } from '@merv/contracts';
import { DurableEvents } from '@merv/domain-events';
import type { PostgresState } from '@merv/state';
import { openState, schemaFor } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

const binary = fileURLToPath(
  new URL('../verification/lean/.lake/build/bin/backend_events_model', import.meta.url),
);
const lean = {
  skip:
    !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build backend_events_model'
      : undefined,
  timeout: 15_000,
};
type Command = {
  kind: string;
  ticket?: number;
  wanted?: boolean;
  fromNow?: boolean;
  observed?: number;
  elapsed?: number;
  abort?: boolean;
  fail?: boolean;
};
type View = {
  allocated: number;
  head: number;
  cursor: number;
  baseline: number;
  attempts: number;
  retryAt: number;
  clock: number;
  serial: number;
  active: boolean;
  registered: boolean;
  events: number[];
  records: number[];
  effects: number[];
  external: number[];
};
function model(commands: Command[]): View[] {
  const directory = mkdtempSync(join(tmpdir(), 'merv-events-oracle-'));
  writeFileSync(join(directory, 'input.json'), JSON.stringify({ commands }));
  const stdin = openSync(join(directory, 'input.json'), 'r');
  const stdout = openSync(join(directory, 'output.json'), 'w');
  try {
    const child = spawnSync(binary, [], {
      stdio: [stdin, stdout, 'pipe'],
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr || String(child.error ?? child.signal));
    return JSON.parse(readFileSync(join(directory, 'output.json'), 'utf8')).observations;
  } finally {
    closeSync(stdin);
    closeSync(stdout);
    rmSync(directory, { recursive: true, force: true });
  }
}
const event = (wanted = true) => ({
  projectId: 'p',
  actorId: 'a',
  subjectId: 's',
  type: wanted ? 'probe.wanted' : 'probe.noise',
  data: {},
});
async function fixture(t: TestContext, manual = true) {
  const schema = schemaFor();
  const state = await openState(':memory:', { schema });
  const other = await openState(':memory:', { schema });
  await state.migrate('events_probe', [
    {
      version: 1,
      sql: 'CREATE TABLE publisher_rows(event BIGINT); CREATE TABLE local_effects(event BIGINT);',
    },
  ]);
  const states = [state, other],
    dispatchers: DurableEvents[] = [];
  async function dispatcher(owner = state) {
    const events = await createService(new DurableEvents(owner));
    if (manual) {
      // Control scheduling only; every drain/transaction/SQL statement remains production code.
      Object.defineProperty(events, 'scheduleWake', { value: () => {} });
      await events.drain();
    }
    dispatchers.push(events);
    return events;
  }
  const events = await dispatcher();
  t.after(async () => {
    await Promise.all(dispatchers.map((e) => e.close()));
    await Promise.all(states.map((s) => s.close()));
  });
  return {
    state,
    other,
    events,
    schema,
    dispatcher,
    async reopen() {
      const reopened = await openState(':memory:', { schema });
      states.push(reopened);
      return reopened;
    },
  };
}
async function publish(state: PostgresState, wanted = true, abort = false) {
  return state.transaction(async (tx) => {
    const e = await state.appendEvent(tx, event(wanted));
    await tx.run('INSERT INTO publisher_rows VALUES(?)', e.id);
    if (abort) throw new Error('publisher abort');
    return e;
  });
}
async function durable(state: PostgresState) {
  return state.snapshot(async () => ({
    head: await state.eventHead(),
    events: (
      await state.read((sql) => sql.all<{ id: number }>('SELECT id FROM events ORDER BY id'))
    ).map((r) => r.id),
    records: (
      await state.read((sql) =>
        sql.all<{ event: number }>('SELECT event FROM publisher_rows ORDER BY event'),
      )
    ).map((r) => r.event),
    effects: (
      await state.read((sql) =>
        sql.all<{ event: number }>('SELECT event FROM local_effects ORDER BY event'),
      )
    ).map((r) => r.event),
    cursor:
      (
        await state.read((sql) =>
          sql.get<{ cursor: number }>("SELECT cursor FROM event_consumers WHERE id='worker'"),
        )
      )?.cursor ?? 0,
  }));
}
function project(v: View) {
  return {
    head: v.head,
    events: v.events,
    records: v.records,
    effects: v.effects,
    cursor: v.cursor,
  };
}

// This regression intentionally runs without the oracle as well: the first post-scope
// timer poll is an explicit barrier, so it cannot pass by a later notification repairing it.
test(
  'backend events: a drain in a plain read does not poison subsequent background polls',
  { timeout: 5000 },
  async (t) => {
    const { state, other, events } = await fixture(t, false);
    const handled = deferred();
    await events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
        handled.resolve();
      },
    });
    await events.drain(); // Join the registration wakeup before starting a new pass in this read.
    await state.read(() => events.drain());
    const poll = deferred<string | undefined>();
    const read = state.read.bind(state);
    state.read = async (fn) => {
      try {
        const value = await read(fn);
        poll.resolve(undefined);
        return value;
      } catch (error) {
        poll.resolve((error as { code?: string }).code);
        throw error;
      }
    };
    t.after(() => {
      state.read = read;
    });
    await publish(other); // No local State notification: only the safety poll can deliver.
    assert.equal(await poll.promise, undefined);
    await handled.promise;
    await events.drain();
    assert.deepEqual((await durable(other)).effects, [1]);
  },
);

const pub = (wanted = true, abort = false): Command => ({ kind: 'publish', wanted, abort });
const sub = (fromNow = false): Command => ({ kind: 'subscribe', fromNow });
const drain = (fail = false): Command => ({ kind: 'drain', fail });
const tick = (elapsed: number): Command => ({ kind: 'tick', elapsed });

async function executeTrace(t: TestContext, commands: Command[]) {
  const f = await fixture(t);
  let state = f.state,
    events = f.events,
    detach: (() => void | Promise<void>) | undefined;
  let fail = false,
    clock = 1_000_000;
  const external: number[] = [];
  t.mock.method(Date, 'now', () => clock);
  const expected = model(commands);
  for (const [index, c] of commands.entries()) {
    switch (c.kind) {
      case 'publish':
        if (c.abort) await assert.rejects(publish(state, c.wanted, true), /publisher abort/);
        else await publish(state, c.wanted);
        break;
      case 'subscribe':
        detach = await events.subscribe({
          id: 'worker',
          types: ['probe.wanted'],
          from: c.fromNow ? 'now' : 'beginning',
          async handle(e, tx) {
            external.push(e.id); // A network-like attempt is intentionally outside SQL rollback.
            await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
            if (fail) throw new Error('handler abort');
          },
        });
        break;
      case 'detach':
        await detach?.();
        break;
      case 'drain':
        fail = c.fail ?? false;
        await events.drain();
        break;
      case 'tick':
        clock += c.elapsed!;
        break;
      case 'notification':
        await events.drain();
        break;
      case 'crash':
        await events.close();
        await state.close();
        state = await f.reopen();
        events = await f.dispatcher(state);
        break;
      default:
        assert.fail(`Unknown fixture action ${c.kind}`);
    }
    const actual = await durable(f.other);
    assert.deepEqual(
      actual,
      project(expected[index]!),
      `durable step ${index}: ${JSON.stringify(c)}`,
    );
    const status = (await events.status())[0];
    if (status) {
      const view = expected[index]!;
      assert.equal(status.active, view.active, `active step ${index}`);
      assert.equal(status.attempts, view.attempts, `attempts step ${index}`);
      assert.equal(
        status.retryAt ? status.retryAt - 1_000_000 : 0,
        view.retryAt,
        `retry step ${index}`,
      );
    }
    assert.deepEqual(
      [...external].sort((a, b) => a - b),
      expected[index]!.external,
      `external attempts step ${index}`,
    );
  }
}

test(
  'backend events: Lean conformance across publisher rollback, gaps, skip, retry boundary, unload, replacement and real State restart',
  lean,
  async (t) => {
    await executeTrace(t, [
      pub(true, true),
      pub(false),
      pub(true),
      pub(false, true),
      pub(true),
      sub(),
      drain(),
      drain(),
      { kind: 'detach' },
      pub(),
      pub(false),
      drain(),
      sub(true),
      drain(true),
      tick(99),
      drain(true),
      tick(1),
      drain(true),
      tick(199),
      drain(),
      tick(1),
      drain(),
      { kind: 'crash' },
      pub(true),
      sub(true),
      drain(),
      drain(),
    ]);
  },
);

test(
  'backend events: from-now installs a baseline, but reinstall from-now retains the durable cursor',
  lean,
  async (t) => {
    await executeTrace(t, [
      pub(),
      pub(false),
      pub(true, true),
      pub(),
      sub(true),
      drain(),
      pub(),
      drain(),
      { kind: 'detach' },
      pub(),
      sub(true),
      drain(),
    ]);
  },
);

test(
  'backend events: exponential backoff saturates, refuses early retries, and repaired delivery clears errors',
  lean,
  async (t) => {
    const commands = [pub(), sub()];
    for (const delay of [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 25600])
      commands.push(drain(true), tick(delay - 1), drain(true), tick(1));
    commands.push(drain(), { kind: 'crash' }, sub(), drain());
    await executeTrace(t, commands);
  },
);

async function waitForBlocked(state: PostgresState, holder: number) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const row = await state.read((sql) =>
      sql.get<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE NOT granted AND ? = ANY(pg_catalog.pg_blocking_pids(pid))',
        holder,
      ),
    );
    if (row!.n > 0) return;
    assert.ok(Date.now() < deadline, 'the second connection must reach the PostgreSQL writer lock');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test(
  'backend events: an uncommitted lower ID and rolled-back application row cannot be skipped by a concurrent writer/dispatcher',
  lean,
  async (t) => {
    const { state, other, events } = await fixture(t);
    await events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
      },
    });
    const staged = deferred<number>(),
      release = deferred();
    const first = state.transaction(async (tx) => {
      const pid = (await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
      const e = await state.appendEvent(tx, event());
      await tx.run('INSERT INTO publisher_rows VALUES(?)', e.id);
      staged.resolve(pid);
      await release.promise;
      throw new Error('publisher abort');
    });
    const aborted = assert.rejects(first, /publisher abort/);
    const pid = await staged.promise;
    let second: ReturnType<typeof publish> | undefined;
    try {
      second = publish(other);
      await waitForBlocked(other, pid);
      await events.drain();
      const before = model([sub(), { kind: 'beginPublish', wanted: true }]).at(-1)!;
      assert.deepEqual(await durable(other), project(before));
    } finally {
      release.resolve();
      await aborted;
    }
    await second;
    await events.drain();
    const after = model([
      sub(),
      { kind: 'beginPublish', wanted: true },
      { kind: 'abort', ticket: 1 },
      pub(),
      drain(),
    ]).at(-1)!;
    assert.deepEqual(await durable(other), project(after));
  },
);

for (const cut of ['before_effect', 'after_effect', 'after_cursor', 'lost_commit_reply'] as const) {
  test(
    `backend events: ${cut} leaves an atomic durable outcome and restart converges without duplicate effects`,
    lean,
    async (t) => {
      const f = await fixture(t);
      let clock = 1_000_000,
        faulted = false;
      t.mock.method(Date, 'now', () => clock);
      await publish(f.state);
      const external: number[] = [];
      let captured!: Transaction;
      await f.events.subscribe({
        id: 'worker',
        types: ['probe.wanted'],
        from: 'beginning',
        async handle(e, tx) {
          captured = tx;
          external.push(e.id);
          if (!faulted && cut === 'before_effect') {
            faulted = true;
            throw new Error(cut);
          }
          await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
          if (!faulted && cut === 'after_effect') {
            faulted = true;
            throw new Error(cut);
          }
        },
      });
      const transaction = f.state.transaction.bind(f.state);
      f.state.transaction = async (fn) => {
        let delivering = false;
        const value = await transaction(async (tx) => {
          const run = tx.run;
          tx.run = async (sql, ...args) => {
            const result = await run(sql, ...args);
            if (sql.startsWith('UPDATE event_consumers SET cursor=')) {
              delivering = true;
              if (!faulted && cut === 'after_cursor') {
                faulted = true;
                throw new Error(cut);
              }
            }
            return result;
          };
          return fn(tx);
        });
        // Fault at the acknowledged API boundary after a real successful SQL COMMIT.
        if (delivering && !faulted && cut === 'lost_commit_reply') {
          faulted = true;
          throw new Error(cut);
        }
        return value;
      };
      try {
        await f.events.drain();
      } finally {
        f.state.transaction = transaction;
      }
      assert.equal(faulted, true);
      const failure = cut !== 'lost_commit_reply';
      const prefix = [pub(), sub(), drain(failure)];
      const before = model(prefix).at(-1)!;
      assert.deepEqual(await durable(f.other), project(before));
      assert.equal((await f.events.status())[0]!.attempts, before.attempts);
      assert.deepEqual(external, before.external);
      // The same captured SQL object is unusable both outside and inside a new scope.
      await assert.rejects(captured.run('INSERT INTO local_effects VALUES(999)'), {
        code: 'transaction_closed',
      });
      await assert.rejects(f.state.appendEvent(captured, event()), { code: 'invalid_transaction' });
      await f.state.transaction(async () => {
        await assert.rejects(captured.get('SELECT 1'), { code: 'transaction_closed' });
      });
      await f.events.close();
      await f.state.close();
      clock += 100;
      const reopened = await f.reopen(),
        successor = await f.dispatcher(reopened);
      await successor.subscribe({
        id: 'worker',
        types: ['probe.wanted'],
        from: 'now',
        async handle(e, tx) {
          external.push(e.id);
          await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
        },
      });
      await successor.drain();
      await successor.drain();
      const after = model([
        ...prefix,
        { kind: 'crash' },
        tick(100),
        sub(true),
        drain(),
        drain(),
      ]).at(-1)!;
      assert.deepEqual(await durable(f.other), project(after));
      assert.deepEqual(external, after.external);
    },
  );
}

for (const mode of ['detach', 'close'] as const) {
  test(
    `backend events: ${mode} joins an admitted transaction and replacement retains progress`,
    lean,
    async (t) => {
      const f = await fixture(t);
      await publish(f.state);
      await publish(f.state);
      const entered = deferred<number>(),
        release = deferred();
      const oldCalls: number[] = [],
        newCalls: number[] = [];
      const dispose = await f.events.subscribe({
        id: 'worker',
        types: ['probe.wanted'],
        from: 'beginning',
        async handle(e, tx) {
          oldCalls.push(e.id);
          await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
          entered.resolve((await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid);
          await release.promise;
        },
      });
      const running = f.events.drain();
      const pid = await entered.promise;
      let joined = false;
      const withdrawing = Promise.resolve(mode === 'close' ? f.events.close() : dispose()).then(
        () => {
          joined = true;
        },
      );
      let replacement: Promise<() => void | Promise<void>> | undefined;
      const replacementInput = {
        id: 'worker',
        types: ['probe.wanted'],
        from: 'now' as const,
        async handle(e: { id: number }, tx: Transaction) {
          newCalls.push(e.id);
          await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
        },
      };
      try {
        assert.equal(joined, false);
        assert.deepEqual(
          await durable(f.other),
          project(
            model([pub(), pub(), sub(), { kind: 'beginDelivery' }, { kind: 'detach' }]).at(-1)!,
          ),
        );
        if (mode === 'detach') {
          replacement = f.events.subscribe(replacementInput);
          await waitForBlocked(f.other, pid);
          assert.equal(joined, false);
        }
      } finally {
        release.resolve();
      }
      await Promise.all([running, withdrawing, replacement]);
      assert.equal(joined, true);
      const successor = mode === 'close' ? await f.dispatcher() : f.events;
      if (mode === 'close') await successor.subscribe(replacementInput);
      await dispose(); // The retired disposer must not withdraw the replacement.
      await successor.drain();
      const expected = model([
        pub(),
        pub(),
        sub(),
        { kind: 'beginDelivery' },
        { kind: 'detach' },
        { kind: 'commit', ticket: 3 },
        sub(true),
        drain(),
      ]).at(-1)!;
      assert.deepEqual(await durable(f.other), project(expected));
      assert.deepEqual(oldCalls, [1]);
      assert.deepEqual(newCalls, [2]);
    },
  );
}

test(
  'backend events: delayed failed worker cannot overwrite another connection’s successful cursor with retry',
  lean,
  async (t) => {
    const f = await fixture(t),
      second = await f.dispatcher(f.other);
    const rolledBack = deferred(),
      release = deferred();
    const marker = new Error('failed worker');
    await publish(f.state);
    let attempts = 0;
    await f.events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        attempts++;
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
        throw marker;
      },
    });
    await second.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        attempts++;
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
      },
    });
    const transaction = f.state.transaction.bind(f.state);
    f.state.transaction = async (fn) => {
      try {
        return await transaction(fn);
      } catch (error) {
        if (error === marker) {
          rolledBack.resolve();
          await release.promise;
        }
        throw error;
      }
    };
    const running = f.events.drain();
    try {
      await rolledBack.promise;
      await second.drain();
    } finally {
      release.resolve();
      await running;
      f.state.transaction = transaction;
    }
    const expected = model([
      pub(),
      sub(),
      { kind: 'beginDelivery' },
      { kind: 'abort', ticket: 2 },
      { kind: 'beginDelivery' },
      { kind: 'commit', ticket: 3 },
      { kind: 'failure', observed: 0 },
    ]).at(-1)!;
    assert.deepEqual(await durable(f.other), project(expected));
    assert.equal((await second.status())[0]!.attempts, expected.attempts);
    assert.equal(attempts, expected.external.length);
    await Promise.all([f.events.drain(), second.drain()]);
    assert.deepEqual(await durable(f.other), project(expected));
  },
);

test(
  'backend events: a PostgreSQL connection terminated between handler queries rolls back and recovers without killing the process',
  lean,
  async (t) => {
    const f = await fixture(t);
    await publish(f.state);
    // A subprocess contains the historical unhandled pg Client error. The barrier is the
    // actual checked-out socket's end event, not a delay or a fabricated SQL exception.
    const code = `
    import { PostgresState } from '@merv/state';
    import { DurableEvents } from '@merv/domain-events';
    import { createService } from '@merv/contracts';
    const config = { connectionString: process.env.MERV_TEST_POSTGRES_URL, schema: process.env.MERV_EVENTS_SCHEMA, maxConnections:2, readConnections:2 };
    const state = await PostgresState.open(config), killer = await PostgresState.open(config);
    const events = await createService(new DurableEvents(state));
    Object.defineProperty(events, 'scheduleWake', { value: () => {} });
    await events.drain();
    const ends = new Map();
    state.pool.on('acquire', client => {
      if (!ends.has(client.processID)) ends.set(client.processID, new Promise(resolve => client.once('end',resolve)));
    });
    let clock = 1000000, killed = false;
    Date.now = () => clock;
    const external = [];
    await events.subscribe({ id:'worker', types:['probe.wanted'], from:'beginning', async handle(e,tx) {
      external.push(e.id);
      await tx.run('INSERT INTO local_effects VALUES(?)',e.id);
      if (!killed) {
        killed = true;
        const {pid} = await tx.get('SELECT pg_backend_pid() AS pid');
        await killer.read(sql => sql.get('SELECT pg_terminate_backend(?) AS killed',pid));
        await ends.get(pid);
      }
    } });
    try {
      await events.drain();
      const failed = (await events.status())[0];
      const effects = await killer.read(sql => sql.all('SELECT event FROM local_effects'));
      clock += 100;
      await events.drain();
      console.log(JSON.stringify({failed, effects, external, recovered:(await events.status())[0]}));
    } finally { await events.close(); await state.close(); await killer.close(); }
  `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, MERV_EVENTS_SCHEMA: f.schema },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(child.status, 0, child.stderr || String(child.error ?? child.signal));
    const actual = JSON.parse(child.stdout);
    const expected = model([pub(), sub(), drain(true), tick(100), drain()]);
    assert.equal(actual.failed.cursor, expected[2]!.cursor);
    assert.equal(actual.failed.attempts, expected[2]!.attempts);
    assert.deepEqual(actual.effects, []);
    assert.deepEqual(actual.external, expected.at(-1)!.external);
    assert.deepEqual(await durable(f.other), project(expected.at(-1)!));
  },
);

test(
  'backend events: lost publisher reply and throwing postcommit callbacks cannot undo publication or prevent replay',
  lean,
  async (t) => {
    const f = await fixture(t),
      notified = deferred();
    const unlisten = [
      f.state.onEventsCommitted(() => {
        throw new Error('sync notification failure');
      }),
      f.state.onEventsCommitted(async () => {
        throw new Error('async notification failure');
      }),
      f.state.onEventsCommitted(() => notified.resolve()),
    ];
    const transaction = f.state.transaction.bind(f.state);
    f.state.transaction = async (fn) => {
      await transaction(fn);
      throw new Error('publisher reply lost');
    };
    try {
      await assert.rejects(publish(f.state), /publisher reply lost/);
    } finally {
      f.state.transaction = transaction;
    }
    await notified.promise;
    for (const dispose of unlisten) dispose();
    assert.deepEqual(await durable(f.other), project(model([pub()])[0]!));
    await f.events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
      },
    });
    await f.events.drain();
    await f.events.drain();
    assert.deepEqual(
      await durable(f.other),
      project(model([pub(), sub(), drain(), drain()]).at(-1)!),
    );
  },
);

test(
  'backend events: retry-metadata storage failure is visible, retains pending work, and recovers after reopening',
  lean,
  async (t) => {
    const f = await fixture(t);
    await publish(f.state);
    await f.events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
        throw new Error('handler failed');
      },
    });
    const transaction = f.state.transaction.bind(f.state);
    f.state.transaction = (fn) =>
      transaction(async (tx) => {
        const run = tx.run;
        tx.run = async (sql, ...args) => {
          if (sql.startsWith('UPDATE event_consumers SET attempts=')) await tx.get('SELECT 1/0');
          return run(sql, ...args);
        };
        return fn(tx);
      });
    try {
      await assert.rejects(f.events.drain(), { code: 'state_unavailable' });
    } finally {
      f.state.transaction = transaction;
    }
    const prefix = [pub(), sub(), { kind: 'beginDelivery' }, { kind: 'abort', ticket: 2 }];
    assert.deepEqual(await durable(f.other), project(model(prefix).at(-1)!));
    assert.equal((await f.events.status())[0]!.attempts, 0);
    await f.events.close();
    await f.state.close();
    const successor = await f.dispatcher(await f.reopen());
    await successor.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
      },
    });
    await successor.drain();
    assert.deepEqual(
      await durable(f.other),
      project(model([...prefix, { kind: 'crash' }, sub(), drain()]).at(-1)!),
    );
  },
);

// These mutation controls always run when the oracle is required. They execute production
// dispatcher/State code with one deliberately omitted SQL operation or writer lock.
for (const mutation of ['omit_effect', 'omit_cursor_once'] as const) {
  test(
    `backend events mutation control: Lean detects ${mutation} on real SQL without uniqueness constraints`,
    lean,
    async (t) => {
      const f = await fixture(t);
      await publish(f.state);
      await f.events.subscribe({
        id: 'worker',
        types: ['probe.wanted'],
        from: 'beginning',
        async handle(e, tx) {
          await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
        },
      });
      const transaction = f.state.transaction.bind(f.state);
      let mutated = false;
      f.state.transaction = (fn) =>
        transaction(async (tx) => {
          const run = tx.run;
          tx.run = async (sql, ...args) => {
            const selected =
              mutation === 'omit_effect'
                ? sql.startsWith('INSERT INTO local_effects')
                : sql.startsWith('UPDATE event_consumers SET cursor=');
            if (!mutated && selected) {
              mutated = true;
              return { changes: 1 };
            }
            return run(sql, ...args);
          };
          return fn(tx);
        });
      try {
        await f.events.drain();
      } finally {
        f.state.transaction = transaction;
      }
      assert.equal(mutated, true);
      const actual = await durable(f.other),
        expected = project(model([pub(), sub(), drain()]).at(-1)!);
      assert.notDeepEqual(actual, expected);
      assert.deepEqual(actual.effects, mutation === 'omit_effect' ? [] : [1, 1]);
      assert.deepEqual(expected.effects, [1]);
    },
  );
}

test(
  'backend events mutation control: removing the writer lock admits a late lower ID behind the durable cursor',
  lean,
  async (t) => {
    const f = await fixture(t);
    await f.events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
      },
    });
    Object.defineProperty(f.state, 'writeBegin', { value: 'BEGIN' });
    const entered = deferred(),
      release = deferred();
    const slow = f.state.transaction(async (tx) => {
      const e = await f.state.appendEvent(tx, event());
      await tx.run('INSERT INTO publisher_rows VALUES(?)', e.id);
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      await publish(f.other);
      await f.events.drain();
      assert.equal((await f.events.status())[0]!.cursor, 2);
    } finally {
      release.resolve();
      await slow;
    }
    await f.events.drain();
    const actual = await durable(f.other),
      expected = project(model([sub(), pub(), pub(), drain()]).at(-1)!);
    assert.deepEqual(actual.events, [1, 2]);
    assert.deepEqual(actual.effects, [2]);
    assert.deepEqual(expected.effects, [1, 2]);
    assert.notDeepEqual(actual, expected);
  },
);

test(
  'backend events: two successful dispatchers race on one cursor and commit exactly one unconstrained effect',
  lean,
  async (t) => {
    const f = await fixture(t),
      second = await f.dispatcher(f.other);
    const entered = deferred<number>(),
      release = deferred();
    let calls = 0;
    await f.events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        calls++;
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
        entered.resolve((await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid);
        await release.promise;
      },
    });
    await second.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(e, tx) {
        calls++;
        await tx.run('INSERT INTO local_effects VALUES(?)', e.id);
      },
    });
    await publish(f.state);
    const first = f.events.drain();
    const pid = await entered.promise;
    const competing = second.drain();
    try {
      await waitForBlocked(f.other, pid);
    } finally {
      release.resolve();
    }
    await Promise.all([first, competing]);
    const expected = model([
      sub(),
      pub(),
      { kind: 'beginDelivery' },
      { kind: 'beginDelivery' },
      { kind: 'commit', ticket: 2 },
      drain(),
    ]).at(-1)!;
    assert.deepEqual(await durable(f.other), project(expected));
    assert.equal(calls, expected.external.length);
  },
);
