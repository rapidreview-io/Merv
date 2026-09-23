/**
 * The one way tests reach server state: PostgreSQL at MERV_TEST_POSTGRES_URL, one schema per
 * data directory (or per call for ':memory:'). The same key always maps to the same schema within
 * a test process, so reopening the same directory finds the data it left.
 * Every state opened here is closed, and every schema named here is dropped, when the file ends;
 * `npm run test:sweep` removes schemas a killed run left behind.
 */
import { after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import type { Transaction } from '@merv/contracts';
import { PostgresState, statePlugin, type PostgresConfig } from '@merv/state';

type StateConfig = Parameters<typeof statePlugin.apply>[1];

const url = process.env.MERV_TEST_POSTGRES_URL;
if (!url?.trim())
  throw new Error('Set MERV_TEST_POSTGRES_URL, e.g. postgres://merv@127.0.0.1:55439/merv');
export const postgresUrl: string = url;

/** Small pools: ~13 parallel files x a few states each must stay well under max_connections. */
export const testLimits = { maxConnections: 6, readConnections: 3 } as const;

const schemas = new Map<string, string>();
const named = new Set<string>();
const opened = new Set<PostgresState>();

/** t_<base36 ms>_<hex>: the creation time lets a sweep drop only stale schemas of any run. */
const fresh = () => `t_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;
/** A directory and any spelling of its path are one database. */
const keyOf = (key: string) => resolve(key);

export function schemaFor(key = ':memory:'): string {
  if (key !== ':memory:') {
    const existing = schemas.get(keyOf(key));
    if (existing) return existing;
  }
  const schema = fresh();
  named.add(schema);
  if (key !== ':memory:') schemas.set(keyOf(key), schema);
  return schema;
}

/** A state on the schema for `key`: the same directory reopens the same data; ':memory:' is fresh. */
export async function openState(
  key = ':memory:',
  options: Partial<Omit<PostgresConfig, 'connectionString'>> = {},
): Promise<PostgresState> {
  const state = await PostgresState.open({
    connectionString: postgresUrl,
    schema: options.schema ?? schemaFor(key),
    ...testLimits,
    ...options,
  });
  opened.add(state);
  return state;
}

/** The @merv/state plugin config (parsed shape) for a data directory. */
export function stateConfig(directory: string, overrides: Partial<StateConfig> = {}): StateConfig {
  return {
    connectionStringEnv: 'MERV_TEST_POSTGRES_URL',
    schema: schemaFor(directory),
    ...testLimits,
    connectionTimeoutMs: 10000,
    statementTimeoutMs: 30000,
    lockTimeoutMs: 5000,
    ...overrides,
  };
}

/** Environment for a spawned CLI that must open the same database as `directory`. */
export function cliEnv(directory: string) {
  return { MERV_DB_URL: postgresUrl, MERV_DB_SCHEMA: schemaFor(directory) };
}

/** Counts the INSERT/UPDATE/DELETE statements a state runs, rolled back or not. */
export function countWrites(state: PostgresState): () => number {
  let writes = 0;
  const write = /^\s*(INSERT|UPDATE|DELETE)\b/i;
  const transaction = state.transaction.bind(state);
  state.transaction = ((fn: (tx: Transaction) => unknown) =>
    transaction((tx) => {
      // Mutate in place: assertTransaction() compares the transaction object's identity.
      const { run, get, all } = tx;
      Object.assign(tx, {
        run: (sql: string, ...p: never[]) => (write.test(sql) && writes++, run(sql, ...p)),
        get: (sql: string, ...p: never[]) => (write.test(sql) && writes++, get(sql, ...p)),
        all: (sql: string, ...p: never[]) => (write.test(sql) && writes++, all(sql, ...p)),
      });
      return fn(tx);
    })) as typeof state.transaction;
  return () => writes;
}

let admin: pg.Client | undefined;
export async function dropSchema(schema: string) {
  if (!admin) {
    admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
  }
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

after(async () => {
  const bounded = (p: Promise<unknown>) =>
    Promise.race([p, new Promise((r) => setTimeout(r, 5000).unref())]);
  await Promise.allSettled([...opened].map((state) => bounded(state.close())));
  for (const schema of named) await dropSchema(schema).catch(() => undefined);
  await admin?.end();
  admin = undefined;
});
