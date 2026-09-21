/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
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
};
