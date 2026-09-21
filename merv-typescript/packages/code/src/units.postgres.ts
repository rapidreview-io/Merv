/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
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
CREATE TABLE code_units (
  project_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  workflow TEXT NOT NULL,
  version BIGINT NOT NULL,
  declared_at TEXT NOT NULL,
  base_json TEXT,
  base_hash TEXT,
  base_lease_id TEXT,
  based_at TEXT,
  acceptance_json TEXT,
  acceptance_hash TEXT,
  accepted_at TEXT,
  PRIMARY KEY (project_id,unit_id),
  CHECK ((base_json IS NULL)=(base_hash IS NULL) AND (base_json IS NULL)=(base_lease_id IS NULL) AND (base_json IS NULL)=(based_at IS NULL)),
  CHECK ((acceptance_json IS NULL)=(acceptance_hash IS NULL) AND (acceptance_json IS NULL)=(accepted_at IS NULL))
);
CREATE INDEX code_units_declared ON code_units(project_id,declared_at,unit_id);
CREATE TABLE code_edges (
  project_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id,source_ref,relation,target_ref)
);
CREATE INDEX code_edges_target ON code_edges(project_id,target_ref,relation);
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
CREATE OR REPLACE FUNCTION code_units_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.workflow IS DISTINCT FROM OLD.workflow OR NEW.version IS DISTINCT FROM OLD.version OR NEW.declared_at IS DISTINCT FROM OLD.declared_at THEN
    RAISE EXCEPTION USING MESSAGE = 'Code unit identity is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_units_identity BEFORE UPDATE ON code_units
FOR EACH ROW EXECUTE FUNCTION code_units_identity_guard();
CREATE OR REPLACE FUNCTION code_units_base_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.base_json IS NOT NULL AND (NEW.base_json IS DISTINCT FROM OLD.base_json OR NEW.base_hash IS DISTINCT FROM OLD.base_hash OR NEW.base_lease_id IS DISTINCT FROM OLD.base_lease_id OR NEW.based_at IS DISTINCT FROM OLD.based_at) THEN
    RAISE EXCEPTION USING MESSAGE = 'The base pin of a unit is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_units_base BEFORE UPDATE ON code_units
FOR EACH ROW EXECUTE FUNCTION code_units_base_guard();
CREATE OR REPLACE FUNCTION code_units_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.acceptance_json IS NOT NULL AND (NEW.acceptance_json IS DISTINCT FROM OLD.acceptance_json OR NEW.acceptance_hash IS DISTINCT FROM OLD.acceptance_hash OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at) THEN
    RAISE EXCEPTION USING MESSAGE = 'The acceptance of a unit is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_units_acceptance BEFORE UPDATE ON code_units
FOR EACH ROW EXECUTE FUNCTION code_units_acceptance_guard();
CREATE OR REPLACE FUNCTION code_units_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Code units are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER code_units_no_delete BEFORE DELETE ON code_units
FOR EACH ROW EXECUTE FUNCTION code_units_no_delete_guard();
CREATE OR REPLACE FUNCTION code_edges_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Code lineage is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_edges_no_update BEFORE UPDATE ON code_edges
FOR EACH ROW EXECUTE FUNCTION code_edges_no_update_guard();
CREATE OR REPLACE FUNCTION code_edges_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Code lineage is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER code_edges_no_delete BEFORE DELETE ON code_edges
FOR EACH ROW EXECUTE FUNCTION code_edges_no_delete_guard();
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
`,
  2: `
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
ALTER TABLE code_units ADD COLUMN generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE code_units ADD COLUMN writer_state TEXT NOT NULL DEFAULT 'idle' CHECK (writer_state IN ('idle','reserved','active','closing','closed','recovery_required'));
ALTER TABLE code_units ADD COLUMN writer_session_id TEXT;
ALTER TABLE code_units ADD COLUMN writer_lease_id TEXT;
ALTER TABLE code_units ADD COLUMN writer_changed_at TEXT;
ALTER TABLE code_units ADD COLUMN head_oid TEXT;
ALTER TABLE code_units ADD COLUMN head_operation_id TEXT;
ALTER TABLE code_units ADD COLUMN mirrored_oid TEXT;
ALTER TABLE code_units ADD COLUMN mirrored_at TEXT;
ALTER TABLE code_units ADD COLUMN quarantine_operation_id TEXT;
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
CREATE OR REPLACE FUNCTION code_units_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.generation < OLD.generation OR NEW.generation > OLD.generation + 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'A writer generation only advances by one', ERRCODE = '23514';
  END IF;
  IF NEW.generation IS DISTINCT FROM OLD.generation AND EXISTS (
    SELECT 1 FROM code_operations
    WHERE project_id=OLD.project_id AND unit_id=OLD.unit_id AND kind='upload' AND status='prepared' AND phase IN ('admitting','objects_durable','refs_applied')
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'A writer generation cannot change while an admitted upload is unresolved', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_units_generation BEFORE UPDATE ON code_units
FOR EACH ROW EXECUTE FUNCTION code_units_generation_guard();
`,
  3: `CREATE TABLE code_unit_inputs(project_id TEXT NOT NULL,unit_id TEXT NOT NULL,reference TEXT NOT NULL,PRIMARY KEY(project_id,unit_id));
CREATE FUNCTION code_unit_inputs_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Unit inputs are immutable and retained'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_unit_inputs_guard BEFORE UPDATE OR DELETE ON code_unit_inputs FOR EACH ROW EXECUTE FUNCTION code_unit_inputs_guard();`,
  4: `CREATE INDEX code_units_accepted_commit ON code_units(project_id,((acceptance_json::jsonb #>> '{code,commit}'))) WHERE acceptance_json IS NOT NULL;`,
  5: `ALTER TABLE code_units ADD COLUMN quarantine_base_key TEXT;
CREATE FUNCTION code_units_base_quarantine_guard() RETURNS trigger AS $$ BEGIN
IF OLD.quarantine_base_key IS NOT NULL AND NEW.quarantine_base_key IS DISTINCT FROM OLD.quarantine_base_key THEN RAISE EXCEPTION 'Base quarantine is retained'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_units_base_quarantine BEFORE UPDATE ON code_units FOR EACH ROW EXECUTE FUNCTION code_units_base_quarantine_guard();`,
};
