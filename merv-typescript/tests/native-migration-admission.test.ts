import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { NATIVE_CODE_DRIVER } from '@merv/contracts';
import { ExperimentService } from '@merv/experiments';
import { programVersion } from '@merv/experiments/program';
import { LeasedSessions } from '@merv/sessions';
import type { HoldRow } from '@merv/sessions/dispatch';
import { migrateNativeWorkflow } from '@merv/workflows/native-migration';
import { createApp } from './fixtures/app.js';
import { taskActors } from './fixtures/task-actors.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

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
    const current = owner.handles.get(programVersion)!;
    owner.handles.set(programVersion, owner.handles.get(40)!);
    let experiment;
    try {
      experiment = await owner.create(source, {
        name: 'retain-held-work',
        intent: 'Preserve the pending plan.',
        requestId: randomUUID(),
      });
    } finally {
      owner.handles.set(programVersion, current);
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
