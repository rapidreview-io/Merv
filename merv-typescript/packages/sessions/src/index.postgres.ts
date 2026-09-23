import { retiredInstancesSql, withoutTriggers } from '@merv/contracts/retired-instances';

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE worker_sessions (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id), instance_id TEXT NOT NULL, revision BIGINT NOT NULL,
        owner_hash TEXT NOT NULL, runner_id TEXT NOT NULL, request_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('offered','active','released','expired')), session_json TEXT NOT NULL,
        UNIQUE(owner_hash,runner_id,request_id)
      );
      CREATE UNIQUE INDEX worker_sessions_live_target ON worker_sessions(project_id,instance_id,revision)
        WHERE status IN ('offered','active');
      CREATE OR REPLACE FUNCTION worker_sessions_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Session history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER worker_sessions_no_delete BEFORE DELETE ON worker_sessions
FOR EACH ROW EXECUTE FUNCTION worker_sessions_no_delete_guard();
      CREATE OR REPLACE FUNCTION worker_sessions_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
          NEW.instance_id IS DISTINCT FROM OLD.instance_id OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.owner_hash IS DISTINCT FROM OLD.owner_hash OR
          NEW.runner_id IS DISTINCT FROM OLD.runner_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR
          NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR OLD.status IN ('released','expired') OR
          (OLD.status='active' AND NEW.status='offered') OR
          NULLIF((NEW.session_json::jsonb #> '{source}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{source}'), 'null'::jsonb) OR
          NULLIF((NEW.session_json::jsonb #> '{assignment}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{assignment}'), 'null'::jsonb) OR
          NULLIF((NEW.session_json::jsonb #> '{execution}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{execution}'), 'null'::jsonb) OR
          NULLIF((NEW.session_json::jsonb #> '{lease}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{lease}'), 'null'::jsonb) OR
          NULLIF((NEW.session_json::jsonb #> '{hardDeadline}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{hardDeadline}'), 'null'::jsonb) OR
          NULLIF((NEW.session_json::jsonb #> '{createdAt}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{createdAt}'), 'null'::jsonb) OR
          NULLIF((NEW.session_json::jsonb #> '{role}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{role}'), 'null'::jsonb) THEN
    RAISE EXCEPTION USING MESSAGE = 'Session assignment and delegation are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER worker_sessions_immutable BEFORE UPDATE ON worker_sessions
FOR EACH ROW EXECUTE FUNCTION worker_sessions_immutable_guard();
`,
  2: `
CREATE TABLE session_workspaces (
        session_id TEXT PRIMARY KEY REFERENCES worker_sessions(id),
        attachment_json TEXT NOT NULL CHECK((attachment_json IS JSON)),
        result_json TEXT CHECK(result_json IS NULL OR (result_json IS JSON))
      );
      CREATE OR REPLACE FUNCTION session_workspaces_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Workspace capture history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER session_workspaces_no_delete BEFORE DELETE ON session_workspaces
FOR EACH ROW EXECUTE FUNCTION session_workspaces_no_delete_guard();
      CREATE OR REPLACE FUNCTION session_workspaces_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.attachment_json IS DISTINCT FROM OLD.attachment_json OR
          (OLD.result_json IS NOT NULL AND NEW.result_json IS DISTINCT FROM OLD.result_json) THEN
    RAISE EXCEPTION USING MESSAGE = 'Workspace attachment and final capture are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_workspaces_immutable BEFORE UPDATE ON session_workspaces
FOR EACH ROW EXECUTE FUNCTION session_workspaces_immutable_guard();
`,
  3: `
ALTER TABLE worker_sessions DROP CONSTRAINT worker_sessions_actor_id_key;

CREATE UNIQUE INDEX worker_sessions_live_actor ON worker_sessions(actor_id) WHERE status IN ('offered','active');
CREATE OR REPLACE FUNCTION worker_sessions_agent_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NULLIF((NEW.session_json::jsonb #> '{agentId}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{agentId}'), 'null'::jsonb) OR
NULLIF((NEW.session_json::jsonb #> '{agentSessionId}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{agentSessionId}'), 'null'::jsonb) OR
NULLIF((NEW.session_json::jsonb #> '{contextEpoch}'), 'null'::jsonb) IS DISTINCT FROM NULLIF((OLD.session_json::jsonb #> '{contextEpoch}'), 'null'::jsonb) THEN
    RAISE EXCEPTION USING MESSAGE = 'Agent attribution is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER worker_sessions_agent_immutable BEFORE UPDATE ON worker_sessions
FOR EACH ROW EXECUTE FUNCTION worker_sessions_agent_immutable_guard();
`,
  4: `
CREATE TABLE session_usage (
        session_id TEXT PRIMARY KEY REFERENCES worker_sessions(id), project_id TEXT NOT NULL,
        instance_id TEXT NOT NULL, revision BIGINT NOT NULL, workflow TEXT NOT NULL, state TEXT NOT NULL,
        role TEXT NOT NULL, outcome TEXT NOT NULL, started_at TEXT, closed_at TEXT NOT NULL,
        wall_ms BIGINT NOT NULL CHECK(wall_ms >= 0), harness TEXT, model TEXT,
        input_tokens BIGINT CHECK(input_tokens IS NULL OR input_tokens >= 0),
        output_tokens BIGINT CHECK(output_tokens IS NULL OR output_tokens >= 0),
        cost_micros BIGINT CHECK(cost_micros IS NULL OR cost_micros >= 0),
        reported_model TEXT, reported_at TEXT
      );
      CREATE INDEX session_usage_project ON session_usage(project_id, instance_id, revision);
      CREATE OR REPLACE FUNCTION session_usage_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Session usage is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER session_usage_no_delete BEFORE DELETE ON session_usage
FOR EACH ROW EXECUTE FUNCTION session_usage_no_delete_guard();
      CREATE OR REPLACE FUNCTION session_usage_write_once_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.reported_at IS NOT NULL OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
          NEW.instance_id IS DISTINCT FROM OLD.instance_id OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.workflow IS DISTINCT FROM OLD.workflow OR
          NEW.state IS DISTINCT FROM OLD.state OR NEW.role IS DISTINCT FROM OLD.role OR NEW.outcome IS DISTINCT FROM OLD.outcome OR
          NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.wall_ms IS DISTINCT FROM OLD.wall_ms OR
          NEW.harness IS DISTINCT FROM OLD.harness OR NEW.model IS DISTINCT FROM OLD.model THEN
    RAISE EXCEPTION USING MESSAGE = 'Session usage is recorded once', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_usage_write_once BEFORE UPDATE ON session_usage
FOR EACH ROW EXECUTE FUNCTION session_usage_write_once_guard();
`,
  5: `CREATE INDEX worker_sessions_instance ON worker_sessions(project_id,instance_id,revision);`,
  // Deletes the sessions of retired workflow instances with the rows that hang off them. The
  // dispatch and tool-call tables belong to components that migrate after this one, so they are
  // reached only once they exist.
  6: `${retiredInstancesSql}
CREATE TEMP TABLE retired_sessions ON COMMIT DROP AS
  SELECT id FROM worker_sessions WHERE instance_id IN (SELECT id FROM wf_retired_instances);
DO $retire$
BEGIN
  IF to_regclass('session_tool_calls') IS NOT NULL THEN
    EXECUTE 'DELETE FROM session_tool_calls WHERE execution_id IN (SELECT id FROM retired_sessions)';
  END IF;
  IF to_regclass('session_dispatch_receipts') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE session_dispatch_receipts DISABLE TRIGGER session_dispatch_receipts_no_delete';
    EXECUTE 'DELETE FROM session_dispatch_receipts WHERE session_id IN (SELECT id FROM retired_sessions)';
    EXECUTE 'ALTER TABLE session_dispatch_receipts ENABLE TRIGGER session_dispatch_receipts_no_delete';
  END IF;
  IF to_regclass('session_dispatch_holds') IS NOT NULL THEN
    EXECUTE 'DELETE FROM session_dispatch_holds WHERE instance_id IN (SELECT id FROM wf_retired_instances)
      OR last_session_id IN (SELECT id FROM retired_sessions)';
  END IF;
  IF to_regclass('session_hold_requests') IS NOT NULL THEN
    EXECUTE 'DELETE FROM session_hold_requests
      WHERE result::jsonb->>''instanceId'' IN (SELECT id FROM wf_retired_instances)';
  END IF;
  IF to_regclass('session_budgets') IS NOT NULL THEN
    EXECUTE 'DELETE FROM session_budgets WHERE scope_id IN (SELECT id FROM wf_retired_instances)';
  END IF;
END $retire$;
${withoutTriggers(
  'session_workspaces',
  ['session_workspaces_no_delete'],
  `DELETE FROM session_workspaces WHERE session_id IN (SELECT id FROM retired_sessions);`,
)}
${withoutTriggers(
  'session_usage',
  ['session_usage_no_delete'],
  `DELETE FROM session_usage WHERE session_id IN (SELECT id FROM retired_sessions);`,
)}
${withoutTriggers(
  'worker_sessions',
  ['worker_sessions_no_delete'],
  `DELETE FROM worker_sessions WHERE id IN (SELECT id FROM retired_sessions);`,
)}`,
  7: `
CREATE TABLE session_managed_runners (
  allocation_id TEXT PRIMARY KEY,
  epoch BIGINT NOT NULL CHECK(epoch>=0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_json TEXT NOT NULL CHECK(source_json IS JSON),
  source_hash TEXT NOT NULL,
  runtime_profile_id TEXT NOT NULL,
  platform_json TEXT NOT NULL CHECK(platform_json IS JSON),
  capabilities_json TEXT NOT NULL CHECK(capabilities_json IS JSON),
  enrollment_hash TEXT NOT NULL UNIQUE,
  enrollment_expires_at TEXT NOT NULL,
  control_hash TEXT NOT NULL UNIQUE,
  control_expires_at TEXT NOT NULL,
  runner_id TEXT,
  bound_session_id TEXT UNIQUE REFERENCES worker_sessions(id),
  runner_released_at TEXT,
  created_at TEXT NOT NULL
);
CREATE OR REPLACE FUNCTION session_managed_runners_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.allocation_id IS DISTINCT FROM OLD.allocation_id OR NEW.epoch IS DISTINCT FROM OLD.epoch OR
     NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.source_json IS DISTINCT FROM OLD.source_json OR
     NEW.source_hash IS DISTINCT FROM OLD.source_hash OR NEW.runtime_profile_id IS DISTINCT FROM OLD.runtime_profile_id OR
     NEW.platform_json IS DISTINCT FROM OLD.platform_json OR NEW.capabilities_json IS DISTINCT FROM OLD.capabilities_json OR
     NEW.enrollment_hash IS DISTINCT FROM OLD.enrollment_hash OR NEW.control_hash IS DISTINCT FROM OLD.control_hash OR
     NEW.enrollment_expires_at IS DISTINCT FROM OLD.enrollment_expires_at OR NEW.control_expires_at IS DISTINCT FROM OLD.control_expires_at OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     (OLD.runner_id IS NOT NULL AND NEW.runner_id IS DISTINCT FROM OLD.runner_id) OR
     (OLD.bound_session_id IS NOT NULL AND NEW.bound_session_id IS DISTINCT FROM OLD.bound_session_id) OR
     (OLD.runner_released_at IS NOT NULL AND NEW.runner_released_at IS DISTINCT FROM OLD.runner_released_at) THEN
    RAISE EXCEPTION USING MESSAGE = 'Managed runner binding is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_managed_runners_immutable BEFORE UPDATE ON session_managed_runners
FOR EACH ROW EXECUTE FUNCTION session_managed_runners_guard();
CREATE OR REPLACE FUNCTION session_managed_runners_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Managed runner bindings are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER session_managed_runners_no_delete BEFORE DELETE ON session_managed_runners
FOR EACH ROW EXECUTE FUNCTION session_managed_runners_no_delete_guard();
`,
};
