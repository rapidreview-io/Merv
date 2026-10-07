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

/**
 * A hold on work machines, by whoever must replace the apps they run on: deploy/hosted-release-vm.py
 * holds them while it drains and redeploys the hosted image, since a Cloudflare rollout replaces
 * every running container. While a row's `until` (an ISO instant, as Fleet writes its own) is
 * ahead, the workflow owner rents nothing and stops each machine whose step has settled, and no
 * machine admits a new step. The holder deletes its row; one it leaves lapses.
 */
export const migrationV3 = {
  version: 3,
  sql: `CREATE TABLE fleet_holds (
    name TEXT PRIMARY KEY,
    until TEXT NOT NULL
  );`,
};

/** Fleet workflow's own tables (component `fleet_workflow`): its model ledger and retry grants.
 *  Published migration text is immutable after release. */
export const usageMigration = {
  version: 1,
  sql: `CREATE TABLE fleet_model_usage (
    person TEXT NOT NULL,
    day TEXT NOT NULL,
    tokens BIGINT NOT NULL,
    PRIMARY KEY(person, day)
  );`,
};

/** A person's own daily limit, where they set one (founder ruling 2026-09-25). */
export const limitsMigration = {
  version: 2,
  sql: `CREATE TABLE fleet_model_limits (
    person TEXT PRIMARY KEY,
    tokens BIGINT NOT NULL
  );`,
};

/** The latest unaffordable reservation, separate from charged usage and personal limits. */
export const blockerMigration = {
  version: 3,
  sql: `CREATE TABLE fleet_model_blockers (
    person TEXT NOT NULL,
    day TEXT NOT NULL,
    required_tokens BIGINT NOT NULL,
    PRIMARY KEY(person, day)
  );`,
};
/** Operator-authorized retry windows; old rentals remain immutable Fleet history. */
export const workflowRetryMigration = {
  version: 4,
  sql: `CREATE TABLE fleet_workflow_retry_grants (
    id BIGSERIAL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    instance_id TEXT NOT NULL,
    expected_revision INTEGER NOT NULL,
    prior_allocations INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, request_id),
    UNIQUE(project_id, instance_id, expected_revision, prior_allocations)
  );
  CREATE INDEX fleet_workflow_retry_target ON fleet_workflow_retry_grants
    (project_id, instance_id, expected_revision, id DESC);
  CREATE OR REPLACE FUNCTION fleet_workflow_retry_immutable() RETURNS trigger LANGUAGE plpgsql AS $merv$
  BEGIN
    RAISE EXCEPTION 'Fleet workflow retry grants are retained';
  END;
  $merv$;
  CREATE TRIGGER fleet_workflow_retry_no_update BEFORE UPDATE ON fleet_workflow_retry_grants
    FOR EACH ROW EXECUTE FUNCTION fleet_workflow_retry_immutable();
  CREATE TRIGGER fleet_workflow_retry_no_delete BEFORE DELETE ON fleet_workflow_retry_grants
    FOR EACH ROW EXECUTE FUNCTION fleet_workflow_retry_immutable();`,
};
/** What each session with a budget of its own (a grant's `tokenBudget`) has spent, charged call
 *  by call beside its person's day; and the relay's own faults, by session (or `*` for Main's
 *  restart), so a visit they cut is not counted as its work's failure. New tables: no prod
 *  count. */
export const grantTokensMigration = {
  version: 5,
  sql: `CREATE TABLE fleet_grant_tokens (
    grant_id TEXT PRIMARY KEY,
    tokens BIGINT NOT NULL CHECK (tokens >= 0)
  );
  CREATE TABLE fleet_relay_faults (
    subject TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX fleet_relay_faults_at ON fleet_relay_faults(at);`,
};
export const modelMigrations = [
  usageMigration,
  limitsMigration,
  blockerMigration,
  workflowRetryMigration,
  grantTokensMigration,
];
