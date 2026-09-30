import { withoutTriggers } from '@merv/contracts/retired-instances';

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
  // Bytes up to the inline limit live in the row, verified by the CHECK. The session fill runs
  // while every content is still NULL, and the CHECK comes last, so neither hashes anything.
  // Rollback is forward only: a code revert keeps this version registered (else migration_ahead)
  // and keeps reading row content first, because rows written since have no blob.
  3: `
ALTER TABLE artifacts ADD COLUMN content BYTEA, ADD COLUMN session_id TEXT;
${withoutTriggers(
  'artifacts',
  ['artifacts_immutable_update'],
  `UPDATE artifacts a SET session_id = e.data_json::jsonb #>> '{source,sessionId}'
  FROM events e WHERE e.project_id = a.project_id AND e.subject_id = a.id AND e.type = 'artifact.created'
  AND (e.data_json::jsonb #>> '{source,sessionId}') IS NOT NULL;`,
)}
ALTER TABLE artifacts ADD CONSTRAINT artifacts_content_verified
  CHECK (content IS NULL OR (octet_length(content) = size AND encode(sha256(content), 'hex') = hash));
`,
  // Newest-first pages of a project, and of the outputs of one session, scan an index backwards.
  // The project index leads with project_id, so it serves every use of the one it replaces.
  4: `
CREATE INDEX artifacts_project_created ON artifacts(project_id, created_at, id);
DROP INDEX artifacts_project;
CREATE INDEX artifacts_project_session ON artifacts(project_id, session_id, created_at, id) WHERE session_id IS NOT NULL;
`,
  // Temporary: the one change the update guard permits is filling a row's missing content, which
  // the CHECK then verifies; the legacy backfill made it. Version 6 restores the body of version 1.
  5: `
CREATE OR REPLACE FUNCTION artifacts_immutable_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.content IS NULL AND NEW.content IS NOT NULL
     AND (to_jsonb(NEW) - 'content') = (to_jsonb(OLD) - 'content') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING MESSAGE = 'Artifacts are immutable', ERRCODE = '23514';
END;
$merv$;
`,
  // Prod has no row left to fill, so the guard refuses every UPDATE again, with the body of
  // version 1. Rollback is forward only, as for version 3.
  6: `
CREATE OR REPLACE FUNCTION artifacts_immutable_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Artifacts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
`,
  7: `
ALTER TABLE artifacts ADD COLUMN source_key TEXT, ADD COLUMN collection_input_hash TEXT,
  ADD COLUMN files_json JSONB, ADD COLUMN file_refs_json JSONB, ADD COLUMN metadata_json JSONB;
CREATE UNIQUE INDEX artifacts_project_source_key ON artifacts(project_id,source_key)
  WHERE source_key IS NOT NULL;
`,
};
