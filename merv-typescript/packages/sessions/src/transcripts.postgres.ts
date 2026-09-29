/**
 * Published PostgreSQL migrations. Production pins each text by its digest: never edit one.
 * A retirement migration that deletes worker sessions deletes their transcript rows first, with
 * session_transcripts_immutable disabled; the objects they name are left in the store.
 */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE session_transcripts (
  session_id TEXT PRIMARY KEY REFERENCES worker_sessions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow TEXT NOT NULL, role TEXT NOT NULL, runner_id TEXT NOT NULL, agent_id TEXT,
  host_ref TEXT NOT NULL, hostname TEXT,
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  size BIGINT NOT NULL CHECK(size > 0 AND size <= 67108864),
  log_bytes BIGINT NOT NULL CHECK(log_bytes >= 0),
  truncated BIGINT NOT NULL CHECK(truncated IN (0,1)),
  declared_at TEXT NOT NULL, uploaded_at TEXT
);
CREATE INDEX session_transcripts_runner ON session_transcripts(project_id,runner_id);
CREATE INDEX session_transcripts_workflow ON session_transcripts(project_id,workflow,role);
CREATE INDEX session_transcripts_agent ON session_transcripts(project_id,agent_id);
CREATE INDEX session_transcripts_host ON session_transcripts(host_ref);
CREATE INDEX session_transcripts_sha256 ON session_transcripts(sha256);
CREATE OR REPLACE FUNCTION session_transcripts_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.uploaded_at IS NOT NULL OR NEW.uploaded_at IS NULL OR
     (to_jsonb(NEW) - 'uploaded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'uploaded_at') THEN
    RAISE EXCEPTION USING MESSAGE = 'Session transcripts are retained; the upload is recorded once', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_transcripts_immutable BEFORE UPDATE OR DELETE ON session_transcripts
FOR EACH ROW EXECUTE FUNCTION session_transcripts_guard();
`,
};
