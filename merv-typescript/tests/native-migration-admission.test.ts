import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { NATIVE_CODE_DRIVER, type WorkflowPolicy } from '@merv/contracts';
import { ExperimentService } from '@merv/experiments';
import { EXPERIMENT_WORKFLOW } from '@merv/experiments/program';
import { LeasedSessions } from '@merv/sessions';
import type { HoldRow } from '@merv/sessions/dispatch';
import { migrateNativeWorkflow } from '@merv/workflows/native-migration';
import { createApp } from './fixtures/app.js';
import { taskActors } from './fixtures/task-actors.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { codePublishFixture } from './fixtures/code-publish.js';

const platform = {
  name: 'migration-test',
  harness: 'codex' as const,
  enabled: true,
  parallelism: 1,
};
const capabilities = [NATIVE_CODE_DRIVER];

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-migration-admission-'));
  const app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { operator, producer } = await taskActors(app, 'Migration admission');
  const source = producer.caller;
  const state = app.ctx.state;
  const sessions = app.ctx.sessions as LeasedSessions;
  const dispatch = sessions.dispatch;
  let clock = Date.now();
  t.mock.method(dispatch, 'clock', () => clock);
  await waitForManagedCode(app.ctx.codeWork, source);
  await dispatch.setDispatch(operator, { enabled: true, ownMachines: false });
  const heartbeat = () =>
    dispatch.heartbeatRunner(source, {
      runnerId: 'migration-runner',
      machine: { hostname: 'fixture', system: process.platform, architecture: process.arch },
      platforms: [platform],
      capacity: 1,
      capabilities,
    });
  await heartbeat();
  const demand = () => dispatch.dispatchDemand(source, { platform, capabilities });
  const lease = () =>
    dispatch.lease(source, {
      runnerId: 'migration-runner',
      requestId: randomUUID(),
      secret: `ms_${randomBytes(32).toString('base64url')}`,
      platform: { name: platform.name, harness: platform.harness },
    });
  const legacyExperiment = async () => {
    const owner = app.ctx.experiments as ExperimentService;
    const current = owner.handles.get(45)!;
    owner.handles.set(45, owner.handles.get(40)!);
    let experiment;
    try {
      experiment = await owner.create(source, {
        name: 'retain-held-work',
        intent: 'Preserve the pending plan.',
        requestId: randomUUID(),
      });
    } finally {
      owner.handles.set(45, current);
    }
    // Historical revision12 is part of the regression. Owner records and immutable Code
    // declaration came from the published version40 creation path above.
    await state.transaction((tx) =>
      tx.run('UPDATE wf_instances SET revision=12 WHERE id=?', experiment.id),
    );
    return app.ctx.experiments.get(source, experiment.id);
  };
  const count = async (instanceId: string, revision: number, attempts: number) =>
    state.transaction(async (tx) => {
      const at = new Date(clock).toISOString();
      const row = (await tx.get<HoldRow>(
        `INSERT INTO session_dispatch_holds(project_id,instance_id,revision,attempts,last_code,last_message,last_session_id,first_at,last_at,held_at)
       VALUES(?,?,?,?,'host_failed','The previous hosted launch failed',NULL,?,?,?) RETURNING *`,
        source.projectId,
        instanceId,
        revision,
        attempts,
        at,
        at,
        attempts >= dispatch.thresholds.maxLaunchFailures ? at : null,
      ))!;
      if (row.held_at) await dispatch.reportHold(source.projectId, instanceId, row, tx);
      return row;
    });
  const migrate = (instanceId: string) =>
    state.transaction((tx) =>
      migrateNativeWorkflow(tx, {
        projectId: source.projectId,
        instanceId,
        expectedRevision: 12,
        fromVersion: 40,
        toVersion: 45,
        actorId: operator.actorId,
        reason: 'Preserve this work under the native Git protocol.',
      }),
    );
  return {
    app,
    state,
    source,
    operator,
    sessions,
    dispatch,
    demand,
    lease,
    count,
    migrate,
    legacyExperiment,
    advance: async () => {
      clock += 31_000;
      await heartbeat();
    },
  };
}

