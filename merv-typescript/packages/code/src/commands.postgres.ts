/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE code_commands (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  command_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','dispatched','succeeded','failed','cancelled')),
  receipt_json TEXT,
  error TEXT,
  UNIQUE(session_id,request_id),
  CHECK (
    (status IN ('queued','dispatched') AND receipt_json IS NULL AND error IS NULL) OR
    (status='succeeded' AND receipt_json IS NOT NULL AND error IS NULL) OR
    (status IN ('failed','cancelled') AND receipt_json IS NULL AND error IS NOT NULL)
  )
);
CREATE UNIQUE INDEX code_commands_outstanding ON code_commands(session_id)
  WHERE status IN ('queued','dispatched');
CREATE INDEX code_commands_project ON code_commands(project_id);
CREATE OR REPLACE FUNCTION code_commands_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
  NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
  NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.input_hash IS DISTINCT FROM OLD.input_hash OR
  NEW.command_json IS DISTINCT FROM OLD.command_json THEN
    RAISE EXCEPTION USING MESSAGE = 'Code command identity is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_commands_identity BEFORE UPDATE ON code_commands
FOR EACH ROW EXECUTE FUNCTION code_commands_identity_guard();
CREATE OR REPLACE FUNCTION code_commands_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NOT (
  (OLD.status='queued' AND NEW.status IN ('dispatched','cancelled')) OR
  (OLD.status='dispatched' AND NEW.status IN ('succeeded','failed'))
) THEN
    RAISE EXCEPTION USING MESSAGE = 'Code command result is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_commands_transition BEFORE UPDATE ON code_commands
FOR EACH ROW EXECUTE FUNCTION code_commands_transition_guard();
CREATE OR REPLACE FUNCTION code_commands_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Code commands are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER code_commands_no_delete BEFORE DELETE ON code_commands
FOR EACH ROW EXECUTE FUNCTION code_commands_no_delete_guard();
`,
};
