import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient, type QueryResult } from 'pg';
import {
  check,
  digest,
  MervError,
  now,
  plain,
  type Migration,
  type Sql,
  type SqlValue,
  type State,
  type StoredEvent,
  type Transaction,
} from '@merv/contracts';
import { postgresParameters } from './parameters.js';

export interface PostgresConfig {
  connectionString: string;
  schema?: string;
  /** The writers' pool, whose connections may queue on the state lock. */
  maxConnections?: number;
  /**
   * A separate pool for reads, so writers queued on the state lock never starve a page. One
   * instance opens up to `maxConnections + readConnections` connections.
   */
  readConnections?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Bounds every lock wait, the writer lock included: a writer queued longer fails with state_timeout. */
  lockTimeoutMs?: number;
  ssl?: { rejectUnauthorized: true; ca?: string };
}

/** Checked again where the schema is interpolated into SQL, for callers that skip the plugin Config. */
export const POSTGRES_SCHEMA = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
/** A read-only transaction: a consistent snapshot that takes no writer lock. */
const READ_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
export const POSTGRES_DEFAULTS = {
  schema: 'merv',
  maxConnections: 10,
  readConnections: 6,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 5000,
} as const;

function safeInteger(value: string): number {
  const number = Number(value);
  check(
    Number.isSafeInteger(number),
    'state_integer_range',
    'Database integer exceeds the safe number range',
    500,
  );
  return number;
}

/** What a log may keep of a PostgreSQL error: never its message or detail, which can carry row values. */
interface DatabaseErrorCause {
  sqlstate?: string;
  constraint?: string;
  table?: string;
  column?: string;
  routine?: string;
  position?: string;
}

/**
 * Do not forward connection strings, SQL parameter values or server details to clients. The
 * sanitized cause is non-enumerable: logs show it, and JSON responses never carry it.
 */
function databaseError(error: unknown): MervError {
  if (error instanceof MervError) return error;
  const pg = (error ?? {}) as { code?: string } & Omit<DatabaseErrorCause, 'sqlstate'>;
  const fail = (code: string, message: string, status: number) =>
    Object.defineProperty(new MervError(code, message, status), 'cause', {
      value: {
        // Node socket errors (ECONNRESET, ...) also carry `code`; only a SQLSTATE is one.
        sqlstate: /^[0-9A-Z]{5}$/.test(pg.code ?? '') ? pg.code : undefined,
        constraint: pg.constraint,
        table: pg.table,
        column: pg.column,
        routine: pg.routine,
        position: pg.position,
      } satisfies DatabaseErrorCause,
    });
  const code = pg.code;
  if (code === '23505') return fail('state_conflict', 'Database record already exists', 409);
  if (['23503', '23514', '23502', 'P0001'].includes(code ?? ''))
    return fail('state_constraint', 'Database constraint rejected the operation', 409);
  if (code === '40001' || code === '40P01')
    return fail('transaction_conflict', 'Database transaction conflicted; retry the request', 409);
  if (code === '57014' || code === '55P03')
    return fail('state_timeout', 'Database operation timed out', 503);
  if (/timeout exceeded when trying to connect/.test((error as Error)?.message ?? ''))
    return fail('state_busy', 'Every database connection is in use; retry shortly', 503);
  return fail('state_unavailable', 'PostgreSQL operation failed', 503);
}