test('a migrated launch hold still blocks real dispatch and reports the current revision until an administrator releases it', async (t) => {
  const f = await fixture(t);
  const experiment = await f.legacyExperiment();
  const historical = await f.count(experiment.id, 12, f.dispatch.thresholds.maxLaunchFailures);
  const blocker = async () =>
    (await f.app.ctx.workflows.blockers(f.operator, experiment.id)).find(
      (item) => item.code === 'launch_held',
    )!;
  const originalBlocker = await blocker();
  assert.equal(originalBlocker.revision, 12);
  assert.deepEqual(await f.migrate(experiment.id), { revision: 13, version: 45 });
  assert.deepEqual(
    await f.state.read((sql) =>
      sql.get(
        'SELECT * FROM session_dispatch_holds WHERE project_id=? AND instance_id=? AND revision=12',
        f.source.projectId,
        experiment.id,
      ),
    ),
    historical,
    'migration preserves the original failure evidence',
  );
  assert.deepEqual(
    (await f.demand()).candidates,
    [],
    'a protocol revision is not permission to retry held work',
  );
  assert.deepEqual(await f.lease(), { session: null, reason: 'retries_exhausted' });
  const report = await f.dispatch.projectStatus(f.operator);
  assert.equal(report.retriesExhausted, 1);
  const held = (await f.dispatch.stuck(f.operator)).items.find(
    (item) => item.kind === 'dispatch_held' && item.instanceId === experiment.id,
  )!;
  assert.ok(held, 'the held work stays visible to the owner');
  assert.equal(held.expectedRevision, 13);
  assert.deepEqual(await blocker(), { ...originalBlocker, revision: 13 });
  await f.dispatch.initialize();
  assert.deepEqual(
    await blocker(),
    { ...originalBlocker, revision: 13 },
    'recomputing the hold after migration preserves its original since and updatedAt',
  );
  const history = await f.state.read((sql) =>
    sql.all('SELECT * FROM wf_history WHERE instance_id=? ORDER BY revision', experiment.id),
  );
  assert.deepEqual(await f.migrate(experiment.id), { revision: 13, version: 45 });
  assert.deepEqual(
    await f.state.read((sql) =>
      sql.all('SELECT * FROM wf_history WHERE instance_id=? ORDER BY revision', experiment.id),
    ),
    history,
  );
  assert.deepEqual((await f.demand()).candidates, []);

  const release = {
    instanceId: experiment.id,
    expectedRevision: 13,
    reason: 'The hosted launch fault is fixed.',
    requestId: 'release-migrated-hold',
  };
  await assert.rejects(
    f.dispatch.releaseHold(f.operator, {
      ...release,
      expectedRevision: 12,
      requestId: 'stale-release',
    }),
    { code: 'revision_conflict' },
  );
  const released = await f.dispatch.releaseHold(f.operator, release);
  assert.equal(released.revision, 13);
  assert.equal(released.heldAt, null);
  assert.deepEqual(await f.dispatch.releaseHold(f.operator, release), released);
  await f.migrate(experiment.id);
  await f.advance();
  assert.deepEqual(
    (await f.demand()).candidates.map(({ instanceId, expectedRevision }) => ({
      instanceId,
      expectedRevision,
    })),
    [{ instanceId: experiment.id, expectedRevision: 13 }],
  );
  const admitted = await f.lease();
  assert.ok(admitted.session, admitted.reason);
  assert.equal(admitted.session.instanceId, experiment.id);
  assert.equal(admitted.session.expectedRevision, 13);
  assert.equal((await f.dispatch.projectStatus(f.operator)).retriesExhausted, 0);
  const events = (await f.state.events(f.source.projectId)).filter(
    (event) => event.type === 'session.hold_released',
  );
  assert.equal(
    events.length,
    1,
    'neither release replay nor migration replay duplicates the go-ahead',
  );
  assert.equal(events[0].data.revision, 13);
});

