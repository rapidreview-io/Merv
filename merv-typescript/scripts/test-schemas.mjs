// Drops test schemas that a killed or crashed test run left behind on MERV_TEST_POSTGRES_URL.
// Usage: node scripts/test-schemas.mjs [hours=6]
//
// tests/fixtures/state.ts names every schema t_<base-36 milliseconds>_<10 hex digits> and drops
// its own schemas when a test file ends. The database may be shared with other test runs that
// are still going, so this sweep drops only names of exactly that shape whose embedded creation
// time is older than the given number of hours. It never drops by prefix alone.
import pg from 'pg';

const pattern = /^t_([0-9a-z]+)_[0-9a-f]{10}$/;
const argument = process.argv[2] ?? '6';
const hours = Number(argument);
if (!/^\d+(\.\d+)?$/.test(argument) || !(hours > 0)) {
  console.error('Usage: node scripts/test-schemas.mjs [hours=6], where hours is a positive number');
  process.exit(2);
}
const url = process.env.MERV_TEST_POSTGRES_URL?.trim();
if (!url) {
  console.error('Set MERV_TEST_POSTGRES_URL, e.g. postgres://merv@127.0.0.1:55439/merv');
  process.exit(1);
}

const cutoff = Date.now() - hours * 3_600_000;
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // A schema that a live process still holds locks is reported and skipped, not waited for.
  await client.query("SET lock_timeout = '5s'");
  const { rows } = await client.query(
    "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname ~ '^t_[0-9a-z]+_[0-9a-f]{10}$' ORDER BY nspname",
  );
  const stale = rows
    .map((row) => row.nspname)
    .filter((name) => {
      const created = parseInt(pattern.exec(name)?.[1] ?? '', 36);
      return Number.isSafeInteger(created) && created < cutoff;
    });
  const failed = [];
  for (const name of stale)
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    } catch (error) {
      failed.push({ schema: name, error: error.message });
    }
  console.log(
    JSON.stringify({
      olderThanHours: hours,
      testSchemas: rows.length,
      dropped: stale.length - failed.length,
      ...(failed.length ? { failed } : {}),
    }),
  );
} finally {
  await client.end();
}
