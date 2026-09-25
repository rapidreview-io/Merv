-- Census of the workflow instances whose version can no longer start, and of every record the
-- retirement migrations delete (workflows@7, sessions@6, tasks@8, reviews@10, context_builder@2,
-- experiments@4, experiment_program@3, reflections@2, research@7, knowledge@2), and of the
-- 2026-09-25 experiment.plan retirement (workflows@8, sessions@9, tasks@9, reviews@12,
-- context_builder@3), whose ledger rows carry the reason recipe_experiment.plan_2.
--
-- Run it before a release, and again after it, against a restored pg_dump or the live database:
--
--   PGOPTIONS='-c search_path=<schema>' psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/retirement-census.sql
--
-- It changes nothing: everything runs in one transaction that ends in ROLLBACK. It cannot be READ
-- ONLY, because it computes the ledger the way the migrations do (the text below is
-- retirementLedgerSql in packages/contracts/src/retired-instances.ts, byte for byte) and keeps
-- working sets in temporary tables. After the release the ledger already exists, and its
-- persisted rows are the set. The migrations follow the ledger with preconditions that refuse the
-- whole release; this script leaves them out so that it always runs to the end, and reports each
-- as a row instead (C2, the last query of C4, and the first two of C5).
--
-- Every result row starts with its census number. R is the set of ledger ids and S the worker
-- sessions of R. The gates:
--   C1  R by reason, workflow, version and state. Record it; the release note carries it.
--   C2  Live sessions of R. Must be empty: the migrations refuse the release otherwise. Halt
--       dispatch for those projects until the sessions close.
--   C3  Dependency edges from a surviving instance to R. A non-terminal source needs an owner
--       decision; the migration deletes the edge, which unblocks the source.
--   C4  Research survivors whose predecessor or automation root is in R (research@7 re-links them),
--       and surviving cycles staged on a wave in R (must be empty; the migrations refuse).
--   C5  Records the migrations refuse to leave behind outside R. Every count must be 0.
--   C6  Code lineage and code-research rows of R. Kept; report only. An accepted unit of R whose
--       commit main lacks is history: no research cycle integrates it after the release.
--   C7  Pending paper proposals in surviving experiment submissions. 0 lets paperProposal go.
--   C8  Rows each migration deletes, re-links or drops. The verification compares against them.
--   C9  Every text column holding a ledger id, exactly or inside JSON. Before the release each hit
--       must map to a C8 table or to the kept records; after it only the kept records remain.
--   C10 Tables and functions the migrations alter that the current user does not own. Must be
--       empty: DISABLE TRIGGER and DROP need ownership.
--   C11 Reflection waves in R still open. Informational: they block new waves until deleted.
--   C12 Budgets whose status the release changes. sessions@6 deletes the usage of S, so a budget
--       its sessions exceeded, or left unavailable by not reporting, may let dispatch (and
--       spending) resume; service work charged to R is kept and still counts. Owner decision.
--   C13 Event consumers behind the log. Must be empty for every consumer the new build
--       registers: stop writes and let them drain before deploying. A consumer no plugin
--       registers any more stays behind harmlessly.
--   C14 Managed runners bound to a session of an experiment.plan task in R. Must be 0: the plan
--       migrations refuse the release otherwise (planRetirementPreconditionsSql).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS wf_retired_instances (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow TEXT NOT NULL,
  version BIGINT NOT NULL, reason TEXT NOT NULL);
