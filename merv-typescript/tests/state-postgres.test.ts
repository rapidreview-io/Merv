import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { PostgresState, SqliteState, statePlugin } from '@merv/state';
import { postgresParameters } from '@merv/state/parameters';
import type { Transaction } from '@merv/contracts';

const connectionString = process.env.MERV_TEST_POSTGRES_URL;
const postgres = { skip: !connectionString };
const event = {
  projectId: 'project',
  actorId: 'actor',
  type: 'test.created',
  subjectId: 'subject',
  data: { value: 1 },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  t: TestContext,
  config: { lockTimeoutMs?: number; maxConnections?: number } = {},
) {
  const schema = `merv_test_${randomUUID().replaceAll('-', '')}`;
  const state = await PostgresState.open({
    connectionString: connectionString!,
    schema,
    ...config,
  });
  t.after(async () => {
    await state.close();
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
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

test(
  'PostgreSQL executes bound SQL with carriage-return comments, dollar identifiers and Unicode quote tags',
  postgres,
  async (t) => {
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
  },
);

test('State config retains local path and requires explicit verified TLS settings', () => {
  assert.deepEqual(statePlugin.Config.parse({ path: ':memory:' }), { path: ':memory:' });
  assert.equal(statePlugin.Config.parse({ backend: 'postgres' }).backend, 'postgres');
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

test(
  'PostgreSQL retains binary parameters when a caller reuses buffers before execution',
  postgres,
  async (t) => {
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
  },
);

test(
  'PostgreSQL drains sibling queries before releasing a failed read connection',
  postgres,
  async (t) => {
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
  },
);

for (const backend of ['sqlite', 'postgres'] as const) {
  test(
    `${backend}: a failed read drains the transaction it started`,
    { skip: backend === 'postgres' && !connectionString },
    async (t) => {
      const state = backend === 'sqlite' ? new SqliteState(':memory:') : (await fixture(t)).state;
      if (backend === 'sqlite') t.after(() => state.close());
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
        assert.equal(
          finished,
          false,
          'the connection remains owned until its transaction finishes',
        );
        await late;
        released.resolve();
        assert.equal(await reading, failure);
        assert.equal(await state.eventHead(), 2);
      } finally {
        released.resolve();
        await Promise.allSettled([reading, child, late]);
      }
    },
  );
}

test(
  'PostgreSQL boots in a pre-created owned schema without database CREATE privilege',
  postgres,
  async (t) => {
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
    const url = new URL(connectionString!);
    url.username = role;
    url.password = password;
    state = await PostgresState.open({ connectionString: url.toString(), schema });
    await state.migrate('least-privilege', [
      {
        version: 1,
        sql: 'CREATE TABLE owned_record(id TEXT PRIMARY KEY)',
        postgres: 'CREATE TABLE owned_record(id TEXT PRIMARY KEY)',
      },
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
  },
);

test(
  'PostgreSQL uses native migrations and keeps records, events and checksum history atomic',
  postgres,
  async (t) => {
    const { state } = await fixture(t);
    const migrations = [
      {
        version: 1,
        sql: 'invalid PostgreSQL; SQLite history is retained',
        postgres: 'CREATE TABLE records(id TEXT PRIMARY KEY, retry_at BIGINT NOT NULL);',
      },
    ];
    await state.migrate('test', migrations);
    await state.migrate('test', migrations);
    await assert.rejects(state.migrate('test', [{ version: 1, sql: '', postgres: 'SELECT 1' }]), {
      code: 'migration_changed',
    });
    await assert.rejects(state.migrate('missing', [{ version: 1, sql: 'SELECT 1' }]), {
      code: 'migration_dialect_missing',
    });
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
    await assert.rejects(
      state.transaction((tx) => tx.run('UPDATE events SET type=?', 'mutated')),
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
  },
);

test(
  'PostgreSQL serializes writers across app instances before allocating event IDs',
  postgres,
  async (t) => {
    const { state, schema } = await fixture(t);
    const other = await PostgresState.open({ connectionString: connectionString!, schema });
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
  },
);

test(
  'PostgreSQL lock timeout rolls back the checked-out connection for later requests',
  postgres,
  async (t) => {
    const { state, schema } = await fixture(t);
    const other = await PostgresState.open({
      connectionString: connectionString!,
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
  },
);

test(
  'PostgreSQL disposal drains admitted async work before closing its pool',
  postgres,
  async (t) => {
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
  },
);

test(
  'PostgreSQL snapshot scopes run sibling reads side by side, each in its own transaction context',
  postgres,
  async (t) => {
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
  },
);

test(
  'PostgreSQL appendEvent receipt remains identical to its inserted event during caller edits',
  postgres,
  async (t) => {
    const { state } = await fixture(t);
    const input = structuredClone(event);
    const receipt = await state.transaction(async (tx) => {
      const pending = state.appendEvent(tx, input);
      input.subjectId = 'changed-after-insert';
      input.data.value = 99;
      return await pending;
    });
    assert.equal(receipt.subjectId, event.subjectId);
    assert.deepEqual(receipt.data, event.data);
    assert.deepEqual((await state.events(event.projectId))[0], receipt);
  },
);

test('PostgreSQL queued migrations retain their version and dialect SQL', postgres, async (t) => {
  const { state } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const writer = state.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const original = [
    { version: 1, sql: 'SELECT 1;', postgres: 'CREATE TABLE original_migration(value TEXT);' },
  ];
  const input = structuredClone(original);
  const pending = state.migrate('snapshot', input);
  try {
    input[0].version = 99;
    input[0].postgres = 'CREATE TABLE changed_migration(value TEXT);';
  } finally {
    release.resolve();
  }
  await Promise.all([writer, pending]);
  assert.deepEqual(
    (
      await state.read((sql) =>
        sql.all<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('original_migration','changed_migration') ORDER BY table_name",
        ),
      )
    ).map((row) => row.table_name),
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
});
