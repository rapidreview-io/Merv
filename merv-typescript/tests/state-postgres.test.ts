import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Context, FiberState } from 'cordis';
import { Pool } from 'pg';
import { PostgresState, statePlugin } from '@merv/state';
import { postgresParameters } from '@merv/state/parameters';
import { MervError, type Migration, type Transaction } from '@merv/contracts';
import { postgresUrl, schemaFor } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

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
  config: { lockTimeoutMs?: number; maxConnections?: number; statementTimeoutMs?: number } = {},
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

test('PostgreSQL executes bound SQL with carriage-return comments, dollar identifiers and Unicode quote tags', async (t) => {
  const { state } = await fixture(t);
  for (const sql of [
    'SELECT ? AS first -- ?\r, ? AS second',
    'SELECT ? AS a$tag$tail, ? AS second',
    'SELECT $é$?$é$ AS literal, ? AS first, ? AS second',
  ]) {
    const row = await state.read((tx) => tx.get(sql, 'one', 'two'));
    assert.equal(row?.second, 'two');
    assert.equal(row?.first ?? row?.a$tag$tail, 'one');
    if (row?.literal !== undefined) assert.equal(row.literal, '?');
  }
  await state.transaction(async (tx) => {
    await assert.rejects(tx.get('SELECT ?'), { code: 'invalid_sql_parameters' });
    assert.deepEqual(await tx.get('SELECT ?::integer AS value', 7), { value: 7 });
  });
});

test('State config is PostgreSQL only and requires explicit verified TLS settings', () => {
  assert.deepEqual(statePlugin.Config.parse({}), {
    connectionStringEnv: 'MERV_DB_URL',
    schema: 'merv',
    maxConnections: 10,
    readConnections: 6,
    connectionTimeoutMs: 10000,
    statementTimeoutMs: 30000,
    lockTimeoutMs: 5000,
  });
  // Production configs still name the backend; it is accepted and has one value.
  assert.equal(statePlugin.Config.parse({ backend: 'postgres' }).backend, 'postgres');
  assert.equal(
    statePlugin.Config.parse({ schemaEnv: 'MERV_DB_SCHEMA' }).schemaEnv,
    'MERV_DB_SCHEMA',
  );
  for (const config of [
    { path: ':memory:' },
    { backend: 'sqlite' },
    { backend: 'sqlite', path: 'state.sqlite' },
    { schema: '1bad' },
    { schemaEnv: 'MERV-DB-SCHEMA' },
  ])
    assert.equal(statePlugin.Config.safeParse(config).success, false, JSON.stringify(config));
  assert.equal(
    statePlugin.Config.safeParse({ backend: 'postgres', connectionString: 'secret' }).success,
    false,
  );
  assert.equal(
    statePlugin.Config.safeParse({ backend: 'postgres', ssl: { rejectUnauthorized: false } })
      .success,
    false,
  );
});

test('PostgreSQL retains binary parameters when a caller reuses buffers before execution', async (t) => {
  const { state } = await fixture(t);
  await state.transaction(async (tx) => {
    await tx.run('CREATE TEMP TABLE binary_input (value BYTEA) ON COMMIT DROP');
    for (const value of [new Uint8Array([1, 2]), Buffer.from([0, 1, 2, 3]).subarray(1, 3)]) {
      const writing = tx.run('INSERT INTO binary_input VALUES(?)', value);
      value.fill(9);
      await writing;
    }
    assert.deepEqual(await tx.all('SELECT value FROM binary_input'), [
      { value: Buffer.from([1, 2]) },
      { value: Buffer.from([1, 2]) },
    ]);
    const value = new Uint8Array([3, 4]);
    const reading = tx.get<{ value: Buffer }>('SELECT ?::bytea AS value', value);
    value.fill(9);
    assert.deepEqual((await reading)?.value, Buffer.from([3, 4]));
  });
});

