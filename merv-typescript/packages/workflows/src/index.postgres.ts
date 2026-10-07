import {
  retiredInstancesSql,
  retiredPlanTaskIds,
  retiredPlanTasksSql,
} from './retired-instances.js';
import { withoutTriggers } from '@merv/contracts';

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE wf_definitions (
    name TEXT NOT NULL, version BIGINT NOT NULL CHECK (version > 0),
    fingerprint TEXT NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (name, version)
  );
  CREATE TABLE wf_instances (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow TEXT NOT NULL,
    version BIGINT NOT NULL, state TEXT NOT NULL, revision BIGINT NOT NULL CHECK (revision >= 0),
    data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY (workflow, version) REFERENCES wf_definitions(name, version)
  );
  CREATE INDEX wf_instances_project ON wf_instances(project_id, created_at, id);
  CREATE TABLE wf_requests (
    project_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL, PRIMARY KEY (project_id, request_id)
  );
  CREATE TABLE wf_history (
    instance_id TEXT NOT NULL REFERENCES wf_instances(id), project_id TEXT NOT NULL,
    revision BIGINT NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
    data_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (instance_id, revision)
  );
`,
  2: `
CREATE TABLE wf_success_states (
    workflow TEXT NOT NULL, version BIGINT NOT NULL, success_json TEXT NOT NULL,
    PRIMARY KEY (workflow,version),
    FOREIGN KEY (workflow,version) REFERENCES wf_definitions(name,version)
  );
  CREATE TABLE wf_dependencies (
    project_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
    target_workflow TEXT NOT NULL, target_version BIGINT NOT NULL,
    target_success_json TEXT NOT NULL, target_terminal_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_id,target_id), CHECK (source_id <> target_id)
  );
  CREATE INDEX wf_dependencies_source ON wf_dependencies(project_id,source_id);
  CREATE INDEX wf_dependencies_target ON wf_dependencies(project_id,target_id);
`,
  3: `
CREATE TABLE wf_work_starts (
    instance_id TEXT NOT NULL REFERENCES wf_instances(id), project_id TEXT NOT NULL,
    workflow TEXT NOT NULL, version BIGINT NOT NULL, state TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 0), actor_id TEXT NOT NULL,
    started_at TEXT NOT NULL, event_id BIGINT NOT NULL UNIQUE REFERENCES events(id),
    PRIMARY KEY (instance_id,revision)
  );
  CREATE INDEX wf_work_starts_project ON wf_work_starts(project_id,instance_id,revision);
  CREATE OR REPLACE FUNCTION wf_work_starts_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Workflow work starts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER wf_work_starts_no_update BEFORE UPDATE ON wf_work_starts
FOR EACH ROW EXECUTE FUNCTION wf_work_starts_no_update_guard();
  CREATE OR REPLACE FUNCTION wf_work_starts_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Workflow work starts are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER wf_work_starts_no_delete BEFORE DELETE ON wf_work_starts
FOR EACH ROW EXECUTE FUNCTION wf_work_starts_no_delete_guard();
`,
  4: `
CREATE TABLE wf_execution_policies (
    workflow TEXT NOT NULL, version BIGINT NOT NULL, state TEXT NOT NULL,
    fingerprint TEXT NOT NULL, manifest_json TEXT NOT NULL,
    PRIMARY KEY(workflow,version,state),
    FOREIGN KEY(workflow,version) REFERENCES wf_definitions(name,version)
  );
  CREATE OR REPLACE FUNCTION wf_execution_policies_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Workflow execution declarations are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER wf_execution_policies_no_update BEFORE UPDATE ON wf_execution_policies
FOR EACH ROW EXECUTE FUNCTION wf_execution_policies_no_update_guard();
  CREATE OR REPLACE FUNCTION wf_execution_policies_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Workflow execution declarations are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER wf_execution_policies_no_delete BEFORE DELETE ON wf_execution_policies
FOR EACH ROW EXECUTE FUNCTION wf_execution_policies_no_delete_guard();
`,
  5: `