CREATE OR REPLACE FUNCTION wf_retired_instances_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'The retirement ledger is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$guard$;
CREATE OR REPLACE TRIGGER wf_retired_instances_retained BEFORE UPDATE OR DELETE ON wf_retired_instances
FOR EACH ROW EXECUTE FUNCTION wf_retired_instances_retained_guard();
DO $retire$
BEGIN
  IF to_regclass('wf_instances') IS NULL THEN RETURN; END IF;
  INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
  SELECT id,project_id,workflow,version,'retired_version' FROM wf_instances
  WHERE (workflow='task' AND version=1) OR (workflow='experiment' AND version BETWEEN 1 AND 4)
     OR (workflow='reflection' AND version IN (1,2)) OR (workflow='reflection.lens' AND version=1)
     OR (workflow='research' AND version BETWEEN 2 AND 5) OR workflow='consolidation'
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
  SELECT i.id,i.project_id,i.workflow,i.version,'upgraded_from_task_1' FROM wf_instances i
  WHERE i.workflow='task' AND EXISTS (SELECT 1 FROM wf_history h WHERE h.instance_id=i.id AND h.action='upgrade')
  ON CONFLICT (id) DO NOTHING;
  IF to_regclass('tasks') IS NOT NULL THEN
    INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
    SELECT t.id,t.project_id,'task',COALESCE(i.version,0),
      CASE WHEN t.evidence_version=1 THEN 'task_evidence_1' ELSE 'recipe_experiment.plan_1' END
    FROM tasks t LEFT JOIN wf_instances i ON i.id=t.id
    WHERE t.evidence_version=1 OR (t.type_name='experiment.plan' AND t.type_version=1)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF to_regclass('research_cycles') IS NOT NULL THEN
    INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
    SELECT i.id,i.project_id,i.workflow,i.version,'stage_of_retired_research'
    FROM research_cycles c JOIN wf_retired_instances r ON r.id=c.id JOIN wf_instances i ON i.id=c.reflection_id
    ON CONFLICT (id) DO NOTHING;
  END IF;
  INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
  SELECT i.id,i.project_id,i.workflow,i.version,'lens_of_retired_wave'
  FROM wf_instances i JOIN wf_retired_instances r ON r.id = i.data_json::jsonb->>'reflectionId'
  WHERE i.workflow='reflection.lens'
  ON CONFLICT (id) DO NOTHING;
END $retire$;

-- The experiment.plan retirement's ledger rows (planRetirementLedgerSql, byte for byte).
DO $retire_plan$
BEGIN
  IF to_regclass('tasks') IS NULL THEN RETURN; END IF;
  INSERT INTO wf_retired_instances(id,project_id,workflow,version,reason)
  SELECT t.id,t.project_id,'task',COALESCE(i.version,0),'recipe_experiment.plan_2'
  FROM tasks t LEFT JOIN wf_instances i ON i.id=t.id
  WHERE t.type_name='experiment.plan'
  ON CONFLICT (id) DO NOTHING;
END $retire_plan$;

CREATE TEMP TABLE census_r AS SELECT id FROM wf_retired_instances;
CREATE TEMP TABLE census_s AS
  SELECT id FROM worker_sessions WHERE instance_id IN (SELECT id FROM census_r);
CREATE TEMP TABLE census_reviews AS
  SELECT id FROM reviews WHERE subject_id IN (SELECT id FROM census_r);

