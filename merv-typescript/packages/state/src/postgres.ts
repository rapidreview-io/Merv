import { Pool, types, type PoolClient, type QueryResult } from 'pg';
import { check, MervError, type SqlValue } from '@merv/contracts';
import { StateStore, type Connection } from './base.js';
import { postgresParameters } from './parameters.js';

export interface PostgresConfig {
  connectionString: string;
  schema?: string;
  maxConnections?: number;
  /** Connections kept for reads; the rest serve writers waiting on the state lock. */
  readConnections?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  ssl?: { rejectUnauthorized: true; ca?: string };
}

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

/** Do not forward connection strings, SQL parameter values or server details to clients. */
function databaseError(error: unknown): MervError {
  if (error instanceof MervError) return error;
  const code = (error as { code?: string })?.code;
  if (code === '23505')
    return new MervError('state_conflict', 'Database record already exists', 409);
  if (['23503', '23514', '23502', 'P0001'].includes(code ?? ''))
    return new MervError('state_constraint', 'Database constraint rejected the operation', 409);
  if (code === '40001' || code === '40P01')
    return new MervError(
      'transaction_conflict',
      'Database transaction conflicted; retry the request',
      409,
    );
  if (code === '57014' || code === '55P03')
    return new MervError('state_timeout', 'Database operation timed out', 503);
  if (/timeout exceeded when trying to connect/.test((error as Error)?.message ?? ''))
    return new MervError('state_busy', 'Every database connection is in use; retry shortly', 503);
  return new MervError('state_unavailable', 'PostgreSQL operation failed', 503);
}

export class PostgresState extends StateStore {
  readonly dialect = 'postgres' as const;
  private readonly pool: Pool;
  private readonly readers: Pool;
  private readonly schema: string;

  private constructor(config: PostgresConfig) {
    super();
    check(
      config.connectionString.trim(),
      'invalid_config',
      'PostgreSQL connection string is required',
    );
    this.schema = config.schema ?? 'merv';
    check(
      /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.schema),
      'invalid_config',
      'Invalid PostgreSQL schema',
    );
    for (const value of [
      config.maxConnections,
      config.readConnections,
      config.connectionTimeoutMs,
      config.statementTimeoutMs,
      config.lockTimeoutMs,
    ])
      check(
        value === undefined || (Number.isSafeInteger(value) && value > 0),
        'invalid_config',
        'Database limits must be positive integers',
      );
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
        connectionTimeoutMillis: config.connectionTimeoutMs ?? 10000,
        statement_timeout: config.statementTimeoutMs ?? 30000,
        lock_timeout: config.lockTimeoutMs ?? 5000,
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
    this.pool = pool(config.maxConnections ?? 10);
    this.readers = pool(config.readConnections ?? 6);
  }

  static async open(config: PostgresConfig): Promise<PostgresState> {
    const state = new PostgresState(config);
    try {
      await state.operation(() =>
        state.connect(async (connection) => {
          try {
            await state.begin(connection);
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
            await connection.exec('COMMIT');
          } catch (error) {
            try {
              await connection.exec('ROLLBACK');
            } catch {
              connection.discard?.();
            }
            throw error;
          }
        }),
      );
      return state;
    } catch (error) {
      await state.close();
      throw databaseError(error);
    }
  }

  protected async connect<T>(
    fn: (connection: Connection) => Promise<T>,
    mode: 'write' | 'read' = 'write',
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await (mode === 'read' ? this.readers : this.pool).connect();
    } catch (error) {
      throw databaseError(error);
    }
    let discard = false;
    // Sibling reads of one snapshot arrive together; one connection runs them in turn.
    let tail: Promise<unknown> = Promise.resolve();
    const query = (sql: string, params: SqlValue[] = []): Promise<QueryResult> => {
      const values = params.map((value) =>
        value instanceof Uint8Array ? Buffer.from(value) : value,
      );
      const next = tail.then(
        async () => await client.query(postgresParameters(sql, values.length), values),
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
        run: async (sql, params) => ({
          changes: (await query(sql, params)).rowCount ?? 0,
          lastInsertRowid: 0,
        }),
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

  protected async begin(connection: Connection): Promise<void> {
    await connection.exec('BEGIN');
    // Preserve SQLite's writer serialization and commit-ordered event IDs across app instances.
    await connection.get(
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))',
      [`merv-state:${this.schema}`],
    );
  }

  protected async beginRead(connection: Connection): Promise<void> {
    await connection.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  protected async shutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.readers.end()]);
  }
}
