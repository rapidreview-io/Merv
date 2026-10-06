import {
  retiredInstancesSql,
  retiredPlanTaskIds,
  retiredPlanTasksSql,
} from '@merv/workflows/retired-instances';
import { withoutTriggers } from '@merv/contracts';

/** The retired plan ids query, quoted for the EXECUTE strings version 9 needs for optional tables. */
const quotedPlanTaskIds = retiredPlanTaskIds.replaceAll("'", "''");

/**
 * sessions@13: one thread per worker of a stage, replacing `agents` and `session_conversations`.
 * Production pins the text by its digest once released: never edit it after.
 *
 * Every agent became a thread with its id (its Scope actor's `agent_id` names it and is
 * immutable), so a session's `agentId` is its `thread_id`; a session from before agents gets its actor's
 * thread (`thr_<actor>`): its own, as each such session had an actor of its own. The thread's actor is the sessions' `actor_id`, which an agent's sessions
 * shared. A thread whose actor Scope revoked, or that has no key and no live session, is retired;
 * of a key's other threads the one with the newest session holds the key and the rest are
 * `superseded`, as that session's close would have made them. The conversation a key's row kept
 * moves onto the thread it named. Neither the `agents` rows nor their actors are needed again.
 *
 * Read-only counts to take on production first (and back up):
 *   SELECT count(*) AS sessions,
 *          count(DISTINCT session_json::jsonb->>'agentId') AS agent_threads,
 *          count(*) FILTER (WHERE session_json::jsonb->>'agentId' IS NULL) AS pre_agent_threads,
 *          count(*) FILTER (WHERE status IN ('offered','active')) AS live
 *     FROM worker_sessions;
 *   SELECT status, count(*) FROM agents GROUP BY status;
 *   SELECT count(*) AS agents_without_sessions FROM agents a WHERE NOT EXISTS
 *     (SELECT 1 FROM worker_sessions s WHERE s.session_json::jsonb->>'agentId' = a.id);
 *   SELECT count(*) AS rows, count(sha256) AS conversations, count(uploaded_at) AS uploaded
 *     FROM session_conversations;
 *   SELECT count(*) AS sessions_without_state_role_or_time FROM worker_sessions
 *    WHERE session_json::jsonb#>>'{execution,state}' IS NULL OR session_json::jsonb->>'role' IS NULL
 *       OR session_json::jsonb->>'createdAt' IS NULL;  -- their threads read '' there
 *   SELECT count(*) AS keys_with_rival_threads FROM (
 *     SELECT s.project_id, s.session_json::jsonb#>>'{continuity,key}' FROM worker_sessions s
 *       JOIN actors a ON a.id = s.actor_id
 *      WHERE a.active = 1 AND s.session_json::jsonb#>>'{continuity,key}' IS NOT NULL
 *      GROUP BY 1, 2 HAVING count(DISTINCT s.actor_id) > 1) k;
 */
