import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import pg from 'pg';

/**
 * Live runs and demos keep server state in the PostgreSQL server that MERV_DB_URL names, each in
 * its own schema. Two runs never share data, and reopening the same directory reopens the same
 * schema, as its state file once did. Deleting a run directory leaves its schema behind: drop the
 * schema as well before reusing that directory name.
 */

/** `run_<directory name>_<hash of its path>`: lower case, at most 63 bytes, so psql needs no quotes. */
export function runSchema(directory: string): string {
  const path = resolve(directory);
  const suffix = createHash('sha256').update(path).digest('hex').slice(0, 8);
  const name = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63 - 'run_'.length - 1 - suffix.length);
  return `run_${name}_${suffix}`;
}

export function requireDatabaseUrl(): string {
  const url = process.env.MERV_DB_URL?.trim();
  if (!url)
    throw new Error(
      'Set MERV_DB_URL to a PostgreSQL connection string (README, Quick start); each run keeps its state in its own schema',
    );
  return url;
}

/**
 * Selects the run's schema for every later createApp: a nonblank MERV_DB_SCHEMA wins (tests pass
 * theirs that way), otherwise runSchema(directory). Call it before the first createApp and record
 * the result in the run's report; drop the schema when that evidence is no longer needed.
 */
export function useRunSchema(directory: string): string {
  requireDatabaseUrl();
  if (!process.env.MERV_DB_SCHEMA?.trim()) process.env.MERV_DB_SCHEMA = runSchema(directory);
  return process.env.MERV_DB_SCHEMA.trim();
}

/** Removes a schema this process created for temporary state. */
export async function dropSchema(schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`);
  } finally {
    await client.end();
  }
}
