import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { PostgresState, statePlugin } from '@merv/state';
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
});

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
    const work = state.transaction(async (tx) => {
      entered.resolve();
      await release.promise;
      await state.appendEvent(tx, event);
    });
    await entered.promise;
    const read = state.eventHead();
    const closing = state.close();
    await assert.rejects(state.eventHead(), { code: 'state_closed' });
    release.resolve();
    await work;
    assert.ok((await read) > 0);
    await closing;
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
    const heads = await state.snapshot(async () =>
      Promise.all(
        Array.from({ length: 6 }, async () =>
          state.transaction(async (tx) => {
            state.assertTransaction(tx);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return (await state.events(event.projectId)).length;
          }),
        ),
      ),
    );
    assert.deepEqual(heads, [1, 1, 1, 1, 1, 1]);
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
