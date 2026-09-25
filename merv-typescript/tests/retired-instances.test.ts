import assert from 'node:assert/strict';
import test from 'node:test';
import type { PostgresState } from '@merv/state';
import {
  retiredInstancesSql,
  retiredPlanTasksSql,
  withoutTriggers,
} from '@merv/contracts/retired-instances';
import { postgresMigrations as research } from '../packages/research/src/index.postgres.js';
import { postgresMigrations as tasks } from '../packages/tasks/src/index.postgres.js';
import { postgresMigrations as workflows } from '../packages/workflows/src/index.postgres.js';
import { openState } from './fixtures/state.js';

/** The tables the ledger reads, as published before any migration embedded it. */
async function migrateInputs(state: PostgresState) {
  for (const [component, texts, last] of [
    ['workflows', workflows, 6],
    ['tasks', tasks, 7],
    ['research', research, 6],
  ] as const)
    await state.migrate(
      component,
      Array.from({ length: last }, (_, index) => ({ version: index + 1, sql: texts[index + 1]! })),
    );
}

/** Each probe is one component migration that embeds the ledger, as a retirement migration does. */
const probe = (state: PostgresState, name: string, sql = retiredInstancesSql) =>
  state.migrate(`ledger_probe_${name}`, [{ version: 1, sql }]);

const ledger = (state: PostgresState) =>
  state.read((sql) =>
    sql.all<{ id: string; workflow: string; version: string; reason: string }>(
      'SELECT id,workflow,version::text AS version,reason FROM wf_retired_instances ORDER BY id',
    ),
  );

