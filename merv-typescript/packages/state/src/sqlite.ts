import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { StateStore, type Connection } from './base.js';

export class SqliteState extends StateStore {
  readonly dialect = 'sqlite' as const;
  private readonly db: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
      );
      this.db.exec(`
CREATE TABLE IF NOT EXISTS component_migrations(component TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(component,version));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, type TEXT NOT NULL, subject_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id,id);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Events are retained for durable consumers'); END;`);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the initialization failure even if releasing the handle also fails.
      }
      throw error;
    }
  }
  protected connect<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const operation = this.tail.then(() =>
      fn({
        run: async (sql, params) => {
          const result = this.db.prepare(sql).run(...params);
          return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
        },
        get: async <T>(sql: string, params: Parameters<Connection['run']>[1]) =>
          this.db.prepare(sql).get(...params) as T | undefined,
        all: async <T>(sql: string, params: Parameters<Connection['run']>[1]) =>
          this.db.prepare(sql).all(...params) as T[],
        exec: async (sql) => {
          this.db.exec(sql);
        },
      }),
    );
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  protected async begin(connection: Connection): Promise<void> {
    await connection.exec('BEGIN IMMEDIATE');
  }
  protected async shutdown(): Promise<void> {
    this.db.close();
  }
}