-- A count that reads NULL when its table is gone, as the consolidation tables are after research@7.
CREATE FUNCTION pg_temp.census_count(query TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $census$
DECLARE
  n BIGINT;
BEGIN
  EXECUTE query INTO n;
  RETURN n;
EXCEPTION WHEN undefined_table THEN
  RETURN NULL;
END $census$;

-- C1
SELECT 'C1' AS census, r.reason, r.workflow, r.version, i.state, count(*) AS instances
FROM wf_retired_instances r LEFT JOIN wf_instances i ON i.id = r.id
GROUP BY r.reason, r.workflow, r.version, i.state
ORDER BY r.reason, r.workflow, r.version, i.state;

-- C2
SELECT 'C2' AS census, w.project_id, w.id AS session_id, w.instance_id, w.status
FROM worker_sessions w
WHERE w.id IN (SELECT id FROM census_s) AND w.status IN ('offered', 'active')
ORDER BY w.project_id, w.id;

-- C3
SELECT 'C3' AS census, d.project_id, d.source_id, s.workflow AS source_workflow,
  s.version AS source_version, s.state AS source_state, d.target_id, d.kind
FROM wf_dependencies d LEFT JOIN wf_instances s ON s.id = d.source_id
WHERE d.target_id IN (SELECT id FROM census_r) AND d.source_id NOT IN (SELECT id FROM census_r)
ORDER BY d.project_id, d.source_id, d.target_id;

-- C4
SELECT 'C4' AS census, 'predecessor re-linked to NULL' AS change, c.project_id, c.id,
  c.predecessor_id AS retired_id
FROM research_cycles c
WHERE c.predecessor_id IN (SELECT id FROM census_r) AND c.id NOT IN (SELECT id FROM census_r)
UNION ALL
SELECT 'C4', 'automation root re-pointed', a.project_id, a.research_id, a.root_id
FROM research_automation a
WHERE a.root_id IN (SELECT id FROM census_r) AND a.research_id NOT IN (SELECT id FROM census_r)
UNION ALL
SELECT 'C4', 'survivor staged on a retired wave (must be empty)', c.project_id, c.id,
  c.reflection_id
FROM research_cycles c
WHERE c.id NOT IN (SELECT id FROM census_r) AND c.reflection_id IN (SELECT id FROM census_r)
ORDER BY 2, 3, 4;

-- C5
SELECT 'C5' AS census, 'reviews format_version=1 outside R' AS selector, count(*) AS must_be_0
FROM reviews WHERE format_version = 1 AND subject_id NOT IN (SELECT id FROM census_r)
UNION ALL
SELECT 'C5', 'experiment_evidence role=graph outside R', count(*)
FROM experiment_evidence WHERE role = 'graph' AND experiment_id NOT IN (SELECT id FROM census_r)
UNION ALL
SELECT 'C5', 'tasks evidence_version=1 outside R', count(*)
FROM tasks WHERE evidence_version = 1 AND id NOT IN (SELECT id FROM census_r);

-- C6
SELECT 'C6' AS census, 'code_units of R' AS selector, count(*) AS kept
FROM code_units WHERE unit_id IN (SELECT id FROM census_r)
UNION ALL
SELECT 'C6', 'code_units of R accepted with code (never integrated after the release)', count(*)
FROM code_units
WHERE unit_id IN (SELECT id FROM census_r) AND acceptance_json::jsonb ? 'code'
UNION ALL
SELECT 'C6', 'code_edges from a survivor to an acceptance of R', count(*)
FROM code_edges e
WHERE EXISTS (SELECT 1 FROM census_r r WHERE starts_with(e.target_ref, 'acceptance:' || r.id || '@'))
  AND NOT EXISTS (SELECT 1 FROM census_r r WHERE e.source_ref = 'unit:' || r.id)
UNION ALL
SELECT 'C6', 'code_proposals of R', count(*)
FROM code_proposals WHERE instance_id IN (SELECT id FROM census_r)
UNION ALL
SELECT 'C6', 'code_commands of sessions of R', count(*)
FROM code_commands WHERE session_id IN (SELECT id FROM census_s);

-- C7
SELECT 'C7' AS census, e.project_id, s.experiment_id, s.id AS submission_id, s.review_id,
  v.status AS review_status
FROM experiment_submissions s
JOIN experiments e ON e.id = s.experiment_id
LEFT JOIN reviews v ON v.id = s.review_id
WHERE s.experiment_id NOT IN (SELECT id FROM census_r)
  AND s.record::jsonb ? 'paperProposal' AND e.review_id IS NOT NULL
ORDER BY e.project_id, s.experiment_id, s.id;

-- C8
SELECT 'C8' AS census, migration, selector, pg_temp.census_count(query) AS row_count
FROM (VALUES
  (1, 'workflows@7', 'wf_dependencies source or target in R',
    'SELECT count(*) FROM wf_dependencies WHERE source_id IN (SELECT id FROM census_r) OR target_id IN (SELECT id FROM census_r)'),
  (2, 'workflows@7', 'wf_blockers instance in R',
    'SELECT count(*) FROM wf_blockers WHERE instance_id IN (SELECT id FROM census_r)'),
  (3, 'workflows@7', 'wf_requests response id in R',
    'SELECT count(*) FROM wf_requests WHERE (response_json::jsonb->>''id'') IN (SELECT id FROM census_r)'),
  (4, 'workflows@7', 'wf_system_requests fingerprint instanceId in R',
    'SELECT count(*) FROM wf_system_requests WHERE (fingerprint::jsonb->>''instanceId'') IN (SELECT id FROM census_r)'),
  (5, 'workflows@7', 'wf_work_starts instance in R',
    'SELECT count(*) FROM wf_work_starts WHERE instance_id IN (SELECT id FROM census_r)'),
  (6, 'workflows@7', 'wf_limit_grants instance in R',
    'SELECT count(*) FROM wf_limit_grants WHERE instance_id IN (SELECT id FROM census_r)'),
  (7, 'workflows@7', 'wf_history instance in R',
    'SELECT count(*) FROM wf_history WHERE instance_id IN (SELECT id FROM census_r)'),
  (8, 'workflows@7', 'wf_instances in R',
    'SELECT count(*) FROM wf_instances WHERE id IN (SELECT id FROM census_r)'),
  (9, 'sessions@6', 'worker_sessions of R (S)',
    'SELECT count(*) FROM census_s'),
  (10, 'sessions@6', 'session_tool_calls execution in S',
    'SELECT count(*) FROM session_tool_calls WHERE execution_id IN (SELECT id FROM census_s)'),
  (11, 'sessions@6', 'session_dispatch_receipts session in S',
    'SELECT count(*) FROM session_dispatch_receipts WHERE session_id IN (SELECT id FROM census_s)'),
  (12, 'sessions@6', 'session_dispatch_holds instance in R or last session in S',
    'SELECT count(*) FROM session_dispatch_holds WHERE instance_id IN (SELECT id FROM census_r) OR last_session_id IN (SELECT id FROM census_s)'),
  (12.5, 'sessions@6', 'session_hold_requests result instanceId in R',
    'SELECT count(*) FROM session_hold_requests WHERE (result::jsonb->>''instanceId'') IN (SELECT id FROM census_r)'),
  (13, 'sessions@6', 'session_budgets scope in R',
    'SELECT count(*) FROM session_budgets WHERE scope_id IN (SELECT id FROM census_r)'),
  (14, 'sessions@6', 'session_workspaces session in S',
    'SELECT count(*) FROM session_workspaces WHERE session_id IN (SELECT id FROM census_s)'),
  (15, 'sessions@6', 'session_usage session in S',
    'SELECT count(*) FROM session_usage WHERE session_id IN (SELECT id FROM census_s)'),
  (16, 'tasks@8', 'task_leases task in R',
    'SELECT count(*) FROM task_leases WHERE task_id IN (SELECT id FROM census_r)'),
  (17, 'tasks@8', 'task_checkpoints task in R',
    'SELECT count(*) FROM task_checkpoints WHERE task_id IN (SELECT id FROM census_r)'),
  (18, 'tasks@8', 'task_commands result id or taskId in R',
    'SELECT count(*) FROM task_commands WHERE (result::jsonb->>''id'') IN (SELECT id FROM census_r) OR (result::jsonb->>''taskId'') IN (SELECT id FROM census_r)'),
  (19, 'tasks@8', 'tasks in R',
    'SELECT count(*) FROM tasks WHERE id IN (SELECT id FROM census_r)'),
  (20, 'reviews@10', 'review_commands result id a review of R',
    'SELECT count(*) FROM review_commands WHERE (result::jsonb->>''id'') IN (SELECT id FROM census_reviews)'),
  (21, 'reviews@10', 'reviews subject in R',
    'SELECT count(*) FROM census_reviews'),
  (22, 'context_builder@2', 'context_packages subject in R',
    'SELECT count(*) FROM context_packages WHERE (package::jsonb #>> ''{subject,id}'') IN (SELECT id FROM census_r)'),
  (23, 'experiments@4', 'experiment_slots experiment in R',
    'SELECT count(*) FROM experiment_slots WHERE experiment_id IN (SELECT id FROM census_r)'),
  (24, 'experiments@4', 'experiment_evidence experiment in R',
    'SELECT count(*) FROM experiment_evidence WHERE experiment_id IN (SELECT id FROM census_r)'),
  (25, 'experiments@4', 'experiment_submissions experiment in R',
    'SELECT count(*) FROM experiment_submissions WHERE experiment_id IN (SELECT id FROM census_r)'),
  (26, 'experiments@4', 'experiment_attempts experiment in R',
    'SELECT count(*) FROM experiment_attempts WHERE experiment_id IN (SELECT id FROM census_r)'),
  (27, 'experiments@4', 'experiment_commands result id or experimentId in R',
    'SELECT count(*) FROM experiment_commands WHERE (result::jsonb->>''id'') IN (SELECT id FROM census_r) OR (result::jsonb->>''experimentId'') IN (SELECT id FROM census_r)'),
  (28, 'experiments@4', 'experiments in R',
    'SELECT count(*) FROM experiments WHERE id IN (SELECT id FROM census_r)'),
  (29, 'experiment_program@3', 'experiment_leases experiment in R',
    'SELECT count(*) FROM experiment_leases WHERE experiment_id IN (SELECT id FROM census_r)'),
  (30, 'reflections@2', 'reflection_leases instance in R',
    'SELECT count(*) FROM reflection_leases WHERE instance_id IN (SELECT id FROM census_r)'),
  (31, 'reflections@2', 'reflection_commands result id in R',
    'SELECT count(*) FROM reflection_commands WHERE (result::jsonb->>''id'') IN (SELECT id FROM census_r)'),
  (32, 'reflections@2', 'reflection_lenses wave or lens in R',
    'SELECT count(*) FROM reflection_lenses WHERE reflection_id IN (SELECT id FROM census_r) OR id IN (SELECT id FROM census_r)'),
  (33, 'reflections@2', 'reflections in R',
    'SELECT count(*) FROM reflections WHERE id IN (SELECT id FROM census_r)'),
  (34, 'research@7', 'research_cycles predecessor re-linked',
    'SELECT count(*) FROM research_cycles WHERE predecessor_id IN (SELECT id FROM census_r) AND id NOT IN (SELECT id FROM census_r)'),
  (35, 'research@7', 'research_automation root re-pointed',
    'SELECT count(*) FROM research_automation WHERE root_id IN (SELECT id FROM census_r) AND research_id NOT IN (SELECT id FROM census_r)'),
  (36, 'research@7', 'research_automation research in R',
    'SELECT count(*) FROM research_automation WHERE research_id IN (SELECT id FROM census_r)'),
  (37, 'research@7', 'research_commands result id in R',
    'SELECT count(*) FROM research_commands WHERE (result::jsonb->>''id'') IN (SELECT id FROM census_r)'),
  (38, 'research@7', 'research_cycles in R',
    'SELECT count(*) FROM research_cycles WHERE id IN (SELECT id FROM census_r)'),
  (39, 'research@7', 'consolidations dropped', 'SELECT count(*) FROM consolidations'),
  (40, 'research@7', 'consolidation_submissions dropped',
    'SELECT count(*) FROM consolidation_submissions'),
  (41, 'research@7', 'consolidation_commands dropped', 'SELECT count(*) FROM consolidation_commands'),
  (42, 'research@7', 'consolidation_leases dropped', 'SELECT count(*) FROM consolidation_leases'),
  (43, 'research@7', 'component_migrations of consolidation',
    'SELECT count(*) FROM component_migrations WHERE component = ''consolidation'''),
  (44, 'knowledge@2', 'knowledge_commands', 'SELECT count(*) FROM knowledge_commands'),
  (45, 'knowledge@2', 'knowledge_snapshots', 'SELECT count(*) FROM knowledge_snapshots'),
  (46, 'ledger', 'wf_retired_instances', 'SELECT count(*) FROM census_r'),
  (47, 'kept', 'events', 'SELECT count(*) FROM events')
) AS selectors(position, migration, selector, query)
ORDER BY position;

-- C9
CREATE TEMP TABLE census_scan (
  table_name TEXT NOT NULL, column_name TEXT NOT NULL, exact BIGINT NOT NULL, contained BIGINT NOT NULL);
DO $census$
DECLARE
  c RECORD;
  exact BIGINT;
  contained BIGINT;
BEGIN
  FOR c IN
    SELECT k.table_name::TEXT AS table_name, k.column_name::TEXT AS column_name
    FROM information_schema.columns k
    JOIN information_schema.tables t
      ON t.table_schema = k.table_schema AND t.table_name = k.table_name AND t.table_type = 'BASE TABLE'
    WHERE k.table_schema = current_schema() AND k.data_type = 'text'
      AND k.table_name NOT IN ('events', 'wf_retired_instances')
    ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IN (SELECT id FROM census_r)',
      c.table_name, c.column_name) INTO exact;
    contained := 0;
    IF c.column_name ~ '_json$' OR c.column_name IN ('record', 'result', 'package', 'fingerprint',
      'receipt', 'inputs', 'recovery', 'artifacts', 'checkpoint', 'checkpoints', 'manifest',
      'acceptance', 'completion', 'submission', 'approved', 'feedback', 'corpus', 'paper',
      'artifact', 'integrations', 'digest', 'source_ref', 'target_ref') THEN
      EXECUTE format('SELECT count(*) FROM %I t WHERE EXISTS '
        '(SELECT 1 FROM census_r r WHERE strpos(t.%I, r.id) > 0)', c.table_name, c.column_name)
        INTO contained;
    END IF;
    IF exact > 0 OR contained > 0 THEN
      INSERT INTO census_scan VALUES (c.table_name, c.column_name, exact, contained);
    END IF;
  END LOOP;
