/**
 * A database as production held it before the 2026-09-22 retirement: one instance of every
 * workflow version that can no longer start, every edge case the ledger names, a row in every
 * table a retirement migration deletes from (the no-delete guarded ones included), the retired
 * Consolidation plugin's tables, Knowledge's snapshots, survivors of the same shape on every
 * live version, and the records the release keeps although they name a retired instance
 * (KEPT_TABLES). Rows are written directly: no current code can create a retired record.
 *
 * Retired ids start with `r-`, survivors with `l-`, and no id is a substring of another, so a
 * row names a retired instance exactly when its text contains one of RETIRED's ids.
 */
import type pg from 'pg';
import { digest } from '@merv/contracts';

/** The component migrations that retire the versions, as each owning component registers it. */
export const retirementMigrations = [
  ['workflows', 7],
  ['sessions', 6],
  ['tasks', 8],
  ['reviews', 10],
  ['context_builder', 2],
  ['experiments', 4],
  ['experiment_program', 3],
  ['reflections', 2],
  ['research', 7],
  ['knowledge', 2],
  // The 2026-09-25 retirement of the experiment.plan task type.
  ['workflows', 8],
  ['sessions', 9],
  ['tasks', 9],
  ['reviews', 12],
  ['context_builder', 3],
] as const;

/**
 * The retired Consolidation plugin's PostgreSQL migrations exactly as `b0b1fa62^` published them
 * (packages/consolidation/src/index.postgres.ts): production still holds their tables.
 */
export const consolidationMigrations: Record<1 | 2, string> = {
  1: `
CREATE TABLE consolidations (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record TEXT NOT NULL, review_id TEXT, completion TEXT);
CREATE OR REPLACE FUNCTION consolidation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation inputs are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_identity BEFORE UPDATE OF id,project_id,record ON consolidations
FOR EACH ROW EXECUTE FUNCTION consolidation_identity_guard();
CREATE OR REPLACE FUNCTION consolidation_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.completion IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Reviewed consolidation is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_completion BEFORE UPDATE OF completion ON consolidations
FOR EACH ROW EXECUTE FUNCTION consolidation_completion_guard();
CREATE OR REPLACE FUNCTION consolidation_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidations are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER consolidation_retained BEFORE DELETE ON consolidations
FOR EACH ROW EXECUTE FUNCTION consolidation_retained_guard();
CREATE TABLE consolidation_submissions (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, revision BIGINT NOT NULL, record TEXT NOT NULL, UNIQUE(instance_id,revision));
CREATE OR REPLACE FUNCTION consolidation_submission_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation submissions are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_submission_immutable BEFORE UPDATE ON consolidation_submissions
FOR EACH ROW EXECUTE FUNCTION consolidation_submission_immutable_guard();
CREATE OR REPLACE FUNCTION consolidation_submission_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation submissions are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER consolidation_submission_retained BEFORE DELETE ON consolidation_submissions
FOR EACH ROW EXECUTE FUNCTION consolidation_submission_retained_guard();
CREATE TABLE consolidation_commands (project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(project_id,actor_id,request_id));
CREATE TABLE consolidation_leases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL, revision BIGINT NOT NULL, actor_id TEXT NOT NULL, review_id TEXT, claim_id TEXT, receipt TEXT NOT NULL, artifacts TEXT NOT NULL, inputs TEXT NOT NULL, released_at TEXT);
CREATE UNIQUE INDEX consolidation_lease_active ON consolidation_leases(instance_id,revision) WHERE released_at IS NULL;
CREATE OR REPLACE FUNCTION consolidation_lease_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation ownership is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_lease_immutable BEFORE UPDATE OF id,project_id,instance_id,revision,actor_id,review_id,claim_id,receipt,artifacts,inputs ON consolidation_leases
FOR EACH ROW EXECUTE FUNCTION consolidation_lease_immutable_guard();
CREATE OR REPLACE FUNCTION consolidation_lease_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Consolidation leases are retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER consolidation_lease_retained BEFORE DELETE ON consolidation_leases
FOR EACH ROW EXECUTE FUNCTION consolidation_lease_retained_guard();
`,
  2: `
ALTER TABLE consolidations ADD COLUMN decisions TEXT;
CREATE FUNCTION consolidation_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.decisions IS NOT NULL AND NEW.decisions IS DISTINCT FROM OLD.decisions THEN
    RAISE EXCEPTION USING MESSAGE = 'Consolidation decisions are immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER consolidation_decisions BEFORE UPDATE OF decisions ON consolidations
FOR EACH ROW EXECUTE FUNCTION consolidation_decisions_guard();
`,
};

