// Offline, explicitly planned conversion. Never starts the application or its reconcilers.
import pg from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical, check, digest, now } from '@merv/contracts';
import { postgresParameters } from '@merv/state/parameters';
import { persistContract, readPinned } from '@merv/workflows/pinned';
import { validateDefinition } from '@merv/workflows/definition';
import { validateExecution } from '@merv/workflows/execution-policy';
import {
  nativeMigrationSchema,
  nativeMigrationTarget,
  migrateNativeWorkflow,
} from '@merv/workflows/native-migration';
import { EXPERIMENT_WORKFLOW, activeStates } from '@merv/experiments/program';
import { execution } from '@merv/experiments/execution-policy';
import { TASK_WORKFLOW } from '@merv/tasks/workflow';
import { taskExecutionPolicy } from '@merv/tasks/execution-policy';
import { SERVICE_EXPERIMENT } from '@merv/customer-experiments/program';
import { serviceExecution } from '@merv/customer-experiments/execution';
import { gitCutover } from '@merv/code-work/cutover';
import { deploymentSchema } from './schema.mjs';

export const nativeContracts = () =>
  [
    [
      EXPERIMENT_WORKFLOW,
      45,
      ['complete'],
      activeStates.map((state) => [state, execution(state, 45)]),
    ],
    [
      TASK_WORKFLOW,
      46,
      ['done'],
      ['work', 'review'].map((purpose) => [
        purpose === 'work' ? 'in_progress' : 'in_review',
        taskExecutionPolicy(purpose, 'code', true, true),
      ]),
    ],
    ...[5, 6].map((version) => [
      SERVICE_EXPERIMENT,
      version,
      ['complete'],
      ['running', 'results_review'].map((state) => [
        state,
        serviceExecution(state === 'results_review', version),
      ]),
    ]),
  ].map(([definition, version, successStates, assignments]) => ({
    definition: validateDefinition({ ...definition, version }),
    policy: {
      successStates,
      assignments: assignments.map(([state, manifest]) => ({
        state,
        execution: validateExecution(manifest),
      })),
    },
  }));

export function sqlAdapter(client) {
  const query = (sql, params) => client.query(postgresParameters(sql, params.length), params);
  const all = async (sql, ...params) => (await query(sql, params)).rows;
  return {
    all,
    get: async (sql, ...params) => (await all(sql, ...params))[0],
    run: async (sql, ...params) => ({ changes: (await query(sql, params)).rowCount }),
    transactionId: Symbol('offline-native-migration'),
  };
}

