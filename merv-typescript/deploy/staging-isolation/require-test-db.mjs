if (!process.env.ISOLATION_TEST_DATABASE_URL) {
  console.error(
    'Set ISOLATION_TEST_DATABASE_URL to a disposable local PostgreSQL administrator database; the suite creates/drops only isolation_source, sandboxes_staging, isolation_restore and isolation_relay.',
  );
  process.exitCode = 1;
}

if (
  process.env.ISOLATION_TEST_DATABASE_URL &&
  !['127.0.0.1', 'localhost', '[::1]'].includes(
    new URL(process.env.ISOLATION_TEST_DATABASE_URL).hostname,
  )
)
  throw new Error('Only a disposable local PostgreSQL is permitted');
