/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE session_tool_calls (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES worker_sessions(id),
        tool TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms BIGINT,
        input_tokens BIGINT NOT NULL, output_tokens BIGINT
      );
      CREATE INDEX session_tool_calls_execution ON session_tool_calls(execution_id);
      CREATE OR REPLACE FUNCTION session_tool_calls_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.status!='running' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
        OR NEW.tool IS DISTINCT FROM OLD.tool OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION USING MESSAGE = 'Tool call attribution and completed observations are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_tool_calls_immutable BEFORE UPDATE ON session_tool_calls
FOR EACH ROW EXECUTE FUNCTION session_tool_calls_immutable_guard();
`,
};
