/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_by TEXT NOT NULL,title TEXT NOT NULL,media_type TEXT NOT NULL,hash TEXT NOT NULL,size BIGINT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX artifacts_project ON artifacts(project_id);
      CREATE OR REPLACE FUNCTION artifacts_immutable_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Artifacts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts
FOR EACH ROW EXECUTE FUNCTION artifacts_immutable_update_guard();
      CREATE OR REPLACE FUNCTION artifacts_immutable_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Artifacts are immutable', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER artifacts_immutable_delete BEFORE DELETE ON artifacts
FOR EACH ROW EXECUTE FUNCTION artifacts_immutable_delete_guard();
`,
};