/** Workflow versions no current flow can start. Their definitions and policies are kept. */
export const retiredVersions: [workflow: string, version: number][] = [
  ['task', 1],
  ...[1, 2, 3, 4].map((v): [string, number] => ['experiment', v]),
  ['reflection', 1],
  ['reflection', 2],
  ['reflection.lens', 1],
  ...[2, 3, 4, 5].map((v): [string, number] => ['research', v]),
  ...[1, 2, 3, 4, 5].map((v): [string, number] => ['consolidation', v]),
];
/** Recipes that can no longer be selected; their pinned rows are kept as documentation. */
export const retiredRecipes: [type: string, version: number][] = [
  ['experiment.plan', 1],
  ['experiment.plan', 2],
  ['reflection.synthesis', 7],
  ['reflection.review', 7],
];

type Place = 'live' | 'history';
interface Instance {
  id: string;
  /** `live` is the project the test also works in after the release; `history` holds the rest. */
  place: Place;
  workflow: string;
  version: number;
  state: string;
  task?: { type: string; version: number; evidence: 1 | 2 };
  /** The wave a lens belongs to. */
  wave?: string;
  /** A wave still open (no approval), which holds the project's one open-wave slot. */
  open?: boolean;
  research?: { reflection?: string; predecessor?: string; root?: string; index?: number };
}

const task = (type: string, version: number, evidence: 1 | 2 = 2) => ({ type, version, evidence });
/** Every instance whose version can no longer start, with the reason the ledger must record. */
export const RETIRED: (Instance & { reason: string })[] = [
  {
    id: 'r-task1',
    place: 'history',
    workflow: 'task',
    version: 1,
    state: 'in_progress',
    task: task('task.work', 1),
    reason: 'retired_version',
  },
  {
    id: 'r-taskup',
    place: 'history',
    workflow: 'task',
    version: 2,
    state: 'in_progress',
    task: task('task.work', 2),
    reason: 'upgraded_from_task_1',
  },
  {
    id: 'r-taskev1',
    place: 'history',
    workflow: 'task',
    version: 2,
    state: 'in_review',
    task: task('task.work', 2, 1),
    reason: 'task_evidence_1',
  },
  {
    id: 'r-plan1',
    place: 'history',
    workflow: 'task',
    version: 2,
    state: 'in_progress',
    task: task('experiment.plan', 1),
    reason: 'recipe_experiment.plan_1',
  },
  // Retired on 2026-09-25 with the type: Experiments plans its own designs.
  {
    id: 'r-plan2',
    place: 'history',
    workflow: 'task',
    version: 2,
    state: 'done',
    task: task('experiment.plan', 2),
    reason: 'recipe_experiment.plan_2',
  },
  ...[1, 2, 3, 4].map((version) => ({
    id: `r-exp${version}`,
    // The live project's task depends on experiment@3.
    place: (version === 3 ? 'live' : 'history') as Place,
    workflow: 'experiment',
    version,
    state: version === 1 ? 'running' : 'planned',
    reason: 'retired_version',
  })),
  {
    id: 'r-wave1',
    place: 'history',
    workflow: 'reflection',
    version: 1,
    state: 'approved',
    reason: 'retired_version',
  },
  {
    id: 'r-lens1',
    place: 'history',
    workflow: 'reflection.lens',
    version: 1,
    state: 'complete',
    wave: 'r-wave1',
    reason: 'retired_version',
  },
  // An open retired wave holds the live project's only open-wave slot until it is deleted.
  {
    id: 'r-wave2',
    place: 'live',
    workflow: 'reflection',
    version: 2,
    state: 'reflecting',
    open: true,
    reason: 'retired_version',
  },
  {
    id: 'r-lens2',
    place: 'live',
    workflow: 'reflection.lens',
    version: 2,
    state: 'reflecting',
    wave: 'r-wave2',
    reason: 'lens_of_retired_wave',
  },
  ...[2, 3, 4].map((version) => ({
    id: `r-res${version}`,
    place: 'history' as Place,
    workflow: 'research',
    version,
    state: 'complete',
    research: {},
    reason: 'retired_version',
  })),
  {
    id: 'r-res5',
    place: 'history',
    workflow: 'research',
    version: 5,
    state: 'reflecting',
    research: { reflection: 'r-stage', root: 'r-res5', index: 0 },
    reason: 'retired_version',
  },
  {
    id: 'r-stage',
    place: 'history',
    workflow: 'reflection',
    version: 3,
    state: 'reflecting',
    open: true,
    reason: 'stage_of_retired_research',
  },
  {
    id: 'r-stlens',
    place: 'history',
    workflow: 'reflection.lens',
    version: 2,
    state: 'reflecting',
    wave: 'r-stage',
    reason: 'lens_of_retired_wave',
  },
  {
    id: 'r-cons',
    place: 'history',
    workflow: 'consolidation',
    version: 5,
    state: 'consolidating',
    reason: 'retired_version',
  },
];

