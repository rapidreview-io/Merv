import { retiredInstancesSql, withoutTriggers } from '@merv/contracts/retired-instances';

const retired = '(SELECT id FROM wf_retired_instances)';
/** Deletes one table's rows of retired experiments past its no-delete guard. */
const purge = (table: string, trigger: string, where = `experiment_id IN ${retired}`) =>
  withoutTriggers(table, [trigger], `DELETE FROM ${table} WHERE ${where};`);

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE experiments (
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,
 intent TEXT NOT NULL,details TEXT NOT NULL,owner_id TEXT NOT NULL,created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,tested_claim_ids TEXT NOT NULL,attempt_index BIGINT NOT NULL CHECK(attempt_index>0),
 review_id TEXT,conclusion TEXT,UNIQUE(project_id,name)
);
CREATE INDEX experiments_project ON experiments(project_id,created_at,id);
CREATE OR REPLACE FUNCTION experiments_identity_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Experiment definition is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER experiments_identity_immutable BEFORE UPDATE OF id,project_id,name,intent,details,owner_id,created_by,created_at,tested_claim_ids ON experiments
FOR EACH ROW EXECUTE FUNCTION experiments_identity_immutable_guard();
CREATE OR REPLACE FUNCTION experiments_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Experiments are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER experiments_no_delete BEFORE DELETE ON experiments
FOR EACH ROW EXECUTE FUNCTION experiments_no_delete_guard();
CREATE TABLE experiment_attempts (
 experiment_id TEXT NOT NULL,attempt_index BIGINT NOT NULL,started_revision BIGINT NOT NULL,
 ended_revision BIGINT,previous_index BIGINT,feedback TEXT NOT NULL,
 approved_submission_id TEXT,approved_review_id TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(experiment_id,attempt_index)
);
CREATE OR REPLACE FUNCTION experiment_attempt_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Attempt identity is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER experiment_attempt_identity BEFORE UPDATE OF experiment_id,attempt_index,started_revision,previous_index,created_at ON experiment_attempts
FOR EACH ROW EXECUTE FUNCTION experiment_attempt_identity_guard();
CREATE OR REPLACE FUNCTION experiment_attempt_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.approved_submission_id IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Approved plan is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER experiment_attempt_approval BEFORE UPDATE OF approved_submission_id,approved_review_id ON experiment_attempts
FOR EACH ROW EXECUTE FUNCTION experiment_attempt_approval_guard();
CREATE OR REPLACE FUNCTION experiment_attempt_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Attempts are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER experiment_attempt_no_delete BEFORE DELETE ON experiment_attempts
FOR EACH ROW EXECUTE FUNCTION experiment_attempt_no_delete_guard();
CREATE TABLE experiment_evidence (
 id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,attempt_index BIGINT NOT NULL,
 role TEXT NOT NULL,path TEXT NOT NULL,sequence BIGINT NOT NULL,record TEXT NOT NULL,
 UNIQUE(experiment_id,sequence)
);
CREATE INDEX experiment_evidence_target ON experiment_evidence(experiment_id,attempt_index,role,path);
CREATE OR REPLACE FUNCTION experiment_evidence_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Evidence associations are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER experiment_evidence_immutable BEFORE UPDATE ON experiment_evidence
FOR EACH ROW EXECUTE FUNCTION experiment_evidence_immutable_guard();
CREATE OR REPLACE FUNCTION experiment_evidence_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Evidence associations are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER experiment_evidence_no_delete BEFORE DELETE ON experiment_evidence
FOR EACH ROW EXECUTE FUNCTION experiment_evidence_no_delete_guard();
CREATE TABLE experiment_slots (
 experiment_id TEXT NOT NULL,attempt_index BIGINT NOT NULL,role TEXT NOT NULL,path TEXT NOT NULL,evidence_id TEXT NOT NULL,
 PRIMARY KEY(experiment_id,attempt_index,role,path)
);
CREATE TABLE experiment_submissions (
 id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,attempt_index BIGINT NOT NULL,stage TEXT NOT NULL,
 round BIGINT NOT NULL,review_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,
 UNIQUE(experiment_id,attempt_index,stage,round)
);
CREATE OR REPLACE FUNCTION experiment_submission_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Submission snapshots are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER experiment_submission_immutable BEFORE UPDATE ON experiment_submissions
FOR EACH ROW EXECUTE FUNCTION experiment_submission_immutable_guard();
CREATE OR REPLACE FUNCTION experiment_submission_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Submission snapshots are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER experiment_submission_no_delete BEFORE DELETE ON experiment_submissions
FOR EACH ROW EXECUTE FUNCTION experiment_submission_no_delete_guard();
CREATE TABLE experiment_commands (
 project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT NOT NULL,
 PRIMARY KEY(project_id,actor_id,request_id)
);
CREATE OR REPLACE FUNCTION experiment_command_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Command receipts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER experiment_command_immutable BEFORE UPDATE ON experiment_commands
FOR EACH ROW EXECUTE FUNCTION experiment_command_immutable_guard();
CREATE OR REPLACE FUNCTION experiment_command_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Command receipts are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER experiment_command_no_delete BEFORE DELETE ON experiment_commands
FOR EACH ROW EXECUTE FUNCTION experiment_command_no_delete_guard();
CREATE UNIQUE INDEX experiments_project_name_folded ON experiments(project_id,lower(name));
`,
  2: `
ALTER TABLE experiment_attempts ADD COLUMN feedback_review_ids TEXT NOT NULL DEFAULT '[]';
`,
  3: `
ALTER TABLE experiments ADD COLUMN workspace TEXT NOT NULL DEFAULT 'none' CHECK(workspace IN ('none','git'));
CREATE OR REPLACE FUNCTION experiment_workspace_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Experiment workspace selection is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER experiment_workspace_immutable BEFORE UPDATE OF workspace ON experiments
FOR EACH ROW EXECUTE FUNCTION experiment_workspace_immutable_guard();
`,
  // Retires experiment@1-4: their records go, the graph evidence role with them. The pinned
  // definitions and policies stay in Workflows, and the events log keeps their history.
  4: `
${retiredInstancesSql}
DELETE FROM experiment_slots WHERE experiment_id IN ${retired};
${purge('experiment_evidence', 'experiment_evidence_no_delete')}
${purge('experiment_submissions', 'experiment_submission_no_delete')}
${purge('experiment_attempts', 'experiment_attempt_no_delete')}
${purge(
  'experiment_commands',
  'experiment_command_no_delete',
  `(result::jsonb->>'id') IN ${retired} OR (result::jsonb->>'experimentId') IN ${retired}`,
)}
${purge('experiments', 'experiments_no_delete', `id IN ${retired}`)}
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM experiment_evidence WHERE role='graph') THEN
    RAISE EXCEPTION USING MESSAGE = 'Graph evidence outlived experiment@1-4', ERRCODE = '23514';
  END IF;
END $check$;
`,
};
