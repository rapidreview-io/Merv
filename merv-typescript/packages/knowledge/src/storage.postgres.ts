/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE knowledge_snapshots (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 format_version BIGINT NOT NULL CHECK(format_version=1), manifest_hash TEXT NOT NULL,
 record TEXT NOT NULL CHECK((record IS JSON))
);
CREATE INDEX knowledge_snapshots_project ON knowledge_snapshots(project_id,created_at,id);
CREATE OR REPLACE FUNCTION knowledge_snapshots_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Knowledge snapshots are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER knowledge_snapshots_no_update BEFORE UPDATE ON knowledge_snapshots
FOR EACH ROW EXECUTE FUNCTION knowledge_snapshots_no_update_guard();
CREATE OR REPLACE FUNCTION knowledge_snapshots_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Knowledge snapshots are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER knowledge_snapshots_no_delete BEFORE DELETE ON knowledge_snapshots
FOR EACH ROW EXECUTE FUNCTION knowledge_snapshots_no_delete_guard();
CREATE TABLE knowledge_commands (
 project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
 input_hash TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
 PRIMARY KEY(project_id,actor_id,request_id)
);
CREATE OR REPLACE FUNCTION knowledge_commands_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Knowledge command receipts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER knowledge_commands_no_update BEFORE UPDATE ON knowledge_commands
FOR EACH ROW EXECUTE FUNCTION knowledge_commands_no_update_guard();
CREATE OR REPLACE FUNCTION knowledge_commands_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Knowledge command receipts are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER knowledge_commands_no_delete BEFORE DELETE ON knowledge_commands
FOR EACH ROW EXECUTE FUNCTION knowledge_commands_no_delete_guard();
`,
};