CREATE TABLE wf_limit_grants (
    project_id TEXT NOT NULL, request_id TEXT NOT NULL,
    instance_id TEXT NOT NULL REFERENCES wf_instances(id), limit_name TEXT NOT NULL,
    additional BIGINT NOT NULL CHECK (additional > 0), reason TEXT NOT NULL,
    actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, request_id)
  );
  CREATE INDEX wf_limit_grants_instance ON wf_limit_grants(instance_id, limit_name);
  CREATE OR REPLACE FUNCTION wf_limit_grants_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Workflow limit grants are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER wf_limit_grants_no_update BEFORE UPDATE ON wf_limit_grants
FOR EACH ROW EXECUTE FUNCTION wf_limit_grants_no_update_guard();
  CREATE OR REPLACE FUNCTION wf_limit_grants_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Workflow limit grants are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER wf_limit_grants_no_delete BEFORE DELETE ON wf_limit_grants
FOR EACH ROW EXECUTE FUNCTION wf_limit_grants_no_delete_guard();
`,
  // The one workflow table that is rewritten and cleared: it mirrors what another plugin
  // thinks now, and must stay readable and clearable while that plugin is unloaded.
  6: `
CREATE TABLE wf_blockers (
    project_id TEXT NOT NULL, instance_id TEXT NOT NULL, provider TEXT NOT NULL,
    blocker_key TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
    status BIGINT NOT NULL CHECK (status BETWEEN 400 AND 599), next TEXT NOT NULL,
    related_json TEXT NOT NULL, since TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (instance_id,provider,blocker_key)
  );
  CREATE INDEX wf_blockers_project ON wf_blockers(project_id,provider);
  CREATE OR REPLACE FUNCTION wf_blockers_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.instance_id IS DISTINCT FROM OLD.instance_id OR
  NEW.provider IS DISTINCT FROM OLD.provider OR NEW.blocker_key IS DISTINCT FROM OLD.blocker_key THEN
    RAISE EXCEPTION USING MESSAGE = 'Workflow blocker identity is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER wf_blockers_identity BEFORE UPDATE ON wf_blockers
FOR EACH ROW EXECUTE FUNCTION wf_blockers_identity_guard();

ALTER TABLE wf_dependencies ADD COLUMN kind TEXT NOT NULL DEFAULT 'declared' CHECK(kind IN ('declared','system'));
ALTER TABLE wf_dependencies ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE wf_dependencies DROP CONSTRAINT wf_dependencies_pkey;
ALTER TABLE wf_dependencies ADD PRIMARY KEY(source_id,target_id,kind,owner);
ALTER TABLE wf_dependencies ADD CHECK((kind='declared' AND owner='') OR (kind='system' AND owner<>''));
CREATE FUNCTION wf_dependencies_identity_guard() RETURNS trigger AS $$ BEGIN IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.owner IS DISTINCT FROM OLD.owner THEN RAISE EXCEPTION 'Dependency contracts are immutable'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER wf_dependencies_identity BEFORE UPDATE ON wf_dependencies FOR EACH ROW EXECUTE FUNCTION wf_dependencies_identity_guard();
CREATE TABLE wf_system_requests(project_id TEXT NOT NULL,provider TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(project_id,provider,request_id));
CREATE FUNCTION wf_system_requests_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'System requests are immutable and retained'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER wf_system_requests_guard BEFORE UPDATE OR DELETE ON wf_system_requests FOR EACH ROW EXECUTE FUNCTION wf_system_requests_guard();`,
  // Retires the workflow versions no current flow can start: the ledger names their instances,
  // and every workflow row keyed by one is deleted. Definitions and policies stay as history.
  7: `${retiredInstancesSql}
DELETE FROM wf_dependencies WHERE source_id IN (SELECT id FROM wf_retired_instances)
  OR target_id IN (SELECT id FROM wf_retired_instances);
