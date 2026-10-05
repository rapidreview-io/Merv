import { postgresGuard } from './postgres-guard.js';

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
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
  // Sealed proposals and the GitHub checkpoint transport are retired with their records; commit
  // commands remain, because every workspace upload delivers one.
  2: `
DROP TABLE IF EXISTS code_proposals, code_github_workspaces, code_github_pushes;
DROP FUNCTION IF EXISTS code_proposals_no_update_guard(), code_proposals_no_delete_guard();
DO $code_legacy$
BEGIN
  IF to_regclass('component_migrations') IS NOT NULL THEN
    DELETE FROM component_migrations WHERE component IN ('code_proposals','code_github_transport');
  END IF;
END $code_legacy$;
`,
};
