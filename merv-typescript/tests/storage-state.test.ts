import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { openState, postgresUrl, schemaFor } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

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

test('async requests cannot enter another request transaction or see its rolled-back data', async () => {
  const state = await openState(':memory:');
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

test('commit notifications start independent database scopes after a read-owned transaction', async () => {
  const state = await openState(':memory:');
  let observed!: Promise<number>;
  state.onEventsCommitted(() => {
    observed = state.eventHead();
  });
  await state.read(() => state.transaction((tx) => state.appendEvent(tx, event)));
  assert.equal(await observed, 1);
  await state.close();
});

test('appendEvent returns the same detached event snapshot that was inserted', async () => {
  const state = await openState(':memory:');
  try {
    const input = structuredClone(event);
    const inserted = await state.transaction(async (tx) => {
      const pending = state.appendEvent(tx, input);
      input.subjectId = 'changed-after-insert';
      input.data.value = 2;
      const result = await pending;
      assert.equal(result.subjectId, event.subjectId);
      assert.deepEqual(result.data, event.data);
      input.data.value = 3;
      assert.deepEqual(result.data, event.data, 'returned data must not alias the caller');
      return result;
    });
    assert.deepEqual((await state.events(event.projectId))[0], inserted);
  } finally {
    await state.close();
  }
});

test('queued migrations retain the validated version and SQL input', async () => {
  const state = await openState(':memory:');
  const entered = deferred(),
    release = deferred();
  try {
    const busy = state.transaction(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const original = [{ version: 1, sql: 'CREATE TABLE original_migration(value TEXT);' }];
    const input = structuredClone(original);
    const pending = state.migrate('snapshot', input);
    input[0].version = 99;
    input[0].sql = 'CREATE TABLE changed_migration(value TEXT);';
    release.resolve();
    await Promise.all([busy, pending]);
    assert.deepEqual(
      (
        await state.read((sql) =>
          sql.all<{ name: string }>(
            "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('original_migration','changed_migration') ORDER BY table_name",
          ),
        )
      ).map((row) => row.name),
      ['original_migration'],
    );
    await state.migrate('snapshot', original);
    assert.equal(
      (await state.read((sql) =>
        sql.get<{ version: number }>(
          'SELECT version FROM component_migrations WHERE component=?',
          'snapshot',
        ),
      ))!.version,
      1,
    );
  } finally {
    release.resolve();
    await state.close();
  }
});

test('a commit listener can replace itself without being notified repeatedly for one commit', async () => {
  const state = await openState(':memory:');
  let calls = 0,
    detach = () => {};
  const listener = () => {
    calls++;
    detach();
    // Bound the reproduction even against the old live-Set loop.
    if (calls < 5) detach = state.onEventsCommitted(listener);
  };
  detach = state.onEventsCommitted(listener);
  try {
    await state.transaction((tx) => state.appendEvent(tx, event));
    assert.equal(calls, 1);
    await state.transaction((tx) => state.appendEvent(tx, event));
    assert.equal(calls, 2);
  } finally {
    detach();
    await state.close();
  }
});

test('a listener withdrawn during notification is not admitted later in that notification', async () => {
  const state = await openState(':memory:');
  let laterCalls = 0,
    detachLater = () => {};
  state.onEventsCommitted(() => detachLater());
  detachLater = state.onEventsCommitted(() => {
    laterCalls++;
  });
  try {
    await state.transaction((tx) => state.appendEvent(tx, event));
    assert.equal(laterCalls, 0);
  } finally {
    await state.close();
  }
});

test('rejected asynchronous commit listeners cannot crash the process or block other listeners', () => {
  // A subprocess exercises Node's normal unhandled-rejection policy without
  // changing the test runner's global rejection handlers.
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { PostgresState } from '@merv/state';
    const state = await PostgresState.open({
      connectionString: ${JSON.stringify(postgresUrl)},
      schema: ${JSON.stringify(schemaFor())},
      maxConnections: 2,
      readConnections: 1,
    });
    let calls = 0;
    state.onEventsCommitted(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('Failed async wakeup');
    });
    state.onEventsCommitted(() => { calls++; });
    await state.transaction((tx) => state.appendEvent(tx, ${JSON.stringify(event)}));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(await state.eventHead(), 1);
    await state.close();
  `,
    ],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