DELETE FROM wf_blockers WHERE instance_id IN (SELECT id FROM wf_retired_instances);
DELETE FROM wf_requests WHERE response_json::jsonb->>'id' IN (SELECT id FROM wf_retired_instances);
${withoutTriggers(
  'wf_system_requests',
  ['wf_system_requests_guard'],
  `DELETE FROM wf_system_requests WHERE fingerprint::jsonb->>'instanceId' IN (SELECT id FROM wf_retired_instances);`,
)}
${withoutTriggers(
  'wf_work_starts',
  ['wf_work_starts_no_delete'],
  `DELETE FROM wf_work_starts WHERE instance_id IN (SELECT id FROM wf_retired_instances);`,
)}
${withoutTriggers(
  'wf_limit_grants',
  ['wf_limit_grants_no_delete'],
  `DELETE FROM wf_limit_grants WHERE instance_id IN (SELECT id FROM wf_retired_instances);`,
)}
DELETE FROM wf_history WHERE instance_id IN (SELECT id FROM wf_retired_instances);
DELETE FROM wf_instances WHERE id IN (SELECT id FROM wf_retired_instances);
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM wf_instances
    WHERE (workflow='task' AND version=1) OR (workflow='experiment' AND version BETWEEN 1 AND 4)
       OR (workflow='reflection' AND version IN (1,2)) OR (workflow='reflection.lens' AND version=1)
       OR (workflow='research' AND version BETWEEN 2 AND 5) OR workflow='consolidation')
    OR EXISTS (SELECT 1 FROM wf_history WHERE action='upgrade') THEN
    RAISE EXCEPTION USING MESSAGE = 'Retired workflow instances remain', ERRCODE = '23514';
  END IF;
END $check$;`,
  // Deletes the instances of retired experiment.plan tasks; Tasks checks that none remain.
  8: `${retiredPlanTasksSql}
DELETE FROM wf_dependencies WHERE source_id IN (${retiredPlanTaskIds})
  OR target_id IN (${retiredPlanTaskIds});
DELETE FROM wf_blockers WHERE instance_id IN (${retiredPlanTaskIds});
DELETE FROM wf_requests WHERE response_json::jsonb->>'id' IN (${retiredPlanTaskIds});
${withoutTriggers(
  'wf_system_requests',
  ['wf_system_requests_guard'],
  `DELETE FROM wf_system_requests WHERE fingerprint::jsonb->>'instanceId' IN (${retiredPlanTaskIds});`,
)}
${withoutTriggers(
  'wf_work_starts',
  ['wf_work_starts_no_delete'],
  `DELETE FROM wf_work_starts WHERE instance_id IN (${retiredPlanTaskIds});`,
)}
${withoutTriggers(
  'wf_limit_grants',
  ['wf_limit_grants_no_delete'],
  `DELETE FROM wf_limit_grants WHERE instance_id IN (${retiredPlanTaskIds});`,
)}
DELETE FROM wf_history WHERE instance_id IN (${retiredPlanTaskIds});
DELETE FROM wf_instances WHERE id IN (${retiredPlanTaskIds});`,
  // Pinned contracts become immutable, as execution policies already are, so a service may keep
  // them in memory; and one version's instances in given states are found by index.
  9: `
CREATE INDEX wf_instances_kind ON wf_instances(project_id, workflow, version, state);
CREATE FUNCTION wf_pinned_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION USING MESSAGE='Pinned workflow contracts are immutable', ERRCODE='23514'; END; $merv$;
CREATE TRIGGER wf_definitions_pinned BEFORE UPDATE OR DELETE ON wf_definitions FOR EACH ROW EXECUTE FUNCTION wf_pinned_guard();
CREATE TRIGGER wf_success_states_pinned BEFORE UPDATE OR DELETE ON wf_success_states FOR EACH ROW EXECUTE FUNCTION wf_pinned_guard();
`,
  // Drops the system-request table no code writes any more; production held no row of it.
  10: `
DROP TABLE wf_system_requests;
DROP FUNCTION wf_system_requests_guard();
`,
  // A blocker may say which kind of its code it is, so readers never parse its message.
  11: `ALTER TABLE wf_blockers ADD COLUMN cause TEXT;`,
  // One table holds every leased step's lease. The owning programs move their own lease rows
  // here in their next migrations. Provenance is immutable; only the release is written.
  12: `
CREATE TABLE wf_leases (
    _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
    revision BIGINT NOT NULL, workflow TEXT NOT NULL, state TEXT NOT NULL,
    actor_id TEXT NOT NULL, source_actor_id TEXT, review_id TEXT, claim_id TEXT,
    receipt TEXT NOT NULL, details TEXT NOT NULL, released_at TEXT
  );
  CREATE UNIQUE INDEX wf_leases_active ON wf_leases(project_id,instance_id,revision) WHERE released_at IS NULL;
  CREATE INDEX wf_leases_instance ON wf_leases(project_id,instance_id,revision);
  CREATE FUNCTION wf_leases_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION USING MESSAGE='Lease provenance is immutable', ERRCODE='23514'; END; $merv$;
  CREATE TRIGGER wf_leases_immutable BEFORE UPDATE OF id,project_id,instance_id,revision,workflow,state,actor_id,source_actor_id,review_id,claim_id,receipt,details ON wf_leases FOR EACH ROW EXECUTE FUNCTION wf_leases_immutable_guard();
  CREATE TRIGGER wf_leases_retained BEFORE DELETE ON wf_leases FOR EACH ROW EXECUTE FUNCTION wf_leases_immutable_guard();