const disabledTriggers = (state: PostgresState) =>
  state.read((sql) =>
    sql.all(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND t.tgenabled<>'O'`,
    ),
  );

test('withoutTriggers wraps statements in one DISABLE and ENABLE line per trigger', () => {
  assert.equal(
    withoutTriggers('t', ['a', 'b'], 'DELETE FROM t;'),
    [
      'ALTER TABLE t DISABLE TRIGGER a;',
      'ALTER TABLE t DISABLE TRIGGER b;',
      'DELETE FROM t;',
      'ALTER TABLE t ENABLE TRIGGER a;',
      'ALTER TABLE t ENABLE TRIGGER b;',
    ].join('\n'),
  );
});

test('The retirement ledger is an idempotent no-op on a fresh database', async () => {
  const state = await openState();
  // Before Workflows has migrated, as when reviews or context-builder migrate first.
  await probe(state, 'a');
  await probe(state, 'b');
  assert.deepEqual(await ledger(state), []);
  // With every input table present and empty.
  await migrateInputs(state);
  await probe(state, 'c');
  await probe(
    state,
    'd',
    `${retiredInstancesSql}\n${withoutTriggers(
      'wf_work_starts',
      ['wf_work_starts_no_delete'],
      'DELETE FROM wf_work_starts WHERE instance_id IN (SELECT id FROM wf_retired_instances);',
    )}`,
  );
  assert.deepEqual(await ledger(state), []);
  assert.deepEqual(await disabledTriggers(state), []);
});

test('The experiment.plan retirement is a no-op on a fresh database', async () => {
  const state = await openState();
  await probe(state, 'a', retiredPlanTasksSql);
  await migrateInputs(state);
  await probe(state, 'b', retiredPlanTasksSql);
  assert.deepEqual(await ledger(state), []);
});

test('The experiment.plan retirement refuses a plan task whose session a managed runner holds', async () => {
  const state = await openState();
  await migrateInputs(state);
  await state.transaction(async (tx) => {
    // Only the columns the preconditions read; the real tables are Sessions'. The session is
    // closed, so only the binding refuses.
    await tx.run(
      'CREATE TABLE worker_sessions (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, status TEXT NOT NULL)',
    );
    await tx.run(
      'CREATE TABLE session_managed_runners (allocation_id TEXT PRIMARY KEY, bound_session_id TEXT)',
    );
    await tx.run(
      `INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at,type_name,type_version,evidence_version)
       VALUES('task-plan-2','p','t','g','[]','actor','brief','2026-01-01T00:00:00.000Z','experiment.plan',2,2)`,
    );
    await tx.run("INSERT INTO worker_sessions VALUES('session-1','task-plan-2','closed')");
    await tx.run("INSERT INTO session_managed_runners VALUES('allocation-1','session-1')");
  });
  // State reports every refusal as state_constraint; removing the binding shows which one it was.
  await assert.rejects(probe(state, 'plan', retiredPlanTasksSql), { code: 'state_constraint' });
  // Nothing committed: the ledger the refused migration began does not exist.
  assert.deepEqual(
    await state.read((sql) => sql.all("SELECT to_regclass('wf_retired_instances') AS ledger")),
    [{ ledger: null }],
  );
  await state.transaction(async (tx) => {
    await tx.run('DELETE FROM session_managed_runners');
  });
  await probe(state, 'plan', retiredPlanTasksSql);
  assert.deepEqual(await ledger(state), [
    { id: 'task-plan-2', workflow: 'task', version: '0', reason: 'recipe_experiment.plan_2' },
  ]);
});

test('The retirement ledger records each retired instance once, with its reason', async () => {
  const state = await openState();
  await migrateInputs(state);
  const at = '2026-01-01T00:00:00.000Z';
  const instances: [id: string, workflow: string, version: number, data?: object][] = [
    ['task-v1', 'task', 1],
    ['task-upgraded', 'task', 2],
    ['task-evidence-1', 'task', 2],
    ['task-plan-1', 'task', 2],
    ['task-live', 'task', 2],
    ['task-plan-2', 'task', 2],
    ['experiment-4', 'experiment', 4],
    ['experiment-5', 'experiment', 5],
    ['wave-2', 'reflection', 2],
    ['lens-of-wave-2', 'reflection.lens', 2, { reflectionId: 'wave-2' }],
    ['lens-1', 'reflection.lens', 1, { reflectionId: 'wave-3' }],
    ['research-5', 'research', 5],
    ['stage-of-research-5', 'reflection', 3],
    ['lens-of-stage', 'reflection.lens', 2, { reflectionId: 'stage-of-research-5' }],
    ['research-6', 'research', 6],
    ['wave-3', 'reflection', 3],
    ['lens-of-wave-3', 'reflection.lens', 2, { reflectionId: 'wave-3' }],
    ['consolidation-1', 'consolidation', 1],
  ];
  const definitions = new Map(instances.map(([, w, v]) => [`${w}@${v}`, [w, v] as const]));
  await state.transaction(async (tx) => {
    for (const [name, version] of definitions.values())
      await tx.run(
        `INSERT INTO wf_definitions(name,version,fingerprint,definition_json,created_at)
         VALUES(?,?,'fixture','{}',?)`,
        name,
        version,
        at,
      );
    for (const [id, workflow, version, data = {}] of instances)
      await tx.run(
        `INSERT INTO wf_instances(id,project_id,workflow,version,state,revision,data_json,created_at,updated_at)
         VALUES(?,'p',?,?,'open',1,?,?,?)`,
        id,
        workflow,
        version,
        JSON.stringify(data),
        at,
        at,
      );
    await tx.run(
      `INSERT INTO wf_history(instance_id,project_id,revision,action,actor_id,request_id,from_state,to_state,data_json,created_at)
       VALUES('task-upgraded','p',1,'upgrade','actor','request','open','open','{}',?)`,
      at,
    );
    for (const [id, typeName, typeVersion, evidence] of [
      ['task-evidence-1', 'task.work', 2, 1],
      ['task-plan-1', 'experiment.plan', 1, 2],
      ['task-live', 'task.work', 1, 2],
      ['task-plan-2', 'experiment.plan', 2, 2],
    ] as const)
      await tx.run(
        `INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at,type_name,type_version,evidence_version)
         VALUES(?,'p','t','g','[]','actor','brief',?,?,?,?)`,
        id,
        at,
        typeName,
        typeVersion,
        evidence,
      );
    for (const [id, reflection] of [
      ['research-5', 'stage-of-research-5'],
      ['research-6', 'wave-3'],
    ])
      await tx.run(
        `INSERT INTO research_cycles(id,project_id,record,reflection_id) VALUES(?,'p','{}',?)`,
        id,
        reflection,
      );
  });

  const expected = [
    ['consolidation-1', 'consolidation', '1', 'retired_version'],
    ['experiment-4', 'experiment', '4', 'retired_version'],
    ['lens-1', 'reflection.lens', '1', 'retired_version'],
    ['lens-of-stage', 'reflection.lens', '2', 'lens_of_retired_wave'],
    ['lens-of-wave-2', 'reflection.lens', '2', 'lens_of_retired_wave'],
    ['research-5', 'research', '5', 'retired_version'],
    ['stage-of-research-5', 'reflection', '3', 'stage_of_retired_research'],
    ['task-evidence-1', 'task', '2', 'task_evidence_1'],
    ['task-plan-1', 'task', '2', 'recipe_experiment.plan_1'],
    ['task-upgraded', 'task', '2', 'upgraded_from_task_1'],
    ['task-v1', 'task', '1', 'retired_version'],
    ['wave-2', 'reflection', '2', 'retired_version'],
  ].map(([id, workflow, version, reason]) => ({ id, workflow, version, reason }));
  await probe(state, 'a');
  assert.deepEqual(await ledger(state), expected);
  await probe(state, 'b');
  assert.deepEqual(await ledger(state), expected);
  // The experiment.plan retirement adds the version 2 task and keeps version 1's first reason.
  const withPlans = [
    ...expected,
    { id: 'task-plan-2', workflow: 'task', version: '2', reason: 'recipe_experiment.plan_2' },
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
  await probe(state, 'plan-a', retiredPlanTasksSql);
  assert.deepEqual(await ledger(state), withPlans);
  await probe(state, 'plan-b', retiredPlanTasksSql);
  assert.deepEqual(await ledger(state), withPlans);
});
