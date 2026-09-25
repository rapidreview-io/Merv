import {
  retiredInstancesSql,
  retiredPlanTaskIds,
  retiredPlanTasksSql,
  withoutTriggers,
} from '@merv/contracts/retired-instances';

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
        checks TEXT NOT NULL, producer_id TEXT NOT NULL, brief_id TEXT NOT NULL,
        delivery_ids TEXT NOT NULL DEFAULT '[]', review_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX tasks_project ON tasks(project_id, created_at);
      CREATE TABLE task_commands (
        project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        operation TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(project_id, actor_id, request_id)
      );
`,
  2: `
CREATE OR REPLACE FUNCTION tasks_brief_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'A task brief is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER tasks_brief_immutable BEFORE UPDATE OF project_id, title, goal, checks, producer_id, brief_id, created_at ON tasks
FOR EACH ROW EXECUTE FUNCTION tasks_brief_immutable_guard();
`,
  3: `
ALTER TABLE tasks ADD COLUMN type_name TEXT NOT NULL DEFAULT 'task.work';
        ALTER TABLE tasks ADD COLUMN type_version BIGINT NOT NULL DEFAULT 1;
        ALTER TABLE tasks ADD COLUMN context_inputs TEXT NOT NULL DEFAULT '{}';
        CREATE OR REPLACE FUNCTION tasks_context_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Task type and context inputs are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER tasks_context_immutable BEFORE UPDATE OF type_name,type_version,context_inputs ON tasks
FOR EACH ROW EXECUTE FUNCTION tasks_context_immutable_guard();
`,
  4: `
CREATE TABLE task_checkpoints(
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,purpose TEXT NOT NULL,revision BIGINT NOT NULL,review_id TEXT,checkpoint TEXT NOT NULL);
        CREATE INDEX task_checkpoints_target ON task_checkpoints(project_id,task_id,purpose,revision);
        CREATE OR REPLACE FUNCTION task_checkpoints_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Checkpoints are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER task_checkpoints_immutable BEFORE UPDATE ON task_checkpoints
FOR EACH ROW EXECUTE FUNCTION task_checkpoints_immutable_guard();
        CREATE OR REPLACE FUNCTION task_checkpoints_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Checkpoints are durable', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER task_checkpoints_no_delete BEFORE DELETE ON task_checkpoints
FOR EACH ROW EXECUTE FUNCTION task_checkpoints_no_delete_guard();
`,
  5: `
ALTER TABLE tasks ADD COLUMN evidence_version BIGINT NOT NULL DEFAULT 1 CHECK(evidence_version IN (1,2));
        CREATE OR REPLACE FUNCTION tasks_evidence_version_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Task evidence contract is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER tasks_evidence_version_immutable BEFORE UPDATE OF evidence_version ON tasks
FOR EACH ROW EXECUTE FUNCTION tasks_evidence_version_immutable_guard();
`,
  6: `
CREATE TABLE task_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,revision BIGINT NOT NULL,actor_id TEXT NOT NULL UNIQUE,source_actor_id TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('work','review')),review_id TEXT,claim_id TEXT,receipt TEXT NOT NULL,pinned_artifacts TEXT NOT NULL,checkpoints TEXT NOT NULL,released_at TEXT);
        CREATE UNIQUE INDEX task_lease_active ON task_leases(project_id,task_id,revision) WHERE released_at IS NULL;
        CREATE OR REPLACE FUNCTION task_lease_identity_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Lease assignment provenance is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER task_lease_identity_immutable BEFORE UPDATE OF id,project_id,task_id,revision,actor_id,source_actor_id,purpose,review_id,claim_id,receipt,pinned_artifacts,checkpoints ON task_leases
FOR EACH ROW EXECUTE FUNCTION task_lease_identity_immutable_guard();
        CREATE OR REPLACE FUNCTION task_lease_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Lease assignment provenance is durable', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER task_lease_no_delete BEFORE DELETE ON task_leases
FOR EACH ROW EXECUTE FUNCTION task_lease_no_delete_guard();
`,
  7: `
ALTER TABLE task_leases DROP CONSTRAINT task_leases_actor_id_key;
`,
  // Deletes the tasks the ledger retires: task@1 instances (also those later upgraded to v2),
  // evidence version 1 and the experiment.plan@1 recipe, which no current flow can start.
  8: `${retiredInstancesSql}
${withoutTriggers(
  'task_leases',
  ['task_lease_no_delete'],
  `DELETE FROM task_leases WHERE task_id IN (SELECT id FROM wf_retired_instances);`,
)}
${withoutTriggers(
  'task_checkpoints',
  ['task_checkpoints_no_delete'],
  `DELETE FROM task_checkpoints WHERE task_id IN (SELECT id FROM wf_retired_instances);`,
)}
DELETE FROM task_commands WHERE result::jsonb->>'id' IN (SELECT id FROM wf_retired_instances)
  OR result::jsonb->>'taskId' IN (SELECT id FROM wf_retired_instances);
DELETE FROM tasks WHERE id IN (SELECT id FROM wf_retired_instances);
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE evidence_version=1 OR (type_name='experiment.plan' AND type_version=1)) THEN
    RAISE EXCEPTION USING MESSAGE = 'Retired tasks remain', ERRCODE = '23514';
  END IF;
END $check$;`,
  // Deletes every experiment.plan task: Experiments plans its own designs, and the recipe is gone.
  9: `${retiredPlanTasksSql}
${withoutTriggers(
  'task_leases',
  ['task_lease_no_delete'],
  `DELETE FROM task_leases WHERE task_id IN (${retiredPlanTaskIds});`,
)}
${withoutTriggers(
  'task_checkpoints',
  ['task_checkpoints_no_delete'],
  `DELETE FROM task_checkpoints WHERE task_id IN (${retiredPlanTaskIds});`,
)}
DELETE FROM task_commands WHERE result::jsonb->>'id' IN (${retiredPlanTaskIds})
  OR result::jsonb->>'taskId' IN (${retiredPlanTaskIds});
DELETE FROM tasks WHERE id IN (${retiredPlanTaskIds});
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE type_name='experiment.plan') THEN
    RAISE EXCEPTION USING MESSAGE = 'Retired experiment.plan tasks remain', ERRCODE = '23514';
  END IF;
END $check$;`,
};