// This retires an uncompleted protocol request, not its unknown execution outcome.
// The later durable completion is retained. Neither a success receipt nor a Git change is invented.
export async function abandonedCommand(sql, id) {
  const command = await sql.get('SELECT * FROM code_commands WHERE id=?', id);
  if (
    !command ||
    command.status !== 'dispatched' ||
    command.receipt_json !== null ||
    command.error !== null
  )
    return null;
  const instanceId = JSON.parse(command.command_json).instanceId;
  const session = await sql.get(
    "SELECT id,project_id,instance_id,revision,status,runner_id,session_json::jsonb ->> 'createdAt' AS created_at,session_json::jsonb ->> 'closedAt' AS closed_at FROM worker_sessions WHERE id=?",
    command.session_id,
  );
  const unit = await sql.get(
    `SELECT i.id,i.project_id,i.version,i.revision,i.state,i.updated_at FROM wf_instances i
    JOIN wf_definitions d ON d.name=i.workflow AND d.version=i.version
    WHERE i.id=? AND i.project_id=? AND jsonb_exists(d.definition_json::jsonb -> 'terminal',i.state)`,
    instanceId,
    command.project_id,
  );
  const workspace = await sql.get(
    'SELECT * FROM code_workspaces WHERE project_id=? AND unit_id=?',
    command.project_id,
    instanceId,
  );
  const allocations = await sql.all(
    `SELECT a.allocation_id,f.phase FROM session_managed_assignments a
    LEFT JOIN fleet_allocations f ON f.id=a.allocation_id AND f.project_id=? WHERE a.session_id=? ORDER BY a.allocation_id`,
    command.project_id,
    command.session_id,
  );
  const operation = await sql.get(
    'SELECT id FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
    command.project_id,
    `session:${command.session_id}`,
    id,
  );
  const headOperation =
    workspace?.head_operation_id &&
    (await sql.get(
      'SELECT id,kind,status,principal_scope,payload_json,result_json,completed_at FROM code_operations WHERE project_id=? AND id=?',
      command.project_id,
      workspace.head_operation_id,
    ));
  const successor =
    workspace?.writer_session_id &&
    (await sql.get(
      "SELECT id,project_id,instance_id,status,session_json::jsonb ->> 'createdAt' AS created_at FROM worker_sessions WHERE id=?",
      workspace.writer_session_id,
    ));
  const upload = JSON.parse(headOperation?.payload_json ?? '{}');
  if (
    !session ||
    !['expired', 'released'].includes(session.status) ||
    !session.closed_at ||
    session.project_id !== command.project_id ||
    session.instance_id !== instanceId ||
    !unit ||
    Number(unit.revision) <= Number(session.revision) ||
    unit.updated_at <= session.closed_at ||
    !workspace ||
    workspace.writer_state !== 'closed' ||
    !successor ||
    !['released', 'expired'].includes(successor.status) ||
    successor.id === command.session_id ||
    successor.project_id !== command.project_id ||
    successor.instance_id !== instanceId ||
    !session.created_at ||
    !successor.created_at ||
    successor.created_at <= session.created_at ||
    !workspace.head_oid ||
    !workspace.head_operation_id ||
    workspace.final_owed ||
    workspace.quarantine_operation_id ||
    workspace.blocked_by ||
    !headOperation ||
    headOperation.kind !== 'upload' ||
    headOperation.status !== 'completed' ||
    headOperation.principal_scope !== `session:${successor.id}` ||
    upload.sessionId !== successor.id ||
    upload.unitId !== instanceId ||
    Number(upload.generation) !== Number(workspace.generation) ||
    upload.tip !== workspace.head_oid ||
    !headOperation.completed_at ||
    headOperation.completed_at <= session.closed_at ||
    JSON.parse(headOperation.result_json ?? '{}').head !== workspace.head_oid ||
    !allocations.length ||
    allocations.some((a) => a.phase !== 'released') ||
    operation
  )
    return null;
  return { command, session, unit, workspace, allocations, headOperation, successor };
}

