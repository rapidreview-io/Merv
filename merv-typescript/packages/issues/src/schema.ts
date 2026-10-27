/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const issueMigrations: Record<number, string> = {
  1: `
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  class TEXT NOT NULL CHECK (class IN ('tool','question','platform')),
  where_at TEXT NOT NULL CHECK (length(where_at) BETWEEN 1 AND 120),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 120),
  key TEXT CHECK (key IS NULL OR length(key) <= 300),
  level TEXT NOT NULL CHECK (level IN ('notice','warn','severe')),
  loop BOOLEAN NOT NULL DEFAULT false,
  standing BOOLEAN NOT NULL DEFAULT false,
  state TEXT NOT NULL CHECK (state IN ('open','resolved')),
  count BIGINT NOT NULL CHECK (count > 0),
  hour_at TEXT NOT NULL,
  hour_count BIGINT NOT NULL,
  peak_hour BIGINT NOT NULL,
  stored INTEGER NOT NULL DEFAULT 0,
  kept_at TEXT, kept_subject TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 280),
  first_at TEXT NOT NULL, opened_at TEXT NOT NULL, last_at TEXT NOT NULL,
  resolved_at TEXT, resolved_by TEXT,
  alerted_at TEXT,
  reopened INTEGER NOT NULL DEFAULT 0,
  _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX issues_recent ON issues(last_at);
CREATE INDEX issues_owed ON issues(opened_at) WHERE state='open' AND level='severe' AND alerted_at IS NULL;
CREATE INDEX issues_quiet ON issues(last_at) WHERE state='open' AND (standing OR level<>'severe');
CREATE FUNCTION issues_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF TG_OP='DELETE' OR NEW.count < OLD.count OR
     (NEW.id, NEW.fingerprint, NEW.class, NEW.where_at, NEW.code, NEW.key, NEW.first_at) IS DISTINCT FROM
     (OLD.id, OLD.fingerprint, OLD.class, OLD.where_at, OLD.code, OLD.key, OLD.first_at) THEN
    RAISE EXCEPTION USING MESSAGE = 'Issues are retained; an issue keeps its identity and its count', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER issues_retained BEFORE UPDATE OR DELETE ON issues
FOR EACH ROW EXECUTE FUNCTION issues_guard();

CREATE TABLE issue_occurrences (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('notice','warn','severe')),
  status INTEGER,
  repeats INTEGER NOT NULL CHECK (repeats > 0),
  project_id TEXT, subject TEXT, session_id TEXT, instance_id TEXT,
  release TEXT,
  refs_json TEXT NOT NULL,
  error_json TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 280),
  trace_json TEXT,
  _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX issue_occurrences_issue ON issue_occurrences(issue_id, _merv_rowid);
CREATE INDEX issue_occurrences_session ON issue_occurrences(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX issue_occurrences_instance ON issue_occurrences(instance_id) WHERE instance_id IS NOT NULL;
CREATE INDEX issue_occurrences_unpinned ON issue_occurrences(_merv_rowid) WHERE trace_json IS NULL AND session_id IS NOT NULL;
CREATE FUNCTION issue_occurrences_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF TG_OP='DELETE' OR OLD.trace_json IS NOT NULL OR NEW.trace_json IS NULL OR
     (to_jsonb(NEW) - 'trace_json') IS DISTINCT FROM (to_jsonb(OLD) - 'trace_json') THEN
    RAISE EXCEPTION USING MESSAGE = 'A case is retained; its trace is write-once', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER issue_occurrences_immutable BEFORE UPDATE OR DELETE ON issue_occurrences
FOR EACH ROW EXECUTE FUNCTION issue_occurrences_guard();
`,
};
