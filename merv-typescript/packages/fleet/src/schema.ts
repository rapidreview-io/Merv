/** Published migration text is immutable after release. */
export const migration = {
  version: 1,
  sql: `CREATE TABLE fleet_allocations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    source_hash TEXT NOT NULL,
    request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    phase TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data_json TEXT NOT NULL,
    UNIQUE(project_id, source_hash, request_id)
  );
  CREATE INDEX fleet_allocations_pending ON fleet_allocations(phase, created_at, id);
  CREATE OR REPLACE FUNCTION fleet_allocation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
  BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
      NEW.source_hash IS DISTINCT FROM OLD.source_hash OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
      NEW.input_hash IS DISTINCT FROM OLD.input_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Fleet allocation identity is immutable';
    END IF;
    RETURN NEW;
  END;
  $merv$;
  CREATE TRIGGER fleet_allocation_identity BEFORE UPDATE ON fleet_allocations
  FOR EACH ROW EXECUTE FUNCTION fleet_allocation_identity_guard();`,
};

/**
 * Rows are never deleted, so each read that runs every pass needs an index on what it filters:
 * the open rows (all()), an owner's targets (listOwned()) and one person's rentals by day (the
 * spend cap). The expressions must match the queries' text, or the planner cannot use them.
 */
export const migrationV2 = {
  version: 2,
  sql: `CREATE INDEX fleet_allocations_open ON fleet_allocations(created_at, id) WHERE phase <> 'released';
  CREATE INDEX fleet_allocations_owner ON fleet_allocations((data_json::jsonb #>> '{owner,id}'));
  CREATE INDEX fleet_allocations_person ON fleet_allocations((data_json::jsonb ->> 'person'), created_at);`,
};
