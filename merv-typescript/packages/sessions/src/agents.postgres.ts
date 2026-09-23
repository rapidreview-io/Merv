/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE agents(
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id), owner_hash TEXT NOT NULL,
        runner_id TEXT NOT NULL, request_id TEXT NOT NULL, token_hash TEXT UNIQUE,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','retired')), agent_json TEXT NOT NULL,
        UNIQUE(owner_hash,runner_id,request_id));
      CREATE OR REPLACE FUNCTION agents_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Agent history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER agents_no_delete BEFORE DELETE ON agents
FOR EACH ROW EXECUTE FUNCTION agents_no_delete_guard();
      CREATE OR REPLACE FUNCTION agents_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
          NEW.owner_hash IS DISTINCT FROM OLD.owner_hash OR NEW.runner_id IS DISTINCT FROM OLD.runner_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
          NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR OLD.status='retired' OR
          NULLIF((NEW.agent_json::jsonb #> '{source}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.agent_json::jsonb #> '{source}'), 'null'::jsonb) OR
          NULLIF((NEW.agent_json::jsonb #> '{sessionId}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.agent_json::jsonb #> '{sessionId}'), 'null'::jsonb) OR
          NULLIF((NEW.agent_json::jsonb #> '{persistent}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.agent_json::jsonb #> '{persistent}'), 'null'::jsonb) OR
          NULLIF((NEW.agent_json::jsonb #> '{contextEpoch}'), 'null'::jsonb) < NULLIF((OLD.agent_json::jsonb #> '{contextEpoch}'), 'null'::jsonb) THEN
    RAISE EXCEPTION USING MESSAGE = 'Agent identity and source are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER agents_immutable BEFORE UPDATE ON agents
FOR EACH ROW EXECUTE FUNCTION agents_immutable_guard();
`,
};
