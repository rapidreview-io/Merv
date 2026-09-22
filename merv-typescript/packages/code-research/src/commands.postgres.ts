import { postgresGuard } from '@merv/code/postgres-guard';

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
${postgresGuard(
  'code_commands',
  'identity',
  'UPDATE',
  'Code command identity is immutable',
  `NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
  NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
  NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.input_hash IS DISTINCT FROM OLD.input_hash OR
  NEW.command_json IS DISTINCT FROM OLD.command_json`,
)}
${postgresGuard(
  'code_commands',
  'transition',
  'UPDATE',
  'Code command result is immutable',
  `NOT (
  (OLD.status='queued' AND NEW.status IN ('dispatched','cancelled')) OR
  (OLD.status='dispatched' AND NEW.status IN ('succeeded','failed'))
)`,
)}
${postgresGuard('code_commands', 'no_delete', 'DELETE', 'Code commands are retained')}
`,
};
