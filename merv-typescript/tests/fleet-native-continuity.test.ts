import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExperimentService } from '@merv/experiments';
import { FleetWorkflowAdapter } from '@merv/fleet/workflow';
import { modelMigrations } from '@merv/fleet/schema';
import type { Fleet, FleetAllocation } from '@merv/fleet/types';
import { migrateNativeWorkflow } from '@merv/workflows/native-migration';
import { createApp } from './fixtures/app.js';
import { taskActors } from './fixtures/task-actors.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-fleet-continuity-'));
  const app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { operator, producer } = await taskActors(app, 'Fleet migration continuity');
  const caller = producer.caller;
  const state = app.ctx.state;
  await state.migrate('fleet_workflow', modelMigrations);
  await waitForManagedCode(app.ctx.codeWork, caller);
  await app.ctx.sessions.dispatch.setDispatch(operator, { enabled: true, ownMachines: false });
  const experiments = app.ctx.experiments as ExperimentService;
  const native = experiments.handles.get(45)!;
  experiments.handles.set(45, experiments.handles.get(40)!);
  let created;
  try {
    created = await experiments.create(caller, {
      name: 'retain-rental-window',
      intent: 'Keep failed rental attempts across the protocol migration.',
      requestId: randomUUID(),
    });
  } finally {
    experiments.handles.set(45, native);
  }
  const instanceId = created.id;
  let clock = Date.now();
  const began = new Date(clock - 600_000).toISOString();
  await state.transaction((tx) =>
    tx.run('UPDATE wf_instances SET updated_at=? WHERE id=?', began, instanceId),
  );
  const source = await app.ctx.scope.delegationSource(caller);
  const allocations: FleetAllocation[] = [];
  const fleet = {
    allocationSeconds: 86_400,
    listOwned: async (_owner: unknown, ids: string[]) =>
      allocations.filter((allocation) => ids.includes(allocation.owner.id)),
  } as unknown as Fleet;
  const adapter = new FleetWorkflowAdapter(
    fleet,
    app.ctx.sessions,
    app.ctx.scope,
    { people: ['*'], modelApiKeyEnv: 'MERV_TEST_NO_MODEL', baseUrl: 'https://example.invalid' },
    () => clock,
    state,
  );
  // Retry records a grant and wakes reconciliation; this fixture observes admission only.
  t.mock.method(adapter, 'reconcile', async () => {});
  const addFailedRental = (ago: number) => {
    const id = `allocation_${allocations.length}`;
    const at = new Date(clock - ago).toISOString();
    allocations.push({
      id,
      projectId: caller.projectId,
      source,
      owner: { kind: 'workflow', id: `work:${instanceId}` },
      requestId: id,
      profileId: 'fixture',
      epoch: 1,
      phase: 'released',
      intent: 'stop',
      runtime: {
        sandboxId: id,
        state: 'stopped',
        ready: false,
        leaseExpiresAt: at,
        revision: 1,
        launch: null,
      },
      createAttempted: true,
      createdAt: at,
      deadlineAt: at,
      updatedAt: at,
      retryAt: null,
      failures: 1,
      error: 'runtime_not_ready',
    });
  };
  const status = async (expectedRevision: number) =>
    (await adapter.retryStatus(operator, [{ instanceId, expectedRevision }]))[0]!;
  const grants = () =>
    state.read((sql) => sql.all('SELECT * FROM fleet_workflow_retry_grants ORDER BY id'));
  const grant = (expectedRevision: number) =>
    adapter.retry(operator, {
      instanceId,
      expectedRevision,
      reason: 'The failed machine provisioning has been repaired.',
      requestId: randomUUID(),
    });
  // The candidate runtime correctly refuses legacy dispatch. Seed the immutable grant the
  // previous runtime had already admitted, then exercise only current public retry methods.
  const historicalGrant = () =>
    state.transaction((tx) =>
      tx.run(
        `INSERT INTO fleet_workflow_retry_grants(project_id,instance_id,expected_revision,prior_allocations,request_id,input_hash,reason,actor_id,created_at)
     VALUES(?,?,0,?,'old-retry','historical-input','Repaired before cutover',?,?)`,
        caller.projectId,
        instanceId,
        allocations.length,
        operator.actorId,
        new Date(clock - 90_000).toISOString(),
      ),
    );
  const migrate = () =>
    state.transaction((tx) =>
      migrateNativeWorkflow(tx, {
        projectId: caller.projectId,
        instanceId,
        expectedRevision: 0,
        fromVersion: 40,
        toVersion: 45,
        actorId: operator.actorId,
        reason: 'Keep this unfinished work under the native Git protocol.',
      }),
    );
  return {
    app,
    state,
    operator,
    caller,
    native,
    instanceId,
    began,
    allocations,
    adapter,
    addFailedRental,
    status,
    grant,
    historicalGrant,
    grants,
    migrate,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('protocol migration preserves Fleet rental exhaustion and cooldown without a retry grant', async (t) => {
  const f = await fixture(t);
  f.addFailedRental(90_000);
  f.addFailedRental(30_000);
  const cooldownUntil = new Date(Date.parse(f.allocations[1]!.updatedAt) + 60_000).toISOString();
  const rentals = structuredClone(f.allocations);
  await f.migrate();
  const after = await f.status(1);
  assert.equal(after.state, 'exhausted_cooldown');
  assert.equal(after.unclaimedAttempts, 2);
  assert.equal(after.cooldownUntil, cooldownUntil);
  assert.deepEqual(f.allocations, rentals);
  assert.deepEqual(await f.grants(), []);
  assert.equal((await f.status(0)).state, 'not_current_demand');
  f.advance(61_000);
  assert.equal((await f.status(1)).state, 'exhausted_unclaimed');

  // A real user dependency change still begins a fresh rental allowance.
  const dependency = await f.app.ctx.workflows.register(
    {
      name: 'fleet-complete-input',
      version: 1,
      initial: 'done',
      states: ['done'],
      terminal: ['done'],
      edges: [],
    },
    { successStates: ['done'], actions: [] },
  );
  const done = await dependency.start(f.caller, {
    workflow: 'fleet-complete-input',
    requestId: randomUUID(),
  });
  const changed = await f.native.addDependencies(f.caller, {
    instanceId: f.instanceId,
    expectedRevision: 1,
    dependsOn: [done.id],
    requestId: randomUUID(),
  });
  assert.equal(changed.revision, 2);
  const revised = await f.status(2);
  assert.equal(revised.state, 'ready');
  assert.equal(revised.unclaimedAttempts, 0);
});

test('a migrated Fleet retry grant retains its window and a new current-revision grant supersedes it', async (t) => {
  const f = await fixture(t);
  f.addFailedRental(180_000);
  f.addFailedRental(120_000);
  await f.historicalGrant();
  const original = await f.grants();
  f.addFailedRental(30_000);
  const cooldownUntil = new Date(Date.parse(f.allocations[2]!.updatedAt) + 60_000).toISOString();
  await f.migrate();
  const after = await f.status(1);
  assert.equal(after.state, 'cooldown');
  assert.equal(after.unclaimedAttempts, 1);
  assert.equal(after.cooldownUntil, cooldownUntil);
  assert.deepEqual(await f.grants(), original, 'migration never rewrites an operator grant');
  f.advance(61_000);
  assert.equal((await f.status(1)).state, 'ready');
  f.addFailedRental(0);
  assert.equal((await f.status(1)).state, 'exhausted_cooldown');
  f.advance(61_000);
  await f.grant(1);
  assert.equal((await f.status(1)).state, 'ready');
  assert.equal((await f.status(1)).unclaimedAttempts, 0);
  assert.deepEqual((await f.grants()).slice(0, 1), original);
});
