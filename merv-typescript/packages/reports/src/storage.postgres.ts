/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
const guards = (table: string, what: string) => `
CREATE OR REPLACE FUNCTION ${table}_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = '${what} are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table}
FOR EACH ROW EXECUTE FUNCTION ${table}_immutable_guard();
CREATE OR REPLACE FUNCTION ${table}_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = '${what} are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
FOR EACH ROW EXECUTE FUNCTION ${table}_retained_guard();`;

export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE report_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,subject_kind,subject_id));
${guards('report_drafts', 'Report drafts')}
CREATE TABLE report_revisions(report_id TEXT NOT NULL,revision BIGINT NOT NULL,project_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(report_id,revision));
${guards('report_revisions', 'Report revisions')}
CREATE TABLE report_finals(source_artifact_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,report_id TEXT NOT NULL,revision BIGINT NOT NULL,record TEXT NOT NULL);
CREATE INDEX report_finals_report ON report_finals(project_id,report_id,revision);
${guards('report_finals', 'Final reports')}
CREATE TABLE report_commands(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
${guards('report_commands', 'Report receipts')}
`,
};
