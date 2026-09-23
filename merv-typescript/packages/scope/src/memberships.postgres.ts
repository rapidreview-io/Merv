/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  3: `
CREATE TABLE shared_users (
      issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(issuer,subject)
    );
    CREATE TABLE member_actors (
      project_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      actor_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(project_id,issuer,subject),
      FOREIGN KEY(actor_id,project_id) REFERENCES actors(id,project_id)
    );
    CREATE TABLE project_memberships (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      actor_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('operator','producer','reviewer','reader')),
      active BIGINT NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, revoked_at TEXT,
      FOREIGN KEY(project_id,issuer,subject) REFERENCES member_actors(project_id,issuer,subject),
      FOREIGN KEY(actor_id,project_id) REFERENCES actors(id,project_id),
      CHECK((active=1 AND revoked_at IS NULL) OR (active=0 AND revoked_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX project_membership_active ON project_memberships(project_id,issuer,subject) WHERE active=1;
    CREATE UNIQUE INDEX project_membership_actor_active ON project_memberships(actor_id) WHERE active=1;
    CREATE INDEX project_membership_user ON project_memberships(issuer,subject,project_id);
    CREATE TABLE user_project_requests (
      issuer TEXT NOT NULL, subject TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
      PRIMARY KEY(issuer,subject,request_id),
      FOREIGN KEY(issuer,subject) REFERENCES shared_users(issuer,subject)
    );
    CREATE OR REPLACE FUNCTION shared_users_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Verified user identity is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER shared_users_no_update BEFORE UPDATE ON shared_users
FOR EACH ROW EXECUTE FUNCTION shared_users_no_update_guard();
    CREATE OR REPLACE FUNCTION shared_users_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Verified user identity is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER shared_users_no_delete BEFORE DELETE ON shared_users
FOR EACH ROW EXECUTE FUNCTION shared_users_no_delete_guard();
    CREATE OR REPLACE FUNCTION member_actors_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Member attribution is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER member_actors_no_update BEFORE UPDATE ON member_actors
FOR EACH ROW EXECUTE FUNCTION member_actors_no_update_guard();
    CREATE OR REPLACE FUNCTION member_actors_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Member attribution is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER member_actors_no_delete BEFORE DELETE ON member_actors
FOR EACH ROW EXECUTE FUNCTION member_actors_no_delete_guard();
    CREATE OR REPLACE FUNCTION project_memberships_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Membership history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER project_memberships_no_delete BEFORE DELETE ON project_memberships
FOR EACH ROW EXECUTE FUNCTION project_memberships_no_delete_guard();
    CREATE OR REPLACE FUNCTION project_memberships_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
        NEW.issuer IS DISTINCT FROM OLD.issuer OR NEW.subject IS DISTINCT FROM OLD.subject OR
        NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.role IS DISTINCT FROM OLD.role OR
        NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.active<>1 OR NEW.active<>0 OR
        OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Membership epochs only allow removal', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER project_memberships_immutable BEFORE UPDATE ON project_memberships
FOR EACH ROW EXECUTE FUNCTION project_memberships_immutable_guard();
`,
};