test('PostgreSQL drains sibling queries before releasing a failed read connection', async (t) => {
  const { state } = await fixture(t);
  let completed = 0;
  await assert.rejects(
    state.read((sql) =>
      Promise.all([
        sql.get('SELECT 1/0'),
        sql.get('SELECT pg_sleep(0.02)').then(() => completed++),
        sql.get('SELECT pg_sleep(0.02)').then(() => completed++),
      ]),
    ),
    { code: 'state_unavailable' },
  );
  assert.equal(completed, 2, 'a rejected callback still owns its admitted queries');
  assert.deepEqual(await state.read((sql) => sql.get('SELECT 1 AS value')), { value: 1 });
});

test('PostgreSQL: a failed read drains the transaction it started', async (t) => {
  const { state } = await fixture(t);
  const entered = deferred(),
    released = deferred(),
    callbackEnded = deferred();
  const failure = new Error('parallel read failed');
  let child!: Promise<unknown>,
    late!: Promise<void>,
    finished = false;
  const reading = state
    .read(async (sql) => {
      late = callbackEnded.promise.then(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(sql.get('SELECT 1'), { code: 'transaction_closed' });
        await assert.rejects(
          state.transaction(() => undefined),
          { code: 'transaction_closed' },
        );
      });
      child = state.transaction(async (tx) => {
        await state.appendEvent(tx, event);
        entered.resolve();
        await released.promise;
        await state.appendEvent(tx, { ...event, subjectId: 'second' });
      });
      try {
        await Promise.all([
          child,
          entered.promise.then(() => {
            throw failure;
          }),
        ]);
      } finally {
        callbackEnded.resolve();
      }
    })
    .catch((error) => {
      finished = true;
      return error;
    });
  try {
    await callbackEnded.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false, 'the connection remains owned until its transaction finishes');
    await late;
    released.resolve();
    assert.equal(await reading, failure);
    assert.equal(await state.eventHead(), 2);
  } finally {
    released.resolve();
    await Promise.allSettled([reading, child, late]);
  }
});

test('PostgreSQL boots in a pre-created owned schema without database CREATE privilege', async (t) => {
  const suffix = randomUUID().replaceAll('-', '');
  const role = `merv_role_${suffix}`;
  const schema = `merv_owned_${suffix}`;
  const foreignSchema = `merv_other_${suffix}`;
  const password = randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString });
  let state: PostgresState | undefined;
  t.after(async () => {
    await state?.close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${foreignSchema}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      await admin.end();
    }
  });
  // Identifiers and password are generated hexadecimal strings, never external input.
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD '${password}'`,
  );
  await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${role}"`);
  await admin.query(`CREATE SCHEMA "${foreignSchema}"`);
  await admin.query(`CREATE TABLE "${foreignSchema}".private_record(id INTEGER)`);
  assert.equal(
    (
      await admin.query(
        "SELECT has_database_privilege($1, current_database(), 'CREATE') AS allowed",
        [role],
      )
    ).rows[0].allowed,
    false,
  );
  const url = new URL(connectionString);
  url.username = role;
  url.password = password;
  state = await PostgresState.open({ connectionString: url.toString(), schema });
  await state.migrate('least-privilege', [
    { version: 1, sql: 'CREATE TABLE owned_record(id TEXT PRIMARY KEY)' },
  ]);
  await state.transaction(async (tx) => {
    await tx.run('INSERT INTO owned_record(id) VALUES(?)', 'record');
    await state!.appendEvent(tx, event);
  });
  assert.equal((await state.events('project')).length, 1);
  await assert.rejects(
    state.read((sql) => sql.get(`SELECT * FROM "${foreignSchema}".private_record`)),
    { code: 'state_unavailable' },
  );
  await state.close();
  state = await PostgresState.open({ connectionString: url.toString(), schema });
  assert.equal((await state.events('project')).length, 1);
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
  // The events trigger refuses changes; PostgreSQL errors reach callers as state_constraint.
  for (const change of ["UPDATE events SET type='mutated'", 'DELETE FROM events'])
    await assert.rejects(
      state.transaction((tx) => tx.run(change)),
      { code: 'state_constraint' },
    );
  assert.equal((await state.events('project')).length, 2);
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
    (await state.eventBatch(0, 10)).map((item) => item.id),
    [one.id, two.id],
  );
});