const threadsMigration = `
CREATE TABLE session_threads (
  _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  continuity_key TEXT CHECK(length(continuity_key) BETWEEN 1 AND 512),
  instance_id TEXT NOT NULL, state TEXT NOT NULL, role TEXT NOT NULL,
  actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id),
  status TEXT NOT NULL CHECK(status IN ('open','dormant','retired')),
  retired_reason TEXT CHECK((status = 'retired') = (retired_reason IS NOT NULL)),
  harness TEXT CHECK(harness IN ('claude','codex')),
  conversation_id TEXT,
  sha256 TEXT CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  size BIGINT CHECK(size > 0 AND size <= 67108864),
  uploaded_at TEXT,
  latest_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((harness IS NULL) = (sha256 IS NULL) AND (sha256 IS NULL) = (size IS NULL) AND
        (size IS NULL) = (conversation_id IS NULL) AND (uploaded_at IS NULL OR sha256 IS NOT NULL))
);
CREATE TEMP TABLE thread_visits ON COMMIT DROP AS
  SELECT s.id, s._merv_rowid AS seq, s.project_id, s.instance_id, s.actor_id,
         s.status IN ('offered','active') AS live,
         COALESCE(x.j->>'agentId', 'thr_' || s.actor_id) AS thread_id,
         x.j#>>'{continuity,key}' AS continuity_key, COALESCE(x.j#>>'{execution,state}', '') AS state,
         COALESCE(x.j->>'role', '') AS role, COALESCE(x.j->>'createdAt', '') AS created_at,
         COALESCE(x.j->>'closedAt', x.j->>'createdAt', '') AS touched
    FROM worker_sessions s CROSS JOIN LATERAL (SELECT s.session_json::jsonb AS j OFFSET 0) x;
INSERT INTO session_threads(id,project_id,continuity_key,instance_id,state,role,actor_id,status,
  retired_reason,latest_session_id,created_at,updated_at)
SELECT f.thread_id, f.project_id, f.continuity_key, f.instance_id, f.state, f.role, f.actor_id,
       CASE WHEN a.active = 0 OR (f.continuity_key IS NULL AND NOT l.live) THEN 'retired'
            WHEN l.live THEN 'open' ELSE 'dormant' END,
       CASE WHEN a.active = 0 OR (f.continuity_key IS NULL AND NOT l.live) THEN
         COALESCE((SELECT e.data_json::jsonb->>'reason' FROM events e WHERE e.project_id = f.project_id
           AND e.subject_id = f.thread_id AND e.type = 'agent.retired' ORDER BY e.id DESC LIMIT 1), 'retired') END,
       CASE WHEN l.live THEN NULL ELSE l.id END, f.created_at, l.touched
  FROM (SELECT DISTINCT ON (thread_id) * FROM thread_visits ORDER BY thread_id, seq) f
  JOIN (SELECT DISTINCT ON (thread_id) thread_id, id, live, seq, touched FROM thread_visits
         ORDER BY thread_id, seq DESC) l ON l.thread_id = f.thread_id
  JOIN actors a ON a.id = f.actor_id;
UPDATE session_threads t SET status = 'retired', retired_reason = 'superseded'
 WHERE t.status <> 'retired' AND t.continuity_key IS NOT NULL AND EXISTS (
   SELECT 1 FROM session_threads o JOIN thread_visits v ON v.thread_id = o.id
    WHERE o.project_id = t.project_id AND o.continuity_key = t.continuity_key AND o.id <> t.id
      AND o.status <> 'retired'
      AND v.seq > (SELECT max(seq) FROM thread_visits w WHERE w.thread_id = t.id));
DO $threads$
BEGIN
  IF to_regclass('session_conversations') IS NOT NULL THEN
    EXECUTE 'UPDATE session_threads t SET harness = c.harness, conversation_id = c.conversation_id,
      sha256 = c.sha256, size = c.size, uploaded_at = c.uploaded_at, updated_at = c.updated_at,
      latest_session_id = c.session_id
      FROM session_conversations c WHERE c.agent_id = t.id AND c.project_id = t.project_id';
  END IF;
END $threads$;
CREATE UNIQUE INDEX session_threads_key ON session_threads(project_id, continuity_key)
  WHERE status <> 'retired' AND continuity_key IS NOT NULL;
CREATE INDEX session_threads_dormant ON session_threads(updated_at) WHERE status = 'dormant';
CREATE INDEX session_threads_latest ON session_threads(latest_session_id);
CREATE OR REPLACE FUNCTION session_threads_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'retired' OR NEW.id IS DISTINCT FROM OLD.id OR
     NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.continuity_key IS DISTINCT FROM OLD.continuity_key OR
     NEW.instance_id IS DISTINCT FROM OLD.instance_id OR NEW.state IS DISTINCT FROM OLD.state OR
     NEW.role IS DISTINCT FROM OLD.role OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING MESSAGE = 'A thread keeps its identity, and a retired one is final', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_threads_guard BEFORE UPDATE OR DELETE ON session_threads
FOR EACH ROW EXECUTE FUNCTION session_threads_guard();
ALTER TABLE worker_sessions ADD COLUMN thread_id TEXT REFERENCES session_threads(id);
${withoutTriggers(
  'worker_sessions',
  ['worker_sessions_immutable', 'worker_sessions_agent_immutable'],
  'UPDATE worker_sessions s SET thread_id = v.thread_id FROM thread_visits v WHERE v.id = s.id;',
)}
ALTER TABLE worker_sessions ALTER COLUMN thread_id SET NOT NULL;
CREATE INDEX worker_sessions_thread ON worker_sessions(thread_id);
DROP TRIGGER worker_sessions_agent_immutable ON worker_sessions;
DROP FUNCTION worker_sessions_agent_immutable_guard();
CREATE FUNCTION worker_sessions_thread_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.thread_id IS DISTINCT FROM OLD.thread_id THEN
    RAISE EXCEPTION USING MESSAGE = 'A session''s thread is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER worker_sessions_thread_immutable BEFORE UPDATE ON worker_sessions
FOR EACH ROW EXECUTE FUNCTION worker_sessions_thread_immutable_guard();
DROP TABLE IF EXISTS session_conversations;
DROP TABLE IF EXISTS agents;
DROP FUNCTION IF EXISTS agents_no_delete_guard(), agents_immutable_guard();
DO $threads$
BEGIN
  IF to_regclass('component_migrations') IS NOT NULL THEN
    DELETE FROM component_migrations WHERE component IN ('agents', 'session_conversations');
  END IF;
END $threads$;
`;
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
  // A new table, because a closed session row refuses every update: what a session cost is known
  // only at and after its close.
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
`, // Deletes the sessions of retired experiment.plan tasks, as version 6 did for the earlier
  // retirement.
  9: `${retiredPlanTasksSql}
