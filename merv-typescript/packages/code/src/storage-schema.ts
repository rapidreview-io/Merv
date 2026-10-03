import type { State } from '@merv/contracts';
import { migratePendingMerges } from './pending-merge.js';

/** Generic Git storage; no research records are created by standalone Code. */
const schema = `DO $code_storage$
BEGIN
IF to_regclass('code_projects') IS NULL THEN
CREATE TABLE code_projects (
  project_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('local')),
  repository_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  main_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE code_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  principal_scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','completed','failed')),
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (project_id,principal_scope,request_id),
  CHECK (
    (status='prepared' AND result_json IS NULL AND error IS NULL AND completed_at IS NULL) OR
    (status='completed' AND result_json IS NOT NULL AND error IS NULL AND completed_at IS NOT NULL) OR
    (status='failed' AND result_json IS NULL AND error IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE OR REPLACE FUNCTION code_projects_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.repository_id IS DISTINCT FROM OLD.repository_id OR NEW.binding_json IS DISTINCT FROM OLD.binding_json THEN
    RAISE EXCEPTION USING MESSAGE = 'Code repository binding is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_projects_binding BEFORE UPDATE ON code_projects
FOR EACH ROW EXECUTE FUNCTION code_projects_binding_guard();
CREATE OR REPLACE FUNCTION code_projects_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Code repository bindings are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER code_projects_no_delete BEFORE DELETE ON code_projects
FOR EACH ROW EXECUTE FUNCTION code_projects_no_delete_guard();
CREATE OR REPLACE FUNCTION code_operations_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.principal_scope IS DISTINCT FROM OLD.principal_scope OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.input_hash IS DISTINCT FROM OLD.input_hash OR NEW.payload_json IS DISTINCT FROM OLD.payload_json OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING MESSAGE = 'Code operation identity is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_operations_identity BEFORE UPDATE ON code_operations
FOR EACH ROW EXECUTE FUNCTION code_operations_identity_guard();
CREATE OR REPLACE FUNCTION code_operations_result_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.status <> 'prepared' THEN
    RAISE EXCEPTION USING MESSAGE = 'A finished Code operation is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_operations_result BEFORE UPDATE ON code_operations
FOR EACH ROW EXECUTE FUNCTION code_operations_result_guard();
CREATE OR REPLACE FUNCTION code_operations_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Code operations are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER code_operations_no_delete BEFORE DELETE ON code_operations
FOR EACH ROW EXECUTE FUNCTION code_operations_no_delete_guard();
ALTER TABLE code_projects ADD COLUMN store_json TEXT;
CREATE OR REPLACE FUNCTION code_projects_store_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.store_json IS NOT NULL AND NEW.store_json IS DISTINCT FROM OLD.store_json THEN
    RAISE EXCEPTION USING MESSAGE = 'The repository of a project is recorded once and is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_projects_store BEFORE UPDATE ON code_projects
FOR EACH ROW EXECUTE FUNCTION code_projects_store_guard();
ALTER TABLE code_operations ADD COLUMN unit_id TEXT;
ALTER TABLE code_operations ADD COLUMN generation BIGINT;
ALTER TABLE code_operations ADD COLUMN phase TEXT;
ALTER TABLE code_operations ADD COLUMN progress_json TEXT;
ALTER TABLE code_operations ADD COLUMN detail_json TEXT;
ALTER TABLE code_operations ADD COLUMN claim_id TEXT;
ALTER TABLE code_operations ADD COLUMN claim_until TEXT;
ALTER TABLE code_operations ADD COLUMN attempts BIGINT NOT NULL DEFAULT 0;
ALTER TABLE code_operations ADD COLUMN next_at TEXT;
ALTER TABLE code_operations ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX code_operations_unit_open ON code_operations(project_id,unit_id,kind) WHERE status='prepared' AND unit_id IS NOT NULL;
CREATE INDEX code_operations_due ON code_operations(status,kind,next_at);
CREATE OR REPLACE FUNCTION code_projects_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION USING MESSAGE = 'Code repository binding is immutable outside its own rebind operation', ERRCODE = '23514';
  END IF;
  IF (NEW.repository_id IS DISTINCT FROM OLD.repository_id OR NEW.binding_json IS DISTINCT FROM OLD.binding_json) AND NOT EXISTS (
    SELECT 1 FROM code_operations
    WHERE id = NEW.binding_json::jsonb->>'operationId' AND project_id = OLD.project_id
      AND kind = 'rebind' AND status = 'prepared'
      AND payload_json::jsonb->>'repositoryId' = NEW.repository_id
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'Code repository binding is immutable outside its own rebind operation', ERRCODE = '23514';
  END IF;
  IF NEW.repository_id IS DISTINCT FROM OLD.repository_id AND (
    NEW.binding_json::jsonb->'previous'->-1->>'repositoryId' IS DISTINCT FROM OLD.repository_id
    OR NEW.binding_json::jsonb->'previous' IS DISTINCT FROM
       COALESCE(OLD.binding_json::jsonb->'previous','[]'::jsonb) || jsonb_build_array(NEW.binding_json::jsonb->'previous'->-1)
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'Code repository binding is immutable outside its own rebind operation', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
END IF;
END $code_storage$;
CREATE TABLE code_workspaces (
  project_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  base_json TEXT,
  generation BIGINT NOT NULL DEFAULT 0,
  writer_state TEXT NOT NULL DEFAULT 'idle' CHECK (writer_state IN ('idle','reserved','active','closing','closed','recovery_required')),
  writer_session_id TEXT,
  writer_lease_id TEXT,
  writer_changed_at TEXT,
  head_oid TEXT,
  head_operation_id TEXT,
  mirrored_oid TEXT,
  mirrored_at TEXT,
  quarantine_operation_id TEXT,
  blocked_by TEXT,
  PRIMARY KEY(project_id,unit_id)
);
CREATE FUNCTION code_workspaces_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Code workspaces are retained'; END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.declared_at IS DISTINCT FROM OLD.declared_at THEN
    RAISE EXCEPTION 'Code workspace identity is immutable';
  END IF;
  IF OLD.base_json IS NOT NULL AND NEW.base_json IS DISTINCT FROM OLD.base_json THEN
    RAISE EXCEPTION 'The workspace starting commit is immutable';
  END IF;
  IF NEW.generation < OLD.generation OR NEW.generation > OLD.generation+1 THEN
    RAISE EXCEPTION 'A writer generation only advances by one';
  END IF;
  IF NEW.generation IS DISTINCT FROM OLD.generation AND EXISTS (
    SELECT 1 FROM code_operations WHERE project_id=OLD.project_id AND unit_id=OLD.unit_id AND kind='upload' AND status='prepared' AND phase IN ('admitting','objects_durable','refs_applied')
  ) THEN RAISE EXCEPTION 'A writer generation cannot change while an admitted upload is unresolved'; END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER code_workspaces_guard BEFORE UPDATE OR DELETE ON code_workspaces FOR EACH ROW EXECUTE FUNCTION code_workspaces_guard();
CREATE TABLE code_retained_commits (
  project_id TEXT NOT NULL,
  retention_key TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  storage TEXT NOT NULL CHECK(storage IN ('code','external')),
  receipt TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,retention_key)
);
CREATE FUNCTION code_retained_commits_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN RAISE EXCEPTION 'Retained Git facts are immutable'; END $guard$;
CREATE TRIGGER code_retained_commits_guard BEFORE UPDATE OR DELETE ON code_retained_commits FOR EACH ROW EXECUTE FUNCTION code_retained_commits_guard();
CREATE TABLE code_repository_holds (
  project_id TEXT NOT NULL,
  hold_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(project_id,hold_key)
);
CREATE TABLE code_reference_eligibility (
  project_id TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  blocked_reason TEXT,
  PRIMARY KEY(project_id,ref_key)
);
CREATE FUNCTION code_set_reference_eligibility(project TEXT, key TEXT, reason TEXT) RETURNS void LANGUAGE sql AS $eligibility$
  INSERT INTO code_reference_eligibility(project_id,ref_key,blocked_reason) VALUES(project,key,reason)
  ON CONFLICT(project_id,ref_key) DO UPDATE SET blocked_reason=EXCLUDED.blocked_reason;
$eligibility$;
-- Transactional API for storage owners projecting their obligations through SQL triggers.
-- Keys belong to the caller; releasing one obligation never clears another owner's hold.
CREATE FUNCTION code_hold_repository(project TEXT, key TEXT, detail TEXT) RETURNS void LANGUAGE sql AS $hold$
  INSERT INTO code_repository_holds(project_id,hold_key,reason) VALUES(project,key,detail)
  ON CONFLICT(project_id,hold_key) DO UPDATE SET reason=EXCLUDED.reason;
$hold$;
CREATE FUNCTION code_release_repository(project TEXT, key TEXT) RETURNS void LANGUAGE sql AS $hold$
  DELETE FROM code_repository_holds WHERE project_id=project AND hold_key=key;
$hold$;
-- Existing databases stay closed to mutation until their owning adapter translates legacy
-- obligations. Detect only the legacy table; Code never interprets its research records.
DO $upgrade$
BEGIN
IF to_regclass('code_units') IS NOT NULL THEN
  INSERT INTO code_repository_holds(project_id,hold_key,reason)
  SELECT project_id,'code-storage-upgrade','Legacy repository obligations require migration'
  FROM code_projects;
END IF;
END $upgrade$;
`;

export async function initializeCodeStorage(state: State): Promise<void> {
  await state.migrate('code_storage', [{ version: 1, sql: schema }]);
  await migratePendingMerges(state);
}