interface Connection {
  run(sql: string, params: SqlValue[]): ReturnType<Sql['run']>;
  get<T>(sql: string, params: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, params: SqlValue[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  discard(): void;
}

interface Context {
  connection: Connection;
  live: boolean;
  sql: Sql;
  transaction?: Transaction;
  eventWritten: boolean;
  childTransaction?: Promise<unknown>;
  /** A read scope: nested "transactions" read on the same snapshot and refuse writes. */
  readOnly?: boolean;
  /** Shared by every scope of one snapshot: whether an isolated read holds its savepoint. */
  isolation?: { open: boolean };
}

/** Explicit transactions stay on one connection; async context never crosses requests. */
export class PostgresState implements State {
  private readonly context = new AsyncLocalStorage<Context>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private closing?: Promise<void>;
  private closed = false;

  private readonly pool: Pool;
  private readonly readers: Pool;
  private readonly schema: string;
  /**
   * Opens a write transaction and takes the writer lock in one round trip. This advisory lock is
   * the writer serialization: one writer per schema at a time, across app instances, which also
   * keeps event IDs in commit order. The key is the one earlier servers bound as a parameter, so
   * old and new instances still serialize with each other during a deploy.
   */
  private readonly writeBegin: string;

  private constructor(config: PostgresConfig) {
    this.schema = config.schema ?? POSTGRES_DEFAULTS.schema;
    check(POSTGRES_SCHEMA.test(this.schema), 'invalid_config', 'Invalid PostgreSQL schema');
    this.writeBegin = `BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('merv-state:${this.schema}', 0))`;
    // URI TLS parameters override pg's ssl object. Keep TLS exclusively in the explicit config.
    let url: URL;
    try {
      url = new URL(config.connectionString);
    } catch {
      throw new MervError('invalid_config', 'Invalid PostgreSQL connection string');
    }
    check(
      ['postgres:', 'postgresql:'].includes(url.protocol),
      'invalid_config',
      'Invalid PostgreSQL protocol',
    );
    check(
      ![...url.searchParams.keys()].some((key) => /^ssl/i.test(key)),
      'invalid_config',
      'Configure PostgreSQL TLS through the ssl option',
    );
    const pool = (max: number) => {
      const created = new Pool({
        connectionString: config.connectionString,
        max,
        connectionTimeoutMillis:
          config.connectionTimeoutMs ?? POSTGRES_DEFAULTS.connectionTimeoutMs,
        statement_timeout: config.statementTimeoutMs ?? POSTGRES_DEFAULTS.statementTimeoutMs,
        lock_timeout: config.lockTimeoutMs ?? POSTGRES_DEFAULTS.lockTimeoutMs,
        ssl: config.ssl ?? false,
        types: {
          getTypeParser: (oid, format) =>
            oid === 20 && format !== 'binary' ? safeInteger : types.getTypeParser(oid, format),
        },
      });
      // Idle clients can emit errors outside a query. pg removes them; later requests reconnect.
      created.on('error', () => undefined);
      return created;
    };
    // Writers queue on the state lock holding their connection; reads answer from their own pool.
    this.pool = pool(config.maxConnections ?? POSTGRES_DEFAULTS.maxConnections);
    this.readers = pool(config.readConnections ?? POSTGRES_DEFAULTS.readConnections);
  }

  static async open(config: PostgresConfig): Promise<PostgresState> {
    const state = new PostgresState(config);
    try {
      await state.operation(() =>
        state.connect((connection) =>
          state.within(connection, state.writeBegin, undefined, async () => {
            // Even IF NOT EXISTS requires database CREATE. Production can pre-create
            // an owned schema and give this role authority only inside that schema.
            const existing = await connection.get<{ exists: number }>(
              'SELECT 1 AS exists FROM pg_catalog.pg_namespace WHERE nspname=?',
              [state.schema],
            );
            if (!existing) await connection.exec(`CREATE SCHEMA "${state.schema}"`);
            await connection.exec(`
CREATE TABLE IF NOT EXISTS component_migrations(component TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(component,version));
CREATE TABLE IF NOT EXISTS events(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, type TEXT NOT NULL, subject_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id,id);
CREATE INDEX IF NOT EXISTS events_subject ON events(project_id,subject_id,type,id);
CREATE OR REPLACE FUNCTION merv_events_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION 'Events are immutable and retained'; END;
$merv$;
DO $merv$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='events'::regclass AND tgname='events_immutable') THEN
    CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION merv_events_immutable();
  END IF;
END $merv$;`);
          }),
        ),
      );
      return state;
    } catch (error) {
      await state.close();
      throw databaseError(error);
    }
  }

  /** Reads take a connection of their own kind, so writers queued on the lock never starve a page. */
  private async connect<T>(
    fn: (connection: Connection) => Promise<T>,
    pool: Pool = this.pool,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throw databaseError(error);
    }
    let discard = false;
    // Sibling reads of one snapshot arrive together; one connection runs them in turn.
    let tail: Promise<unknown> = Promise.resolve();
    // `exec` passes no parameters: its SQL goes over the simple protocol, where a `?` is SQL
    // (jsonb `?`, `?|`, `?&`), not a bind marker. run/get/all always pass an array.
    const query = (sql: string, params?: SqlValue[]): Promise<QueryResult> => {
      const values = (params ?? []).map((value) =>
        value instanceof Uint8Array ? Buffer.from(value) : value,
      );
      const next = tail.then(
        async () =>
          await client.query(params ? postgresParameters(sql, values.length) : sql, values),
      );
      tail = next.catch(() => undefined);
      return next.catch((error) => {
        throw databaseError(error);
      });
    };
    try {
      try {
        await client.query("SELECT pg_catalog.set_config('search_path', $1, false)", [
          `"${this.schema}"`,
        ]);
      } catch (error) {
        discard = true;
        throw databaseError(error);
      }
      return await fn({
        run: async (sql, params) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
        get: async <R>(sql: string, params: SqlValue[]) =>
          (await query(sql, params)).rows[0] as R | undefined,
        all: async <R>(sql: string, params: SqlValue[]) => (await query(sql, params)).rows as R[],
        exec: async (sql) => {
          if (!sql.trim()) return;
          const result = await query(sql);
          check(
            sql !== 'COMMIT' || result.command === 'COMMIT',
            'transaction_aborted',
            'Database transaction was rolled back after an earlier statement failed',
            409,
          );
        },
        discard: () => {
          discard = true;
        },
      });
    } finally {
      await tail;
      client.release(discard);
    }
  }

  /**
   * Runs `run` in a transaction that `begin` opens on `connection`, and commits it or rolls it
   * back. `begin` is inside the try: a writer-lock timeout leaves an aborted transaction block,
   * which must be rolled back before the pool lends the connection again. `scope` retires before
   * COMMIT or ROLLBACK is sent, so a late sibling fails with transaction_closed instead of
   * running in autocommit without the writer lock.
   */
  private async within<T>(
    connection: Connection,
    begin: string,
    scope: Context | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      await connection.exec(begin);
      const value = await run();
      if (scope) scope.live = false;
      // exec reports a COMMIT the server turned into a rollback as transaction_aborted.
      await connection.exec('COMMIT');
      return value;
    } catch (error) {
      if (scope) scope.live = false;
      try {
        await connection.exec('ROLLBACK');
      } catch {
        connection.discard();
      }
      throw error;
    } finally {
      if (scope) scope.live = false;
    }
  }

