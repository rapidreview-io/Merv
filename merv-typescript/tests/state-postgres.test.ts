import { type Transaction } from '@merv/contracts';
import { PostgresState } from '@merv/state';
import { postgresParameters } from '@merv/state/parameters';
import assert from 'node:assert/strict';

import test, { type TestContext } from 'node:test';

import { deferred } from './fixtures/deferred.js';
import { postgresUrl, schemaFor } from './fixtures/state.js';

const connectionString = postgresUrl;
const event = {
  projectId: 'project',
  actorId: 'actor',
  type: 'test.created',
  subjectId: 'subject',
  data: { value: 1 },
};
async function fixture(
  t: TestContext,
  config: {
    lockTimeoutMs?: number;
    maxConnections?: number;
    readConnections?: number;
    connectionTimeoutMs?: number;
    statementTimeoutMs?: number;
  } = {},
) {
  // The class's own pool defaults, not the fixture's small test pools.
  const schema = schemaFor();
  const state = await PostgresState.open({ connectionString, schema, ...config });
  t.after(() => state.close());
  return { state, schema };
}

test('PostgreSQL bind lexer preserves quoted SQL, nested comments and dollar bodies', () => {
  const sql = `SELECT ?, '?', "?", 'it''s ?', E'it\\'s ?', $$ ? $$, $body$ ? $body$
-- ?
/* outer ? /* inner ? */ */ WHERE x=?`;
  const translated = postgresParameters(sql, 2);
  assert.equal(
    translated,
    sql.replace('SELECT ?,', 'SELECT $1,').replace('WHERE x=?', 'WHERE x=$2'),
  );
  assert.throws(() => postgresParameters('SELECT ?', 0), { code: 'invalid_sql_parameters' });
  for (const [input, output] of [
    ['SELECT ? AS first -- ?\r, ? AS second', 'SELECT $1 AS first -- ?\r, $2 AS second'],
    ['SELECT ? AS a$tag$tail, ? AS second', 'SELECT $1 AS a$tag$tail, $2 AS second'],
    [
      'SELECT $é$?$é$ AS literal, ? AS first, ? AS second',
      'SELECT $é$?$é$ AS literal, $1 AS first, $2 AS second',
    ],
  ])
    assert.equal(postgresParameters(input!, 2), output);
});