test('PostgreSQL lock timeout rolls back the checked-out connection for later requests', async (t) => {
  const { state, schema } = await fixture(t);
  const other = await PostgresState.open({
    connectionString,
    schema,
    maxConnections: 1,
    lockTimeoutMs: 30,
  });
  t.after(() => other.close());
  const entered = deferred();
  const release = deferred();
  const held = state.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  await assert.rejects(
    other.transaction(() => undefined),
    { code: 'state_timeout' },
  );
  release.resolve();
  await held;
  await other.transaction((tx) => other.appendEvent(tx, event));
  assert.equal((await other.events('project')).length, 1);
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

test('failed State activation ends both pools once and publishes no service', async (t) => {
  // One schema whose `events` table has another shape: the connection is acquired, and the
  // bootstrap then fails on it, because its index names a column this table lacks.
  const malformed = schemaFor();
  const admin = new Pool({ connectionString });
  try {
    await admin.query(`CREATE SCHEMA "${malformed}"`);
    await admin.query(`CREATE TABLE "${malformed}".events(id INTEGER PRIMARY KEY)`);
  } finally {
    await admin.end();
  }
  const variable = `MERV_TEST_STATE_URL_${randomUUID().replaceAll('-', '')}`;
  t.after(() => delete process.env[variable]);
  const ended: Pool[] = [];
  const end = Pool.prototype.end as (this: Pool) => Promise<void>;
  t.mock.method(Pool.prototype, 'end', function (this: Pool) {
    ended.push(this);
    return end.call(this);
  });
  for (const [url, schema] of [
    [connectionString, malformed],
    // And one that never reaches a server: nothing listens on port 1.
    ['postgres://merv@127.0.0.1:1/merv', schemaFor()],
  ]) {
    process.env[variable] = url;
    ended.length = 0;
    const ctx = new Context();
    t.mock.method(ctx.logger, 'error', () => undefined);
    try {
      const fiber = ctx.plugin(
        statePlugin,
        statePlugin.Config.parse({
          connectionStringEnv: variable,
          schema,
          maxConnections: 2,
          readConnections: 1,
        }),
      );
      await assert.rejects(fiber.await(), (error: unknown) => {
        assert.ok(error instanceof MervError);
        assert.equal(error.code, 'state_unavailable');
        return true;
      });
      assert.equal(fiber.state, FiberState.FAILED);
      assert.equal(ctx.get('state'), undefined);
      // The writers' pool and the readers' pool, each ended exactly once.
      assert.equal(ended.length, 2, schema);
      assert.equal(new Set(ended).size, 2);
    } finally {
      await ctx.fiber.dispose();
    }
    assert.equal(ended.length, 2, 'Disposal must not end the failed provider twice');
  }
});

test('PostgreSQL snapshot scopes run sibling reads side by side, each in its own transaction context', async (t) => {
  const { state } = await fixture(t);
  await state.transaction(async (tx) => await state.appendEvent(tx, event));
  // A page's parts are independent read-only tools sharing one snapshot: none of them may
  // see another's transaction as its own nesting, and each may assert its own handle.
  const siblings: Transaction[] = [];
  const heads = await state.snapshot(async () =>
    Promise.all(
      Array.from({ length: 6 }, async () =>
        state.transaction(async (tx) => {
          state.assertTransaction(tx);
          siblings.push(tx);
          await new Promise((resolve) => setTimeout(resolve, 5));
          for (const sibling of siblings)
            if (sibling !== tx)
              await assert.rejects(sibling.get('SELECT 1'), { code: 'transaction_closed' });
          return (await state.events(event.projectId)).length;
        }),
      ),
    ),
  );
  assert.deepEqual(heads, [1, 1, 1, 1, 1, 1]);
  await state.snapshot(async () => {
    for (const fail of [false, true]) {
      let captured!: Transaction;
      const operation = state.transaction((tx) => {
        captured = tx;
        if (fail) throw new Error('Failed child read');
      });
      if (fail) await assert.rejects(operation, /Failed child read/);
      else await operation;
      for (const query of [
        () => captured.get('SELECT 1'),
        () => captured.all('SELECT 1'),
        () => captured.run('SELECT 1'),
      ])
        await assert.rejects(query, { code: 'transaction_closed' });
      assert.equal(await state.eventHead(), 1, 'The parent snapshot remains usable');
    }
  });
  const resume = deferred();
  let child!: Promise<void>;
  await state.snapshot(() => {
    child = state.transaction(async (tx) => {
      await resume.promise;
      await assert.rejects(tx.get('SELECT 1'), { code: 'transaction_closed' });
    });
  });
  resume.resolve();
  await child;
  for (const enclosing of ['snapshot', 'read'] as const)
    await state[enclosing](async () => {
      const release = deferred();
      let closing!: Promise<string | undefined>;
      await state.transaction(() => {
        closing = release.promise
          .then(() => state.close())
          .then(
            () => 'closed',
            (error: { code?: string }) => error.code,
          );
      });
      release.resolve();
      assert.equal(
        await Promise.race([
          closing,
          new Promise((resolve) => setTimeout(() => resolve('stalled'), 100)),
        ]),
        'transaction_active',
      );
      assert.equal(await state.eventHead(), 1);
    });
  await assert.rejects(
    state.snapshot(() =>
      state.transaction((tx) => state.transaction(async () => tx.transactionId)),
    ),
    { code: 'nested_transaction' },
  );
  await assert.rejects(
    state.snapshot(() => state.transaction(async (tx) => await state.appendEvent(tx, event))),
    { code: 'read_only_scope' },
  );
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

test('PostgreSQL refuses a migration that still carries a second dialect or a rebuild flag', async (t) => {
  const { state } = await fixture(t);
  // The shape owners used when they carried two texts: a leftover must fail loudly, not run either.
  for (const leftover of [
    {
      version: 1,
      sql: 'CREATE TABLE leftover(id TEXT)',
      postgres: 'CREATE TABLE leftover(id TEXT)',
    },
    { version: 1, sql: 'CREATE TABLE leftover(id TEXT)', rebuild: true },
    { version: 1, postgres: 'CREATE TABLE leftover(id TEXT)' },
  ])
    await assert.rejects(state.migrate('leftover', [leftover as unknown as Migration]), {
      code: 'invalid_migration',
    });
  assert.deepEqual(
    await state.read((sql) =>
      sql.all(
        "SELECT component FROM component_migrations WHERE component='leftover' UNION ALL SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='leftover'",
      ),
    ),
    [],
  );
});

test('State schemaEnv names the schema when set, and a bad name is refused', async (t) => {
  const suffix = randomUUID().replaceAll('-', '');
  const variable = `MERV_TEST_STATE_SCHEMA_${suffix}`;
  const schema = `merv_env_${suffix}`;
  const config = statePlugin.Config.parse({
    connectionStringEnv: 'MERV_TEST_POSTGRES_URL',
    schema: `merv_unused_${suffix}`,
    schemaEnv: variable,
  });
  const admin = new Pool({ connectionString });
  t.after(async () => {
    delete process.env[variable];
    try {
      for (const name of [schema, config.schema])
        await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  const schemaOf = async (value: string | undefined) => {
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
    const ctx = new Context();
    try {
      await ctx.plugin(statePlugin, config);
      return (await ctx.state.read((sql) =>
        sql.get<{ schema: string }>('SELECT current_schema() AS schema'),
      ))!.schema;
    } finally {
      await ctx.fiber.dispose();
    }
  };
  assert.equal(await schemaOf(` ${schema} `), schema);
  // Unset or blank falls back to the configured schema.
  assert.equal(await schemaOf(' '), config.schema);
  assert.equal(await schemaOf(undefined), config.schema);
  process.env[variable] = 'bad-name';
  const ctx = new Context();
  try {
    await assert.rejects(ctx.plugin(statePlugin, config).await(), { code: 'invalid_config' });
    assert.equal(ctx.get('state'), undefined);
  } finally {
    await ctx.fiber.dispose();
  }
  assert.deepEqual(
    (
      await admin.query('SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1', [
        'bad-name',
      ])
    ).rows,
    [],
  );
});
