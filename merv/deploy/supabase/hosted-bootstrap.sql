-- Run once in the SQL editor of a DEDICATED hosted Supabase project, replacing
-- the password first. Merv must not share the production authentication
-- project's database. Use a URL-safe generated password (openssl rand -hex 32).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merv_app') THEN
    CREATE ROLE merv_app LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE merv_app PASSWORD 'CHANGE_ME_URL_SAFE_APP_PASSWORD';
GRANT CONNECT ON DATABASE postgres TO merv_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO merv_app;

-- Supabase's postgres operator role cannot change merv_app's default
-- privileges. After this succeeds, connect once as merv_app and run
-- app-default-privileges.sql before starting Merv.
