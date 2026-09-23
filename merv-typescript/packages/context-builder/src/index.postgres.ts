/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE context_recipes(type TEXT NOT NULL,version BIGINT NOT NULL,hash TEXT NOT NULL,definition TEXT NOT NULL,PRIMARY KEY(type,version));
      CREATE TABLE context_packages(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,package TEXT NOT NULL,UNIQUE(project_id,actor_id,request_id));
      CREATE OR REPLACE FUNCTION context_recipes_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Context recipe versions are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER context_recipes_immutable BEFORE UPDATE ON context_recipes
FOR EACH ROW EXECUTE FUNCTION context_recipes_immutable_guard();
      CREATE OR REPLACE FUNCTION context_recipes_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Context recipe versions are durable', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER context_recipes_no_delete BEFORE DELETE ON context_recipes
FOR EACH ROW EXECUTE FUNCTION context_recipes_no_delete_guard();
      CREATE OR REPLACE FUNCTION context_packages_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Context packages are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER context_packages_immutable BEFORE UPDATE ON context_packages
FOR EACH ROW EXECUTE FUNCTION context_packages_immutable_guard();
      CREATE OR REPLACE FUNCTION context_packages_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Context packages are durable', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER context_packages_no_delete BEFORE DELETE ON context_packages
FOR EACH ROW EXECUTE FUNCTION context_packages_no_delete_guard();
`,
};
