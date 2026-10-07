// projects.summary, projects.context_revision and project_context_commands are retired: Paper
// serves the Introduction from the Problem. scope@10 drops them, with the receipts' two guard
// functions, once deploy/problem-backfill.mjs has copied every summary that was a project's
// only description into its Problem. Production's count before that release (2026-10-07:
// 109 projects, 41 with a summary, 31 of them with no Problem, 38 receipts):
//   SELECT COUNT(*) FILTER (WHERE summary <> '') AS with_summary,
//          COUNT(*) FILTER (WHERE context_revision > 0) AS revised,
//          (SELECT COUNT(*) FROM project_context_commands) AS receipts
//   FROM projects;
/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
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
  // Refuses while a project's summary is still its only description, so it cannot run before
  // the backfill. Reading Paper's paper_revisions from Scope's migration is a one-time safety
  // check, accepted for this release only; on a new database Paper's table does not exist yet
  // and no project has a summary.
  10: `DO $merv$
DECLARE
  orphans BIGINT;
BEGIN
  IF to_regclass('paper_revisions') IS NULL THEN
    SELECT COUNT(*) INTO orphans FROM projects WHERE btrim(summary) <> '';
  ELSE
    EXECUTE 'SELECT COUNT(*) FROM projects p WHERE btrim(p.summary) <> '''' AND NOT EXISTS (SELECT 1 FROM paper_revisions r WHERE r.project_id = p.id AND r.kind = ''problem'')'
      INTO orphans;
  END IF;
  IF orphans > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format('%s projects still have a summary and no Paper Problem; run deploy/problem-backfill.mjs first', orphans);
  END IF;
END
$merv$;
DROP TABLE project_context_commands;
DROP FUNCTION project_context_commands_no_update_guard();
DROP FUNCTION project_context_commands_no_delete_guard();
ALTER TABLE projects DROP COLUMN summary, DROP COLUMN context_revision;`,
};