async function inventory(sql, schema, retireCommands) {
  const report = await gitCutover(sql);
  const rows =
    await sql.all(`SELECT i.* FROM wf_instances i JOIN wf_definitions d ON d.name=i.workflow AND d.version=i.version
    WHERE ((i.workflow='experiment' AND i.version<45) OR (i.workflow='task' AND i.version<46) OR (i.workflow='service_experiment' AND i.version<5))
    AND NOT jsonb_exists(d.definition_json::jsonb -> 'terminal', i.state) ORDER BY i.project_id,i.id`);
  const retained = new Set(report.retainedArtifactReviews.map((row) => row.id));
  const workflows = rows.map((row) => ({
    projectId: row.project_id,
    instanceId: row.id,
    workflow: row.workflow,
    fromVersion: Number(row.version),
    expectedRevision: Number(row.revision),
    state: row.state,
    toVersion: retained.has(row.id) ? null : nativeMigrationTarget(row),
    disposition: retained.has(row.id) ? 'retain-artifact-review' : 'migrate',
    sourceHash: digest(row),
  }));
  const contractConflicts = [];
  for (const row of workflows.filter((row) => row.toVersion)) {
    const before = await readPinned(sql, row.workflow, row.fromVersion);
    const after = nativeContracts().find(
      (item) => item.definition.name === row.workflow && item.definition.version === row.toVersion,
    );
    if (
      !before ||
      !after ||
      canonical({ ...before.definition, version: 0 }) !==
        canonical({ ...after.definition, version: 0 }) ||
      canonical(before.successStates) !== canonical(after.policy.successStates)
    )
      contractConflicts.push(row.instanceId);
  }
  const commands = [];
  for (const id of [...new Set(retireCommands)].sort()) {
    const evidence = await abandonedCommand(sql, id);
    commands.push({ id, eligible: !!evidence, sourceHash: evidence ? digest(evidence) : null });
  }
  const sessions = await sql.all(
    "SELECT id FROM worker_sessions WHERE status IN ('offered','active') ORDER BY id",
  );
  const leases = await sql.all('SELECT id FROM wf_leases WHERE released_at IS NULL ORDER BY id');
  const missingDefinitions =
    await sql.all(`SELECT i.id FROM wf_instances i LEFT JOIN wf_definitions d
    ON d.name=i.workflow AND d.version=i.version WHERE d.name IS NULL ORDER BY i.id`);
  const unresolved = report.commands.filter(
    (row) => !commands.some((command) => command.id === row.id && command.eligible),
  );
  const blockers = {
    contractConflicts,
    unsupported: workflows
      .filter((row) => row.disposition === 'migrate' && !row.toVersion)
      .map((row) => row.instanceId),
    commands: unresolved.map((row) => row.id),
    invalidRetirements: commands.filter((row) => !row.eligible).map((row) => row.id),
    sessions,
    leases,
    missingDefinitions,
    transfers: report.transfers,
    writers: report.writers,
    allocations: report.allocations,
    managedRunners: report.managedRunners,
  };
  // Hash the dependencies and immutable Code declarations too; they must not drift between plan and apply.
  const dependencies = await sql.all('SELECT * FROM wf_dependencies ORDER BY source_id,target_id');
  const code = await sql.all('SELECT * FROM code_units ORDER BY project_id,unit_id');
  const body = {
    format: 1,
    schema,
    database: (await sql.get('SELECT current_database() AS name')).name,
    contractHash: digest(nativeContracts()),
    workflows,
    commands,
    dependenciesHash: digest(dependencies),
    codeDeclarationsHash: digest(code),
    blockers,
  };
  return {
    ...body,
    ready: Object.values(blockers).every((rows) => rows.length === 0),
    hash: digest(body),
  };
}

export async function migrationPlan(client, schema, retireCommands = []) {
  deploymentSchema(schema);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`SET LOCAL search_path = "${schema}"`);
    return await inventory(sqlAdapter(client), schema, retireCommands);
  } finally {
    await client.query('ROLLBACK');
  }
}