  private async shutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.readers.end()]);
  }

  private operation<T>(fn: () => Promise<T>): Promise<T> {
    check(!this.closed && !this.closing, 'state_closed', 'State is closing or closed', 503);
    const operation = Promise.resolve().then(fn);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private scope(connection: Connection, parent?: Context): Context {
    const scope = (
      parent ? Object.create(parent) : { connection, live: true, eventWritten: false }
    ) as Context;
    const valid = () => {
      const current = this.context.getStore();
      check(
        scope.live &&
          !this.closed &&
          current?.live &&
          current.connection === connection &&
          (!scope.transaction || current.transaction === scope.transaction),
        'transaction_closed',
        'Database scope is no longer active',
      );
      // While a plain read's child transaction is open it owns the read's connection: a sibling
      // query of the read would run inside it, or abort it by failing. Only the read's own
      // context is refused; the child's callback may still use the read's `sql` on purpose.
      check(
        !(current === scope && scope.childTransaction && !scope.transaction && !scope.readOnly),
        'transaction_busy',
        'Wait for the transaction this read started',
        409,
      );
    };
    scope.sql = {
      run: async (sql, ...params) => {
        valid();
        check(!scope.readOnly, 'read_only_scope', 'A read scope cannot write', 409);
        return connection.run(sql, params);
      },
      get: async <T>(sql: string, ...params: SqlValue[]) => {
        valid();
        return connection.get<T>(sql, params);
      },
      all: async <T>(sql: string, ...params: SqlValue[]) => {
        valid();
        return connection.all<T>(sql, params);
      },
    };
    return scope;
  }

  private active(scope: Context): void {
    check(scope.live && !this.closed, 'transaction_closed', 'Database scope is no longer active');
  }

  private async transact<T>(
    connection: Connection,
    fn: (tx: Transaction) => T | Promise<T>,
  ): Promise<T> {
    const scope = this.scope(connection, this.context.getStore());
    // The parent read may retire while this admitted transaction drains.
    scope.live = true;
    const tx: Transaction = { ...scope.sql, transactionId: Symbol('transaction') };
    scope.transaction = tx;
    const value = await this.within(
      connection,
      this.writeBegin,
      scope,
      async () => await this.context.run(scope, () => fn(tx)),
    );
    if (scope.eventWritten) this.wake();
    return value;
  }

  /** Tells event listeners about a commit, outside any database scope. */
  private wake(): void {
    this.context.exit(() =>
      queueMicrotask(() => {
        if (this.closed) return;
        // Registrations created by a wakeup belong to the next commit. Still
        // honor withdrawals before admitting a snapshotted listener.
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) continue;
          try {
            void Promise.resolve(listener()).catch(() => {});
          } catch {
            /* Wakeups cannot undo a committed transaction. */
          }
        }
      }),
    );
  }

  async transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    const current = this.context.getStore();
    check(
      !current?.transaction,
      'nested_transaction',
      'Pass the existing transaction to component operations',
    );
    if (current?.readOnly) {
      // Every read-only tool runs in a snapshot scope, so the reads behind a page never
      // wait on the writer lock; a write attempted there is a bug and is refused. Sibling
      // reads of one page run side by side on the snapshot, each in its own async context,
      // so one part's read is never another part's nested transaction.
      this.active(current);
      const own = this.scope(current.connection, current);
      const tx: Transaction = { ...own.sql, transactionId: Symbol('read') };
      own.transaction = tx;
      try {
        return await this.context.run(own, () => fn(tx));
      } finally {
        own.live = false;
      }
    }
    if (current) return await this.child(current, () => this.transact(current.connection, fn));
    return this.operation(() => this.connect((connection) => this.transact(connection, fn)));
  }

  /**
   * Runs one transaction on a plain read's connection. The read owns that connection until the
   * transaction ends, so a second one at the same time is refused, and the read's own end waits
   * for it.
   */
  private async child<T>(current: Context, start: () => Promise<T>): Promise<T> {
    this.active(current);
    check(
      !current.childTransaction,
      'nested_transaction',
      'A transaction is already using this read scope',
    );
    const child = start();
    current.childTransaction = child;
    try {
      return await child;
    } finally {
      current.childTransaction = undefined;
    }
  }

  async read<T>(fn: (sql: Sql) => T | Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current) {
      this.active(current);
      return fn(current.transaction ?? current.sql);
    }
    return this.operation(() =>
      this.connect(async (connection) => {
        const scope = this.scope(connection);
        try {
          return await this.context.run(scope, () => fn(scope.sql));
        } finally {
          scope.live = false;
          await scope.childTransaction?.catch(() => {});
        }
      }, this.readers),
    );
  }

  get readScope(): boolean {
    return !!this.context.getStore()?.readOnly;
  }

  get ambient(): Transaction | undefined {
    return this.context.getStore()?.transaction;
  }

  /**
   * A read-only snapshot scope: component transactions opened inside it read on one
   * snapshot, take no writer lock, and are refused if they write. Inside a transaction or a
   * snapshot it runs the function there, which sees that scope's own rows. Inside a plain read
   * it opens the snapshot on the read's own connection, as that read's one transaction.
   */
  async snapshot<T>(fn: () => T | Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current?.transaction || current?.readOnly) return await fn();
    if (current)
      return await this.child(current, async () => {
        const scope = this.scope(current.connection, current);
        // The parent read may retire while this admitted snapshot drains.
        scope.live = true;
        scope.readOnly = true;
        scope.isolation = { open: false };
        return await this.within(
          current.connection,
          READ_BEGIN,
          scope,
          async () => await this.context.run(scope, fn),
        );
      });
    return this.operation(() =>
      this.connect(async (connection) => {
        const scope = this.scope(connection);
        scope.readOnly = true;
        scope.isolation = { open: false };
        return await this.within(
          connection,
          READ_BEGIN,
          scope,
          async () => await this.context.run(scope, fn),
        );
      }, this.readers),
    );
  }

  /**
   * Inside a snapshot, runs `fn` behind a savepoint of its own. A statement that fails there,
   * a timeout included, would otherwise abort the whole snapshot and every read after it; here
   * it is rolled back to the savepoint, `fn` fails with its own error, and the snapshot reads
   * on. Savepoints nest by time on the snapshot's one connection, so isolated calls run one at
   * a time and an overlapping or nested one is refused. A read `fn` leaves running is closed
   * with it. Outside any scope every read already has a transaction of its own, so `fn` runs as
   * it is; a write transaction cannot isolate its statements, so there it is refused.
   */
  async isolated<T>(fn: () => T | Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (!current?.readOnly) {
      check(
        !current?.transaction,
        'isolation_unavailable',
        'Only a snapshot isolates its reads',
        500,
      );
      return await fn();
    }
    this.active(current);
    const isolation = current.isolation!;
    check(
      !isolation.open,
      'isolation_overlap',
      'Isolated reads of one snapshot run one at a time',
      500,
    );
    isolation.open = true;
    const { connection } = current;
    // Isolated calls on one snapshot never overlap, so one name serves them all.
    const savepoint = 'merv_isolated';
    const scope = this.scope(connection, current);
    scope.live = true;
    try {
      await connection.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = await this.context.run(scope, fn);
        scope.live = false;
        // Refused when `fn` caught a failed statement of its own: the snapshot is aborted all
        // the same, so it is rolled back below and `fn` fails.
        await connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        scope.live = false;
        try {
          await connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          connection.discard();
        }
        throw error;
      }
    } finally {
      scope.live = false;
      isolation.open = false;
    }
  }

  assertTransaction(tx: Transaction): void {
    const current = this.context.getStore();
    check(
      current?.live && !this.closed && current.transaction === tx,
      'invalid_transaction',
      'Transaction must belong to this active state store and request',
    );
  }

  async migrate(component: string, migrations: Migration[]): Promise<void> {
    check(/^[a-z][a-z0-9_-]*$/.test(component), 'invalid_component', 'Invalid component name');
    check(
      !this.context.getStore(),
      'nested_transaction',
      'Migrations require their own database scope',
    );
    const ordered = plain<Migration[]>(migrations, 'invalid_migration').sort(
      (a, b) => a.version - b.version,
    );
    const seen = new Set<number>();
    for (const migration of ordered) {
      check(
        Number.isSafeInteger(migration.version) &&
          migration.version > 0 &&
          // component_migrations.version is INTEGER.
          migration.version <= 2_147_483_647 &&
          !seen.has(migration.version),
        'invalid_migration',
        'Migration versions must be unique positive integers',
      );
      seen.add(migration.version);
      check(
        typeof migration.sql === 'string' &&
          Object.keys(migration).every((key) => key === 'version' || key === 'sql'),
        'invalid_migration',
        `Migration ${component}/${migration.version} must be { version, sql }`,
      );
    }
    return this.operation(() =>
      this.connect(async (connection) => {
        await this.transact(connection, async (tx) => {
          // One read serves the whole run: migrations never edit their own component's rows.
          const applied = new Map(
            (
              await tx.all<{ version: number; hash: string }>(
                'SELECT version, hash FROM component_migrations WHERE component=?',
                component,
              )
            ).map((row) => [row.version, row.hash]),
          );
          let latest = Math.max(0, ...applied.keys());
          // A database that has already run migrations this code has never seen belongs to a
          // newer server. Reading that schema on the terms this code knows would be silent
          // and wrong, so a rollback that left the database behind fails here instead.
          check(
            latest <= (ordered.at(-1)?.version ?? 0),
            'migration_ahead',
            `The database has ${component} migration ${latest}, which this server does not know`,
            409,
          );
          for (const migration of ordered) {
            const sql = migration.sql;
            const hash = digest(sql);
            const previous = applied.get(migration.version);
            if (previous !== undefined) {
              check(
                previous === hash,
                'migration_changed',
                `Published migration ${component}/${migration.version} changed`,
                409,
              );
              continue;
            }
            check(
              migration.version > latest,
              'migration_order',
              'Cannot insert an older migration',
              409,
            );
            try {
              await connection.exec(sql);
            } catch (error) {
              // Name the migration that failed, and keep the code, status and sanitized cause.
              if (!(error instanceof MervError)) throw error;
              const sqlstate = (error.cause as { sqlstate?: string } | undefined)?.sqlstate;
              throw Object.defineProperty(
                new MervError(
                  error.code,
                  `Migration ${component}/${migration.version} failed${sqlstate ? ` (SQLSTATE ${sqlstate})` : ''}`,
                  error.status,
                ),
                'cause',
                { value: error.cause },
              );
            }
            await tx.run(
              'INSERT INTO component_migrations(component,version,hash) VALUES(?,?,?)',
              component,
              migration.version,
              hash,
            );
            latest = migration.version;
          }
        });
      }),
    );
  }

  async appendEvent(
    tx: Transaction,
    event: Omit<StoredEvent, 'id' | 'createdAt'>,
  ): Promise<StoredEvent> {
    this.assertTransaction(tx);
    check(!this.context.getStore()?.readOnly, 'read_only_scope', 'A read scope cannot write', 409);
    // The returned receipt and stored row must describe one detached event, even
    // when the caller edits its object while the insert is pending.
    event = plain<typeof event>(event, 'invalid_event', { keys: 'any' });
    // plain() drops a key whose value is undefined, so this also refuses an explicit undefined.
    check(
      (['projectId', 'actorId', 'type', 'subjectId'] as const).every(
        (key) => typeof event[key] === 'string',
      ) && event.data !== undefined,
      'invalid_event',
      'An event needs string projectId, actorId, type and subjectId, and data',
    );
    const createdAt = now();
    const row = await tx.get<{ id: number }>(
      'INSERT INTO events(project_id,actor_id,type,subject_id,data_json,created_at) VALUES(?,?,?,?,?,?) RETURNING id',
      event.projectId,
      event.actorId,
      event.type,
      event.subjectId,
      JSON.stringify(event.data),
      createdAt,
    );
    this.context.getStore()!.eventWritten = true;
    return { ...event, id: row!.id, createdAt };
  }

  onEventsCommitted(listener: () => void): () => void {
    check(!this.closed, 'state_closed', 'State is closed', 503);
    // Ownership belongs to the subscription, even when callers share one callback.
    const registered = () => listener();
    this.listeners.add(registered);
    return () => {
      this.listeners.delete(registered);
    };
  }

  async eventHead(tx?: Transaction): Promise<number> {
    // A read inside the asserted transaction reads on it.
    if (tx) this.assertTransaction(tx);
    return this.read(
      async (sql) =>
        (await sql.get<{ id: number }>('SELECT COALESCE(MAX(id),0) AS id FROM events'))!.id,
    );
  }

  async eventBatch(after: number, limit: number, tx?: Transaction): Promise<StoredEvent[]> {
    check(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 1000,
      'invalid_cursor',
      'Invalid event batch bounds',
    );
    if (tx) this.assertTransaction(tx);
    return this.read(async (sql) =>
      (
        await sql.all<EventRow>('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?', after, limit)
      ).map(eventFromRow),
    );
  }

  async events(projectId: string, after = 0): Promise<StoredEvent[]> {
    check(
      Number.isSafeInteger(after) && after >= 0,
      'invalid_cursor',
      'Event cursor must be a nonnegative integer',
    );
    return this.read(async (sql) =>
      (
        await sql.all<EventRow>(
          'SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT 1000',
          projectId,
          after,
        )
      ).map(eventFromRow),
    );
  }
  /** The newest page (below `before`), oldest first: what a reader without a cursor wants. */
  async latestEvents(projectId: string, before = Number.MAX_SAFE_INTEGER): Promise<StoredEvent[]> {
    check(
      Number.isSafeInteger(before) && before >= 0,
      'invalid_cursor',
      'Event cursor must be a nonnegative integer',
    );
    return this.read(async (sql) =>
      (
        await sql.all<EventRow>(
          'SELECT * FROM events WHERE project_id=? AND id<? ORDER BY id DESC LIMIT 1000',
          projectId,
          before,
        )
      )
        .reverse()
        .map(eventFromRow),
    );
  }

  async close(): Promise<void> {
    // A finished child can still belong to a live snapshot or read scope.
    for (let scope = this.context.getStore(); scope; scope = Object.getPrototypeOf(scope))
      check(
        !scope.live,
        'transaction_active',
        'Cannot close State inside an active database scope',
      );
    if (!this.closing)
      this.closing = (async () => {
        await Promise.allSettled([...this.operations]);
        await this.shutdown();
        this.closed = true;
        this.listeners.clear();
      })();
    return this.closing;
  }
}

interface EventRow {
  id: number;
  project_id: string;
  actor_id: string;
  type: string;
  subject_id: string;
  data_json: string;
  created_at: string;
}
const eventFromRow = (row: EventRow): StoredEvent => ({
  id: row.id,
  projectId: row.project_id,
  actorId: row.actor_id,
  type: row.type,
  subjectId: row.subject_id,
  data: JSON.parse(row.data_json),
  createdAt: row.created_at,
});
