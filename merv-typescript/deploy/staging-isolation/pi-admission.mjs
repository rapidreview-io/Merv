/** Temporary, durable Pi admission barrier. It never cancels a command or allocation.
 * SQL triggers cover HTTP, warm, and background callers, including old Main processes.
 * Existing rows can finish normally. Drain requires zero live Pi hosts, not just quiet turns.
 */
import pg from 'pg';
export const BODY = `BEGIN
 IF TG_TABLE_NAME = 'pi_commands' OR (to_jsonb(NEW)->>'data_json')::jsonb->'owner'->>'kind' = 'pi-host' THEN
  RAISE EXCEPTION 'Pi admission paused for staging handoff; retry later' USING ERRCODE = '55000';
 END IF;
 RETURN NEW;
END`;
const NAME = 'merv_staging_handoff_admission';
export async function admission(db, schema, action) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !['inspect', 'apply', 'restore'].includes(action))
    throw Error('invalid admission request');
  const s = '"' + schema + '"';
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL lock_timeout = '10s'");
    // Wait for transactions that could have already admitted work to commit before fencing.
    await db.query(
      `LOCK TABLE ${s}.pi_commands, ${s}.fleet_allocations IN SHARE ROW EXCLUSIVE MODE`,
    );
    const existing = (
      await db.query(
        `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2`,
        [schema, NAME],
      )
    ).rows;
    const triggers = (
      await db.query(
        `SELECT c.relname,t.tgtype,t.tgenabled,p.prosrc FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=$1 AND t.tgname=$2 ORDER BY c.relname`,
        [schema, NAME],
      )
    ).rows;
    const present =
      existing.length === 1 &&
      existing[0].prosrc === BODY &&
      triggers.length === 2 &&
      triggers.every(
        (t, i) =>
          t.relname === ['fleet_allocations', 'pi_commands'][i] &&
          t.tgtype === 7 &&
          t.tgenabled === 'O' &&
          t.prosrc === BODY,
      );
    if (!present && (existing.length || triggers.length))
      throw Error('admission barrier definition collision/drift');
    if (action === 'apply' && !present) {
      await db.query(
        `CREATE FUNCTION ${s}.${NAME}() RETURNS trigger LANGUAGE plpgsql AS $body$${BODY}$body$`,
      );
      for (const table of ['pi_commands', 'fleet_allocations'])
        await db.query(
          `CREATE TRIGGER ${NAME} BEFORE INSERT ON ${s}.${table} FOR EACH ROW EXECUTE FUNCTION ${s}.${NAME}()`,
        );
    }
    if (action === 'restore' && present) {
      for (const table of ['pi_commands', 'fleet_allocations'])
        await db.query(`DROP TRIGGER ${NAME} ON ${s}.${table}`);
      await db.query(`DROP FUNCTION ${s}.${NAME}()`);
    }
    const counts = (
      await db.query(
        `SELECT (SELECT count(*)::int FROM ${s}.pi_commands WHERE status IN ('waiting','starting','working','saving')) AS commands,(SELECT count(*)::int FROM ${s}.pi_hosts WHERE status='live') AS hosts,(SELECT count(*)::int FROM ${s}.fleet_allocations WHERE data_json::jsonb->'owner'->>'kind'='pi-host' AND phase <> 'released') AS allocations`,
      )
    ).rows[0];
    await db.query('COMMIT');
    return { active: action === 'apply' || (action === 'inspect' && present), ...counts };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
if (process.env.MERV_PI_HANDOFF) {
  const db = new pg.Client({ connectionString: process.env.MERV_DB_URL });
  try {
    await db.connect();
    console.log(
      JSON.stringify(
        await admission(
          db,
          process.env.MERV_TS_DB_SCHEMA || 'merv_ts',
          process.env.MERV_PI_HANDOFF,
        ),
      ),
    );
  } catch {
    console.log(JSON.stringify({ error: 'Pi admission barrier refused' }));
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
