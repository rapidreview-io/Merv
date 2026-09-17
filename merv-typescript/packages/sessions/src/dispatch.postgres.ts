/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE project_session_dispatch (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), enabled BIGINT NOT NULL CHECK(enabled IN (0,1)),
        updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
      );
      CREATE TABLE session_runners (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_hash TEXT NOT NULL,
        runner_id TEXT NOT NULL, source_json TEXT NOT NULL, presence_json TEXT NOT NULL,
        desired_version BIGINT NOT NULL DEFAULT 0, settings_json TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        UNIQUE(owner_hash,runner_id)
      );
      CREATE TABLE session_dispatch_receipts (
        owner_hash TEXT NOT NULL, runner_id TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE REFERENCES worker_sessions(id),
        runner_ref TEXT NOT NULL REFERENCES session_runners(id), platform_json TEXT NOT NULL,
        PRIMARY KEY(owner_hash,runner_id,request_id)
      );
      CREATE OR REPLACE FUNCTION session_dispatch_receipts_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Dispatch receipts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_dispatch_receipts_no_update BEFORE UPDATE ON session_dispatch_receipts
FOR EACH ROW EXECUTE FUNCTION session_dispatch_receipts_no_update_guard();
      CREATE OR REPLACE FUNCTION session_dispatch_receipts_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Dispatch receipts are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER session_dispatch_receipts_no_delete BEFORE DELETE ON session_dispatch_receipts
FOR EACH ROW EXECUTE FUNCTION session_dispatch_receipts_no_delete_guard();
      CREATE OR REPLACE FUNCTION session_runners_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.owner_hash IS DISTINCT FROM OLD.owner_hash OR
          NEW.runner_id IS DISTINCT FROM OLD.runner_id OR NEW.source_json IS DISTINCT FROM OLD.source_json THEN
    RAISE EXCEPTION USING MESSAGE = 'Runner delegation is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_runners_identity BEFORE UPDATE ON session_runners
FOR EACH ROW EXECUTE FUNCTION session_runners_identity_guard();
`,
  2: `
ALTER TABLE session_runners ADD COLUMN last_decision TEXT;
      ALTER TABLE session_runners ADD COLUMN last_decision_at TEXT;
`,
};
