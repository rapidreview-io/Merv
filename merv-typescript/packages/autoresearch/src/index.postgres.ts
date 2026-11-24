/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  /**
   * autoresearch_projects: one row a project, its settings and where its loop stands (its history
   * is the autoresearch.* events and autoresearch_lines). Money is kept in whole cents.
   * autoresearch_runs: the tasks and experiments a manager visit started, by their workflow id.
   * autoresearch_wakes: what woke, or will wake, the manager: one row per ended run, delivered to
   * the visit at the manager's revision `delivered_revision`.
   * autoresearch_lines: the one-line log the person reads, append-only.
   */
  1: `
CREATE TABLE autoresearch_projects (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
 project_id TEXT PRIMARY KEY,
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 manager_id TEXT,
 goal TEXT,
 cap_cents INTEGER NOT NULL CHECK (cap_cents >= 0),
 run_estimate_cents INTEGER NOT NULL CHECK (run_estimate_cents >= 0),
 wake_limit INTEGER NOT NULL CHECK (wake_limit BETWEEN 1 AND 1000),
 automatic_wakes INTEGER NOT NULL DEFAULT 0 CHECK (automatic_wakes >= 0),
 paused TEXT CHECK (paused IN ('person','cap','wake_limit')),
 round_started_at TEXT,
 source_json TEXT,
 updated_at TEXT NOT NULL,
 updated_by TEXT NOT NULL);
CREATE TABLE autoresearch_runs (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 manager_id TEXT NOT NULL,
 workflow TEXT NOT NULL CHECK (workflow IN ('task','experiment')),
 name TEXT NOT NULL,
 started_at TEXT NOT NULL,
 ended_at TEXT,
 final_state TEXT);
CREATE INDEX autoresearch_runs_open ON autoresearch_runs(project_id, manager_id) WHERE ended_at IS NULL;
CREATE TABLE autoresearch_wakes (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 manager_id TEXT NOT NULL,
 run_id TEXT NOT NULL UNIQUE REFERENCES autoresearch_runs(id),
 report TEXT NOT NULL,
 created_at TEXT NOT NULL,
 delivered_revision INTEGER);
CREATE INDEX autoresearch_wakes_pending ON autoresearch_wakes(project_id, manager_id) WHERE delivered_revision IS NULL;
CREATE TABLE autoresearch_lines (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 manager_id TEXT NOT NULL,
 revision INTEGER,
 kind TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 text TEXT NOT NULL,
 at TEXT NOT NULL);
CREATE INDEX autoresearch_lines_newest ON autoresearch_lines(project_id, _merv_rowid DESC);
CREATE OR REPLACE FUNCTION autoresearch_lines_retained() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Autoresearch lines are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER autoresearch_lines_retained BEFORE UPDATE OR DELETE ON autoresearch_lines
FOR EACH ROW EXECUTE FUNCTION autoresearch_lines_retained();
CREATE TABLE autoresearch_commands (project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
`,
};