END $census$;
SELECT 'C9' AS census, table_name, column_name, exact, contained
FROM census_scan ORDER BY table_name, column_name;

-- C10
SELECT 'C10' AS census, 'table' AS kind, c.relname::TEXT AS name, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
  AND c.relkind = 'r'
  AND c.relname IN ('wf_system_requests', 'wf_work_starts', 'wf_limit_grants',
    'worker_sessions', 'session_dispatch_receipts', 'session_workspaces', 'session_usage',
    'session_tool_calls', 'session_dispatch_holds', 'session_budgets', 'task_leases',
    'task_checkpoints', 'reviews', 'context_packages', 'experiment_evidence',
    'experiment_submissions', 'experiment_attempts', 'experiment_commands', 'experiments',
    'experiment_leases', 'reflection_leases', 'reflection_lenses', 'reflections',
    'research_cycles', 'research_automation', 'knowledge_commands', 'knowledge_snapshots',
    'consolidations', 'consolidation_submissions', 'consolidation_commands',
    'consolidation_leases')
  AND NOT pg_has_role(current_user, c.relowner, 'MEMBER')
UNION ALL
SELECT 'C10', 'function', p.proname::TEXT, pg_get_userbyid(p.proowner)
FROM pg_proc p
WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
  AND p.proname LIKE 'consolidation\_%\_guard'
  AND NOT pg_has_role(current_user, p.proowner, 'MEMBER')
