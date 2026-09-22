/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
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
};