`,
  // Every lease check compares receipts, and a receipt can carry a frozen paper context, so each
  // lease keeps its receipt's digest() and checks compare that. The backfill rebuilds digest()'s
  // canonical JSON from the stored text: keys sorted, every scalar token kept as written, which is
  // JSON.stringify's own spelling (every writer of a receipt used it). A receipt PostgreSQL cannot
  // read (one escaping NUL or a lone surrogate) keeps no digest, and its read digests it instead.
  // Read-only prod counts: SELECT count(*), count(*) FILTER (WHERE released_at IS NULL) FROM wf_leases;
  13: String.raw`
ALTER TABLE wf_leases ADD COLUMN receipt_digest TEXT;
CREATE FUNCTION wf_receipt_canonical(v json) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $merv$
BEGIN
  RETURN CASE json_typeof(v)
    WHEN 'object' THEN '{' || COALESCE((SELECT string_agg(to_json(e.key)::text || ':' || wf_receipt_canonical(e.value), ',' ORDER BY e.key COLLATE "C") FROM pg_catalog.json_each(v) e), '') || '}'
    WHEN 'array' THEN '[' || COALESCE((SELECT string_agg(wf_receipt_canonical(a.value), ',' ORDER BY a.n) FROM json_array_elements(v) WITH ORDINALITY a(value, n)), '') || ']'
    ELSE v::text END;
END $merv$;
CREATE FUNCTION wf_receipt_digest(receipt text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $merv$
BEGIN
  IF receipt ~ '\\u(0000|[dD][89a-fA-F])' THEN RETURN NULL; END IF;
  RETURN encode(sha256(convert_to(wf_receipt_canonical(receipt::json), 'UTF8')), 'hex');
EXCEPTION WHEN others THEN RETURN NULL;
END $merv$;
UPDATE wf_leases SET receipt_digest=wf_receipt_digest(receipt);
DROP FUNCTION wf_receipt_digest(text);
DROP FUNCTION wf_receipt_canonical(json);
DROP TRIGGER wf_leases_immutable ON wf_leases;
CREATE TRIGGER wf_leases_immutable BEFORE UPDATE OF id,project_id,instance_id,revision,workflow,state,actor_id,source_actor_id,review_id,claim_id,receipt,receipt_digest,details ON wf_leases FOR EACH ROW EXECUTE FUNCTION wf_leases_immutable_guard();
`,
  // A blocker may say whose move ending it is, and the one revision it is about. Existing rows
  // keep neither, as before. Read-only prod check (rows that keep reading as they do):
  // SELECT provider, COUNT(*) FROM wf_blockers GROUP BY provider;
  14: `ALTER TABLE wf_blockers ADD COLUMN whose TEXT CHECK (whose IN ('owner','admin')), ADD COLUMN revision BIGINT;`,
  // (unpublished) A blocker's move may also be an operator's (an admin signed in as a person) or
  // nobody's (a wait on the server). Only the constraint widens; read-only prod check first:
  // SELECT whose, COUNT(*) FROM wf_blockers GROUP BY whose;
  15: `ALTER TABLE wf_blockers DROP CONSTRAINT wf_blockers_whose_check, ADD CONSTRAINT wf_blockers_whose_check CHECK (whose IN ('owner','admin','operator','nobody'));`,
  // (unpublished) A blocker's move may be one actor's alone (`actor:<id>`), as a person's own
  // model limit is. Only the constraint widens; read-only prod check first:
  // SELECT whose, COUNT(*) FROM wf_blockers GROUP BY whose;
  16: `ALTER TABLE wf_blockers DROP CONSTRAINT wf_blockers_whose_check, ADD CONSTRAINT wf_blockers_whose_check CHECK (whose IN ('owner','admin','operator','nobody') OR whose ~ '^actor:[^[:space:]]{1,200}$');`,
};
