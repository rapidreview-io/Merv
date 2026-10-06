import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Context, FiberState } from 'cordis';
import { Pool } from 'pg';
import { PostgresState, statePlugin } from '@merv/state';
import { postgresParameters } from '@merv/state/parameters';
import { MervError, type Migration, type Transaction } from '@merv/contracts';
import { dropSchema, postgresUrl, schemaFor } from './fixtures/state.js';
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

test('PostgreSQL refuses URL parameters that would override TLS or the search_path', async () => {
  const url = new URL(connectionString);
  for (const [key, value] of [
    ['sslmode', 'disable'],
    ['SSLROOTCERT', '/tmp/ca.pem'],
    ['options', '-c search_path=public'],
    ['Options', '-c search_path=public'],
  ]) {
    const refused = new URL(url);
    refused.searchParams.set(key!, value!);
    await assert.rejects(
      PostgresState.open({ connectionString: refused.href, schema: schemaFor() }),
      { code: 'invalid_config' },
      key,
    );
  }
});

test('PostgreSQL opens, migrates and reads in a mixed-case schema on both pools', async (t) => {
  const schema = `Mixed_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  t.after(() => dropSchema(schema));
  const state = await PostgresState.open({ connectionString, schema });
  t.after(() => state.close());
  await state.migrate('test', [{ version: 1, sql: 'CREATE TABLE records(id TEXT PRIMARY KEY);' }]);
  await state.transaction(async (tx) => {
    assert.equal(
      (await tx.get<{ schema: string }>('SELECT current_schema() AS schema'))?.schema,
      schema,
    );
    await tx.run('INSERT INTO records VALUES(?)', 'one');
    await state.appendEvent(tx, event);
  });
  assert.deepEqual(
    await state.read((sql) =>
      sql.all<{ id: string; schema: string }>('SELECT id, current_schema() AS schema FROM records'),
    ),
    [{ id: 'one', schema }],
  );
  assert.equal(await state.eventHead(), 1);
  // The lowercase folding of the name is a different schema, and nothing landed there.
  const admin = new Pool({ connectionString });
  t.after(() => admin.end());
  const { rows } = await admin.query('SELECT nspname FROM pg_namespace WHERE nspname = $1', [
    schema.toLowerCase(),
  ]);
  assert.deepEqual(rows, []);
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

test("PostgreSQL: a read's sibling query waits for the transaction the read started", async (t) => {
  const { state } = await fixture(t);
  const code = (error: { code?: string }) => error.code;
  // A sibling that ran on the connection would join the child, or abort it by failing.
  for (const sibling of ['SELECT 1/0', 'SELECT 1']) {
    const entered = deferred();
    const outcomes = await state.read((sql) =>
      Promise.all([
        state
          .transaction(async (tx) => {
            await state.appendEvent(tx, event);
            entered.resolve();
            await new Promise((resolve) => setTimeout(resolve, 20));
            await state.appendEvent(tx, { ...event, subjectId: 'second' });
          })
          .then(() => 'ok', code),
        entered.promise.then(() => sql.get(sibling)).then(() => 'ran', code),
      ]),
    );
    assert.deepEqual(outcomes, ['ok', 'transaction_busy']);
  }
  assert.equal(await state.eventHead(), 4, "Both of each child's rows commit");
  // Before and after its transaction, and inside a snapshot it opened, the read reads.
  const readOnly = await state.read(async (sql) => {
    await sql.get('SELECT 1');
    await state.transaction(() => undefined);
    await state.snapshot(() => state.transaction(async (tx) => await tx.get('SELECT 1')));
    return (await sql.get<{ n: number }>('SELECT count(*)::int AS n FROM events'))!.n;
  });
  assert.equal(readOnly, 4);
  // The child's own callback may use the read's `sql`: it runs on the child's transaction.
  assert.equal(
    await state.read((sql) =>
      state.transaction(async (tx) => {
        await state.appendEvent(tx, event);
        return (await sql.get<{ n: number }>('SELECT count(*)::int AS n FROM events'))!.n;
      }),
    ),
    5,
  );
  // A snapshot the read opened owns the connection the same way.
  const opened = deferred();
  const release = deferred();
  const busy = await state.read((sql) =>
    Promise.all([
      state.snapshot(async () => {
        opened.resolve();
        await release.promise;
      }),
      opened.promise
        .then(() => sql.get('SELECT 1'))
        .then(() => 'ran', code)
        .finally(() => release.resolve()),
    ]),
  );
  assert.equal(busy[1], 'transaction_busy');
});

test('State.ambient is the transaction this context runs in, and nothing outside one', async (t) => {
  const { state } = await fixture(t);
  assert.equal(state.ambient, undefined);
  await state.read(async () => assert.equal(state.ambient, undefined));
  await state.transaction(async (tx) => {
    assert.equal(state.ambient, tx);
    // A read inside a transaction reads on it; so does anything that joins it.
    await state.read(async (sql) => assert.equal(state.ambient, sql));
  });
  await state.read(() => state.transaction(async (tx) => assert.equal(state.ambient, tx)));
  await state.snapshot(async () => {
    assert.equal(state.ambient, undefined, "A snapshot's root has no transaction of its own");
    await state.transaction(async (tx) => {
      assert.equal(state.ambient, tx);
      await assert.rejects(tx.run('SELECT 1'), { code: 'read_only_scope' });
    });
    assert.equal(state.ambient, undefined);
  });
  await state.read(() =>
    state.snapshot(async () => {
      assert.equal(state.ambient, undefined, "A snapshot's root in a read has none either");
      await state.transaction(async (tx) => assert.equal(state.ambient, tx));
    }),
  );
  assert.equal(state.ambient, undefined);
});

test('PostgreSQL: a snapshot inside a plain read is a read-only transaction on its connection', async (t) => {
  // A short lock timeout: a snapshot that took the writer lock would fail with state_timeout.
  const { state } = await fixture(t, { lockTimeoutMs: 300 });
  await state.transaction(async (tx) => await state.appendEvent(tx, event));
  await state.read(async () => {
    assert.equal(state.readScope, false);
    await state.snapshot(async () => assert.equal(state.readScope, true));
  });

  // Another writer holds the writer lock: the snapshot's reads still answer.
  const locked = deferred();
  const release = deferred();
  const writer = state.transaction(async () => {
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  try {
    assert.equal(
      await state.read(() =>
        state.snapshot(() => state.transaction(async (tx) => await state.eventHead(tx))),
      ),
      1,
    );
  } finally {
    release.resolve();
    await writer;
  }

  // A write there is refused and commits nothing.
  await assert.rejects(
    state.read(() =>
      state.snapshot(() => state.transaction(async (tx) => await state.appendEvent(tx, event))),
    ),
    { code: 'read_only_scope' },
  );
  await assert.rejects(
    state.read(() =>
      state.snapshot(() =>
        state.transaction(async (tx) => {
          await tx.run(
            'INSERT INTO component_migrations(component,version,hash) VALUES(?,?,?)',
            'snapshot',
            1,
            'hash',
          );
        }),
      ),
    ),
    { code: 'read_only_scope' },
  );
  // A write that returns rows goes through get/all; PostgreSQL refuses it the same way.
  await assert.rejects(
    state.read(() =>
      state.snapshot(() =>
        state.transaction(
          async (tx) =>
            await tx.get(
              'INSERT INTO component_migrations(component,version,hash) VALUES(?,?,?) RETURNING version',
              'snapshot',
              1,
              'hash',
            ),
        ),
      ),
    ),
    { code: 'read_only_scope', status: 409 },
  );
  assert.equal(await state.eventHead(), 1);

  // It is the read's one transaction: a second at the same time is refused.
  await assert.rejects(
    state.read(() => Promise.all([state.snapshot(async () => 1), state.snapshot(async () => 2)])),
    { code: 'nested_transaction' },
  );
  await assert.rejects(
    state.read(() => Promise.all([state.snapshot(async () => 1), state.transaction(() => 2)])),
    { code: 'nested_transaction' },
  );
  // One after another, each gets its own.
  assert.deepEqual(
    await state.read(async () => [
      await state.snapshot(async () => await state.eventHead()),
      await state.snapshot(async () => state.readScope),
    ]),
    [1, true],
  );

  // Inside it, State cannot close, and an isolated read recovers from a failing statement.
  await state.read(() =>
    state.snapshot(async () => {
      await assert.rejects(state.close(), { code: 'transaction_active' });
      await assert.rejects(
        state.isolated(() => state.transaction(async (tx) => await tx.get('SELECT 1/0'))),
        { code: 'state_unavailable' },
      );
      assert.equal(await state.isolated(async () => await state.eventHead()), 1);
    }),
  );

  // Inside a write transaction a snapshot still reads that transaction's own rows.
  await state.transaction(async (tx) => {
    await state.appendEvent(tx, event);
    assert.equal(await state.snapshot(async () => await state.eventHead()), 2);
  });
  // The read's connection is usable again once the snapshot ends.
  assert.equal(
    await state.read(async (sql) => {
      await state.snapshot(async () => undefined);
      return (await sql.get<{ n: number }>('SELECT count(*)::int AS n FROM events'))!.n;
    }),
    2,
  );
});

test('PostgreSQL: a write queued on the writer lock holds no reader connection', async (t) => {
  // One reader connection, refused quickly: a read that cannot get it fails with state_busy.
  const { state, schema } = await fixture(t, { readConnections: 1, connectionTimeoutMs: 300 });
  const holder = new Pool({ connectionString, max: 1 });
  const client = await holder.connect();
  t.after(async () => {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await holder.end();
  });
  // Another instance holds this schema's writer lock.
  await client.query('BEGIN');
  await client.query(
    'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
    [`merv-state:${schema}`],
  );
  const pid = (await client.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid'))
    .rows[0]!.pid;
  const waiting = async (count: number) => {
    for (;;) {
      const { rows } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE NOT granted AND $1 = ANY(pg_catalog.pg_blocking_pids(pid))',
        [pid],
      );
      if (rows[0]!.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const plainRead = () => state.read((sql) => sql.get('SELECT 1 AS value'));
  // A component joins its caller's transaction or opens its own, as Sessions does.
  const write = <T>(fn: (tx: Transaction) => Promise<T>) => {
    const tx = state.ambient;
    return tx ? fn(tx) : state.transaction(fn);
  };
  const writing = write((tx) => state.appendEvent(tx, event));
  await waiting(1);
  assert.deepEqual(await plainRead(), { value: 1 });
  // The form it replaces holds the only reader connection while it waits, so pages starve.
  const held = state.read((sql) =>
    'transactionId' in sql
      ? state.appendEvent(sql as Transaction, event)
      : state.transaction((tx) => state.appendEvent(tx, event)),
  );
  await waiting(2);
  await assert.rejects(plainRead(), { code: 'state_busy' });
  await client.query('ROLLBACK');
  await Promise.all([writing, held]);
  assert.equal(await state.eventHead(), 2);
});

test('PostgreSQL migrations run their SQL as written: a jsonb ? operator is SQL, not a bind marker', async (t) => {
  const { state } = await fixture(t);
  await state.migrate('jq', [
    {
      version: 1,
      sql: "CREATE TABLE jq(d JSONB CHECK (d ? 'id' AND NOT d ?| array['x'] AND d ?& array['id']))",
    },
  ]);
  await state.transaction((tx) => tx.run('INSERT INTO jq(d) VALUES(\'{"id":1}\'::jsonb)'));
  await assert.rejects(
    state.transaction((tx) => tx.run("INSERT INTO jq(d) VALUES('{}'::jsonb)")),
    { code: 'state_constraint' },
  );
});

test('PostgreSQL errors keep a sanitized, non-enumerable cause, and a failed migration names itself', async (t) => {
  const { state } = await fixture(t);
  const failure = await state.migrate('jb', [{ version: 1, sql: 'CREATE TABLE jb(' }]).then(
    () => assert.fail('The migration must fail'),
    (error: MervError) => error,
  );
  assert.ok(failure instanceof MervError);
  assert.equal(failure.code, 'state_unavailable');
  assert.equal(failure.status, 503);
  assert.match(failure.message, /^Migration jb\/1 failed \(SQLSTATE 42601\)$/);
  assert.equal((failure.cause as { sqlstate?: string }).sqlstate, '42601');
  assert.equal(Object.keys(failure).includes('cause'), false);
  assert.equal(JSON.stringify(failure).includes('cause'), false);
  assert.equal(JSON.stringify(failure).includes('42601'), false);
  assert.deepEqual(
    await state.read((sql) =>
      sql.all("SELECT version FROM component_migrations WHERE component='jb'"),
    ),
    [],
  );

  await state.migrate('jc', [{ version: 1, sql: 'CREATE TABLE jc(id TEXT PRIMARY KEY)' }]);
  await state.transaction((tx) => tx.run('INSERT INTO jc VALUES(?)', 'secret-row-value'));
  const conflict = await state
    .transaction((tx) => tx.run('INSERT INTO jc VALUES(?)', 'secret-row-value'))
    .then(
      () => assert.fail('The insert must conflict'),
      (error: MervError) => error,
    );
  assert.equal(conflict.code, 'state_conflict');
  const cause = conflict.cause as Record<string, unknown>;
  assert.equal(cause.sqlstate, '23505');
  assert.equal(cause.constraint, 'jc_pkey');
  assert.equal(cause.table, 'jc');
  assert.equal('detail' in cause, false);
  assert.equal('message' in cause, false);
  assert.equal(JSON.stringify(cause).includes('secret-row-value'), false);
  assert.equal(JSON.stringify(conflict).includes('cause'), false);
});

test('State refuses malformed events, cursors and migration versions', async (t) => {
  const { state } = await fixture(t);
  for (const before of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(state.latestEvents('project', before), { code: 'invalid_cursor' });
  assert.deepEqual(await state.latestEvents('project', 0), []);
  await assert.rejects(state.migrate('too-far', [{ version: 2_147_483_648, sql: 'SELECT 1' }]), {
    code: 'invalid_migration',
  });
  await state.migrate('far', [{ version: 2_147_483_647, sql: 'SELECT 1' }]);
  const { subjectId: _subjectId, ...withoutSubject } = event;
  for (const malformed of [
    withoutSubject,
    { ...event, type: 7 },
    { ...event, data: undefined },
    { projectId: 'project', actorId: 'actor', type: 'test.created', subjectId: 'subject' },
  ])
    await assert.rejects(
      state.transaction((tx) =>
        state.appendEvent(tx, malformed as unknown as Parameters<typeof state.appendEvent>[1]),
      ),
      { code: 'invalid_event' },
    );
  await state.transaction((tx) => state.appendEvent(tx, { ...event, data: {} }));
  assert.equal(await state.eventHead(), 1);
});

test('State.findEvents returns the oldest events matching every field, its source included', async (t) => {
  const { state } = await fixture(t);
  const source = (commandId: string) => ({ source: { kind: 'conversation', commandId } });
  const [first, second, third] = await state.transaction(async (tx) => [
    await state.appendEvent(tx, { ...event, data: source('a') }),
    await state.appendEvent(tx, { ...event, type: 'test.changed', data: source('b') }),
    await state.appendEvent(tx, { ...event, data: source('b') }),
    await state.appendEvent(tx, { ...event, projectId: 'other' }),
  ]);
  const ids = async (filter: Partial<Parameters<typeof state.findEvents>[0]>, limit = 10) =>
    (await state.findEvents({ projectId: 'project', ...filter }, limit)).map(({ id }) => id);
  assert.deepEqual(await ids({}), [first!.id, second!.id, third!.id]);
  assert.deepEqual(await ids({}, 1), [first!.id]);
  assert.deepEqual(await ids({ type: 'test.created' }), [first!.id, third!.id]);
  assert.deepEqual(await ids({ type: 'test.created', after: first!.id }), [third!.id]);
  assert.deepEqual(await ids({ source: { commandId: 'b' } }), [second!.id, third!.id]);
  assert.deepEqual(await ids({ source: { commandId: 'b', kind: 'session' } }), []);
  assert.deepEqual(await ids({ subjectId: 'elsewhere' }), []);
  assert.deepEqual(await ids({ actorId: 'actor', since: first!.createdAt }), [
    first!.id,
    second!.id,
    third!.id,
  ]);
  for (const limit of [0, 1001, 1.5])
    await assert.rejects(state.findEvents({ projectId: 'project' }, limit), {
      code: 'invalid_cursor',
    });
});

test('PostgreSQL refuses a read with state_busy when every reader connection is held', async (t) => {
  const { state } = await fixture(t, { readConnections: 1, connectionTimeoutMs: 200 });
  const entered = deferred(),
    release = deferred();
  const held = state.read(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    await assert.rejects(
      state.read((sql) => sql.get('SELECT 1')),
      { code: 'state_busy', status: 503 },
    );
  } finally {
    release.resolve();
    await held;
  }
  assert.deepEqual(await state.read((sql) => sql.get('SELECT 1 AS value')), { value: 1 });
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

test('PostgreSQL events guards install once however often the schema is opened', async (t) => {
  const { state, schema } = await fixture(t);
  await state.transaction((tx) => state.appendEvent(tx, event));
  // A second instance and a concurrent pair boot the same schema under the writer lock.
  const reopened = await Promise.all(
    [1, 2, 3].map(() => PostgresState.open({ connectionString, schema })),
  );
  t.after(() => Promise.all(reopened.map((other) => other.close())));
  assert.deepEqual(
    await state.read((sql) =>
      sql.all<{ name: string; count: number }>(
        `SELECT tgname AS name, count(*)::int AS count FROM pg_catalog.pg_trigger
         WHERE tgrelid='events'::regclass AND NOT tgisinternal GROUP BY tgname ORDER BY tgname`,
      ),
    ),
    [
      { name: 'events_immutable', count: 1 },
      { name: 'events_no_truncate', count: 1 },
    ],
  );
  await assert.rejects(
    reopened[0]!.transaction((tx) => tx.run('TRUNCATE events')),
    { code: 'state_constraint' },
  );
  assert.equal(await state.eventHead(), 1);
});

test('PostgreSQL migrations apply in order in one run and refuse to insert an older one', async (t) => {
  const { state } = await fixture(t);
  const step = (version: number) => ({
    version,
    sql: `CREATE TABLE ordered_${version}(id INTEGER)`,
  });
  await state.migrate('ordered', [step(1), step(3), step(4)]);
  await assert.rejects(state.migrate('ordered', [step(1), step(2), step(3), step(4)]), {
    code: 'migration_order',
  });
  await assert.rejects(state.migrate('ordered', [step(1), step(3)]), { code: 'migration_ahead' });
  await state.migrate('ordered', [step(1), step(3), step(4), step(5), step(6)]);
  assert.deepEqual(
    await state.read((sql) =>
      sql.all(
        "SELECT version FROM component_migrations WHERE component='ordered' ORDER BY version",
      ),
    ),
    [1, 3, 4, 5, 6].map((version) => ({ version })),
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

test('PostgreSQL: a backend killed mid-transaction fails that transaction, not the process', async (t) => {
  const { state } = await fixture(t, { maxConnections: 1 });
  const admin = new Pool({ connectionString, max: 1 });
  t.after(() => admin.end());
  const kill = (pid: number) => admin.query('SELECT pg_terminate_backend($1)', [pid]);
  // Between statements (awaiting other work inside the transaction), then inside one.
  await assert.rejects(
    state.transaction(async (tx) => {
      const { pid } = (await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!;
      await kill(pid);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.get('SELECT 1 AS x');
    }),
    { code: 'state_unavailable' },
  );
  await assert.rejects(
    state.transaction(async (tx) => {
      const { pid } = (await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!;
      setTimeout(() => void kill(pid), 100);
      await tx.get('SELECT pg_sleep(2) AS x');
    }),
    { code: 'state_unavailable' },
  );
  // The broken connections were discarded; the pool reconnects.
  await state.transaction((tx) => state.appendEvent(tx, event));
  assert.equal((await state.events('project')).length, 1);
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

test('State.remember keeps an answer for one snapshot only, and never a failure', async (t) => {
  const { state } = await fixture(t);
  let computed = 0;
  const compute = async () => ++computed;
  // Outside any scope every call computes; a write transaction keeps its answer until it ends.
  assert.equal(await state.remember('k', compute), 1);
  await state.transaction(async () => {
    assert.equal(await state.remember('k', compute), 2);
    assert.equal(await state.remember('k', compute), 2);
  });
  // One snapshot answers once, across its sibling transactions; the next snapshot afresh.
  await state.snapshot(async () => {
    const [a, b] = await Promise.all([
      state.transaction(() => state.remember('k', compute)),
      state.transaction(() => state.remember('k', compute)),
    ]);
    assert.deepEqual([a, b, await state.remember('k', compute)], [3, 3, 3]);
    assert.equal(await state.remember('other', compute), 4);
  });
  await state.snapshot(async () => assert.equal(await state.remember('k', compute), 5));
  // A failure is not kept: a sibling that shared it, and the next caller, decide afresh.
  await state.snapshot(async () => {
    let failing = true;
    const flaky = async () => {
      computed++;
      if (failing) throw new MervError('flaky', 'flaky');
      return computed;
    };
    const first = state.remember('f', flaky);
    failing = false;
    const second = state.remember('f', flaky);
    await assert.rejects(first, { code: 'flaky' });
    assert.equal(await second, 7);
    assert.equal(await state.remember('f', flaky), 7);
  });
});

test('State.remember in a write transaction forgets everything at each statement that may write', async (t) => {
  const { state } = await fixture(t);
  await state.migrate('memo', [
    { version: 1, sql: 'CREATE TABLE memo_rows(id TEXT PRIMARY KEY, value INTEGER NOT NULL)' },
  ]);
  let reads = 0;
  await state.transaction(async (tx) => {
    await tx.run("INSERT INTO memo_rows VALUES ('a', 1)");
    const value = () =>
      state.remember('memo:a', async () => {
        reads++;
        return (await tx.get<{ value: number }>("SELECT value FROM memo_rows WHERE id='a'"))!.value;
      });
    // Reads alone share one answer.
    assert.deepEqual([await value(), await value(), reads], [1, 1, 1]);
    // run(), and a write through get() or all() (RETURNING, a CTE), each retire it.
    await tx.run("UPDATE memo_rows SET value=2 WHERE id='a'");
    assert.deepEqual([await value(), await value(), reads], [2, 2, 2]);
    await tx.get("UPDATE memo_rows SET value=3 WHERE id='a' RETURNING value");
    assert.deepEqual([await value(), reads], [3, 3]);
    await tx.all('WITH w AS (UPDATE memo_rows SET value=4 RETURNING id) SELECT id FROM w');
    assert.deepEqual([await value(), reads], [4, 4]);
    // A plain read does not.
    await tx.all('SELECT id FROM memo_rows');
    assert.deepEqual([await value(), reads], [4, 4]);
  });
  // Each write transaction starts with nothing remembered.
  await state.transaction(async (tx) => {
    await tx.run("UPDATE memo_rows SET value=5 WHERE id='a'");
  });
  assert.equal(
    await state.transaction(() =>
      state.remember('memo:a', async () => {
        reads++;
        return 5;
      }),
    ),
    5,
  );
  assert.equal(reads, 5);
});
