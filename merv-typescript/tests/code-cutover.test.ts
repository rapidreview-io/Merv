import assert from 'node:assert/strict';
import { CODE_DRIVER, NATIVE_CODE_DRIVER } from '@merv/contracts';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { serviceExecution } from '../packages/customer-experiments/src/execution.js';
import { SERVICE_VERSION } from '../packages/customer-experiments/src/program.js';
import { gitCutover, requireGitCutover } from '@merv/code-work/cutover';
import { execution as experimentExecution } from '@merv/experiments/execution-policy';
import { taskExecutionPolicy } from '@merv/tasks/execution-policy';
import { taskVersion } from '@merv/tasks/workflow';
import { programVersion } from '@merv/experiments/program';
import { migration as fleetSchema } from '@merv/fleet/schema';
import { codePublishFixture } from './fixtures/code-publish.js';
import { postgresUrl } from './fixtures/state.js';

test('new workflow policies write plans and isolate reviews while retaining historical published policies', () => {
  assert.equal(programVersion, 45);
  assert.equal(SERVICE_VERSION, 5);
  for (const policy of [experimentExecution('running', 44), serviceExecution(false, 4)])
    assert.equal(policy.workspace?.mode !== 'none' && policy.workspace?.driver, CODE_DRIVER);
  for (const policy of [
    experimentExecution('planned', 45),
    experimentExecution('design_review', 45),
    serviceExecution(false, 5),
    serviceExecution(true, 5),
    taskExecutionPolicy('work', 'code', true, true),
  ])
    assert.equal(policy.workspace?.mode !== 'none' && policy.workspace?.driver, NATIVE_CODE_DRIVER);
  assert.ok(serviceExecution(false, 4).tools.some((tool) => tool.name === 'code.commit'));
  assert.ok(serviceExecution(true, 5).readOnly);
  assert.equal(taskVersion(), 46);
  assert.equal(taskVersion(true), 47);
  assert.equal(experimentExecution('planned', 44).readOnly, true);
  assert.equal(experimentExecution('planned', 45).readOnly, false);
  assert.equal(experimentExecution('planned', 45).workspace?.mode, 'persistent');
  for (const state of ['design_review', 'experiment_review'] as const) {
    const policy = experimentExecution(state, 45);
    assert.equal(policy.readOnly, true);
    assert.ok(policy.workspace && 'base' in policy.workspace);
    assert.equal(policy.workspace.base, 'reference:code');
  }
  for (const policy of [
    serviceExecution(false, 5),
    experimentExecution('planned', 45),
    experimentExecution('running', 45),
    taskExecutionPolicy('work', 'code', true, true),
    taskExecutionPolicy('work', 'resolution', true, true),
  ])
    assert.equal(
      policy.tools.some((tool) =>
        ['code.commit', 'code.merge', 'code.operation'].includes(tool.name),
      ),
      false,
    );
  assert.ok(experimentExecution('running', 44).tools.some((tool) => tool.name === 'code.commit'));
  assert.ok(
    taskExecutionPolicy('work', 'resolution', true).tools.some(
      (tool) => tool.name === 'code.merge',
    ),
  );
});

test('read-only Git cutover preflight blocks unfinished legacy workflows, transfers and writers but retains history', async (t) => {
  const f = await codePublishFixture(t);
  const snapshot = () => f.state.read(gitCutover);
  assert.equal((await snapshot()).ready, true);
  await f.state.transaction(async (tx) => {
    for (const [id, version, state] of [
      ['legacy_open', 44, 'in_review'],
      ['legacy_done', 44, 'done'],
      ['current_open', 46, 'in_progress'],
    ] as const)
      await tx.run(
        "INSERT INTO wf_instances(id,project_id,workflow,version,state,revision,data_json,created_at,updated_at) VALUES(?,?,'task',?,?,1,'{}','now','now')",
        id,
        f.admin.projectId,
        version,
        state,
      );
    for (const version of [4, 5]) {
      await tx.run(
        'INSERT INTO wf_definitions(name,version,definition_json,created_at,fingerprint) VALUES(?,?,?,?,?)',
        'service_experiment',
        version,
        JSON.stringify({ terminal: ['complete', 'failed'] }),
        'now',
        `customer-${version}`,
      );
      await tx.run(
        "INSERT INTO wf_instances(id,project_id,workflow,version,state,revision,data_json,created_at,updated_at) VALUES(?,?,'service_experiment',?,'running',1,'{}','now','now')",
        `customer_${version}`,
        f.admin.projectId,
        version,
      );
    }
    for (const status of ['queued', 'dispatched', 'succeeded'])
      await tx.run(
        `INSERT INTO code_commands(id,project_id,session_id,actor_id,request_id,input_hash,command_json,status,receipt_json)
        VALUES(?,?,?,'fixture',?,'hash','{}',?,?)`,
        `command_${status}`,
        f.admin.projectId,
        `session_${status}`,
        `request_${status}`,
        status,
        status === 'succeeded' ? '{}' : null,
      );
    await tx.run(
      "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at) VALUES('old_transfer',?,'fixture','old_transfer','upload','hash','{}','prepared','now')",
      f.admin.projectId,
    );
    await tx.run(
      "INSERT INTO code_workspaces(project_id,unit_id,declared_at,generation,writer_state,writer_session_id,writer_lease_id,writer_changed_at) VALUES(?,'old_writer','now',1,'active','old_session','old_lease','now')",
      f.admin.projectId,
    );
  });
  const blocked = await snapshot();
  assert.deepEqual(
    blocked.legacyWork.map((row) => row.id),
    ['customer_4', 'legacy_open'],
  );
  assert.deepEqual(
    blocked.commands.map((row) => [row.id, row.status]),
    [
      ['command_dispatched', 'dispatched'],
      ['command_queued', 'queued'],
    ],
  );
  assert.deepEqual(
    blocked.transfers.map((row) => row.id),
    ['old_transfer'],
  );
  assert.deepEqual(
    blocked.writers.map((row) => row.unit_id),
    ['old_writer'],
  );
  await assert.rejects(f.state.read(requireGitCutover), { code: 'code_legacy_drain_required' });
  assert.deepEqual(
    await snapshot(),
    blocked,
    'preflight never edits an old workflow, writer or transfer',
  );
  await f.state.transaction(async (tx) => {
    await tx.run("UPDATE wf_instances SET state='done' WHERE id='legacy_open'");
    await tx.run("UPDATE wf_instances SET state='complete' WHERE id='customer_4'");
    await tx.run(
      "UPDATE code_operations SET status='failed',error='drained',completed_at='now' WHERE id='old_transfer'",
    );
    await tx.run("UPDATE code_workspaces SET writer_state='closed' WHERE unit_id='old_writer'");
    await tx.run(
      "UPDATE code_commands SET status='cancelled',error='drained' WHERE status='queued'",
    );
    await tx.run(
      "UPDATE code_commands SET status='failed',error='drained' WHERE status='dispatched'",
    );
  });
  assert.equal((await f.state.read(requireGitCutover)).ready, true);
});