test('migration preserves a four-failure backoff and the next actual failed launch reaches the cap', async (t) => {
  const f = await fixture(t);
  const experiment = await f.legacyExperiment();
  assert.equal(f.dispatch.thresholds.maxLaunchFailures, 5);
  await f.count(experiment.id, 12, 4);
  await f.migrate(experiment.id);
  assert.deepEqual((await f.demand()).candidates, []);
  assert.deepEqual(await f.lease(), { session: null, reason: 'retry_backoff' });
  await f.advance();
  const offered = await f.lease();
  assert.ok(offered.session, offered.reason);
  await f.sessions.release(f.source, {
    sessionId: offered.session.id,
    runnerId: 'migration-runner',
    outcome: 'host_failed',
  });
  const original = await f.state.read((sql) =>
    sql.get<{ attempts: number; held_at: string | null }>(
      'SELECT attempts,held_at FROM session_dispatch_holds WHERE project_id=? AND instance_id=? AND revision=12',
      f.source.projectId,
      experiment.id,
    ),
  );
  assert.equal(
    original?.attempts,
    4,
    'the original failure evidence stays on its historical revision',
  );
  const hold = (await f.dispatch.stuck(f.operator)).items.find(
    (item) => item.kind === 'dispatch_held' && item.instanceId === experiment.id,
  );
  assert.equal(hold?.attempts, 5, 'migration must not reset the launch failure budget');
  assert.equal(hold.expectedRevision, 13);
  await f.advance();
  assert.deepEqual(await f.lease(), { session: null, reason: 'retries_exhausted' });
});

