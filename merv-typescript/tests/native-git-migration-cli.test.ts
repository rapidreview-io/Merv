import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { canonical, digest, type Sql } from '@merv/contracts';
import { nativeMigrationSchema } from '@merv/workflows/native-migration';
import { executionPolicy } from '@merv/customer-experiments/execution';
import { SERVICE_EXPERIMENT } from '@merv/customer-experiments/program';
import { migration as fleetSchema, workflowRetryMigration } from '@merv/fleet/schema';
import { createApp } from './fixtures/app.js';
import { postgresUrl } from './fixtures/state.js';

// Import the executable module without a TypeScript declaration shim or starting its CLI.
const moduleUrl = new URL('../deploy/git-cutover-migrate.mjs', import.meta.url).href;
const { migrationPlan, applyMigration, abandonedCommand, sqlAdapter } = await import(moduleUrl);
const approval = {
  offline: true,
  actorId: 'migration-operator',
  reason: 'Preserve idle work and evidence while moving to native Git.',
  backupId: 'verified_backup_20261021',
  backupSha256: 'a'.repeat(64),
};
const at = '2026-10-20T00:00:00.000Z';
const closedAt = '2026-10-20T01:00:00.000Z';
const completedAt = '2026-10-20T02:00:00.000Z';
const targetWhere =
  "(workflow='experiment' AND version=45) OR (workflow='task' AND version IN (46,47)) OR (workflow='service_experiment' AND version IN (5,6))";
const contractRows = async (sql: Sql) => {
  const selected = targetWhere.replace('IN (46,47)', '=46');
  const definitions = await sql.all(
    `SELECT name,version::int AS version,fingerprint,definition_json FROM wf_definitions WHERE ${selected.replaceAll('workflow=', 'name=')} ORDER BY name,version`,
  );
  const success = await sql.all(
    `SELECT workflow,version::int AS version,success_json FROM wf_success_states WHERE ${selected} ORDER BY workflow,version`,
  );
  const execution = await sql.all(
    `SELECT workflow,version::int AS version,state,fingerprint,manifest_json FROM wf_execution_policies WHERE ${selected} ORDER BY workflow,version,state`,
  );
  return { definitions, success, execution };
};