test('PostgreSQL migrations keep records, events and checksum history atomic', async (t) => {
  const { state } = await fixture(t);
  const migrations = [
    { version: 1, sql: 'CREATE TABLE records(id TEXT PRIMARY KEY, retry_at BIGINT NOT NULL);' },
  ];
  await state.migrate('test', migrations);
  await state.migrate('test', migrations);
  await assert.rejects(state.migrate('test', [{ version: 1, sql: 'SELECT 1' }]), {
    code: 'migration_changed',
  });
  // A server rolled back under a database a newer one already migrated would read that schema
  // on terms that no longer hold: it refuses to start on it instead.
  const next = [
    ...migrations,
    { version: 2, sql: 'CREATE INDEX records_retry_at ON records(retry_at);' },
  ];
  await state.migrate('test', next);
  await assert.rejects(state.migrate('test', migrations), { code: 'migration_ahead' });
  await state.migrate('test', next);
  const foreign = await PostgresState.open({ connectionString, schema: schemaFor() });
  t.after(() => foreign.close());
  let captured!: Transaction;
  let wakeups = 0;
  state.onEventsCommitted(() => {
    wakeups++;
  });
  await assert.rejects(
    state.transaction(async (tx) => {
      await tx.run('INSERT INTO records VALUES(?,?)', 'rollback', Date.now());
      await state.appendEvent(tx, event);
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.equal(wakeups, 0);
  assert.equal(await state.eventHead(), 0);
  const timestamp = Date.now();
  await state.transaction(async (tx) => {
    captured = tx;
    assert.throws(() => foreign.assertTransaction(tx), { code: 'invalid_transaction' });
    await tx.run('INSERT INTO records VALUES(?,?)', "bound ' ? secret", timestamp);
    await state.appendEvent(tx, event);
    await state.appendEvent(tx, { ...event, subjectId: 'second' });
    await assert.rejects(
      state.transaction(() => undefined),
      { code: 'nested_transaction' },
    );
  });
  assert.equal(wakeups, 1);
  assert.equal(
    (
      await state.read((sql) =>
        sql.get<{ retry_at: number }>(
          'SELECT retry_at FROM records WHERE id=?',
          "bound ' ? secret",
        ),
      )
    )?.retry_at,
    timestamp,
  );
  await assert.rejects(captured.get('SELECT 1'), { code: 'transaction_closed' });
  // The events triggers refuse changes; PostgreSQL errors reach callers as state_constraint.
  const head = await state.eventHead();
  for (const change of [
    "UPDATE events SET type='mutated'",
    'DELETE FROM events',
    'TRUNCATE events',
    'TRUNCATE events CASCADE',
  ])
    await assert.rejects(
      state.transaction((tx) => tx.run(change)),
      { code: 'state_constraint' },
    );
  assert.equal((await state.events('project')).length, 2);
  assert.equal(await state.eventHead(), head);
  await assert.rejects(
    state.transaction(async (tx) => {
      await state.appendEvent(tx, event);
      try {
        await tx.run('INSERT INTO records VALUES(?,?)', "bound ' ? secret", timestamp);
      } catch {
        /* PostgreSQL still marks this transaction aborted. */
      }
      return 'must not report a successful commit';
    }),
    { code: 'transaction_aborted' },
  );
  assert.equal((await state.events('project')).length, 2);
  await assert.rejects(
    state.read((sql) => sql.get('SELECT 9007199254740992::bigint AS unsafe')),
    { code: 'state_integer_range' },
  );
});

test('PostgreSQL serializes writers across app instances before allocating event IDs', async (t) => {
  const { state, schema } = await fixture(t);
  const other = await PostgresState.open({ connectionString, schema });
  t.after(() => other.close());
  const entered = deferred();
  const release = deferred();
  const first = state.transaction(async (tx) => {
    const saved = await state.appendEvent(tx, event);
    entered.resolve();
    await release.promise;
    return saved;
  });
  await entered.promise;
  let secondEntered = false;
  const second = other.transaction(async (tx) => {
    secondEntered = true;
    return other.appendEvent(tx, { ...event, subjectId: 'second' });
  });
  // A separate connection remains responsive, but cannot see uncommitted events.
  assert.equal(await other.eventHead(), 0);
  assert.equal(secondEntered, false);
  release.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.ok(two.id > one.id);
  assert.deepEqual(
    (await state.read((sql) => sql.all<{ id: number }>('SELECT id FROM events ORDER BY id'))).map(
      (item) => item.id,
    ),
    [one.id, two.id],
  );
});

test('PostgreSQL disposal drains admitted async work before closing its pool', async (t) => {
  const { state } = await fixture(t, { maxConnections: 1 });
  const entered = deferred();
  const release = deferred();
  const readEntered = deferred();
  const releaseRead = deferred();
  const work = state.transaction(async (tx) => {
    entered.resolve();
    await release.promise;
    await state.appendEvent(tx, event);
  });
  await entered.promise;
  // Readers have their own pool; a concurrent eventHead may correctly see the old
  // committed head. Hold an admitted read explicitly instead of assuming it queues
  // behind the writer, then query after the writer has committed.
  const read = state.read(async () => {
    readEntered.resolve();
    await releaseRead.promise;
    return state.eventHead();
  });
  let closed = false;
  try {
    await readEntered.promise;
    const closing = state.close().then(() => {
      closed = true;
    });
    await assert.rejects(state.eventHead(), { code: 'state_closed' });
    assert.equal(closed, false);
    release.resolve();
    await work;
    assert.equal(closed, false, 'the admitted read must also drain before closing');
    releaseRead.resolve();
    assert.ok((await read) > 0);
    await closing;
    assert.equal(closed, true);
  } finally {
    release.resolve();
    releaseRead.resolve();
    await Promise.allSettled([work, read]);
  }
});

test('PostgreSQL: a statement that fails in an isolated read costs that read alone, and the snapshot reads on', async (t) => {
  const { state } = await fixture(t, { statementTimeoutMs: 200 });
  await state.transaction(async (tx) => await state.appendEvent(tx, event));
  const code = (error: { code?: string }) => error.code;
  // Without a savepoint, the first of these would abort the snapshot, and its COMMIT with it.
  const outcomes = await state.snapshot(async () => {
    const results: unknown[] = [];
    for (const statement of ['SELECT 1/0', "SELECT '{bad'::jsonb", 'SELECT pg_sleep(1)'])
      results.push(
        await state
          .isolated(() => state.transaction(async (tx) => await tx.get(statement)))
          .catch(code),
      );
    // Catching its own failed statement does not save a read: the snapshot was aborted.
    results.push(
      await state
        .isolated(async () => {
          await state.read((sql) => sql.get('SELECT 1/0')).catch(() => undefined);
          return 'swallowed';
        })
        .catch(code),
    );
    results.push(await state.isolated(async () => await state.eventHead()));
    return results;
  });
  assert.deepEqual(outcomes, [
    'state_unavailable',
    'state_unavailable',
    'state_timeout',
    'state_unavailable',
    1,
  ]);

  await state.snapshot(async () => {
    // Savepoints nest by time on one connection: a second read waits its turn or is refused.
    const release = deferred();
    const first = state.isolated(async () => await release.promise);
    await assert.rejects(
      state.isolated(async () => 1),
      { code: 'isolation_overlap' },
    );
    release.resolve();
    await first;
    await assert.rejects(
      state.isolated(() => state.isolated(async () => 1)),
      { code: 'isolation_overlap' },
    );
    // A read an isolated call leaves running is closed with it.
    const go = deferred();
    let late!: Promise<unknown>;
    await state.isolated(() => {
      late = go.promise.then(() => state.read((sql) => sql.get('SELECT 1')));
    });
    go.resolve();
    await assert.rejects(late, { code: 'transaction_closed' });
    assert.equal(await state.isolated(async () => await state.eventHead()), 1);
  });
  // Outside a scope every read is its own; a write transaction cannot isolate a statement.
  assert.equal(await state.isolated(async () => await state.eventHead()), 1);
  await assert.rejects(
    state.transaction(() => state.isolated(async () => 1)),
    { code: 'isolation_unavailable' },
  );
});
