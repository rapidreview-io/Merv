/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  4: `
CREATE TABLE user_keys (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      grant_scope TEXT NOT NULL CHECK(grant_scope IN ('project','account')),
      label TEXT, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      expires_at TEXT, revoked_at TEXT, previous_id TEXT UNIQUE REFERENCES user_keys(id),
      FOREIGN KEY(issuer,subject) REFERENCES shared_users(issuer,subject)
    );
    CREATE INDEX user_keys_owner ON user_keys(issuer,subject,created_at,id);
    CREATE OR REPLACE FUNCTION user_keys_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'User key history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER user_keys_no_delete BEFORE DELETE ON user_keys
FOR EACH ROW EXECUTE FUNCTION user_keys_no_delete_guard();
    CREATE OR REPLACE FUNCTION user_keys_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.issuer IS DISTINCT FROM OLD.issuer OR
        NEW.subject IS DISTINCT FROM OLD.subject OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
        NEW.grant_scope IS DISTINCT FROM OLD.grant_scope OR NEW.label IS DISTINCT FROM OLD.label OR
        NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
        NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.previous_id IS DISTINCT FROM OLD.previous_id OR
        OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'User keys only allow first revocation', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER user_keys_immutable BEFORE UPDATE ON user_keys
FOR EACH ROW EXECUTE FUNCTION user_keys_immutable_guard();
    CREATE OR REPLACE FUNCTION user_keys_lineage_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.previous_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM user_keys p WHERE p.id=NEW.previous_id AND
          p.issuer=NEW.issuer AND p.subject=NEW.subject AND p.project_id=NEW.project_id AND
          p.grant_scope=NEW.grant_scope AND p.label IS NOT DISTINCT FROM NEW.label AND p.revoked_at IS NOT NULL
      ) THEN
    RAISE EXCEPTION USING MESSAGE = 'Rotation preserves user key ownership and grant', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER user_keys_lineage BEFORE INSERT ON user_keys
FOR EACH ROW EXECUTE FUNCTION user_keys_lineage_guard();
`,
};
