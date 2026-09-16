import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteState } from '@merv/state';
import type { Transaction } from '@merv/contracts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const migration = [
  { version: 1, sql: 'CREATE TABLE values_test(id INTEGER PRIMARY KEY, value TEXT NOT NULL);' },
];
const event = {
  projectId: 'project',
  actorId: 'actor',
  type: 'test.created',
  subjectId: 'subject',
  data: { value: 1 },
};

test('SQLite async requests cannot enter another request transaction or see its rolled-back data', async () => {
  const state = new SqliteState(':memory:');
  await state.migrate('test', migration);
  const inserted = deferred();
  const release = deferred();
  const rollback = state.transaction(async (tx) => {
    await tx.run('INSERT INTO values_test VALUES(?,?)', 1, 'uncommitted');
    assert.equal(
      (await state.read((sql) => sql.get<{ value: string }>('SELECT value FROM values_test')))
        ?.value,
      'uncommitted',
    );
    inserted.resolve();
    await release.promise;
    throw new Error('rollback');
  });
  await inserted.promise;
  let outsideReadFinished = false;
  const outside = state.read(async (sql) => {
    outsideReadFinished = true;
    return sql.all('SELECT * FROM values_test');
  });
  await Promise.resolve();
  assert.equal(outsideReadFinished, false);
  release.resolve();
  await assert.rejects(rollback, /rollback/);
  assert.deepEqual(await outside, []);
  await state.close();
});

test('SQLite keeps explicit transactions, migration checksums and event delivery atomic', async () => {
  const state = new SqliteState(':memory:');
  const foreign = new SqliteState(':memory:');
  await state.migrate('test', migration);
  await state.migrate('test', migration);
  await assert.rejects(state.migrate('test', [{ version: 1, sql: 'SELECT 1;' }]), {
    code: 'migration_changed',
  });
  let captured!: Transaction;
  let wakeups = 0;
  state.onEventsCommitted(() => {
    wakeups++;
  });
  await assert.rejects(
    state.transaction(async (tx) => {
      await tx.run('INSERT INTO values_test VALUES(?,?)', 1, 'rollback');
      await state.appendEvent(tx, event);
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.equal(await state.eventHead(), 0);
  assert.equal(wakeups, 0);
  await state.transaction(async (tx) => {
    captured = tx;
    assert.throws(() => foreign.assertTransaction(tx), { code: 'invalid_transaction' });
    await assert.rejects(
      state.transaction(() => undefined),
      { code: 'nested_transaction' },
    );
    await tx.run('INSERT INTO values_test VALUES(?,?)', 1, 'committed');
    await state.appendEvent(tx, event);
    await state.appendEvent(tx, { ...event, subjectId: 'second' });
  });
  assert.equal(wakeups, 1);
  await assert.rejects(captured.get('SELECT 1'), { code: 'transaction_closed' });
  assert.equal((await state.events('project')).length, 2);
  await assert.rejects(
    state.transaction((tx) => tx.run('DELETE FROM events')),
    /Events are retained/,
  );
  await state.close();
  await foreign.close();
});

test('SQLite close drains admitted requests and denies new work', async () => {
  const state = new SqliteState(':memory:');
  const entered = deferred();
  const release = deferred();
  const transaction = state.transaction(async (tx) => {
    entered.resolve();
    await release.promise;
    await state.appendEvent(tx, event);
    return 42;
  });
  await entered.promise;
  const admittedRead = state.eventHead();
  let closed = false;
  const closing = state.close().then(() => {
    closed = true;
  });
  await assert.rejects(state.eventHead(), { code: 'state_closed' });
  assert.equal(closed, false);
  release.resolve();
  assert.equal(await transaction, 42);
  assert.equal(await admittedRead, 1);
  await closing;
  await state.close();
});

test('commit notifications start independent database scopes after a read-owned transaction', async () => {
  const state = new SqliteState(':memory:');
  let observed!: Promise<number>;
  state.onEventsCommitted(() => {
    observed = state.eventHead();
  });
  await state.read(() => state.transaction((tx) => state.appendEvent(tx, event)));
  assert.equal(await observed, 1);
  await state.close();
});

test('SQLite rebuild migrations validate foreign keys before commit and restore enforcement', async () => {
  const state = new SqliteState(':memory:');
  await state.migrate('test', [
    {
      version: 1,
      sql: 'CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent_id INTEGER REFERENCES parents(id));',
    },
  ]);
  await assert.rejects(
    state.migrate('test', [{ version: 2, rebuild: true, sql: 'INSERT INTO children VALUES(9);' }]),
    { code: 'migration_foreign_key' },
  );
  assert.deepEqual(await state.read((sql) => sql.all('SELECT * FROM children')), []);
  await assert.rejects(
    state.transaction((tx) => tx.run('INSERT INTO children VALUES(9)')),
    /FOREIGN KEY/,
  );
  await state.close();
});
