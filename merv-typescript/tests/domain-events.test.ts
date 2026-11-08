import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DurableEvents } from '@merv/domain-events';
import type { PostgresState } from '@merv/state';
import { deferred as signal } from './fixtures/deferred.js';

import { openState } from './fixtures/state.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Delivery did not converge');
    await sleep(10);
  }
}

test('durable delivery rolls back effects with its cursor, isolates failures, resumes after restart and does not duplicate commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-events-'));
  let state = await openState(dir);
  let events = await createService(new DurableEvents(state));
  try {
    await state.migrate('probe', [
      {
        version: 1,
        sql: 'CREATE TABLE probe (consumer TEXT, event INTEGER, UNIQUE(consumer,event));',
      },
    ]);
    const emit = async () =>
      await state.transaction(
        async (tx) =>
          await state.appendEvent(tx, {
            projectId: 'p',
            actorId: 'a',
            type: 'probe.created',
            subjectId: 's',
            data: {},
          }),
      );
    await assert.rejects(
      async () =>
        await state.transaction(async (tx) => {
          await state.appendEvent(tx, {
            projectId: 'p',
            actorId: 'a',
            type: 'probe.created',
            subjectId: 'rolled-back',
            data: {},
          });
          throw Error('abort');
        }),
    );
    assert.equal(await state.eventHead(), 0);
    let fail = true;
    const handler = (id: string) => ({
      id,
      types: ['probe.created'],
      from: 'beginning' as const,
      async handle(event: any, tx: any) {
        await tx.run('INSERT INTO probe VALUES (?,?)', id, event.id);
        if (id === 'flaky' && fail) throw Error('sensitive failure detail');
      },
    });
    await events.subscribe(handler('flaky'));
    const detach = await events.subscribe(handler('healthy'));
    const first = await emit();
    await events.drain();
    assert.equal((await events.status()).find((x) => x.id === 'flaky')!.cursor, 0);
    assert.equal((await events.status()).find((x) => x.id === 'flaky')!.error, 'handler_failed');
    assert.equal((await events.status()).find((x) => x.id === 'healthy')!.cursor, first.id);
    assert.equal((await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length, 1);
    await detach();
    await emit();
    await events.drain();
    assert.equal((await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length, 1);
    await events.close();
    await state.close();
    state = await openState(dir);
    events = await createService(new DurableEvents(state));
    fail = false;
    await events.subscribe(handler('flaky'));
    await events.subscribe(handler('healthy'));
    await until(
      async () =>
        (await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length === 4,
    );
    await events.drain();
    await events.drain();
    assert.equal((await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length, 4);
    assert.ok((await events.status()).every((x) => x.attempts === 0 && x.error === null));
    await assert.rejects(
      async () => await events.subscribe({ ...handler('healthy'), types: ['different'] }),
      /already active/,
    );
    await events.subscribe({ ...handler('new-consumer'), from: 'now' });
    await events.drain();
    assert.equal((await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length, 4);
  } finally {
    await events.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function emitProbe(state: PostgresState) {
  return state.transaction((tx) =>
    state.appendEvent(tx, {
      projectId: 'p',
      actorId: 'a',
      subjectId: 's',
      type: 'probe.created',
      data: {},
    }),
  );
}

test('drain joins async handlers and close waits for their atomic commit without admitting the next event', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-events-drain-'));
  const state = await openState(directory);
  const observer = await openState(directory);
  const events = await createService(new DurableEvents(state));
  const entered = signal(),
    released = signal();
  try {
    await state.migrate('probe', [
      { version: 1, sql: 'CREATE TABLE probe (event INTEGER PRIMARY KEY);' },
    ]);
    // Both events exist before the consumer does: a handler held open inside its delivery
    // transaction holds the writer lock, so an emit after subscribing could wait on it.
    const first = await emitProbe(state);
    await emitProbe(state);
    await events.subscribe({
      id: 'worker',
      types: ['probe.created'],
      from: 'beginning',
      async handle(event, tx) {
        await tx.run('INSERT INTO probe VALUES (?)', event.id);
        entered.resolve();
        await released.promise;
      },
    });
    const draining = events.drain();
    await entered.promise;
    const joined = events.drain();
    let closed = false;
    const closing = events.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    assert.deepEqual(await observer.read((sql) => sql.all('SELECT * FROM probe')), []);
    assert.equal(
      (await observer.read((sql) =>
        sql.get<{ cursor: number }>('SELECT cursor FROM event_consumers WHERE id=?', 'worker'),
      ))!.cursor,
      0,
    );
    released.resolve();
    await Promise.all([draining, joined, closing]);
    assert.equal(closed, true);
    assert.deepEqual(
      (await observer.read((sql) => sql.all<{ event: number }>('SELECT * FROM probe'))).map(
        (row) => row.event,
      ),
      [first.id],
    );
    assert.equal((await events.status())[0]!.cursor, first.id);
    assert.equal((await events.status())[0]!.active, false);
  } finally {
    released.resolve();
    await events.close();
    await observer.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const cursor of [0, Number.MAX_SAFE_INTEGER]) {
  test(`handler event edits cannot move the durable cursor to ${cursor}`, async () => {
    const state = await openState(':memory:');
    const events = await createService(new DurableEvents(state));
    try {
      await state.migrate('cursor_probe', [
        {
          version: 1,
          sql: 'CREATE TABLE cursor_probe(seq BIGINT GENERATED ALWAYS AS IDENTITY, event BIGINT);',
        },
      ]);
      let changed = false;
      await events.subscribe({
        id: 'cursor-owner',
        types: ['probe.created'],
        from: 'beginning',
        async handle(event, tx) {
          await tx.run('INSERT INTO cursor_probe(event) VALUES (?)', event.id);
          if (!changed) {
            changed = true;
            event.id = cursor;
          }
        },
      });
      const first = await emitProbe(state),
        second = await emitProbe(state);
      await events.drain();
      assert.deepEqual(
        (
          await state.read((sql) =>
            sql.all<{ event: number }>('SELECT event FROM cursor_probe ORDER BY seq'),
          )
        ).map((row) => row.event),
        [first.id, second.id],
      );
      assert.equal((await events.status())[0].cursor, second.id);
      const third = await emitProbe(state);
      await events.drain();
      assert.equal((await events.status())[0].cursor, third.id);
    } finally {
      await events.close();
      await state.close();
    }
  });
}

/** A small seeded generator, so a failure reproduces the same writer schedule. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('two dispatchers deliver every committed event exactly once and in order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-events-random-'));
  const states = [
    await openState(directory),
    await openState(directory),
    await openState(directory),
  ];
  const [first, second, writerOnly] = states as [PostgresState, PostgresState, PostgresState];
  const dispatchers = [
    await createService(new DurableEvents(first)),
    await createService(new DurableEvents(second)),
  ];
  const schedule = seeded(12345),
    failures = seeded(54321);
  const consumers: Record<string, string[]> = {
    all: ['probe.a', 'probe.b', 'probe.c', 'probe.d'],
    'only-a': ['probe.a'],
    'b-and-c': ['probe.b', 'probe.c'],
    'rare-d': ['probe.d'],
    'flaky-c': ['probe.c'],
  };
  try {
    await first.migrate('effects', [
      {
        version: 1,
        sql: 'CREATE TABLE effects(seq BIGINT GENERATED ALWAYS AS IDENTITY, consumer TEXT, event BIGINT);',
      },
    ]);
    // The same consumers run in both dispatchers; their shared cursors decide who delivers.
    for (const events of dispatchers)
      for (const [id, types] of Object.entries(consumers))
        await events.subscribe({
          id,
          types,
          from: 'beginning',
          async handle(event, tx) {
            await tx.run('INSERT INTO effects(consumer,event) VALUES (?,?)', id, event.id);
            if (id === 'flaky-c' && failures() < 0.1) throw new Error('handler failed');
          },
        });
    const pick = () => {
      const roll = schedule();
      return roll < 0.4 ? 'probe.a' : roll < 0.7 ? 'probe.b' : roll < 0.95 ? 'probe.c' : 'probe.d';
    };
    // Rolled-back batches consume identity values and leave gaps in the log.
    await Promise.all(
      states.map(async (state) => {
        for (let batch = 0; batch < 30; batch++) {
          const types = Array.from({ length: 1 + Math.floor(schedule() * 4) }, pick);
          const rollback = schedule() < 0.25;
          await state
            .transaction(async (tx) => {
              for (const type of types)
                await state.appendEvent(tx, {
                  projectId: 'p',
                  actorId: 'a',
                  subjectId: 's',
                  type,
                  data: {},
                });
              if (rollback) throw new Error('rolled back');
            })
            .catch((error: Error) => assert.equal(error.message, 'rolled back'));
          if (schedule() < 0.3) void dispatchers[batch % 2]!.drain().catch(() => {});
          await sleep(Math.floor(schedule() * 3));
        }
      }),
    );
    const head = await writerOnly.eventHead();
    const deadline = Date.now() + 15_000;
    for (;;) {
      await Promise.all(dispatchers.map((events) => events.drain()));
      const status = await dispatchers[0]!.status();
      if (status.every((consumer) => consumer.cursor === head)) break;
      assert.ok(Date.now() < deadline, `Delivery did not converge: ${JSON.stringify(status)}`);
      await sleep(20);
    }
    const log = await writerOnly.read((sql) =>
      sql.all<{ id: number; type: string }>('SELECT id, type FROM events ORDER BY id'),
    );
    assert.ok(log.length > 100 && log.at(-1)!.id > log.length, 'the log has gaps');
    for (const [id, types] of Object.entries(consumers))
      assert.deepEqual(
        (
          await writerOnly.read((sql) =>
            sql.all<{ event: number }>(
              'SELECT event FROM effects WHERE consumer=? ORDER BY seq',
              id,
            ),
          )
        ).map((row) => row.event),
        log.filter((event) => types.includes(event.type)).map((event) => event.id),
        id,
      );
  } finally {
    await Promise.all(dispatchers.map((events) => events.close()));
    await Promise.all(states.map((state) => state.close()));
    rmSync(directory, { recursive: true, force: true });
  }
});