test('cutover drains idle hosted workflow machines and live managed runner grants as well as active writers', async (t) => {
  const f = await codePublishFixture(t);
  await f.state.migrate('fleet', [fleetSchema]);
  await f.state.transaction(async (tx) => {
    for (const [id, kind, phase] of [
      ['workflow_idle', 'workflow', 'ready'],
      ['workflow_released', 'workflow', 'released'],
      ['personal', 'rental', 'ready'],
    ])
      await tx.run(
        "INSERT INTO fleet_allocations(id,project_id,source_hash,request_id,input_hash,phase,created_at,data_json) VALUES(?,?,'fixture',?,'hash',?,'now',?)",
        id,
        f.admin.projectId,
        id,
        phase,
        JSON.stringify({ owner: { kind, id } }),
      );
    await tx.run(
      `INSERT INTO session_managed_runners(allocation_id,epoch,project_id,source_json,source_hash,runtime_profile_id,platform_json,capabilities_json,enrollment_hash,enrollment_expires_at,control_hash,control_expires_at,runner_id,created_at)
      VALUES('idle_runner',0,?,'{}','fixture','profile','{}','[]','enrollment','2999-01-01T00:00:00.000Z','control','2999-01-01T00:00:00.000Z','runner','now')`,
      f.admin.projectId,
    );
  });
  const result = await f.state.read(gitCutover);
  assert.equal(result.ready, false);
  assert.deepEqual(
    result.allocations.map((row) => row.id),
    ['workflow_idle'],
  );
  assert.deepEqual(
    result.managedRunners.map((row) => row.allocation_id),
    ['idle_runner'],
  );
  await f.state.transaction(async (tx) => {
    await tx.run("UPDATE fleet_allocations SET phase='released' WHERE id='workflow_idle'");
    await tx.run(
      "UPDATE session_managed_runners SET runner_released_at='now' WHERE allocation_id='idle_runner'",
    );
  });
  assert.equal((await f.state.read(requireGitCutover)).ready, true);
});

test('deployment preflight queries real PostgreSQL and still blocks old queued commands after native migration', async (t) => {
  const f = await codePublishFixture(t);
  const original = (await f.state.read((sql) =>
    sql.get<{ name: string }>('SELECT current_schema() AS name'),
  ))!.name;
  const schema = `merv_ts_cutover_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  t.after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });
  await client.query(`CREATE SCHEMA "${schema}"`);
  // Copy actual migrated tables: this exercises the CLI's SQL adapter, including
  // parameterized managed-runner queries, without touching a deployment schema.
  for (const table of [
    'component_migrations',
    'wf_instances',
    'wf_definitions',
    'code_operations',
    'code_commands',
    'code_workspaces',
    'session_managed_runners',
  ]) {
    await client.query(
      `CREATE TABLE "${schema}"."${table}" (LIKE "${original}"."${table}" INCLUDING ALL)`,
    );
    await client.query(
      `INSERT INTO "${schema}"."${table}" OVERRIDING SYSTEM VALUE SELECT * FROM "${original}"."${table}"`,
    );
  }
  const module = new URL('../deploy/git-cutover-preflight.mjs', import.meta.url).href;
  const { preflight } = await import(module);
  const ready = await preflight(client, schema);
  assert.equal(ready.ready, true);
  assert.equal(ready.alreadyNative, true);
  await client.query(
    `INSERT INTO "${schema}".code_commands
    (id,project_id,session_id,actor_id,request_id,input_hash,command_json,status)
    VALUES('legacy_queued',$1,'session','actor','request','hash','{}','queued')`,
    [f.admin.projectId],
  );
  const blocked = await preflight(client, schema);
  assert.equal(blocked.alreadyNative, true);
  assert.equal(blocked.ready, false);
  assert.deepEqual(
    blocked.commands.map((row: { id: string }) => row.id),
    ['legacy_queued'],
  );
  assert.equal(
    (await client.query(`SELECT status FROM "${schema}".code_commands WHERE id='legacy_queued'`))
      .rows[0].status,
    'queued',
  );
  assert.equal(
    (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
    'off',
  );
});
