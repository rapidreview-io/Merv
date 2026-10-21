/** Persistent admission fence for the legacy staging-only namespace. Billing checks plugin
 * (cloudflare), not provider aliases. No account-wide control or customer namespace is touched.
 * A stale source reader therefore cannot admit after this transaction commits.
 */
import pg from 'pg';
export const LEGACY = 'merv-stg-pi-da7c4bfa4d89860eee24';
export async function fenceSource(db, apply = false) {
  await db.query('BEGIN');
  try {
    const n = (
      await db.query('SELECT account_id FROM public.infra_namespaces WHERE name=$1', [LEGACY])
    ).rows[0];
    if (n?.account_id !== 'acct_zo40u4jf8tmbhjkh') throw Error('legacy namespace provenance drift');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'infra-account:' + n.account_id,
    ]);
    const recheck = (
      await db.query('SELECT account_id FROM public.infra_namespaces WHERE name=$1', [LEGACY])
    ).rows[0];
    if (recheck?.account_id !== n.account_id) throw Error('namespace moved during fence');
    const old = (
      await db.query(
        "SELECT * FROM public.infra_provider_controls WHERE account_id=$1 AND scope='namespace' AND target=$2 AND provider='cloudflare'",
        [n.account_id, LEGACY],
      )
    ).rows;
    if (apply)
      await db.query(
        "INSERT INTO public.infra_provider_controls(account_id,scope,target,provider,enabled) VALUES($1,'namespace',$2,'cloudflare',false) ON CONFLICT(account_id,scope,target,provider) DO UPDATE SET enabled=false",
        [n.account_id, LEGACY],
      );
    await db.query('COMMIT');
    return {
      namespace: LEGACY,
      account: n.account_id,
      plugin: 'cloudflare',
      old,
      denied: apply || old[0]?.enabled === false,
    };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
if (process.env.MERV_SOURCE_FENCE === 'inspect' || process.env.MERV_SOURCE_FENCE === 'apply') {
  const db = new pg.Client({ connectionString: process.env.SANDBOXES_DATABASE_URL });
  try {
    await db.connect();
    console.log(JSON.stringify(await fenceSource(db, process.env.MERV_SOURCE_FENCE === 'apply')));
  } catch {
    console.log(JSON.stringify({ error: 'source admission fence refused' }));
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