CREATE TEMP TABLE retired_plan_sessions ON COMMIT DROP AS
  SELECT id FROM worker_sessions WHERE instance_id IN (${retiredPlanTaskIds});
DO $retire$
BEGIN
  IF to_regclass('session_tool_calls') IS NOT NULL THEN
    EXECUTE 'DELETE FROM session_tool_calls WHERE execution_id IN (SELECT id FROM retired_plan_sessions)';
  END IF;
  IF to_regclass('session_dispatch_receipts') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE session_dispatch_receipts DISABLE TRIGGER session_dispatch_receipts_no_delete';
    EXECUTE 'DELETE FROM session_dispatch_receipts WHERE session_id IN (SELECT id FROM retired_plan_sessions)';
    EXECUTE 'ALTER TABLE session_dispatch_receipts ENABLE TRIGGER session_dispatch_receipts_no_delete';
  END IF;
  IF to_regclass('session_dispatch_holds') IS NOT NULL THEN
    EXECUTE 'DELETE FROM session_dispatch_holds WHERE instance_id IN (${quotedPlanTaskIds})
      OR last_session_id IN (SELECT id FROM retired_plan_sessions)';
  END IF;
  IF to_regclass('session_hold_requests') IS NOT NULL THEN
    EXECUTE 'DELETE FROM session_hold_requests
      WHERE result::jsonb->>''instanceId'' IN (${quotedPlanTaskIds})';
  END IF;
  IF to_regclass('session_budgets') IS NOT NULL THEN
    EXECUTE 'DELETE FROM session_budgets WHERE scope_id IN (${quotedPlanTaskIds})';
  END IF;
END $retire$;
${withoutTriggers(
  'session_workspaces',
  ['session_workspaces_no_delete'],
  `DELETE FROM session_workspaces WHERE session_id IN (SELECT id FROM retired_plan_sessions);`,
)}
${withoutTriggers(
  'session_usage',
  ['session_usage_no_delete'],
  `DELETE FROM session_usage WHERE session_id IN (SELECT id FROM retired_plan_sessions);`,
)}
${withoutTriggers(
  'worker_sessions',
  ['worker_sessions_no_delete'],
  `DELETE FROM worker_sessions WHERE id IN (SELECT id FROM retired_plan_sessions);`,
)}`,
  10: `