test('an ordinary user revision still starts fresh rather than inheriting a previous revision hold', async (t) => {
  const f = await fixture(t);
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    actions: [
      {
        name: 'revise',
        states: ['working'],
        transitions: ['revise', 'finish'],
        tool: 'revise',
        instruction: 'Revise the work.',
        check: () => {},
      },
    ],
    assignments: [
      {
        state: 'working',
        check: () => {},
        build: () => ({
          role: 'producer',
          label: 'Revised work',
          brief: 'Continue the changed work.',
          references: [],
          handoff: { instruction: 'Finish.', tools: [] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: { readOnly: false, tools: [] },
        lease: {
          role: () => 'producer',
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const owner = await f.app.ctx.workflows.register(
    {
      name: 'ordinary-admission',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [
        { from: 'working', action: 'revise', to: 'working' },
        { from: 'working', action: 'finish', to: 'done' },
      ],
    },
    policy,
  );
  const work = await owner.start(f.source, {
    workflow: 'ordinary-admission',
    requestId: randomUUID(),
  });
  await f.count(work.id, work.revision, f.dispatch.thresholds.maxLaunchFailures);
  assert.deepEqual(await f.lease(), { session: null, reason: 'retries_exhausted' });
  await owner.transition(f.source, {
    instanceId: work.id,
    expectedRevision: work.revision,
    action: 'revise',
    requestId: randomUUID(),
  });
  assert.equal((await f.dispatch.projectStatus(f.operator)).retriesExhausted, 0);
  assert.equal(
    (await f.dispatch.stuck(f.operator)).items.some(
      (item) => item.kind === 'dispatch_held' && item.instanceId === work.id,
    ),
    false,
  );
  const offered = await f.lease();
  assert.ok(offered.session, offered.reason);
  assert.equal(offered.session.instanceId, work.id);
  assert.equal(offered.session.expectedRevision, work.revision + 1);
});

/** This scheduler fixture supplies only an owner's admission/build hooks. Actual Sessions
 * dispatches and closes the visit and writes its immutable receipt/usage. No legacy producer
 * guard is bypassed in the production experiment owner used by the tests above. */
async function dispatchedFailure(t: TestContext) {
  const f = await codePublishFixture(t);
  const dispatch = f.sessions.dispatch;
  let clock = Date.now();
  t.mock.method(dispatch, 'clock', () => clock);
  const policy: WorkflowPolicy = {
    successStates: ['complete'],
    actions: [...new Set(EXPERIMENT_WORKFLOW.edges.map((edge) => edge.action))].map((name) => ({
      name,
      states: [
        ...new Set(
          EXPERIMENT_WORKFLOW.edges.filter((edge) => edge.action === name).map((edge) => edge.from),
        ),
      ],
      transitions: [name],
      tool: name,
      instruction: 'Advance the scheduler fixture.',
      check: () => {},
    })),
    assignments: [
      {
        state: 'planned',
        check: () => {},
        build: () => ({
          role: 'producer',
          label: 'Scheduler fixture',
          brief: 'Exercise session admission.',
          references: [],
          handoff: { instruction: 'Hand off.', tools: [] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: { readOnly: false, tools: [] },
        lease: {
          role: () => 'producer',
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const previous = await f.workflows.register({ ...EXPERIMENT_WORKFLOW, version: 40 }, policy);
  const current = await f.workflows.register({ ...EXPERIMENT_WORKFLOW, version: 45 }, policy);
  const target = await previous.start(f.admin, { workflow: 'experiment', requestId: randomUUID() });
  await f.state.transaction((tx) =>
    tx.run('UPDATE wf_instances SET revision=12 WHERE id=?', target.id),
  );
  const heartbeat = () =>
    dispatch.heartbeatRunner(f.admin, {
      runnerId: 'failure-runner',
      machine: { hostname: 'fixture', system: process.platform, architecture: process.arch },
      platforms: [platform],
      capacity: 1,
    });
  await heartbeat();
  const secrets = new Map<string, string>();
  const lease = async () => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const result = await dispatch.lease(f.admin, {
      runnerId: 'failure-runner',
      requestId: randomUUID(),
      secret,
      platform: { name: platform.name, harness: platform.harness },
    });
    if (result.session) secrets.set(result.session.id, secret);
    return result;
  };
  const authenticate = (sessionId: string) => f.sessions.authenticate(secrets.get(sessionId)!);
  const demand = (name = platform.name) =>
    dispatch.dispatchDemand(f.admin, { platform: { ...platform, name } });
  const offered = await lease();
  assert.ok(offered.session, offered.reason);
  assert.equal(offered.session.expectedRevision, 12);
  assert.equal(offered.session.assignment.workStart, null);
  await authenticate(offered.session.id);
  const sourceStarts = await f.workflows.workStarts(f.admin, target.id);
  assert.equal(sourceStarts.length, 1);
  assert.equal(sourceStarts[0].version, 40);
  assert.equal(sourceStarts[0].revision, 12);
  await f.sessions.release(f.admin, {
    sessionId: offered.session.id,
    runnerId: 'failure-runner',
    outcome: 'host_failed',
  });
  const retained = () =>
    f.state.read(async (sql) => ({
      usage: await sql.get('SELECT * FROM session_usage WHERE session_id=?', offered.session!.id),
      dispatch: await sql.get(
        'SELECT * FROM session_dispatch_receipts WHERE session_id=?',
        offered.session!.id,
      ),
    }));
  const sourceRows = await retained();
  assert.equal(sourceRows.usage?.revision, 12);
  assert.equal(sourceRows.usage?.outcome, 'host_failed');
  assert.ok(sourceRows.dispatch, 'the failure came from real automatic dispatch');
  const hold = await f.state.read((sql) =>
    sql.get<{ attempts: number; last_session_id: string }>(
      'SELECT attempts,last_session_id FROM session_dispatch_holds WHERE instance_id=? AND revision=12',
      target.id,
    ),
  );
  assert.equal(hold?.attempts, 1);
  assert.equal(
    hold.last_session_id,
    offered.session.id,
    'this case relies on recent session failure, not offer-only backoff',
  );
  assert.deepEqual(await lease(), { session: null, reason: 'retry_backoff' });
  assert.deepEqual((await demand()).candidates, []);
  await f.state.transaction((tx) =>
    migrateNativeWorkflow(tx, {
      projectId: f.admin.projectId,
      instanceId: target.id,
      expectedRevision: 12,
      fromVersion: 40,
      toVersion: 45,
      actorId: f.admin.actorId,
      reason: 'Retain dispatch backoff across the protocol conversion.',
    }),
  );
  assert.deepEqual(
    await retained(),
    sourceRows,
    'migration does not rewrite session usage or dispatch provenance',
  );
  return {
    ...f,
    dispatch,
    current,
    target,
    demand,
    lease,
    authenticate,
    retained,
    sourceRows,
    sourceStarts,
    advance: async () => {
      clock += 31_000;
      await heartbeat();
    },
  };
}

test('recent dispatched-session failure keeps runner and platform backoff across migration until expiry', async (t) => {
  const f = await dispatchedFailure(t);
  assert.deepEqual(
    (await f.workflows.evaluate(f.admin, f.target.id)).workStart,
    f.sourceStarts[0],
    'workflow guidance keeps the original version, revision, timestamp and event',
  );
  assert.deepEqual(
    (await f.demand()).candidates,
    [],
    'prospective hosts on the failed platform retain its backoff',
  );
  assert.deepEqual(
    await f.lease(),
    { session: null, reason: 'retry_backoff' },
    'the same runner cannot evade its recent failure through migration',
  );
  assert.deepEqual(
    (await f.demand('another-platform')).candidates.map((item) => item.expectedRevision),
    [13],
    'platform failure history is scoped to that platform',
  );
  await f.advance();
  assert.deepEqual(
    (await f.demand()).candidates.map((item) => item.expectedRevision),
    [13],
  );
  const offered = await f.lease();
  assert.ok(offered.session, offered.reason);
  assert.equal(offered.session.instanceId, f.target.id);
  assert.equal(offered.session.expectedRevision, 13);
  assert.deepEqual(offered.session.assignment.workStart, f.sourceStarts[0]);
  await f.authenticate(offered.session.id);
  assert.deepEqual(
    await f.workflows.workStarts(f.admin, f.target.id),
    f.sourceStarts,
    'migrated authentication retains the original work-start fact without adding a new row',
  );
  assert.deepEqual(await f.retained(), f.sourceRows);
});

test('an ordinary user revision after migration does not inherit the source dispatched-session backoff', async (t) => {
  const f = await dispatchedFailure(t);
  assert.deepEqual(await f.lease(), { session: null, reason: 'retry_backoff' });
  await f.current.transition(f.admin, {
    instanceId: f.target.id,
    expectedRevision: 13,
    action: 'submit_design',
    requestId: randomUUID(),
  });
  await f.current.transition(f.admin, {
    instanceId: f.target.id,
    expectedRevision: 14,
    action: 'revise_design',
    requestId: randomUUID(),
  });
  assert.equal((await f.workflows.evaluate(f.admin, f.target.id)).workStart, null);
  assert.deepEqual(
    (await f.demand()).candidates.map((item) => item.expectedRevision),
    [15],
  );
  const offered = await f.lease();
  assert.ok(offered.session, offered.reason);
  assert.equal(offered.session.expectedRevision, 15);
  assert.equal(offered.session.assignment.workStart, null);
  await f.authenticate(offered.session.id);
  const starts = await f.workflows.workStarts(f.admin, f.target.id);
  assert.equal(starts.length, 2, 'an ordinary revision begins distinct work');
  assert.deepEqual(starts[0], f.sourceStarts[0]);
  assert.equal(starts[1].version, 45);
  assert.equal(starts[1].revision, 15);
  assert.deepEqual(await f.retained(), f.sourceRows);
});
