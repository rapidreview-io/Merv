/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  6: `
ALTER TABLE projects ADD COLUMN summary TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN context_revision BIGINT NOT NULL DEFAULT 0
      CHECK(context_revision >= 0 AND context_revision <= 9007199254740991);
    CREATE TABLE project_context_commands (
      project_id TEXT NOT NULL REFERENCES projects(id), actor_id TEXT NOT NULL REFERENCES actors(id),
      request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(project_id,actor_id,request_id)
    );
    CREATE OR REPLACE FUNCTION project_context_commands_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Project context receipts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER project_context_commands_no_update BEFORE UPDATE ON project_context_commands
FOR EACH ROW EXECUTE FUNCTION project_context_commands_no_update_guard();
    CREATE OR REPLACE FUNCTION project_context_commands_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Project context receipts are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER project_context_commands_no_delete BEFORE DELETE ON project_context_commands
FOR EACH ROW EXECUTE FUNCTION project_context_commands_no_delete_guard();
`,
};
