/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
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
  2: `
ALTER TABLE artifacts ADD COLUMN object_id TEXT;
CREATE UNIQUE INDEX artifacts_project_object ON artifacts(project_id, object_id) WHERE object_id IS NOT NULL;
CREATE TABLE artifact_uploads(upload_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_by TEXT NOT NULL,title TEXT NOT NULL,media_type TEXT NOT NULL,hash TEXT NOT NULL,size BIGINT NOT NULL,object_id TEXT,artifact_id TEXT,created_at TEXT NOT NULL);
CREATE INDEX artifact_uploads_project ON artifact_uploads(project_id, created_by);
`,
};