export async function applyMigration(client, schema, plan, approval) {
  deploymentSchema(schema);
  check(
    approval.offline === true,
    'migration_offline_required',
    'Stop Main and all writers under maintenance before applying',
  );
  check(
    typeof approval.actorId === 'string' &&
      approval.actorId.trim() &&
      typeof approval.reason === 'string' &&
      approval.reason.trim() &&
      approval.reason.length <= 2000,
    'invalid_migration',
    'An operator and specific reason are required',
  );
  check(
    /^[A-Za-z0-9_-]{10,100}$/.test(approval.backupId ?? '') &&
      /^[a-f0-9]{64}$/.test(approval.backupSha256 ?? ''),
    'migration_backup_required',
    'Record the fresh verified matched backup ID and COMPLETE manifest SHA256',
  );
  const { hash, ready, ...body } = plan;
  check(
    ready === true && digest(body) === hash && plan.schema === schema,
    'migration_plan_invalid',
    'Use an unchanged ready plan for this schema',
  );
  await client.query('BEGIN');
  try {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `merv-state:${schema}`,
    ]);
    await client.query(`SET LOCAL search_path = "${schema}"`);
    const tx = sqlAdapter(client);
    const prior = await tx.get(
      "SELECT data_json FROM events WHERE type='workflow.native_git_cutover' AND subject_id=?",
      hash,
    );
    if (prior) {
      const receipt = JSON.parse(prior.data_json);
      check(
        digest(receipt.approval) === digest(approval),
        'migration_conflict',
        'This plan was applied with different operator or backup evidence',
      );
      await client.query('COMMIT');
      return receipt;
    }
    const current = await inventory(
      tx,
      schema,
      plan.commands.map((row) => row.id),
    );
    check(
      current.ready && current.hash === hash,
      'migration_plan_stale',
      'State changed after planning; regenerate and review the plan',
    );
    const installed = await tx.all(
      "SELECT version,hash FROM component_migrations WHERE component='workflow_native_git'",
    );
    if (installed.length)
      check(
        installed.length === 1 &&
          Number(installed[0].version) === 1 &&
          installed[0].hash === digest(nativeMigrationSchema),
        'migration_changed',
        'Native migration schema differs from this candidate',
      );
    else {
      await client.query(nativeMigrationSchema);
      await tx.run(
        "INSERT INTO component_migrations(component,version,hash) VALUES('workflow_native_git',1,?)",
        digest(nativeMigrationSchema),
      );
    }
    for (const { definition, policy } of nativeContracts())
      await persistContract(tx, definition, policy);
    for (const row of plan.workflows)
      if (row.disposition === 'migrate')
        await migrateNativeWorkflow(tx, {
          ...row,
          actorId: approval.actorId,
          reason: approval.reason,
        });
    for (const row of plan.commands) {
      const evidence = await abandonedCommand(tx, row.id);
      check(
        evidence && digest(evidence) === row.sourceHash,
        'migration_plan_stale',
        'Command evidence changed',
      );
      const error =
        'Retired at native Git cutover: the originating session and host ended without a recoverable command receipt; the unit completed later with a durable head. Original execution outcome remains unknown. ' +
        approval.reason;
      await tx.run(
        "UPDATE code_commands SET status='failed',error=? WHERE id=? AND status='dispatched'",
        error,
        row.id,
      );
      await tx.run(
        'INSERT INTO events(project_id,actor_id,type,subject_id,data_json,created_at) VALUES(?,?,?,?,?,?)',
        evidence.command.project_id,
        approval.actorId,
        'code.command_retired',
        row.id,
        canonical({ evidence, error, planHash: hash, backupId: approval.backupId }),
        now(),
      );
    }
    const final = await gitCutover(tx);
    check(
      final.ready,
      'migration_incomplete',
      'Cutover remains blocked; the entire migration is rolled back',
    );
    const receipt = {
      planHash: hash,
      appliedAt: now(),
      approval,
      migrated: plan.workflows.filter((row) => row.toVersion).length,
      retainedArtifactReviews: final.retainedArtifactReviews,
      retiredCommands: plan.commands.map((row) => row.id),
    };
    await tx.run(
      'INSERT INTO events(project_id,actor_id,type,subject_id,data_json,created_at) VALUES(?,?,?,?,?,?)',
      'system',
      approval.actorId,
      'workflow.native_git_cutover',
      hash,
      canonical(receipt),
      now(),
    );
    await client.query('COMMIT');
    return receipt;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      apply: { type: 'string' },
      'retire-command': { type: 'string', multiple: true },
      offline: { type: 'boolean' },
      operator: { type: 'string' },
      reason: { type: 'string' },
      'backup-id': { type: 'string' },
      'backup-sha256': { type: 'string' },
    },
  });
  const client = new pg.Client({ connectionString: process.env.MERV_DB_URL });
  try {
    check(!!values.plan !== !!values.apply, 'invalid_arguments', 'Use --plan FILE or --apply FILE');
    await client.connect();
    if (values.plan) {
      const plan = await migrationPlan(client, deploymentSchema(), values['retire-command']);
      await writeFile(values.plan, JSON.stringify(plan, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          path: values.plan,
          hash: plan.hash,
          ready: plan.ready,
          workflows: plan.workflows.length,
          blockers: plan.blockers,
        }),
      );
      if (!plan.ready) process.exitCode = 1;
    } else
      console.log(
        JSON.stringify(
          await applyMigration(
            client,
            deploymentSchema(),
            JSON.parse(await readFile(values.apply, 'utf8')),
            {
              offline: values.offline === true,
              actorId: values.operator,
              reason: values.reason,
              backupId: values['backup-id'],
              backupSha256: values['backup-sha256'],
            },
          ),
        ),
      );
  } catch (error) {
    // Never print PostgreSQL errors, URLs or unsanitized command data.
    console.error(
      JSON.stringify({
        error: /^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'migration_failed',
        message:
          'Migration refused or failed. Preserve maintenance; inspect the plan and rollback boundary before starting any runtime.',
      }),
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
