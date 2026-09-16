/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE code_proposals (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>0),
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  UNIQUE(project_id,instance_id,revision),
  UNIQUE(project_id,session_id,request_id)
);
CREATE INDEX code_proposals_project ON code_proposals(project_id,instance_id,revision);
CREATE OR REPLACE FUNCTION code_proposals_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Code proposals are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_proposals_no_update BEFORE UPDATE ON code_proposals
FOR EACH ROW EXECUTE FUNCTION code_proposals_no_update_guard();
CREATE OR REPLACE FUNCTION code_proposals_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Code proposals are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER code_proposals_no_delete BEFORE DELETE ON code_proposals
FOR EACH ROW EXECUTE FUNCTION code_proposals_no_delete_guard();
`,
};
