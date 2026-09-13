import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Context } from 'cordis';
import {
  check,
  digest,
  now,
  type State,
  type Sql,
  type Transaction,
  type Migration,
  type StoredEvent,
  type SqlValue,
} from '@merv/contracts';

export class SqliteState implements State {
  private db: DatabaseSync;
  private active: Transaction | undefined;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS component_migrations(component TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(component,version));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, type TEXT NOT NULL, subject_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id,id);`);
  }
  private sql(valid: () => void): Sql {
    return {
      run: (sql, ...params) => {
        valid();
        const r = this.db.prepare(sql).run(...params);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      get: <T>(sql: string, ...params: SqlValue[]) => {
        valid();
        return this.db.prepare(sql).get(...params) as T | undefined;
      },
      all: <T>(sql: string, ...params: SqlValue[]) => {
        valid();
        return this.db.prepare(sql).all(...params) as T[];
      },
    };
  }
  transaction<T>(fn: (tx: Transaction) => T): T {
    check(!this.closed, 'state_closed', 'State is closed', 503);
    check(
      !this.active,
      'nested_transaction',
      'Pass the existing transaction to component operations',
    );
    check(
      fn.constructor.name !== 'AsyncFunction',
      'async_transaction',
      'SQLite transaction callbacks must be synchronous',
    );
    this.db.exec('BEGIN IMMEDIATE');
    let live = true;
    const tx: Transaction = {
      transactionId: Symbol('transaction'),
      ...this.sql(() =>
        check(live && !this.closed, 'transaction_closed', 'Transaction is no longer active'),
      ),
    };
    this.active = tx;
    try {
      const value = fn(tx);
      if (value && typeof (value as any).then === 'function') {
        // A non-async function can still return a rejected promise. Contain it
        // while rejecting the transaction; captured tx methods expire below.
        void Promise.resolve(value).catch(() => undefined);
        check(false, 'async_transaction', 'SQLite transaction callbacks must be synchronous');
      }
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      live = false;
      this.active = undefined;
    }
  }
  read<T>(fn: (sql: Sql) => T): T {
    check(!this.closed, 'state_closed', 'State is closed', 503);
    return fn(
      this.active ?? this.sql(() => check(!this.closed, 'state_closed', 'State is closed', 503)),
    );
  }
  assertTransaction(tx: Transaction): void {
    check(
      tx === this.active,
      'invalid_transaction',
      'Transaction must belong to this active state store',
    );
  }
  migrate(component: string, migrations: Migration[]): void {
    check(/^[a-z][a-z0-9_-]*$/.test(component), 'invalid_component', 'Invalid component name');
    this.transaction((tx) => {
      const seen = new Set<number>();
      for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
        check(
          Number.isSafeInteger(migration.version) &&
            migration.version > 0 &&
            !seen.has(migration.version),
          'invalid_migration',
          'Migration versions must be unique positive integers',
        );
        seen.add(migration.version);
        const hash = digest(migration.sql);
        const previous = tx.get<{ hash: string }>(
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
          tx.get<{ version: number }>(
            'SELECT MAX(version) AS version FROM component_migrations WHERE component=?',
            component,
          )?.version ?? 0;
        check(
          migration.version > latest,
          'migration_order',
          'Cannot insert an older migration',
          409,
        );
        this.db.exec(migration.sql);
        tx.run(
          'INSERT INTO component_migrations(component,version,hash) VALUES(?,?,?)',
          component,
          migration.version,
          hash,
        );
      }
    });
  }
  appendEvent(tx: Transaction, event: Omit<StoredEvent, 'id' | 'createdAt'>): StoredEvent {
    this.assertTransaction(tx);
    const createdAt = now();
    const result = tx.run(
      'INSERT INTO events(project_id,actor_id,type,subject_id,data_json,created_at) VALUES(?,?,?,?,?,?)',
      event.projectId,
      event.actorId,
      event.type,
      event.subjectId,
      JSON.stringify(event.data),
      createdAt,
    );
    return { ...event, id: Number(result.lastInsertRowid), createdAt };
  }
  events(projectId: string, after = 0): StoredEvent[] {
    check(
      Number.isSafeInteger(after) && after >= 0,
      'invalid_cursor',
      'Event cursor must be a nonnegative integer',
    );
    return this.read((sql) =>
      sql
        .all<any>(
          'SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT 1000',
          projectId,
          after,
        )
        .map((row) => ({
          id: row.id,
          projectId: row.project_id,
          actorId: row.actor_id,
          type: row.type,
          subjectId: row.subject_id,
          data: JSON.parse(row.data_json),
          createdAt: row.created_at,
        })),
    );
  }
  close(): void {
    if (!this.closed) {
      check(!this.active, 'transaction_active', 'Cannot close an active transaction');
      this.db.close();
      this.closed = true;
    }
  }
}
export const statePlugin = {
  name: 'merv-state',
  apply(ctx: Context, config: { path: string }) {
    ctx.effect(function* () {
      const state = new SqliteState(config.path);
      yield () => state.close();
      yield ctx.provide('state', state);
    });
  },
};
export default statePlugin;