/**
 * Records the release keeps although they name a retired instance (plan §1, §11 C6): Code
 * lineage and code-research rows, service work, paper history and feed posts. seedRetirement
 * writes one of each; the release must leave them byte for byte.
 */
export const KEPT_TABLES = [
  'code_units',
  'code_edges',
  'code_proposals',
  'code_commands',
  'session_service_work',
  'paper_proposals',
  'feed_posts',
];

/** Ended records of the same shape on every live version, which the release must not touch. */
export const SURVIVORS: Instance[] = [
  ...[2, 3, 4, 5, 6].map((version) => ({
    id: `l-task${version}`,
    place: 'history' as Place,
    workflow: 'task',
    version,
    state: 'done',
    task: task('task.work', 2),
  })),
  // Chosen by an explicit typeVersion 1, which stays live.
  {
    id: 'l-work1',
    place: 'history',
    workflow: 'task',
    version: 2,
    state: 'done',
    task: task('task.work', 1),
  },
  ...[5, 6, 7, 8].map((version) => ({
    id: `l-exp${version}`,
    place: 'history' as Place,
    workflow: 'experiment',
    version,
    state: 'complete',
  })),
  { id: 'l-wave3', place: 'history', workflow: 'reflection', version: 3, state: 'approved' },
  {
    id: 'l-lens3',
    place: 'history',
    workflow: 'reflection.lens',
    version: 2,
    state: 'complete',
    wave: 'l-wave3',
  },
  // Follows the retired research@5 cycle and belongs to its automatic run: research@7 forgets
  // the predecessor and re-roots the run at this cycle.
  {
    id: 'l-res6',
    place: 'history',
    workflow: 'research',
    version: 6,
    state: 'complete',
    research: { reflection: 'l-wave3', predecessor: 'r-res5', root: 'r-res5', index: 1 },
  },
];

/** A task that depends on a retired experiment, when the test has no live one of its own. */
const standInDependent: Instance = {
  id: 'l-dep',
  place: 'live',
  workflow: 'task',
  version: 2,
  state: 'done',
  task: task('task.work', 2),
};

export interface Seed {
  live: { projectId: string; actorId: string };
  history: { projectId: string; actorId: string };
  /** A real task in the live project that is made to depend on retired experiment@3. */
  dependentTaskId?: string;
}

export const at = '2026-09-10T00:00:00.000Z';
const json = (value: unknown) => JSON.stringify(value);

/** Inserts one row, JSON-encoding object values; an events row answers with its id. */
export async function insert(client: pg.Client, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  const values = columns.map((column) => {
    const value = row[column];
    return value !== null && typeof value === 'object' ? json(value) : value;
  });
  const result = await client.query(
    `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})${table === 'events' ? ' RETURNING id' : ''}`,
    values,
  );
  return result.rows[0] as { id: string } | undefined;
}

