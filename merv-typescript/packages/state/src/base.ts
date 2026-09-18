import { AsyncLocalStorage } from 'node:async_hooks';
import {
  check,
  digest,
  now,
  type Migration,
  type Sql,
  type SqlValue,
  type State,
  type StoredEvent,
  type Transaction,
} from '@merv/contracts';

export interface Connection {
  run(sql: string, params: SqlValue[]): ReturnType<Sql['run']>;
  get<T>(sql: string, params: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, params: SqlValue[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  discard?(): void;
}

interface Context {
  connection: Connection;
  live: boolean;
  sql: Sql;
  transaction?: Transaction;
  eventWritten: boolean;
  childTransaction?: boolean;
  /** A read scope: nested "transactions" read on the same snapshot and refuse writes. */
  readOnly?: boolean;
}

/** Explicit transactions stay on one connection; async context never crosses requests. */
export abstract class StateStore implements State {
  abstract readonly dialect: 'sqlite' | 'postgres';
  private readonly context = new AsyncLocalStorage<Context>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private closing?: Promise<void>;
  private closed = false;

  /** Reads take a connection of their own kind, so writers queued on the lock never starve a page. */
  protected abstract connect<T>(
    fn: (connection: Connection) => Promise<T>,
    mode?: 'write' | 'read',
  ): Promise<T>;
  protected abstract begin(connection: Connection): Promise<void>;
  /** A read-only transaction: a consistent snapshot that takes no writer lock. */
  protected abstract beginRead(connection: Connection): Promise<void>;
  protected abstract shutdown(): Promise<void>;

  protected operation<T>(fn: () => Promise<T>): Promise<T> {
    check(!this.closed && !this.closing, 'state_closed', 'State is closing or closed', 503);
    const operation = Promise.resolve().then(fn);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private scope(connection: Connection): Context {
    const scope = { connection, live: true, eventWritten: false } as Context;
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
    };
    scope.sql = {
      dialect: this.dialect,
      run: async (sql, ...params) => {
        valid();
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

  private async transact<T>(
    connection: Connection,
    fn: (tx: Transaction) => T | Promise<T>,
  ): Promise<T> {
    const scope = this.scope(connection);
    const tx: Transaction = { ...scope.sql, transactionId: Symbol('transaction') };
    scope.transaction = tx;
    try {
      await this.begin(connection);
      const value = await this.context.run(scope, () => fn(tx));
      scope.live = false;
      await connection.exec('COMMIT');
      if (scope.eventWritten)
        this.context.exit(() =>
          queueMicrotask(() => {
            if (this.closed) return;
            for (const listener of this.listeners) {
              try {
                listener();
              } catch {
                /* Wakeups cannot undo a committed transaction. */
              }
            }
          }),
        );
      return value;
    } catch (error) {
      scope.live = false;
      try {
        await connection.exec('ROLLBACK');
      } catch {
        connection.discard?.();
      }
      throw error;
    } finally {
      scope.live = false;
    }
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
      check(
        current.live && !this.closed,
        'transaction_closed',
        'Database scope is no longer active',
      );
      const tx: Transaction = {
        ...current.sql,
        run: async (sql: string) => {
          check(false, 'read_only_scope', `A read scope cannot write: ${sql.slice(0, 60)}`, 409);
          throw new Error('unreachable');
        },
        transactionId: Symbol('read'),
      };
      const own = Object.create(current, { transaction: { value: tx } }) as Context;
      return await this.context.run(own, () => fn(tx));
    }
    if (current) {
      check(
        current.live && !this.closed,
        'transaction_closed',
        'Database scope is no longer active',
      );
      check(
        !current.childTransaction,
        'nested_transaction',
        'A transaction is already using this read scope',
      );
      current.childTransaction = true;
      try {
        return await this.transact(current.connection, fn);
      } finally {
        current.childTransaction = false;
      }
    }
    return this.operation(() => this.connect((connection) => this.transact(connection, fn)));
  }

  async read<T>(fn: (sql: Sql) => T | Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current) {
      check(
        current.live && !this.closed,
        'transaction_closed',
        'Database scope is no longer active',
      );
      return fn(current.transaction ?? current.sql);
    }
    return this.operation(() =>
      this.connect(async (connection) => {
        const scope = this.scope(connection);
        try {
          return await this.context.run(scope, () => fn(scope.sql));
        } finally {
          scope.live = false;
        }
      }, 'read'),
    );
  }

  /**
   * A read-only snapshot scope: component transactions opened inside it read on one
   * snapshot, take no writer lock, and are refused if they write. Inside an existing
   * scope it simply runs the function there.
   */
  get readScope(): boolean {
    return !!this.context.getStore()?.readOnly;
  }

  async snapshot<T>(fn: () => T | Promise<T>): Promise<T> {
    // SQLite hands out one serialised connection, so a scope held across a handler would
    // deadlock anything the handler waits on; the writer lock this avoids is Postgres's.
    if (this.dialect !== 'postgres' || this.context.getStore()) return await fn();
    return this.operation(() =>
      this.connect(async (connection) => {
        const scope = this.scope(connection);
        scope.readOnly = true;
        try {
          await this.beginRead(connection);
          const value = await this.context.run(scope, fn);
          scope.live = false;
          await connection.exec('COMMIT');
          return value;
        } catch (error) {
          scope.live = false;
          try {
            await connection.exec('ROLLBACK');
          } catch {
            connection.discard?.();
          }
          throw error;
        } finally {
          scope.live = false;
        }
      }, 'read'),
    );
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
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    const seen = new Set<number>();
    for (const migration of ordered) {
      check(
        Number.isSafeInteger(migration.version) &&
          migration.version > 0 &&
          !seen.has(migration.version),
        'invalid_migration',
        'Migration versions must be unique positive integers',
      );
      seen.add(migration.version);
      if (this.dialect === 'postgres')
        check(
          typeof migration.postgres === 'string',
          'migration_dialect_missing',
          `PostgreSQL migration ${component}/${migration.version} is missing`,
        );
    }
    return this.operation(() =>
      this.connect(async (connection) => {
        const rebuild = this.dialect === 'sqlite' && ordered.some((migration) => migration.rebuild);
        if (rebuild) await connection.exec('PRAGMA foreign_keys=OFF');
        try {
          await this.transact(connection, async (tx) => {
            for (const migration of ordered) {
              const sql = this.dialect === 'postgres' ? migration.postgres! : migration.sql;
              const hash = digest(sql);
              const previous = await tx.get<{ hash: string }>(
                'SELECT hash FROM component_migrations WHERE component=? AND version=?',
                component,
                migration.version,
              );
              if (previous) {
                check(
                  previous.hash === hash,
                  'migration_changed',
                  `Published migration ${component}/${migration.version} changed`,
                  409,
                );
                continue;
              }
              const latest =
                (
                  await tx.get<{ version: number | null }>(
                    'SELECT MAX(version) AS version FROM component_migrations WHERE component=?',
                    component,
                  )
                )?.version ?? 0;
              check(
                migration.version > latest,
                'migration_order',
                'Cannot insert an older migration',
                409,
              );
              await connection.exec(sql);
              await tx.run(
                'INSERT INTO component_migrations(component,version,hash) VALUES(?,?,?)',
                component,
                migration.version,
                hash,
              );
            }
            if (rebuild)
              check(
                !(await tx.get('PRAGMA foreign_key_check')),
                'migration_foreign_key',
                'Migration violates foreign keys',
              );
          });
        } finally {
          if (rebuild) await connection.exec('PRAGMA foreign_keys=ON');
        }
      }),
    );
  }

  async appendEvent(
    tx: Transaction,
    event: Omit<StoredEvent, 'id' | 'createdAt'>,
  ): Promise<StoredEvent> {
    this.assertTransaction(tx);
    check(!this.context.getStore()?.readOnly, 'read_only_scope', 'A read scope cannot write', 409);
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
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async eventHead(tx?: Transaction): Promise<number> {
    if (tx) this.assertTransaction(tx);
    const read = async (sql: Sql) =>
      (await sql.get<{ id: number }>('SELECT COALESCE(MAX(id),0) AS id FROM events'))!.id;
    return tx ? read(tx) : this.read(read);
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
    const read = async (sql: Sql) =>
      (
        await sql.all<EventRow>('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?', after, limit)
      ).map(eventFromRow);
    return tx ? read(tx) : this.read(read);
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
    check(
      !this.context.getStore()?.live,
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
