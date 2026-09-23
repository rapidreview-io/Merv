import { retiredInstancesSql, withoutTriggers } from '@merv/contracts/retired-instances';

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE research_cycles (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,project_id TEXT NOT NULL,record TEXT NOT NULL,problem TEXT,reflection_id TEXT,consolidation_id TEXT,methods_update_id TEXT,results_update_id TEXT);
CREATE OR REPLACE FUNCTION research_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Research inputs are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER research_identity BEFORE UPDATE OF id,project_id,record ON research_cycles
FOR EACH ROW EXECUTE FUNCTION research_identity_guard();
CREATE OR REPLACE FUNCTION research_children_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF (OLD.problem IS NOT NULL AND NEW.problem IS DISTINCT FROM OLD.problem) OR (OLD.reflection_id IS NOT NULL AND NEW.reflection_id IS DISTINCT FROM OLD.reflection_id) OR (OLD.consolidation_id IS NOT NULL AND NEW.consolidation_id IS DISTINCT FROM OLD.consolidation_id) OR (OLD.methods_update_id IS NOT NULL AND NEW.methods_update_id IS DISTINCT FROM OLD.methods_update_id) OR (OLD.results_update_id IS NOT NULL AND NEW.results_update_id IS DISTINCT FROM OLD.results_update_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'Research children and accepted definition are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER research_children BEFORE UPDATE ON research_cycles
FOR EACH ROW EXECUTE FUNCTION research_children_guard();
CREATE OR REPLACE FUNCTION research_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Research history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER research_retained BEFORE DELETE ON research_cycles
FOR EACH ROW EXECUTE FUNCTION research_retained_guard();
CREATE TABLE research_commands (project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
`,
  2: `
ALTER TABLE research_cycles ADD COLUMN predecessor_id TEXT;
CREATE UNIQUE INDEX research_successor ON research_cycles(predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE TRIGGER research_predecessor BEFORE UPDATE OF predecessor_id ON research_cycles
FOR EACH ROW EXECUTE FUNCTION research_identity_guard();
`,
  3: `
ALTER TABLE research_cycles ADD COLUMN digest TEXT;
CREATE OR REPLACE FUNCTION research_digest_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.digest IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'A research cycle digest is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER research_digest BEFORE UPDATE OF digest ON research_cycles
FOR EACH ROW EXECUTE FUNCTION research_digest_guard();
`,
  4: `
CREATE TABLE research_automation (
 research_id TEXT PRIMARY KEY REFERENCES research_cycles(id),project_id TEXT NOT NULL,
 source_json TEXT NOT NULL,root_id TEXT NOT NULL REFERENCES research_cycles(id),
 cycle_index INTEGER NOT NULL,max_cycles INTEGER NOT NULL,blocker_json TEXT);
CREATE TRIGGER research_automation_identity BEFORE UPDATE OF research_id,project_id,source_json,root_id,cycle_index,max_cycles ON research_automation
FOR EACH ROW EXECUTE FUNCTION research_identity_guard();
CREATE TRIGGER research_automation_retained BEFORE DELETE ON research_automation
FOR EACH ROW EXECUTE FUNCTION research_retained_guard();
`,
  5: `
ALTER TABLE research_cycles ADD COLUMN integrations TEXT;
`,
  6: `
ALTER TABLE research_cycles ADD COLUMN code_required INTEGER CHECK(code_required IN (0,1));
`,
  // Research@2-5 can no longer start, so their cycles go. A surviving cycle that followed one
  // forgets its predecessor, and an automatic run rooted in one is re-rooted at its earliest
  // surviving cycle. The tables, guards and receipts of the retired Consolidation plugin go too.
  7: `
${retiredInstancesSql}
${withoutTriggers(
  'research_automation',
  ['research_automation_identity', 'research_automation_retained'],
  `UPDATE research_automation a SET root_id=(SELECT b.research_id FROM research_automation b WHERE b.root_id=a.root_id AND b.research_id NOT IN (SELECT id FROM wf_retired_instances) ORDER BY b.cycle_index,b.research_id LIMIT 1)
WHERE a.root_id IN (SELECT id FROM wf_retired_instances) AND a.research_id NOT IN (SELECT id FROM wf_retired_instances);
DELETE FROM research_automation WHERE research_id IN (SELECT id FROM wf_retired_instances);`,
)}
DELETE FROM research_commands WHERE result::jsonb->>'id' IN (SELECT id FROM wf_retired_instances);
${withoutTriggers(
  'research_cycles',
  ['research_predecessor', 'research_retained'],
  `UPDATE research_cycles SET predecessor_id=NULL WHERE predecessor_id IN (SELECT id FROM wf_retired_instances) AND id NOT IN (SELECT id FROM wf_retired_instances);
DELETE FROM research_cycles WHERE id IN (SELECT id FROM wf_retired_instances);`,
)}
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM research_cycles WHERE reflection_id IN (SELECT id FROM wf_retired_instances)) THEN
    RAISE EXCEPTION USING MESSAGE = 'A surviving research cycle names a retired reflection', ERRCODE = '23514';
  END IF;
END $check$;
DROP TABLE IF EXISTS consolidation_leases, consolidation_commands, consolidation_submissions, consolidations;
DROP FUNCTION IF EXISTS consolidation_decisions_guard(), consolidation_identity_guard(), consolidation_completion_guard(), consolidation_retained_guard(), consolidation_submission_immutable_guard(), consolidation_submission_retained_guard(), consolidation_lease_immutable_guard(), consolidation_lease_retained_guard();
DO $consolidation$
BEGIN
  IF to_regclass('component_migrations') IS NOT NULL THEN
    DELETE FROM component_migrations WHERE component='consolidation';
  END IF;
END $consolidation$;
`,
};
