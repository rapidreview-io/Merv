\set ON_ERROR_STOP on

-- Merv applies its own schema migrations at process startup, so this role must
-- own the application tables and retain DDL rights. It intentionally has none
-- of Supabase's API/auth roles and no elevated cluster privileges.
SELECT format(
  'CREATE ROLE merv_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'merv_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merv_app')
\gexec

SELECT format('ALTER ROLE merv_app PASSWORD %L', :'merv_password')
\gexec

GRANT CONNECT ON DATABASE postgres TO merv_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO merv_app;
