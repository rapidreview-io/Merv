/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  2: `
ALTER TABLE consolidations ADD COLUMN decisions TEXT;
CREATE FUNCTION consolidation_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.decisions IS NOT NULL AND NEW.decisions IS DISTINCT FROM OLD.decisions THEN
    RAISE EXCEPTION USING MESSAGE = 'Consolidation decisions are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_decisions BEFORE UPDATE OF decisions ON consolidations
FOR EACH ROW EXECUTE FUNCTION consolidation_decisions_guard();
`,
  1: `
CREATE TABLE consolidations (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record TEXT NOT NULL, review_id TEXT, completion TEXT);
CREATE OR REPLACE FUNCTION consolidation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation inputs are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_identity BEFORE UPDATE OF id,project_id,record ON consolidations
FOR EACH ROW EXECUTE FUNCTION consolidation_identity_guard();
CREATE OR REPLACE FUNCTION consolidation_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.completion IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Reviewed consolidation is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_completion BEFORE UPDATE OF completion ON consolidations
FOR EACH ROW EXECUTE FUNCTION consolidation_completion_guard();
CREATE OR REPLACE FUNCTION consolidation_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidations are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER consolidation_retained BEFORE DELETE ON consolidations
FOR EACH ROW EXECUTE FUNCTION consolidation_retained_guard();
CREATE TABLE consolidation_submissions (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, revision BIGINT NOT NULL, record TEXT NOT NULL, UNIQUE(instance_id,revision));
CREATE OR REPLACE FUNCTION consolidation_submission_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation submissions are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_submission_immutable BEFORE UPDATE ON consolidation_submissions
FOR EACH ROW EXECUTE FUNCTION consolidation_submission_immutable_guard();
CREATE OR REPLACE FUNCTION consolidation_submission_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation submissions are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER consolidation_submission_retained BEFORE DELETE ON consolidation_submissions
FOR EACH ROW EXECUTE FUNCTION consolidation_submission_retained_guard();
CREATE TABLE consolidation_commands (project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(project_id,actor_id,request_id));
CREATE TABLE consolidation_leases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL, revision BIGINT NOT NULL, actor_id TEXT NOT NULL, review_id TEXT, claim_id TEXT, receipt TEXT NOT NULL, artifacts TEXT NOT NULL, inputs TEXT NOT NULL, released_at TEXT);
CREATE UNIQUE INDEX consolidation_lease_active ON consolidation_leases(instance_id,revision) WHERE released_at IS NULL;
CREATE OR REPLACE FUNCTION consolidation_lease_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation ownership is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_lease_immutable BEFORE UPDATE OF id,project_id,instance_id,revision,actor_id,review_id,claim_id,receipt,artifacts,inputs ON consolidation_leases
FOR EACH ROW EXECUTE FUNCTION consolidation_lease_immutable_guard();
CREATE OR REPLACE FUNCTION consolidation_lease_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation leases are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER consolidation_lease_retained BEFORE DELETE ON consolidation_leases
FOR EACH ROW EXECUTE FUNCTION consolidation_lease_retained_guard();
`,
};
