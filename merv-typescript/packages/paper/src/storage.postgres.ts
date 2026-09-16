/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE paper_revisions(project_id TEXT NOT NULL,kind TEXT NOT NULL,revision BIGINT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(project_id,kind,revision));
CREATE OR REPLACE FUNCTION paper_revisions_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper revisions are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER paper_revisions_immutable BEFORE UPDATE ON paper_revisions
FOR EACH ROW EXECUTE FUNCTION paper_revisions_immutable_guard();
CREATE OR REPLACE FUNCTION paper_revisions_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper revisions are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER paper_revisions_retained BEFORE DELETE ON paper_revisions
FOR EACH ROW EXECUTE FUNCTION paper_revisions_retained_guard();
CREATE TABLE paper_citations(id TEXT NOT NULL,project_id TEXT NOT NULL,revision BIGINT NOT NULL,identifier TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE INDEX paper_citations_project ON paper_citations(project_id,id,revision);
CREATE OR REPLACE FUNCTION paper_citations_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Citation revisions are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER paper_citations_immutable BEFORE UPDATE ON paper_citations
FOR EACH ROW EXECUTE FUNCTION paper_citations_immutable_guard();
CREATE OR REPLACE FUNCTION paper_citations_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Citation revisions are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER paper_citations_retained BEFORE DELETE ON paper_citations
FOR EACH ROW EXECUTE FUNCTION paper_citations_retained_guard();
CREATE TABLE paper_updates(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,base_revision BIGINT NOT NULL,corpus_id TEXT NOT NULL,record TEXT NOT NULL);
CREATE OR REPLACE FUNCTION paper_updates_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper update inputs are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER paper_updates_immutable BEFORE UPDATE ON paper_updates
FOR EACH ROW EXECUTE FUNCTION paper_updates_immutable_guard();
CREATE OR REPLACE FUNCTION paper_updates_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper update inputs are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER paper_updates_retained BEFORE DELETE ON paper_updates
FOR EACH ROW EXECUTE FUNCTION paper_updates_retained_guard();
CREATE TABLE paper_publications(
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,revision BIGINT NOT NULL,update_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL);
CREATE OR REPLACE FUNCTION paper_publications_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper publications are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER paper_publications_immutable BEFORE UPDATE ON paper_publications
FOR EACH ROW EXECUTE FUNCTION paper_publications_immutable_guard();
CREATE OR REPLACE FUNCTION paper_publications_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper publications are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER paper_publications_retained BEFORE DELETE ON paper_publications
FOR EACH ROW EXECUTE FUNCTION paper_publications_retained_guard();
CREATE TABLE paper_commands(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
CREATE OR REPLACE FUNCTION paper_commands_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper receipts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER paper_commands_immutable BEFORE UPDATE ON paper_commands
FOR EACH ROW EXECUTE FUNCTION paper_commands_immutable_guard();
CREATE OR REPLACE FUNCTION paper_commands_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper receipts are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER paper_commands_retained BEFORE DELETE ON paper_commands
FOR EACH ROW EXECUTE FUNCTION paper_commands_retained_guard();
CREATE TABLE paper_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,update_id TEXT NOT NULL,actor_id TEXT NOT NULL,revision BIGINT NOT NULL,receipt TEXT NOT NULL,released_at TEXT);
CREATE UNIQUE INDEX paper_live_lease ON paper_leases(project_id,update_id) WHERE released_at IS NULL;
CREATE OR REPLACE FUNCTION paper_leases_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper lease provenance is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER paper_leases_immutable BEFORE UPDATE OF id,project_id,update_id,actor_id,revision,receipt ON paper_leases
FOR EACH ROW EXECUTE FUNCTION paper_leases_immutable_guard();
CREATE OR REPLACE FUNCTION paper_leases_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper leases are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER paper_leases_retained BEFORE DELETE ON paper_leases
FOR EACH ROW EXECUTE FUNCTION paper_leases_retained_guard();
`,
  2: `
CREATE TABLE paper_proposals(
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,project_id TEXT NOT NULL,record TEXT NOT NULL,acceptance TEXT);
CREATE OR REPLACE FUNCTION paper_proposal_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper proposals are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER paper_proposal_immutable BEFORE UPDATE OF id,project_id,record ON paper_proposals
FOR EACH ROW EXECUTE FUNCTION paper_proposal_immutable_guard();
CREATE OR REPLACE FUNCTION paper_acceptance_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.acceptance IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Accepted paper proposals are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER paper_acceptance_immutable BEFORE UPDATE ON paper_proposals
FOR EACH ROW EXECUTE FUNCTION paper_acceptance_immutable_guard();
CREATE OR REPLACE FUNCTION paper_proposal_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Paper proposals are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER paper_proposal_retained BEFORE DELETE ON paper_proposals
FOR EACH ROW EXECUTE FUNCTION paper_proposal_retained_guard();
`,
};