ORDER BY 2, 3;

-- C11
SELECT 'C11' AS census, r.project_id, r.id AS reflection_id, i.workflow, i.version, i.state
FROM reflections r LEFT JOIN wf_instances i ON i.id = r.id
WHERE r.id IN (SELECT id FROM census_r) AND r.approved IS NULL
ORDER BY r.project_id, r.id;

-- C12 measures every surviving budget as Sessions does (sessions/src/usage.ts budgetStatuses):
-- a project scope over all of the project's usage, an instance scope over its dependency closure
-- (dependency edges, and lenses under their wave). Service work counts toward wall time only.
-- "After" leaves out the usage of S and every instance the closure reached only through R.
CREATE TEMP TABLE census_budget_reach AS
WITH RECURSIVE
edges AS (
  SELECT project_id, source_id AS source, target_id AS target FROM wf_dependencies
  UNION ALL
  SELECT project_id, reflection_id, id FROM reflection_lenses
),
reach(project_id, scope_id, id, through_r) AS (
  SELECT b.project_id, b.scope_id, i.id, false
  FROM session_budgets b JOIN wf_instances i ON i.id = b.scope_id AND i.project_id = b.project_id
  WHERE b.scope_id <> b.project_id AND b.scope_id NOT IN (SELECT id FROM census_r)
  UNION
  SELECT r.project_id, r.scope_id, i.id, r.through_r OR i.id IN (SELECT id FROM census_r)
  FROM reach r
  JOIN edges e ON e.project_id = r.project_id AND e.source = r.id
  JOIN wf_instances i ON i.id = e.target AND i.project_id = r.project_id
)
SELECT project_id, scope_id, id, bool_and(through_r) AS only_through_r
FROM reach GROUP BY project_id, scope_id, id;
CREATE TEMP TABLE census_budget_status AS
WITH measured AS (
  SELECT b.project_id, b.scope_id, phase.after, b.max_wall_ms, b.max_cost_micros, b.max_tokens,
    count(u.session_id) AS sessions, count(u.reported_at) AS reported,
    COALESCE(sum(u.wall_ms), 0) AS wall_ms,
    COALESCE(sum(u.input_tokens), 0) + COALESCE(sum(u.output_tokens), 0) AS tokens,
    COALESCE(sum(u.cost_micros), 0) AS cost_micros
  FROM session_budgets b
  CROSS JOIN (VALUES (false), (true)) AS phase(after)
  LEFT JOIN session_usage u ON u.project_id = b.project_id
    AND NOT (phase.after AND u.session_id IN (SELECT id FROM census_s))
    AND (b.scope_id = b.project_id OR EXISTS (SELECT 1 FROM census_budget_reach c
      WHERE c.project_id = b.project_id AND c.scope_id = b.scope_id AND c.id = u.instance_id
        AND NOT (phase.after AND c.only_through_r)))
  WHERE b.scope_id NOT IN (SELECT id FROM census_r)
  GROUP BY b.project_id, b.scope_id, phase.after, b.max_wall_ms, b.max_cost_micros, b.max_tokens
),
served AS (
  SELECT b.project_id, b.scope_id, COALESCE(sum(w.wall_ms), 0) AS wall_ms
  FROM session_budgets b
  LEFT JOIN session_service_work w ON w.project_id = b.project_id AND w.settled_at IS NOT NULL
    AND (b.scope_id = b.project_id OR w.sponsors_json::jsonb ? b.scope_id)
  GROUP BY b.project_id, b.scope_id
)
SELECT m.project_id, m.scope_id, m.after,
  concat_ws(',',
    CASE WHEN m.max_wall_ms IS NOT NULL AND m.wall_ms + s.wall_ms >= m.max_wall_ms THEN 'wall' END,
    CASE WHEN m.max_cost_micros IS NOT NULL AND m.cost_micros >= m.max_cost_micros THEN 'cost' END,
    CASE WHEN m.max_tokens IS NOT NULL AND m.tokens >= m.max_tokens THEN 'tokens' END) AS exceeded,
  concat_ws(',',
    CASE WHEN m.sessions > m.reported AND m.max_cost_micros IS NOT NULL
      AND m.cost_micros < m.max_cost_micros THEN 'cost' END,
    CASE WHEN m.sessions > m.reported AND m.max_tokens IS NOT NULL
      AND m.tokens < m.max_tokens THEN 'tokens' END) AS unavailable
