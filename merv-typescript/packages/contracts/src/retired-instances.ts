/**
 * The ledger of workflow instances whose version can no longer start. Every component migration
 * that deletes their records opens with `retiredInstancesSql`: the ledger, then the release's
 * preconditions.
 *
 * The ledger is insert-only, so whichever retirement migration runs first captures the whole set
 * while its inputs (wf_instances, wf_history, tasks, research_cycles) still exist, and later ones
 * read the persisted rows; on a fresh database it creates an empty ledger and selects nothing.
 * A guard refuses every UPDATE and DELETE of it: two of its selectors join wf_instances, which
 * workflows@7 empties of retired rows, so a ledger lost between a failed boot and its resumption
 * could not be computed again. `wf_retired_instances` is kept permanently (Workflows owns it): it
 * explains the ids that the events log names but no other table holds.
 *
 * The preconditions refuse the release while deleting the set would strand a record that
 * survives it. They run in every retirement migration, inside its transaction and before its
 * deletes, so the first one to run refuses before any component commits, and the previous image
 * still boots. Each is phrased against the persisted ledger, so it holds in any partial state a
 * resumed boot may find. The census (scripts/retirement-census.sql) embeds only the ledger and
 * reports the same conditions as rows (C2, C4, C5), so that it runs to the end on a database the
 * release would refuse.
 *
 * Published migrations embed these texts and pin them by digest: after the first release none
 * may change, and whitespace is migration identity.
 */
export const retirementLedgerSql = `CREATE TABLE IF NOT EXISTS wf_retired_instances (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow TEXT NOT NULL,
  version BIGINT NOT NULL, reason TEXT NOT NULL);
CREATE OR REPLACE FUNCTION wf_retired_instances_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'The retirement ledger is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$guard$;
CREATE OR REPLACE TRIGGER wf_retired_instances_retained BEFORE UPDATE OR DELETE ON wf_retired_instances
FOR EACH ROW EXECUTE FUNCTION wf_retired_instances_retained_guard();
DO $retire$
BEGIN
  IF to_regclass('wf_instances') IS NULL THEN RETURN; END IF;
  INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
  SELECT id,project_id,workflow,version,'retired_version' FROM wf_instances
  WHERE (workflow='task' AND version=1) OR (workflow='experiment' AND version BETWEEN 1 AND 4)
     OR (workflow='reflection' AND version IN (1,2)) OR (workflow='reflection.lens' AND version=1)
     OR (workflow='research' AND version BETWEEN 2 AND 5) OR workflow='consolidation'
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
  SELECT i.id,i.project_id,i.workflow,i.version,'upgraded_from_task_1' FROM wf_instances i
  WHERE i.workflow='task' AND EXISTS (SELECT 1 FROM wf_history h WHERE h.instance_id=i.id AND h.action='upgrade')
  ON CONFLICT (id) DO NOTHING;
  IF to_regclass('tasks') IS NOT NULL THEN
    INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
    SELECT t.id,t.project_id,'task',COALESCE(i.version,0),
      CASE WHEN t.evidence_version=1 THEN 'task_evidence_1' ELSE 'recipe_experiment.plan_1' END
    FROM tasks t LEFT JOIN wf_instances i ON i.id=t.id
    WHERE t.evidence_version=1 OR (t.type_name='experiment.plan' AND t.type_version=1)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF to_regclass('research_cycles') IS NOT NULL THEN
    INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
    SELECT i.id,i.project_id,i.workflow,i.version,'stage_of_retired_research'
    FROM research_cycles c JOIN wf_retired_instances r ON r.id=c.id JOIN wf_instances i ON i.id=c.reflection_id
    ON CONFLICT (id) DO NOTHING;
  END IF;
  INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
  SELECT i.id,i.project_id,i.workflow,i.version,'lens_of_retired_wave'
  FROM wf_instances i JOIN wf_retired_instances r ON r.id = i.data_json::jsonb->>'reflectionId'
  WHERE i.workflow='reflection.lens'
  ON CONFLICT (id) DO NOTHING;
END $retire$;`;

/**
 * The release's preconditions, each against the ledger above (census C2, C4 and C5). A table is
 * read only once it exists, in a statement of its own, because a fresh database may not have it.
 */
export const retirementPreconditionsSql = `DO $refuse$
BEGIN
  IF to_regclass('worker_sessions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM worker_sessions WHERE status IN ('offered','active')
      AND instance_id IN (SELECT id FROM wf_retired_instances)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Retirement refused: a live session serves a retired instance; halt dispatch until it closes';
    END IF;
  END IF;
  IF to_regclass('research_cycles') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM research_cycles WHERE id NOT IN (SELECT id FROM wf_retired_instances)
      AND reflection_id IN (SELECT id FROM wf_retired_instances)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Retirement refused: a surviving research cycle is staged on a retired reflection';
    END IF;
  END IF;
  IF to_regclass('reviews') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM reviews WHERE format_version=1
      AND subject_id NOT IN (SELECT id FROM wf_retired_instances)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Retirement refused: a format 1 review has a surviving subject';
    END IF;
  END IF;
  IF to_regclass('experiment_evidence') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM experiment_evidence WHERE role='graph'
      AND experiment_id NOT IN (SELECT id FROM wf_retired_instances)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Retirement refused: graph evidence belongs to a surviving experiment';
    END IF;
  END IF;
END $refuse$;`;

/** What every retirement migration runs before its deletes. */
export const retiredInstancesSql = `${retirementLedgerSql}
${retirementPreconditionsSql}`;

/**
 * `statements` between `ALTER TABLE <table> DISABLE TRIGGER <trigger>;` and the matching ENABLE,
 * one line per trigger. DISABLE TRIGGER is transactional, so other sessions never see a guard off,
 * and it names the one guard without copying its pinned DDL; it needs table ownership. The emitted
 * text is embedded in published migrations and frozen like the ledger above.
 */
export function withoutTriggers(
  table: string,
  triggers: readonly string[],
  statements: string,
): string {
  const alter = (action: 'DISABLE' | 'ENABLE') =>
    triggers.map((trigger) => `ALTER TABLE ${table} ${action} TRIGGER ${trigger};`);
  return [...alter('DISABLE'), statements, ...alter('ENABLE')].join('\n');
}