/** Real migrated schemas and immutable triggers, with candidate-only pins removed offline. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-native-migrate-'));
  const app = await createApp({ directory, api: false });
  const bootstrap = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Migration',
    actorName: 'Owner',
  });
  const projectId = bootstrap.project.id;
  const actorId = bootstrap.actor.id;
  await app.ctx.state.migrate('fleet', [fleetSchema]);
  // Use the runtime's actual registration function for the optional customer plugin too.
  for (const version of [1, 3, 5, 6])
    await app.ctx.workflows.register(
      { ...SERVICE_EXPERIMENT, version },
      executionPolicy({} as Parameters<typeof executionPolicy>[0], version),
    );
  const original = (await app.ctx.state.read((sql) =>
    sql.get<{ name: string }>('SELECT current_schema() AS name'),
  ))!.name;
  const expected = await app.ctx.state.read(contractRows);
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  const schema = `merv_ts_migrate_${randomUUID().replaceAll('-', '')}`;
  await client.query(`ALTER SCHEMA "${original}" RENAME TO "${schema}"`);
  t.after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });
  await client.query(`SET search_path = "${schema}"`);
  // This setup models the old database before candidate initialization. Guards are restored
  // before any plan/apply call, so all migration writes exercise production constraints.
  for (const table of ['wf_execution_policies', 'wf_success_states', 'wf_definitions']) {
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await client.query(
      `DELETE FROM ${table} WHERE ${table === 'wf_definitions' ? targetWhere.replaceAll('workflow=', 'name=') : targetWhere}`,
    );
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  await client.query('DROP TABLE wf_protocol_migrations');
  await client.query('DROP FUNCTION wf_protocol_migrations_guard()');
  await client.query(
    "DELETE FROM component_migrations WHERE component IN ('workflow_native_git','code_git_remote')",
  );
  const sql = sqlAdapter(client);
  const add = async (
    id: string,
    workflow: string,
    version: number,
    state: string,
    revision = 1,
  ) => {
    await sql.run(
      'INSERT INTO wf_instances(id,project_id,workflow,version,state,revision,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      projectId,
      workflow,
      version,
      state,
      revision,
      canonical({ title: id, originalArtifact: `${id}-artifact` }),
      at,
      completedAt,
    );
    await sql.run(
      "INSERT INTO wf_history(instance_id,project_id,revision,action,actor_id,request_id,from_state,to_state,data_json,created_at) VALUES(?,?,?,'historical',?,?,NULL,?,'{}',?)",
      id,
      projectId,
      revision,
      actorId,
      `${id}-history`,
      state,
      at,
    );
  };
  const rows = async (table: string) =>
    (
      await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)
    ).rows.map((row) => row.row);
  const snapshot = async () => {
    const tables = await sql.all(
      'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename',
    );
    const result: Record<string, unknown> = {};
    for (const { tablename } of tables) result[tablename] = await rows(tablename);
    return result;
  };
  const seed = async () => {
    await add('a_experiment', 'experiment', 41, 'planned');
    await add('b_task', 'task', 43, 'in_progress');
    await add('c_structured', 'service_experiment', 1, 'ready');
    await add('d_document', 'service_experiment', 3, 'awaiting_payment');
    await sql.run(
      "INSERT INTO wf_dependencies(project_id,source_id,target_id,target_workflow,target_version,target_success_json,target_terminal_json,created_at) VALUES(?,'b_task','a_experiment','experiment',41,'[\"complete\"]','[\"complete\",\"failed\"]',?)",
      projectId,
      at,
    );
    await sql.run(
      "INSERT INTO code_units(project_id,unit_id,workflow,version,declared_at,base_json,base_hash,base_lease_id,based_at) VALUES(?,'b_task','task',43,?,?,?,'historic-lease',?)",
      projectId,
      at,
      canonical({ retained: 'source-base' }),
      digest({ retained: 'source-base' }),
      at,
    );
  };
  return {
    client,
    schema,
    sql,
    projectId,
    actorId,
    expected,
    add,
    seed,
    rows,
    snapshot,
    plan: (commands: string[] = []) => migrationPlan(client, schema, commands),
    apply: (plan: unknown, evidence = approval) => applyMigration(client, schema, plan, evidence),
  };
}

test('offline plan is read-only and apply pins runtime-identical contracts while preserving source evidence and dependencies', async (t) => {
  const f = await fixture(t);
  await f.seed();
  const before = await f.snapshot();
  const plan = await f.plan();
  assert.equal(plan.ready, true);
  assert.deepEqual(
    plan.workflows.map((row: { fromVersion: number; toVersion: number }) => [
      row.fromVersion,
      row.toVersion,
    ]),
    [
      [41, 45],
      [43, 46],
      [1, 6],
      [3, 5],
    ],
  );
  assert.deepEqual(
    await f.snapshot(),
    before,
    'planning does not initialize migrations or contracts',
  );
  const receipt = await f.apply(plan);
  assert.equal(receipt.migrated, 4);
  assert.deepEqual(await contractRows(f.sql), f.expected);
  for (const table of ['wf_dependencies', 'code_units'])
    assert.deepEqual(await f.rows(table), before[table]);
  const instances = await f.rows('wf_instances');
  for (const source of before.wf_instances as Record<string, unknown>[]) {
    const migrated = instances.find((row) => row.id === source.id)!;
    for (const key of ['id', 'project_id', 'workflow', 'state', 'data_json', 'created_at'])
      assert.deepEqual(migrated[key], source[key]);
    assert.equal(Number(migrated.revision), Number(source.revision) + 1);
  }
  const ledger = await f.rows('wf_protocol_migrations');
  assert.equal(ledger.length, 4);
  for (const row of ledger) assert.equal(digest(JSON.parse(row.source_json)), row.source_hash);
  for (const table of [
    'wf_history',
    'wf_definitions',
    'wf_success_states',
    'wf_execution_policies',
  ])
    for (const old of before[table] as unknown[])
      assert.ok(
        (await f.rows(table)).some((row) => canonical(row) === canonical(old)),
        `${table} retains source rows`,
      );
  const applied = await f.snapshot();
  assert.deepEqual(await f.apply(plan), receipt);
  assert.deepEqual(
    await f.snapshot(),
    applied,
    'replay creates no new history, events or revisions',
  );
  await assert.rejects(f.apply(plan, { ...approval, reason: 'Different authority' }), {
    code: 'migration_conflict',
  });
  await assert.rejects(
    f.client.query("UPDATE wf_protocol_migrations SET reason='rewritten'"),
    /immutable/,
  );
});

test('offline apply refuses missing backup/offline evidence, corrupt plans and stale revisions without mutation', async (t) => {
  const f = await fixture(t);
  await f.seed();
  const plan = await f.plan();
  const before = await f.snapshot();
  for (const [evidence, code] of [
    [{ ...approval, offline: false }, 'migration_offline_required'],
    [{ ...approval, backupId: '' }, 'migration_backup_required'],
    [{ ...approval, backupSha256: 'unverified' }, 'migration_backup_required'],
    [{ ...approval, actorId: '' }, 'invalid_migration'],
  ] as const)
    await assert.rejects(f.apply(plan, evidence), { code });
  await assert.rejects(f.apply({ ...plan, ready: false }), { code: 'migration_plan_invalid' });
  await assert.rejects(f.apply({ ...plan, codeDeclarationsHash: 'changed' }), {
    code: 'migration_plan_invalid',
  });
  assert.deepEqual(await f.snapshot(), before);
  await f.sql.run("UPDATE wf_instances SET revision=2 WHERE id='d_document'");
  const changed = await f.snapshot();
  await assert.rejects(f.apply(plan), { code: 'migration_plan_stale' });
  assert.deepEqual(
    await f.snapshot(),
    changed,
    'a stale final item cannot migrate an earlier item',
  );
});

test('offline plans bind admission holds, dispatch gates, blocker opinions and retry grants before any writes', async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.client.query(workflowRetryMigration.sql);
  await f.sql.run(
    "INSERT INTO session_dispatch_holds(project_id,instance_id,revision,attempts,last_code,last_message,first_at,last_at,held_at) VALUES(?,'a_experiment',1,5,'host_failed','original failure',?,?,?)",
    f.projectId,
    at,
    at,
    at,
  );
  await f.sql.run(
    "INSERT INTO wf_blockers(project_id,instance_id,provider,blocker_key,code,message,status,next,related_json,revision,since,updated_at) VALUES(?,'a_experiment','fixture','hold','launch_held','original failure',409,'Repair the host','[]',1,?,?)",
    f.projectId,
    at,
    at,
  );
  const mutations = [
    () =>
      f.sql.run("UPDATE session_dispatch_holds SET attempts=6 WHERE instance_id='a_experiment'"),
    () =>
      f.sql.run(
        'INSERT INTO project_session_dispatch(project_id,enabled,own_machines,updated_at,updated_by) VALUES(?,0,1,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=0,own_machines=1',
        f.projectId,
        at,
        f.actorId,
      ),
    () =>
      f.sql.run(
        "UPDATE wf_blockers SET message='failure details changed' WHERE instance_id='a_experiment'",
      ),
    () =>
      f.sql.run(
        "INSERT INTO fleet_workflow_retry_grants(project_id,instance_id,expected_revision,prior_allocations,request_id,input_hash,reason,actor_id,created_at) VALUES(?,'a_experiment',1,2,'retry','hash','An explicit retry window',?,?)",
        f.projectId,
        f.actorId,
        at,
      ),
    () =>
      f.sql.run(
        "INSERT INTO wf_limit_grants(project_id,request_id,instance_id,limit_name,additional,reason,actor_id,created_at) VALUES(?,'extend','a_experiment','plan_rounds',1,'Allow another reviewed round',?,?)",
        f.projectId,
        f.actorId,
        at,
      ),
  ];
  for (const mutate of mutations) {
    const plan = await f.plan();
    assert.equal(plan.ready, true);
    await mutate();
    const before = await f.snapshot();
    await assert.rejects(f.apply(plan), { code: 'migration_plan_stale' });
    assert.deepEqual(await f.snapshot(), before, 'stale admission cannot migrate any workflow');
  }
  const plan = await f.plan();
  const receipt = await f.apply(plan);
  assert.deepEqual(
    receipt.admission,
    plan.admission,
    'receipt retains reviewed admission evidence',
  );
  await f.sql.run(
    "UPDATE session_dispatch_holds SET attempts=0,held_at=NULL WHERE instance_id='a_experiment'",
  );
  const released = await f.snapshot();
  assert.deepEqual(await f.apply(plan), receipt);
  assert.deepEqual(
    await f.snapshot(),
    released,
    'replay cannot restore an explicitly released hold',
  );
});

test('a database error after the first converted workflow rolls back the entire batch, including pins and schema', async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.client
    .query(`CREATE FUNCTION fixture_refuse_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='b_task' AND NEW.version=46 THEN RAISE EXCEPTION 'injected second workflow failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fixture_refuse_second BEFORE UPDATE ON wf_instances FOR EACH ROW EXECUTE FUNCTION fixture_refuse_second()`);
  const plan = await f.plan();
  const before = await f.snapshot();
  await assert.rejects(f.apply(plan), /injected second workflow failure/);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(
    (await f.sql.get("SELECT to_regclass('wf_protocol_migrations')::text AS name")).name,
    null,
  );
});

test('planning rejects a historical graph or success contract that the candidate cannot preserve', async (t) => {
  const f = await fixture(t);
  await f.seed();
  // Model a different historically published contract, without changing candidate code.
  await f.client.query('ALTER TABLE wf_success_states DISABLE TRIGGER USER');
  await f.client.query(
    "UPDATE wf_success_states SET success_json='[\"failed\"]' WHERE workflow='task' AND version=43",
  );
  await f.client.query('ALTER TABLE wf_success_states ENABLE TRIGGER USER');
  const before = await f.snapshot();
  const plan = await f.plan();
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.blockers.contractConflicts, ['b_task']);
  await assert.rejects(f.apply(plan), { code: 'migration_plan_invalid' });
  assert.deepEqual(await f.snapshot(), before);
});

test('unknown native migration schema history is refused atomically', async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.client.query(nativeMigrationSchema);
  await f.sql.run(
    "INSERT INTO component_migrations(component,version,hash) VALUES('workflow_native_git',1,?),('workflow_native_git',2,'unknown')",
    digest(nativeMigrationSchema),
  );
  const plan = await f.plan();
  const before = await f.snapshot();
  await assert.rejects(f.apply(plan), { code: 'migration_changed' });
  assert.deepEqual(await f.snapshot(), before);
});

async function seedCommand(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  options: {
    status?: string;
    operation?:
      | 'missing'
      | 'failed'
      | 'wrong-head'
      | 'wrong-unit'
      | 'wrong-principal'
      | 'wrong-generation'
      | 'older'
      | 'matching';
    activeAllocation?: boolean;
    priorReceipt?: boolean;
    noSuccessor?: boolean;
  } = {},
) {
  const sessionId = `session-${id}`,
    successorId = `successor-${id}`,
    unitId = `unit-${id}`,
    allocationId = `allocation-${id}`;
  await f.add(unitId, 'task', 43, 'done', 9);
  // Each real worker session has a distinct scoped actor. Its historical grant is retained.
  for (const [sid, createdAt, endedAt] of [
    [sessionId, at, closedAt],
    [successorId, '2026-10-20T01:30:00.000Z', '2026-10-20T01:59:00.000Z'],
  ]) {
    await f.sql.run(
      "INSERT INTO actors(id,project_id,name,role) VALUES(?,?,'Historical producer','producer')",
      `actor-${sid}`,
      f.projectId,
    );
    await f.sql.run(
      "INSERT INTO session_threads(id,project_id,instance_id,state,role,actor_id,status,created_at,updated_at) VALUES(?,?,?,'in_progress','producer',?,'dormant',?,?)",
      `thread-${sid}`,
      f.projectId,
      unitId,
      `actor-${sid}`,
      createdAt,
      endedAt,
    );
    // A replacement can legitimately retain the same workflow revision as the expired visit.
    await f.sql.run(
      "INSERT INTO worker_sessions(id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json,thread_id) VALUES(?,?,?,?,2,?,'runner',?,?,?,'expired',?,?)",
      sid,
      f.projectId,
      `actor-${sid}`,
      unitId,
      `owner-${sid}`,
      `request-${sid}`,
      `token-${sid}`,
      `fingerprint-${sid}`,
      canonical({ createdAt, closedAt: endedAt }),
      `thread-${sid}`,
    );
  }
  await f.sql.run(
    "INSERT INTO session_managed_runners(allocation_id,epoch,project_id,source_json,source_hash,runtime_profile_id,platform_json,capabilities_json,enrollment_hash,enrollment_expires_at,control_hash,control_expires_at,runner_id,runner_released_at,created_at) VALUES(?,0,?,'{}','source','profile','{}','[]',?,?,?,?,'runner',?,?)",
    allocationId,
    f.projectId,
    `enrollment-${id}`,
    at,
    `control-${id}`,
    at,
    closedAt,
    at,
  );
  await f.sql.run(
    "INSERT INTO session_managed_assignments(session_id,allocation_id,runner_id,source_json,bound_at,release_ack_at,settled_at) VALUES(?,?,'runner','{}',?,?,?)",
    sessionId,
    allocationId,
    at,
    closedAt,
    closedAt,
  );
  await f.sql.run(
    "INSERT INTO fleet_allocations(id,project_id,source_hash,request_id,input_hash,phase,created_at,data_json) VALUES(?,?,'source',?,'hash',?,?,?)",
    allocationId,
    f.projectId,
    id,
    options.activeAllocation ? 'ready' : 'released',
    at,
    canonical({ owner: { kind: 'workflow', id: unitId } }),
  );
  const head = '1'.repeat(40),
    operationId = `head-${id}`;
  await f.sql.run(
    "INSERT INTO code_workspaces(project_id,unit_id,declared_at,generation,writer_state,writer_changed_at,head_oid,head_operation_id,writer_session_id) VALUES(?,?,?,2,'closed',?,?,?,?)",
    f.projectId,
    unitId,
    at,
    completedAt,
    head,
    operationId,
    options.noSuccessor ? null : successorId,
  );
  if (options.operation !== 'missing')
    await f.sql.run(
      "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,error,created_at,completed_at,unit_id) VALUES(?,?,?,?,'upload','hash',?,?,?,?,?,?,?)",
      operationId,
      f.projectId,
      options.operation === 'wrong-principal' ? 'session:someone-else' : `session:${successorId}`,
      operationId,
      canonical({
        unitId: options.operation === 'wrong-unit' ? 'another-unit' : unitId,
        sessionId: successorId,
        generation: options.operation === 'wrong-generation' ? 1 : 2,
        tip: head,
      }),
      options.operation === 'failed' ? 'failed' : 'completed',
      options.operation === 'failed'
        ? null
        : canonical({ head: options.operation === 'wrong-head' ? '2'.repeat(40) : head }),
      options.operation === 'failed' ? 'upload failed' : null,
      completedAt,
      options.operation === 'older' ? at : completedAt,
      unitId,
    );
  await f.sql.run(
    "INSERT INTO code_commands(id,project_id,session_id,actor_id,request_id,input_hash,command_json,status) VALUES(?,?,?,?,?,'hash',?,?)",
    id,
    f.projectId,
    sessionId,
    `actor-${sessionId}`,
    id,
    canonical({ instanceId: unitId }),
    options.status ?? 'dispatched',
  );
  if (options.priorReceipt)
    await f.sql.run(
      "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES(?,?,?,?,'upload','hash','{}','completed',?,?,?,?)",
      `prior-${id}`,
      f.projectId,
      `session:${sessionId}`,
      id,
      canonical({ head }),
      at,
      closedAt,
      unitId,
    );
  return { sessionId, unitId, allocationId, head, operationId };
}

test('retiring an abandoned command requires later durable evidence and records an immutable truthful failure', async (t) => {
  const f = await fixture(t);
  const source = await seedCommand(f, 'orphan-command');
  const before = await f.rows('code_commands');
  assert.equal((await f.plan()).ready, false, 'retirement must be explicitly named');
  const plan = await f.plan(['orphan-command']);
  assert.equal(plan.ready, true);
  assert.ok(await abandonedCommand(f.sql, 'orphan-command'));
  const receipt = await f.apply(plan);
  assert.deepEqual(receipt.retiredCommands, ['orphan-command']);
  const command = (await f.rows('code_commands'))[0];
  assert.equal(command.status, 'failed');
  assert.equal(command.receipt_json, null);
  assert.match(command.error, /execution outcome remains unknown/i);
  for (const key of [
    'id',
    'project_id',
    'session_id',
    'actor_id',
    'request_id',
    'input_hash',
    'command_json',
  ])
    assert.equal(command[key], before[0][key]);
  assert.equal(
    (await f.sql.get('SELECT head_oid FROM code_workspaces WHERE unit_id=?', source.unitId))
      .head_oid,
    source.head,
  );
  const event = await f.sql.get("SELECT * FROM events WHERE type='code.command_retired'");
  const evidence = JSON.parse(event.data_json);
  assert.equal(evidence.evidence.command.status, 'dispatched');
  assert.equal(evidence.planHash, plan.hash);
  assert.equal(evidence.backupId, approval.backupId);
  await assert.rejects(
    f.sql.run("UPDATE events SET data_json='{}' WHERE id=?", event.id),
    /immutable/,
  );
  await assert.rejects(
    f.sql.run(
      "UPDATE code_commands SET status='succeeded',error=NULL,receipt_json='{}' WHERE id='orphan-command'",
    ),
    /immutable/,
  );
  assert.deepEqual(await f.apply(plan), receipt);
});

test('queued requests, live hosts, matching prior operations and absent or conflicting durable heads cannot be retired', async (t) => {
  const f = await fixture(t);
  for (const [id, options] of [
    ['queued', { status: 'queued' }],
    ['live-host', { activeAllocation: true }],
    ['prior-receipt', { priorReceipt: true }],
    ['missing-head', { operation: 'missing' as const }],
    ['failed-head', { operation: 'failed' as const }],
    ['wrong-head', { operation: 'wrong-head' as const }],
    ['no-successor', { noSuccessor: true }],
    ['other-unit', { operation: 'wrong-unit' as const }],
    ['other-principal', { operation: 'wrong-principal' as const }],
    ['old-generation', { operation: 'wrong-generation' as const }],
    ['older-head', { operation: 'older' as const }],
  ] as const) {
    await seedCommand(f, id, options);
    assert.equal(await abandonedCommand(f.sql, id), null, id);
  }
  const before = await f.snapshot();
  const ids = (await f.rows('code_commands')).map((row) => row.id);
  const plan = await f.plan(ids);
  assert.equal(plan.ready, false);
  assert.equal(plan.blockers.invalidRetirements.length, ids.length);
  await assert.rejects(f.apply(plan), { code: 'migration_plan_invalid' });
  assert.deepEqual(await f.snapshot(), before);
});