FROM measured m JOIN served s ON s.project_id = m.project_id AND s.scope_id = m.scope_id;

-- C12
SELECT 'C12' AS census, b.project_id, b.scope_id,
  CASE WHEN b.scope_id = b.project_id THEN 'project' ELSE 'instance' END AS kind,
  b.exceeded AS exceeded_before, a.exceeded AS exceeded_after,
  b.unavailable AS unavailable_before, a.unavailable AS unavailable_after
FROM census_budget_status b
JOIN census_budget_status a ON a.project_id = b.project_id AND a.scope_id = b.scope_id AND a.after
WHERE NOT b.after AND (a.exceeded, a.unavailable) IS DISTINCT FROM (b.exceeded, b.unavailable)
ORDER BY b.project_id, b.scope_id;

-- C13
SELECT 'C13' AS census, c.id AS consumer, c.cursor, h.head, c.attempts, c.error
FROM event_consumers c CROSS JOIN (SELECT COALESCE(max(id), 0) AS head FROM events) h
WHERE c.cursor < h.head
ORDER BY c.id;

-- C14 (NULL before sessions@7 created the table)
SELECT 'C14' AS census, 'managed runners bound to a session of a retired experiment.plan task' AS selector,
  pg_temp.census_count('SELECT count(*) FROM session_managed_runners r JOIN worker_sessions s ON s.id = r.bound_session_id
    WHERE s.instance_id IN (SELECT id FROM wf_retired_instances WHERE reason = ''recipe_experiment.plan_2'')') AS must_be_0;

ROLLBACK;
