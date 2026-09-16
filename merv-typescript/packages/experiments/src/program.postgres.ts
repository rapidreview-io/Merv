/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE experiment_leases (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, experiment_id TEXT NOT NULL,
        revision BIGINT NOT NULL, attempt_index BIGINT NOT NULL, state TEXT NOT NULL,
        actor_id TEXT NOT NULL UNIQUE, source_actor_id TEXT NOT NULL, review_id TEXT, claim_id TEXT,
        receipt TEXT NOT NULL, artifacts TEXT NOT NULL, recovery TEXT NOT NULL, inputs TEXT NOT NULL,
        released_at TEXT
      );
      CREATE UNIQUE INDEX experiment_lease_active ON experiment_leases(project_id,experiment_id,revision) WHERE released_at IS NULL;
      CREATE OR REPLACE FUNCTION experiment_lease_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Experiment lease provenance is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER experiment_lease_immutable BEFORE UPDATE OF id,project_id,experiment_id,revision,attempt_index,state,actor_id,source_actor_id,review_id,claim_id,receipt,artifacts,recovery,inputs ON experiment_leases
FOR EACH ROW EXECUTE FUNCTION experiment_lease_immutable_guard();
      CREATE OR REPLACE FUNCTION experiment_lease_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Experiment lease provenance is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER experiment_lease_no_delete BEFORE DELETE ON experiment_leases
FOR EACH ROW EXECUTE FUNCTION experiment_lease_no_delete_guard();
`,
  2: `
ALTER TABLE experiment_leases DROP CONSTRAINT experiment_leases_actor_id_key;
`,
};
