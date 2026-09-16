/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE reflections(
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,attempt BIGINT NOT NULL,corpus TEXT NOT NULL,paper TEXT NOT NULL,review_id TEXT,submission TEXT,approved TEXT,feedback TEXT NOT NULL);
      CREATE UNIQUE INDEX reflection_open_project ON reflections(project_id) WHERE approved IS NULL;
      CREATE OR REPLACE FUNCTION reflection_identity_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Reflection corpus and identity are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reflection_identity_immutable BEFORE UPDATE OF id,project_id,title,owner_id,created_at,corpus,paper ON reflections
FOR EACH ROW EXECUTE FUNCTION reflection_identity_immutable_guard();
      CREATE OR REPLACE FUNCTION reflection_approved_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.approved IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Approved reflections are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reflection_approved_immutable BEFORE UPDATE ON reflections
FOR EACH ROW EXECUTE FUNCTION reflection_approved_immutable_guard();
      CREATE OR REPLACE FUNCTION reflection_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Reflection history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER reflection_no_delete BEFORE DELETE ON reflections
FOR EACH ROW EXECUTE FUNCTION reflection_no_delete_guard();
      CREATE TABLE reflection_lenses(
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,project_id TEXT NOT NULL,reflection_id TEXT NOT NULL REFERENCES reflections(id),attempt BIGINT NOT NULL,perspective TEXT NOT NULL,instructions TEXT NOT NULL,producer_id TEXT,artifact TEXT,UNIQUE(reflection_id,attempt,perspective));
      CREATE UNIQUE INDEX reflection_independent_lenses ON reflection_lenses(reflection_id,attempt,producer_id) WHERE producer_id IS NOT NULL;
      CREATE OR REPLACE FUNCTION reflection_lens_identity_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Lens identity is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reflection_lens_identity_immutable BEFORE UPDATE OF id,project_id,reflection_id,attempt,perspective,instructions ON reflection_lenses
FOR EACH ROW EXECUTE FUNCTION reflection_lens_identity_immutable_guard();
      CREATE OR REPLACE FUNCTION reflection_lens_output_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.artifact IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Submitted lenses are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reflection_lens_output_immutable BEFORE UPDATE ON reflection_lenses
FOR EACH ROW EXECUTE FUNCTION reflection_lens_output_immutable_guard();
      CREATE OR REPLACE FUNCTION reflection_lens_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Lens history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER reflection_lens_no_delete BEFORE DELETE ON reflection_lenses
FOR EACH ROW EXECUTE FUNCTION reflection_lens_no_delete_guard();
      CREATE TABLE reflection_commands(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
      CREATE TABLE reflection_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,instance_id TEXT NOT NULL,revision BIGINT NOT NULL,actor_id TEXT NOT NULL,receipt TEXT NOT NULL,inputs TEXT NOT NULL,artifacts TEXT NOT NULL,review_id TEXT,claim_id TEXT,released_at TEXT);
      CREATE UNIQUE INDEX reflection_active_lease ON reflection_leases(project_id,instance_id,revision) WHERE released_at IS NULL;
      CREATE OR REPLACE FUNCTION reflection_lease_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Reflection lease provenance is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reflection_lease_immutable BEFORE UPDATE OF id,project_id,instance_id,revision,actor_id,receipt,inputs,artifacts,review_id,claim_id ON reflection_leases
FOR EACH ROW EXECUTE FUNCTION reflection_lease_immutable_guard();
      CREATE OR REPLACE FUNCTION reflection_lease_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Reflection leases are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER reflection_lease_no_delete BEFORE DELETE ON reflection_leases
FOR EACH ROW EXECUTE FUNCTION reflection_lease_no_delete_guard();
`,
};