CREATE TABLE session_messages (
  _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT NOT NULL REFERENCES worker_sessions(id),
  sender_actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  ack_request_id TEXT,
  reply_body TEXT,
  UNIQUE(project_id,sender_actor_id,request_id)
);
CREATE INDEX session_messages_pending ON session_messages(project_id,session_id,_merv_rowid) WHERE acknowledged_at IS NULL;
CREATE OR REPLACE FUNCTION session_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF TG_OP='DELETE' OR OLD.acknowledged_at IS NOT NULL OR
     NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
     NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.sender_actor_id IS DISTINCT FROM OLD.sender_actor_id OR
     NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR
     NEW.body IS DISTINCT FROM OLD.body OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.acknowledged_at IS NULL OR NEW.ack_request_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Session messages are retained; acknowledgement is write-once', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_messages_immutable BEFORE UPDATE OR DELETE ON session_messages
FOR EACH ROW EXECUTE FUNCTION session_messages_guard();
`,
  11: `
ALTER TABLE session_managed_runners ADD COLUMN work_instance_id TEXT;
ALTER TABLE session_managed_runners ADD COLUMN step_seconds BIGINT CHECK(step_seconds BETWEEN 60 AND 86400);
ALTER TABLE session_managed_runners ADD CONSTRAINT managed_work_step CHECK ((work_instance_id IS NULL) = (step_seconds IS NULL));
CREATE FUNCTION session_managed_work_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.work_instance_id IS DISTINCT FROM OLD.work_instance_id OR NEW.step_seconds IS DISTINCT FROM OLD.step_seconds OR
     (NEW.work_instance_id IS NOT NULL AND NEW.bound_session_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Managed work affinity is immutable';
  END IF;
  RETURN NEW;
END $merv$;
CREATE TRIGGER session_managed_work_immutable BEFORE UPDATE ON session_managed_runners
FOR EACH ROW EXECUTE FUNCTION session_managed_work_guard();
CREATE TABLE session_managed_assignments (
  ordinal BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  session_id TEXT PRIMARY KEY REFERENCES worker_sessions(id),
  allocation_id TEXT NOT NULL REFERENCES session_managed_runners(allocation_id),
  runner_id TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(source_json IS JSON),
  bound_at TEXT NOT NULL,
  release_ack_at TEXT,
  settled_at TEXT
);
CREATE UNIQUE INDEX session_managed_assignment_active ON session_managed_assignments(allocation_id) WHERE settled_at IS NULL;
CREATE FUNCTION session_managed_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF TG_OP='DELETE' OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.session_id IS DISTINCT FROM OLD.session_id OR
     NEW.allocation_id IS DISTINCT FROM OLD.allocation_id OR NEW.runner_id IS DISTINCT FROM OLD.runner_id OR
     NEW.source_json IS DISTINCT FROM OLD.source_json OR NEW.bound_at IS DISTINCT FROM OLD.bound_at OR
     (OLD.release_ack_at IS NOT NULL AND NEW.release_ack_at IS DISTINCT FROM OLD.release_ack_at) OR
     (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION 'Managed assignment history is retained';
  END IF;
  RETURN NEW;
END $merv$;
CREATE TRIGGER session_managed_assignment_immutable BEFORE UPDATE OR DELETE ON session_managed_assignments
FOR EACH ROW EXECUTE FUNCTION session_managed_assignment_guard();
`,
  // Every lease reads the closes in its backoff window, and every board read those since its
  // deferral window: both ask by close time, which no other index orders.
  12: `CREATE INDEX session_usage_closed ON session_usage(closed_at);`,
  13: threadsMigration,
};
