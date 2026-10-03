import type { State } from '@merv/contracts';
import { postgresMigrations } from './legacy-units.postgres.js';
import { migrateBases } from './base-schema.js';
import { migratePublications } from './publications-schema.js';

/** Fresh work-unit storage. Published legacy SQL is kept byte-identical for existing databases. */
const schema = `DO $research_records$
BEGIN
IF to_regclass('code_units') IS NULL THEN
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
CREATE TABLE code_unit_frontiers(project_id TEXT NOT NULL,unit_id TEXT NOT NULL,inputs_json TEXT NOT NULL,PRIMARY KEY(project_id,unit_id));
CREATE FUNCTION code_unit_frontiers_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Unit frontier is immutable and retained'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_unit_frontiers_guard BEFORE UPDATE OR DELETE ON code_unit_frontiers FOR EACH ROW EXECUTE FUNCTION code_unit_frontiers_guard();
CREATE TABLE code_unit_inputs(project_id TEXT NOT NULL,unit_id TEXT NOT NULL,reference TEXT NOT NULL,PRIMARY KEY(project_id,unit_id));
CREATE FUNCTION code_unit_inputs_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Unit inputs are immutable and retained'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_unit_inputs_guard BEFORE UPDATE OR DELETE ON code_unit_inputs FOR EACH ROW EXECUTE FUNCTION code_unit_inputs_guard();
CREATE INDEX code_units_accepted_commit ON code_units(project_id,((acceptance_json::jsonb #>> '{code,commit}'))) WHERE acceptance_json IS NOT NULL;
ALTER TABLE code_units ADD COLUMN quarantine_base_key TEXT;
CREATE FUNCTION code_units_base_quarantine_guard() RETURNS trigger AS $$ BEGIN
IF OLD.quarantine_base_key IS NOT NULL AND NEW.quarantine_base_key IS DISTINCT FROM OLD.quarantine_base_key THEN RAISE EXCEPTION 'Base quarantine is retained'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_units_base_quarantine BEFORE UPDATE ON code_units FOR EACH ROW EXECUTE FUNCTION code_units_base_quarantine_guard();

CREATE OR REPLACE FUNCTION code_units_base_quarantine_guard() RETURNS trigger AS $$ BEGIN
IF OLD.quarantine_base_key IS NOT NULL AND NEW.quarantine_base_key IS DISTINCT FROM OLD.quarantine_base_key AND NEW.quarantine_base_key IS NOT NULL THEN RAISE EXCEPTION 'Base quarantine is retained'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
ALTER TABLE code_units ADD COLUMN publishes_at TEXT;
ALTER TABLE code_units ADD COLUMN publication_id TEXT;
CREATE FUNCTION code_units_publish_guard() RETURNS trigger AS $$ BEGIN
IF OLD.publishes_at IS NOT NULL AND NEW.publishes_at IS DISTINCT FROM OLD.publishes_at THEN RAISE EXCEPTION 'Publishing to main is declared once'; END IF;
IF OLD.publication_id IS NOT NULL AND NEW.publication_id IS DISTINCT FROM OLD.publication_id THEN RAISE EXCEPTION 'The publication of a unit is immutable'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_units_publish BEFORE UPDATE ON code_units FOR EACH ROW EXECUTE FUNCTION code_units_publish_guard();
END IF;
END $research_records$;`;

export async function initializeWorkRecords(state: State): Promise<void> {
  const legacy = await state.read((sql) =>
    sql.get("SELECT 1 FROM component_migrations WHERE component='code_units' LIMIT 1"),
  );
  if (legacy) await initializeLegacyCodeRecords(state);
  await state.migrate('code_research_records', [{ version: 1, sql: schema }]);
  await migrateBases(state);
  await migratePublications(state);
}

/** Preserve the exact published migration path for existing installations and release census. */
export async function initializeLegacyCodeRecords(state: State): Promise<void> {
  await state.migrate(
    'code_units',
    Object.entries(postgresMigrations).map(([version, sql]) => ({ version: Number(version), sql })),
  );
}
