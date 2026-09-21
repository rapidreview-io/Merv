/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE actors(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('operator','producer','reviewer','reader')),token_hash TEXT NOT NULL UNIQUE,active BIGINT NOT NULL DEFAULT 1);
      CREATE INDEX actors_project ON actors(project_id);
`,
  2: `
ALTER TABLE actors ADD CONSTRAINT actors_project_identity UNIQUE(id,project_id);
ALTER TABLE actors ADD CONSTRAINT actors_active_check CHECK(active IN (0,1));
      CREATE TABLE actor_credentials (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind='actor'), token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
        previous_id TEXT UNIQUE REFERENCES actor_credentials(id),
        FOREIGN KEY(actor_id,project_id) REFERENCES actors(id,project_id)
      );
      INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at)
        SELECT 'credential_' || md5(random()::text || clock_timestamp()::text), a.id, a.project_id, 'actor', a.token_hash,
          COALESCE((SELECT e.created_at FROM events e WHERE e.project_id=a.project_id AND
            ((e.type='actor.created' AND e.subject_id=a.id) OR
             (e.type='project.created' AND e.actor_id=a.id)) ORDER BY e.id LIMIT 1),
            to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        FROM actors a;
      ALTER TABLE actors DROP COLUMN token_hash;
      CREATE INDEX actor_credentials_actor ON actor_credentials(project_id,actor_id,created_at,id);
      CREATE OR REPLACE FUNCTION actor_credentials_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Actor credential history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER actor_credentials_no_delete BEFORE DELETE ON actor_credentials
FOR EACH ROW EXECUTE FUNCTION actor_credentials_no_delete_guard();
      CREATE OR REPLACE FUNCTION actor_credentials_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
          NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind OR
          NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
          NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.previous_id IS DISTINCT FROM OLD.previous_id OR
          OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Actor credentials only allow first revocation', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER actor_credentials_immutable BEFORE UPDATE ON actor_credentials
FOR EACH ROW EXECUTE FUNCTION actor_credentials_immutable_guard();
`,
  5: `
ALTER TABLE actors ADD COLUMN session_id TEXT;
          CREATE UNIQUE INDEX actors_session ON actors(session_id) WHERE session_id IS NOT NULL;
          CREATE OR REPLACE FUNCTION actors_session_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR
              (OLD.session_id IS NOT NULL AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.id IS DISTINCT FROM OLD.id)) THEN
    RAISE EXCEPTION USING MESSAGE = 'Session actor identity and role are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER actors_session_immutable BEFORE UPDATE ON actors
FOR EACH ROW EXECUTE FUNCTION actors_session_immutable_guard();
          CREATE OR REPLACE FUNCTION actors_session_role_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.session_id IS NOT NULL AND NEW.role='operator' THEN
    RAISE EXCEPTION USING MESSAGE = 'Session actors cannot be operators', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER actors_session_role BEFORE INSERT ON actors
FOR EACH ROW EXECUTE FUNCTION actors_session_role_guard();
          CREATE OR REPLACE FUNCTION actor_credentials_no_session_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF EXISTS(SELECT 1 FROM actors WHERE id=NEW.actor_id AND session_id IS NOT NULL) THEN
    RAISE EXCEPTION USING MESSAGE = 'Session actors cannot receive independent credentials', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER actor_credentials_no_session BEFORE INSERT ON actor_credentials
FOR EACH ROW EXECUTE FUNCTION actor_credentials_no_session_guard();
`,
  7: `
ALTER TABLE actors ADD COLUMN agent_id TEXT;
        CREATE UNIQUE INDEX actors_agent ON actors(agent_id) WHERE agent_id IS NOT NULL;
        DROP TRIGGER actors_session_immutable ON actors;
        CREATE OR REPLACE FUNCTION actors_session_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR
            (OLD.session_id IS NOT NULL AND (NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.role='operator' OR
              (OLD.agent_id IS NULL AND NEW.role IS DISTINCT FROM OLD.role))) THEN
    RAISE EXCEPTION USING MESSAGE = 'Managed actor identity is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER actors_session_immutable BEFORE UPDATE ON actors
FOR EACH ROW EXECUTE FUNCTION actors_session_immutable_guard();
`,
  8: `ALTER TABLE actors ADD COLUMN service_owner TEXT;
CREATE UNIQUE INDEX actors_service ON actors(project_id,service_owner) WHERE service_owner IS NOT NULL;
CREATE FUNCTION actors_service_guard() RETURNS trigger AS $$ BEGIN
IF TG_OP='DELETE' THEN IF OLD.service_owner IS NOT NULL THEN RAISE EXCEPTION 'Service actors are retained'; END IF; RETURN OLD; END IF;
IF TG_OP='UPDATE' THEN
 IF NEW.service_owner IS DISTINCT FROM OLD.service_owner OR (OLD.service_owner IS NOT NULL AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.role IS DISTINCT FROM OLD.role)) THEN RAISE EXCEPTION 'Service actor identity is immutable'; END IF;
END IF;
IF NEW.service_owner IS NOT NULL AND (NEW.role <> 'producer' OR NEW.session_id IS NOT NULL OR NEW.agent_id IS NOT NULL) THEN RAISE EXCEPTION 'Service actors are credential-free producers'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER actors_service_guard BEFORE INSERT OR UPDATE OR DELETE ON actors FOR EACH ROW EXECUTE FUNCTION actors_service_guard();
CREATE FUNCTION actor_credentials_service_guard() RETURNS trigger AS $$ BEGIN
IF EXISTS(SELECT 1 FROM actors WHERE id=NEW.actor_id AND service_owner IS NOT NULL) THEN RAISE EXCEPTION 'Service actors cannot receive credentials'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER actor_credentials_no_service BEFORE INSERT ON actor_credentials FOR EACH ROW EXECUTE FUNCTION actor_credentials_service_guard();
CREATE FUNCTION actors_service_update_guard() RETURNS trigger AS $$ BEGIN
IF NEW.service_owner IS NOT NULL AND (NEW.role <> 'producer' OR NEW.session_id IS NOT NULL OR NEW.agent_id IS NOT NULL) THEN RAISE EXCEPTION 'Service actors are credential-free producers'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER actors_service_update BEFORE UPDATE ON actors FOR EACH ROW EXECUTE FUNCTION actors_service_update_guard();`,
};
