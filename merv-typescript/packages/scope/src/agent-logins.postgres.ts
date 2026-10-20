/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  13: `CREATE TABLE agent_logins (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  ip_hash TEXT,
  install_id TEXT NOT NULL,
  client TEXT NOT NULL,
  host TEXT NOT NULL,
  phrase TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  issuer TEXT,
  subject TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','locked')),
  key_id TEXT UNIQUE REFERENCES user_keys(id),
  FOREIGN KEY (issuer, subject) REFERENCES shared_users(issuer, subject)
);
CREATE INDEX agent_logins_email ON agent_logins(email_hash, created_at);
CREATE INDEX agent_logins_ip ON agent_logins(ip_hash, created_at);
CREATE INDEX agent_logins_created ON agent_logins(created_at);
CREATE INDEX agent_logins_install ON agent_logins(issuer, subject, install_id) WHERE key_id IS NOT NULL;
CREATE OR REPLACE FUNCTION agent_logins_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.key_id IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Agent sign-in evidence is retained', ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER agent_logins_no_delete BEFORE DELETE ON agent_logins
FOR EACH ROW EXECUTE FUNCTION agent_logins_no_delete_guard();
`,
};
