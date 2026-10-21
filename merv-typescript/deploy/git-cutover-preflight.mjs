// Read-only, before replacing an old server. No service initialization or migrations.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { deploymentSchema } from './schema.mjs';
import { postgresParameters } from '@merv/state/parameters';

export async function preflight(client, schema) {
  deploymentSchema(schema);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`SET LOCAL search_path = "${schema}"`);
    const present = await client.query("SELECT to_regclass('component_migrations') AS name");
    if (!present.rows[0].name) return { ready: true, firstInstallation: true };
    const migrated = await client.query(
      "SELECT 1 FROM component_migrations WHERE component='code_git_remote' LIMIT 1",
    );
    const ledger = await client.query("SELECT to_regclass('wf_protocol_migrations') AS name");
    const protocolMigrated =
      !!ledger.rows[0].name &&
      !!(await client.query('SELECT 1 FROM wf_protocol_migrations LIMIT 1')).rowCount;
    const compiled = new URL('../dist/packages/code-work/src/cutover.js', import.meta.url);
    const { gitCutover } = await import(
      existsSync(compiled)
        ? compiled.href
        : new URL('../packages/code-work/src/cutover.ts', import.meta.url).href
    );
    const all = async (sql, ...params) =>
      (await client.query(postgresParameters(sql, params.length), params)).rows;
    const report = {
      ...(await gitCutover({
        all,
        get: async (sql, ...params) => (await all(sql, ...params))[0],
      })),
      protocolMigrated,
    };
    // Current native writers may survive an ordinary server deployment. Legacy
    // work/transfers are always checked, including after a partial startup.
    return migrated.rowCount
      ? {
          ...report,
          alreadyNative: true,
          ready:
            report.legacyWork.length === 0 &&
            report.transfers.length === 0 &&
            report.commands.length === 0,
        }
      : report;
  } finally {
    await client.query('ROLLBACK');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new pg.Client({ connectionString: process.env.MERV_DB_URL });
  try {
    await client.connect();
    const report = await preflight(client, deploymentSchema());
    console.log(JSON.stringify(report));
    if (!report.ready) {
      console.error(
        'Native Git cutover blocked: resolve the listed work and ownership with a compatible runtime before retrying. Preserve maintenance; do not restart an unverified previous image.',
      );
      process.exitCode = 1;
    }
  } catch {
    // PG errors can contain connection credentials; never print the error object.
    console.error(
      'Native Git cutover preflight could not verify the database. Preserve maintenance and the current runtime state; do not start a previous image without proving compatibility.',
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
