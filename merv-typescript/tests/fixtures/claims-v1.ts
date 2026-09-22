import type { Migration } from '@merv/contracts';

/**
 * The published claims v1 migration, copied verbatim from the retired Claims plugin
 * (packages/claims/src/index.ts and index.postgres.ts before its removal), so a test can build
 * the tables a deployed database still holds. Production applied the PostgreSQL text under
 * hash da705fe4… (tests/fixtures/published-migrations.json).
 */
export const claimsV1: Migration = {
  version: 1,
  postgres: `
CREATE TABLE claims (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, statement TEXT NOT NULL, scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','active','supported','weakened','contradicted','abandoned')),
  confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
  revision BIGINT NOT NULL CHECK(revision>=0), created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX claims_project ON claims(project_id,created_at,id);
CREATE OR REPLACE FUNCTION claims_identity_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Claim identity is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER claims_identity_immutable BEFORE UPDATE OF id,project_id,created_by,created_at ON claims
FOR EACH ROW EXECUTE FUNCTION claims_identity_immutable_guard();
CREATE OR REPLACE FUNCTION claims_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Claims are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER claims_no_delete BEFORE DELETE ON claims
FOR EACH ROW EXECUTE FUNCTION claims_no_delete_guard();
CREATE TABLE claim_commands (
  project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY(project_id,actor_id,request_id)
);
CREATE OR REPLACE FUNCTION claim_commands_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Claim command receipts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER claim_commands_no_update BEFORE UPDATE ON claim_commands
FOR EACH ROW EXECUTE FUNCTION claim_commands_no_update_guard();
CREATE OR REPLACE FUNCTION claim_commands_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Claim command receipts are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER claim_commands_no_delete BEFORE DELETE ON claim_commands
FOR EACH ROW EXECUTE FUNCTION claim_commands_no_delete_guard();
`,
  sql: `
CREATE TABLE claims (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, statement TEXT NOT NULL, scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','active','supported','weakened','contradicted','abandoned')),
  confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
  revision INTEGER NOT NULL CHECK(revision>=0), created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX claims_project ON claims(project_id,created_at,id);
CREATE TRIGGER claims_identity_immutable BEFORE UPDATE OF id,project_id,created_by,created_at ON claims
BEGIN SELECT RAISE(ABORT,'Claim identity is immutable'); END;
CREATE TRIGGER claims_no_delete BEFORE DELETE ON claims
BEGIN SELECT RAISE(ABORT,'Claims are retained'); END;
CREATE TABLE claim_commands (
  project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY(project_id,actor_id,request_id)
);
CREATE TRIGGER claim_commands_no_update BEFORE UPDATE ON claim_commands
BEGIN SELECT RAISE(ABORT,'Claim command receipts are immutable'); END;
CREATE TRIGGER claim_commands_no_delete BEFORE DELETE ON claim_commands
BEGIN SELECT RAISE(ABORT,'Claim command receipts are retained'); END;
`,
};
