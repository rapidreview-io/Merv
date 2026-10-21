/** Offline registration: use the pinned consumer definition and append fence. No Events
 * instance is created, so no delivery timer or handler can run, even momentarily.
 * Invoke with node --import tsx. The destination has already run pinned migrations.
 */
import { RELAY_CONSUMER_ID, RELAYED_TYPES } from '@sandboxes/merv-host/relay';
import { openDatabase } from '@sandboxes/db';
import { hash, need, durable } from './history.mjs';
import { readFileSync } from 'node:fs';
export async function initializeRelay(db, expectedBoundary) {
  need(
    Number.isSafeInteger(expectedBoundary) && expectedBoundary >= 0,
    'explicit safe event boundary required',
  );
  const definition = hash(JSON.stringify([...RELAYED_TYPES].sort()));
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('lock_timeout','5000ms',true)");
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      db.lockText('sandboxes-domain-events'),
    ]);
    const { head } = await tx.get('SELECT coalesce(max(id),0) AS head FROM domain_events');
    need(head === expectedBoundary, 'event boundary drift');
    const old = await tx.get('SELECT * FROM domain_event_consumers WHERE id=$1', [
      RELAY_CONSUMER_ID,
    ]);
    if (!old)
      await tx.run(
        'INSERT INTO domain_event_consumers(id,definition_hash,cursor) VALUES($1,$2,$3)',
        [RELAY_CONSUMER_ID, definition, expectedBoundary],
      );
    const row = await tx.get('SELECT * FROM domain_event_consumers WHERE id=$1', [
      RELAY_CONSUMER_ID,
    ]);
    need(
      row.definition_hash === definition &&
        row.cursor === expectedBoundary &&
        row.attempts === 0 &&
        row.error === null &&
        row.retry_at_ms === 0,
      'relay already consumed or definition changed',
    );
    return {
      consumer: RELAY_CONSUMER_ID,
      definitionHash: definition,
      boundary: expectedBoundary,
      deliveryEnabled: false,
    };
  });
}
if (process.argv[1]?.endsWith('/relay.mjs')) {
  let db;
  try {
    need(process.env.MERV_BOOT_MAINTENANCE === '1', 'maintenance must remain enabled');
    const expected = JSON.parse(readFileSync(process.env.STAGING_HISTORY_IDENTITY_FILE));
    db = await openDatabase({ url: process.env.STAGING_HISTORY_DATABASE_URL, schema: 'public' });
    const actual = await db.get(
      'SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port',
    );
    need(
      expected.database === 'sandboxes_staging' && hash(actual) === hash(expected),
      'destination identity mismatch',
    );
    durable(process.argv[3], await initializeRelay(db, Number(process.argv[2])));
  } catch {
    console.error(
      'Offline relay initialization refused; preserve maintenance and inspect private inputs.',
    );
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