/**
 * Rewinds a booted schema to the release before the retirement, then writes the fixture.
 * The caller must have stopped the app that booted it.
 */
export async function seedRetirement(client: pg.Client, seed: Seed): Promise<void> {
  await client.query('BEGIN');
  try {
    const managed = await client.query(
      'SELECT count(*)::integer AS count FROM session_managed_runners',
    );
    if (managed.rows[0].count !== 0)
      throw new Error('Cannot rewind a fixture with managed runners');
    await client.query('DROP TABLE session_managed_runners');
    await client.query(
      "DELETE FROM component_migrations WHERE component='sessions' AND version IN (7,8)",
    );
    // reflections@3 (a wave can be abandoned) came after the retirement too.
    await client.query('ALTER TABLE reflections DROP COLUMN abandoned');
    await client.query(
      'CREATE UNIQUE INDEX reflection_open_project ON reflections(project_id) WHERE approved IS NULL',
    );
    await client.query(
      "DELETE FROM component_migrations WHERE component='reflections' AND version=3",
    );
    // So did reviews@11 (the owner override): version 1's check and version 7's claim guard return.
    await client.query(`ALTER TABLE reviews DROP COLUMN owner_override CASCADE;
ALTER TABLE reviews ADD CHECK(reviewer_id IS NULL OR reviewer_id != producer_id);
CREATE OR REPLACE FUNCTION reviews_contributors_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.reviewer_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NEW.excluded_actor_ids,'[]')::jsonb) AS excluded(value) WHERE value=NEW.reviewer_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'A contributor cannot review their submission', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_contributors_claim BEFORE UPDATE OF reviewer_id ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_contributors_claim_guard();
DELETE FROM component_migrations WHERE component='reviews' AND version=11;`);
    await client.query(
      `DELETE FROM component_migrations WHERE ${retirementMigrations
        .map(([component, version]) => `(component='${component}' AND version=${version})`)
        .join(' OR ')}`,
    );
    await client.query('DROP TABLE wf_retired_instances');
    for (const version of [1, 2] as const) {
      await client.query(consolidationMigrations[version]);
      await insert(client, 'component_migrations', {
        component: 'consolidation',
        version,
        hash: digest(consolidationMigrations[version]),
      });
    }
    for (const [name, version] of retiredVersions) {
      await client.query(
        `INSERT INTO wf_definitions(name,version,fingerprint,definition_json,created_at)
         VALUES($1,$2,$3,'{}',$4) ON CONFLICT DO NOTHING`,
        [name, version, `fixture-${name}-${version}`, at],
      );
      await client.query(
        `INSERT INTO wf_success_states(workflow,version,success_json) VALUES($1,$2,'[]')
         ON CONFLICT DO NOTHING`,
        [name, version],
      );
    }
    await client.query(
      `INSERT INTO wf_execution_policies(workflow,version,state,fingerprint,manifest_json)
       VALUES('experiment',1,'planned','fixture-policy','{}') ON CONFLICT DO NOTHING`,
    );
    for (const [type, version] of retiredRecipes)
      await client.query(
        `INSERT INTO context_recipes(type,version,hash,definition) VALUES($1,$2,$3,'{}')
         ON CONFLICT DO NOTHING`,
        [type, version, `fixture-${type}-${version}`],
      );

    const runner = 'l-runner';
    await insert(client, 'session_runners', {
      id: runner,
      project_id: seed.history.projectId,
      owner_hash: 'fixture-owner',
      runner_id: 'fixture-runner',
      source_json: {},
      presence_json: {},
      settings_json: {},
      last_seen_at: at,
    });
    const instances = [
      ...RETIRED,
      ...SURVIVORS,
      ...(seed.dependentTaskId ? [] : [standInDependent]),
    ];
    for (const instance of instances) await instanceRows(client, seed, instance, runner);
    // Automatic runs name cycles by foreign key, so they go in once every cycle exists.
    for (const i of instances)
      if (i.research?.root)
        await insert(client, 'research_automation', {
          research_id: i.id,
          project_id: seed[i.place].projectId,
          source_json: {},
          root_id: i.research.root,
          cycle_index: i.research.index ?? 0,
          max_cycles: 10,
        });

    // A live task waiting on retired experiment@3: the release deletes the edge.
    const dependent = seed.dependentTaskId ?? standInDependent.id;
    for (const [source, target, workflow, version] of [
      [dependent, 'r-exp3', 'experiment', 3],
      ['l-task3', 'l-task2', 'task', 2],
    ] as const)
      await insert(client, 'wf_dependencies', {
        project_id: source === dependent ? seed.live.projectId : seed.history.projectId,
        source_id: source,
        target_id: target,
        target_workflow: workflow,
        target_version: version,
        target_success_json: workflow === 'task' ? ['done'] : ['complete'],
        target_terminal_json:
          workflow === 'task' ? ['done', 'failed'] : ['abandoned', 'complete', 'failed'],
        created_at: at,
        kind: 'declared',
        owner: '',
      });
    // Task@1 instances that markFailed upgraded read version 2 but are still retired.
    await insert(client, 'wf_history', {
      instance_id: 'r-taskup',
      project_id: seed.history.projectId,
      revision: 2,
      action: 'upgrade',
      actor_id: seed.history.actorId,
      request_id: 'upgrade-r-taskup',
      from_state: 'in_progress',
      to_state: 'in_progress',
      data_json: {},
      created_at: at,
    });
    // Format 1 was reached only by omission; one survives only on a retired subject.
    await review(client, seed.history, 'v1-r-task1', 'r-task1', 1);
    // Graph evidence exists only on experiment@1-2.
    await insert(client, 'experiment_evidence', {
      id: 'e-graph-r-exp1',
      experiment_id: 'r-exp1',
      attempt_index: 1,
      role: 'graph',
      path: 'graph.json',
      sequence: 2,
      record: { role: 'graph', experimentId: 'r-exp1' },
    });

    const { projectId, actorId } = seed.history;
    await insert(client, 'consolidations', {
      id: 'r-cons',
      project_id: projectId,
      record: { id: 'r-cons' },
      decisions: [],
    });
    await insert(client, 'consolidation_submissions', {
      id: 'cs-r-cons',
      instance_id: 'r-cons',
      revision: 1,
      record: {},
    });
    await insert(client, 'consolidation_commands', {
      project_id: projectId,
      actor_id: actorId,
      request_id: 'cc-r-cons',
      input_hash: 'hash',
      result: { id: 'r-cons' },
    });
    await insert(client, 'consolidation_leases', {
      id: 'cl-r-cons',
      project_id: projectId,
      instance_id: 'r-cons',
      revision: 1,
      actor_id: actorId,
      receipt: {},
      artifacts: [],
      inputs: {},
      released_at: at,
    });
    // A close logged before the release but not yet consumed, of a session sessions@6 deletes.
    await insert(client, 'events', {
      project_id: projectId,
      actor_id: actorId,
      type: 'session.closed',
      subject_id: 's-r-task1',
      data_json: {},
      created_at: at,
    });
    // The history project's usage exceeds this budget only while the retired sessions count:
    // 30 sessions of 1 ms and 5 ms of service work before the release, 14 and 5 after it.
    await insert(client, 'session_budgets', {
      project_id: projectId,
      scope_id: projectId,
      max_wall_ms: 20,
      updated_at: at,
      updated_by: actorId,
    });
    await keptRows(client, seed.history);
    // Only the retired reflection@1 corpus capture wrote these.
    await insert(client, 'knowledge_snapshots', {
      id: 'k-snapshot',
      project_id: projectId,
      created_by: actorId,
      created_at: at,
      format_version: 1,
      manifest_hash: 'hash',
      record: {},
    });
    await insert(client, 'knowledge_commands', {
      project_id: projectId,
      actor_id: actorId,
      request_id: 'k-request',
      input_hash: 'hash',
      snapshot_id: 'k-snapshot',
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** One kept record of each kind named in KEPT_TABLES, each naming a retired instance. */
async function keptRows(client: pg.Client, { projectId, actorId }: Seed['history']) {
  // Accepted Git work of retired experiment@4, and a survivor's base on that acceptance.
  await insert(client, 'code_units', {
    project_id: projectId,
    unit_id: 'r-exp4',
    workflow: 'experiment',
    version: 4,
    declared_at: at,
    acceptance_json: { code: { commit: 'a'.repeat(40) }, storage: 'code' },
    acceptance_hash: 'hash',
    accepted_at: at,
  });
  await insert(client, 'code_edges', {
    project_id: projectId,
    source_ref: 'unit:l-task4',
    relation: 'based_on',
    target_ref: 'acceptance:r-exp4@1',
    created_at: at,
  });
  await insert(client, 'code_proposals', {
    id: 'cp-r-exp4',
    project_id: projectId,
    instance_id: 'r-exp4',
    revision: 1,
    session_id: 's-r-exp4',
    request_id: 'proposal-r-exp4',
    input_hash: 'hash',
    proposal_json: { instanceId: 'r-exp4' },
  });
  await insert(client, 'code_commands', {
    id: 'cc-r-exp4',
    project_id: projectId,
    session_id: 's-r-exp4',
    actor_id: actorId,
    request_id: 'command-r-exp4',
    input_hash: 'hash',
    command_json: {},
    status: 'cancelled',
    error: 'fixture',
  });
  // Server work sponsored by a retired cycle and by its surviving successor.
  await insert(client, 'session_service_work', {
    provider: 'fixture',
    operation_id: 'op-r-res5',
    execution_epoch: 1,
    project_id: projectId,
    sponsors_json: ['r-res5', 'l-res6'],
    input_hash: 'hash',
    started_at: at,
    deadline: '2026-09-10T01:00:00.000Z',
    settled_at: at,
    outcome: 'completed',
    wall_ms: 5,
  });
  await insert(client, 'paper_proposals', {
    id: 'pp-r-exp1',
    project_id: projectId,
    record: { source: { kind: 'experiment', id: 'r-exp1' } },
  });
  await insert(client, 'feed_posts', {
    id: 'f-r-task1',
    project_id: projectId,
    author_id: actorId,
    body: 'Closed r-task1.',
    artifact_ids: [],
    created_at: at,
  });
}

async function review(
  client: pg.Client,
  { projectId, actorId }: Seed['live'],
  id: string,
  subject: string,
  formatVersion: 1 | 2 = 2,
) {
  await insert(client, 'reviews', {
    id,
    project_id: projectId,
    subject_id: subject,
    subject_revision: 1,
    producer_id: actorId,
    artifact_ids: [],
    criteria: ['The work is complete.'],
    manifest: {},
    snapshot_hash: `hash-${id}`,
    status: 'requested',
    created_at: at,
    format_version: formatVersion,
    administrative_actor_id: actorId,
    pinned_input_ids: [],
  });
  await insert(client, 'review_commands', {
    project_id: projectId,
    actor_id: actorId,
    request_id: `request-${id}`,
    operation: 'request',
    input_hash: 'hash',
    result: { id, subjectId: subject },
  });
}

/** One instance with a row in every table keyed by it, as its family writes them. */
async function instanceRows(client: pg.Client, seed: Seed, i: Instance, runner: string) {
  const owner = seed[i.place];
  const { projectId, actorId } = owner;
  const project = { project_id: projectId };
  await insert(client, 'wf_instances', {
    id: i.id,
    ...project,
    workflow: i.workflow,
    version: i.version,
    state: i.state,
    revision: 1,
    data_json: i.wave ? { reflectionId: i.wave } : {},
    created_at: at,
    updated_at: at,
  });
  await insert(client, 'wf_history', {
    instance_id: i.id,
    ...project,
    revision: 1,
    action: 'start',
    actor_id: actorId,
    request_id: `start-${i.id}`,
    from_state: null,
    to_state: i.state,
    data_json: {},
    created_at: at,
  });
  await insert(client, 'wf_requests', {
    ...project,
    request_id: `start-${i.id}`,
    fingerprint: 'hash',
    response_json: { id: i.id, workflow: i.workflow, version: i.version },
  });
  await insert(client, 'wf_system_requests', {
    ...project,
    provider: 'fixture',
    request_id: `system-${i.id}`,
    fingerprint: { instanceId: i.id },
  });
  await insert(client, 'wf_blockers', {
    ...project,
    instance_id: i.id,
    provider: 'fixture',
    blocker_key: 'held',
    code: 'fixture_held',
    message: 'Held by the fixture.',
    status: 409,
    next: 'Wait.',
    related_json: [],
    since: at,
    updated_at: at,
  });
  await insert(client, 'wf_limit_grants', {
    ...project,
    request_id: `grant-${i.id}`,
    instance_id: i.id,
    limit_name: 'rounds',
    additional: 1,
    reason: 'Fixture allowance.',
    actor_id: actorId,
    created_at: at,
  });
  // Events are the audit log: the release keeps every one, retired subjects included.
  const event = await insert(client, 'events', {
    ...project,
    actor_id: actorId,
    type: 'fixture.history',
    subject_id: i.id,
    data_json: {},
    created_at: at,
  });
  await insert(client, 'wf_work_starts', {
    instance_id: i.id,
    ...project,
    workflow: i.workflow,
    version: i.version,
    state: i.state,
    revision: 1,
    actor_id: actorId,
    started_at: at,
    event_id: event!.id,
  });

  const session = `s-${i.id}`;
  await insert(client, 'worker_sessions', {
    id: session,
    ...project,
    actor_id: actorId,
    instance_id: i.id,
    revision: 1,
    owner_hash: 'fixture-owner',
    runner_id: 'fixture-runner',
    request_id: session,
    token_hash: `token-${i.id}`,
    fingerprint: 'hash',
    status: 'released',
    session_json: {},
  });
  await insert(client, 'session_tool_calls', {
    id: `call-${i.id}`,
    execution_id: session,
    tool: 'workflow.assignment',
    status: 'succeeded',
    started_at: at,
    input_tokens: 1,
  });
  await insert(client, 'session_dispatch_receipts', {
    owner_hash: 'fixture-owner',
    runner_id: 'fixture-runner',
    request_id: `dispatch-${i.id}`,
    fingerprint: 'hash',
    session_id: session,
    runner_ref: runner,
    platform_json: {},
  });
  await insert(client, 'session_dispatch_holds', {
    ...project,
    instance_id: i.id,
    revision: 1,
    attempts: 1,
    last_code: 'fixture_held',
    last_message: 'Held by the fixture.',
    last_session_id: session,
    first_at: at,
    last_at: at,
  });
  await insert(client, 'session_hold_requests', {
    ...project,
    actor_id: actorId,
    request_id: `hold-${i.id}`,
    input_hash: 'hash',
    result: { instanceId: i.id },
  });
  await insert(client, 'session_budgets', {
    ...project,
    scope_id: i.id,
    max_tokens: 1000,
    updated_at: at,
    updated_by: actorId,
  });
  await insert(client, 'session_workspaces', {
    session_id: session,
    attachment_json: {},
    result_json: {},
  });
  await insert(client, 'session_usage', {
    session_id: session,
    ...project,
    instance_id: i.id,
    revision: 1,
    workflow: i.workflow,
    state: i.state,
    role: 'producer',
    outcome: 'released',
    closed_at: at,
    wall_ms: 1,
  });
  await review(client, owner, `v-${i.id}`, i.id);
  await insert(client, 'context_packages', {
    id: `c-${i.id}`,
    ...project,
    actor_id: actorId,
    request_id: `context-${i.id}`,
    input_hash: 'hash',
    package: { subject: { id: i.id, revision: 1 } },
  });

  if (i.task) {
    await insert(client, 'tasks', {
      id: i.id,
      ...project,
      title: i.id,
      goal: 'Fixture goal.',
      checks: ['It works.'],
      producer_id: actorId,
      brief_id: `brief-${i.id}`,
      created_at: at,
      type_name: i.task.type,
      type_version: i.task.version,
      context_inputs: {},
      evidence_version: i.task.evidence,
    });
    await insert(client, 'task_leases', {
      id: `tl-${i.id}`,
      ...project,
      task_id: i.id,
      revision: 1,
      actor_id: actorId,
      source_actor_id: actorId,
      purpose: 'work',
      receipt: {},
      pinned_artifacts: [],
      checkpoints: [],
      released_at: at,
    });
    await insert(client, 'task_checkpoints', {
      id: `tc-${i.id}`,
      ...project,
      task_id: i.id,
      purpose: 'work',
      revision: 1,
      checkpoint: {},
    });
    for (const [key, result] of [
      ['id', { id: i.id }],
      ['taskId', { taskId: i.id }],
    ] as const)
      await insert(client, 'task_commands', {
        ...project,
        actor_id: actorId,
        request_id: `task-${key}-${i.id}`,
        operation: 'create',
        input_hash: 'hash',
        result,
      });
  }

  if (i.workflow === 'experiment') {
    await insert(client, 'experiments', {
      id: i.id,
      ...project,
      name: i.id,
      intent: 'Fixture intent.',
      details: '',
      owner_id: actorId,
      created_by: actorId,
      created_at: at,
      tested_claim_ids: [],
      attempt_index: 1,
      review_id: `v-${i.id}`,
      workspace: [2, 4, 6, 7, 8].includes(i.version) ? 'git' : 'none',
    });
    await insert(client, 'experiment_attempts', {
      experiment_id: i.id,
      attempt_index: 1,
      started_revision: 0,
      feedback: [],
      feedback_review_ids: [],
      created_at: at,
    });
    await insert(client, 'experiment_evidence', {
      id: `e-${i.id}`,
      experiment_id: i.id,
      attempt_index: 1,
      role: 'plan',
      path: 'plan.md',
      sequence: 1,
      record: { role: 'plan', experimentId: i.id },
    });
    await insert(client, 'experiment_slots', {
      experiment_id: i.id,
      attempt_index: 1,
      role: 'plan',
      path: 'plan.md',
      evidence_id: `e-${i.id}`,
    });
    await insert(client, 'experiment_submissions', {
      id: `es-${i.id}`,
      experiment_id: i.id,
      attempt_index: 1,
      stage: 'design',
      round: 1,
      review_id: `v-${i.id}`,
      record: { experimentId: i.id },
    });
    for (const [key, result] of [
      ['id', { id: i.id }],
      ['experimentId', { id: `e-${i.id}`, experimentId: i.id }],
    ] as const)
      await insert(client, 'experiment_commands', {
        ...project,
        actor_id: actorId,
        request_id: `experiment-${key}-${i.id}`,
        input_hash: 'hash',
        result,
      });
    await insert(client, 'experiment_leases', {
      id: `el-${i.id}`,
      ...project,
      experiment_id: i.id,
      revision: 1,
      attempt_index: 1,
      state: 'planned',
      actor_id: actorId,
      source_actor_id: actorId,
      receipt: {},
      artifacts: [],
      recovery: [],
      inputs: {},
      released_at: at,
    });
  }

  if (i.workflow === 'reflection') {
    await insert(client, 'reflections', {
      id: i.id,
      ...project,
      title: i.id,
      owner_id: actorId,
      created_at: at,
      attempt: 1,
      corpus: {},
      paper: {},
      approved: i.open ? null : { at },
      feedback: [],
    });
    await insert(client, 'reflection_leases', {
      id: `rl-${i.id}`,
      ...project,
      instance_id: i.id,
      revision: 1,
      actor_id: actorId,
      receipt: {},
      inputs: {},
      artifacts: [],
      released_at: at,
    });
    await insert(client, 'reflection_commands', {
      ...project,
      actor_id: actorId,
      request_id: `reflection-${i.id}`,
      fingerprint: 'hash',
      result: { id: i.id },
    });
  }
  if (i.wave)
    await insert(client, 'reflection_lenses', {
      id: i.id,
      ...project,
      reflection_id: i.wave,
      attempt: 1,
      perspective: i.id,
      instructions: 'Fixture lens.',
    });

  if (i.research) {
    await insert(client, 'research_cycles', {
      id: i.id,
      ...project,
      record: {},
      reflection_id: i.research.reflection ?? null,
      predecessor_id: i.research.predecessor ?? null,
    });
    await insert(client, 'research_commands', {
      ...project,
      actor_id: actorId,
      request_id: `research-${i.id}`,
      input_hash: 'hash',
      result: { id: i.id },
    });
  }
}
