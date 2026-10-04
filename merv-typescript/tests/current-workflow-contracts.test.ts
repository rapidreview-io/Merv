import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, MervError } from '@merv/contracts';
import { nativeTask, TaskService } from '@merv/tasks';
import { ExperimentService } from '@merv/experiments';
import type { SandboxCompute, SandboxRental } from '@merv/sandboxes/types';
import { nativeExperiment } from '../packages/experiments/src/program.js';
import { createApp } from './fixtures/app.js';

// Captured before retirement. These include the graph, success states and every fixed
// execution manifest: pruning history must not change current worker permissions.
const current = {
  'task@6': '9e61a6e5e930fedbdb21dc5312637e3acea38f886e5a3674f9294bd854f8263c',
  'task@11': 'c01c239aec645fcff44e7727737c332a8086ecd2ea022df5e5c8d6b1680e5d60',
  'task@31': 'a3f8c5370031fcc7b8c5bc3bbdfaaf379f7f15ec1de3df4b2e07a0baaa73fd2e',
  'task@35': '471c6614ab9fefda1426e1165839a1678fdc512352c9e0e688e3921a5c7af84b',
  'task@39': '125c77e994c38591382d2819f27672d2775fa4c06f65b7416204f4cbfe87cbd0',
  'task@43': 'c1f2f37f67bc6ee96c86d7345419b6708d6938fd4f535c55f29720a84d22779b',
  'experiment@28': '2d803d79781cda656f6607697fc66a4fb9af15098e3a3410f2bd8ac314f43854',
  'experiment@32': '82baa1d27a93b1cef4f526e86f1b7e561fc842ae615995edc9d97e7746d80129',
  'experiment@36': 'f6a4a1ea1ee638d8edd729414215fed080599dae1aadc4dac5255d2718c6a44c',
  'experiment@40': '183e98516c3c980d63cbf45603684978a2a8338afdff451674700b59693d5e07',
};

test('only current work contracts register, with unchanged permissions across restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-current-contracts-'));
  let app = await createApp({ directory });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  for (let boot = 0; boot < 2; boot++) {
    const catalog = app.ctx.workflows
      .catalog()
      .filter(({ name }) => ['task', 'experiment'].includes(name));
    assert.deepEqual(
      catalog.map(({ name, version }) => `${name}@${version}`).sort(),
      Object.keys(current).sort(),
    );
    for (const [key, expected] of Object.entries(current)) {
      const [name, version] = key.split('@');
      assert.equal(digest(await app.ctx.workflows.pinned(name!, Number(version))), expected, key);
    }
    for (const [name, last] of [
      ['task', 43],
      ['experiment', 40],
    ] as const) {
      for (let version = 1; version <= last; version++) {
        if (`${name}@${version}` in current) continue;
        assert.equal(
          await app.ctx.workflows.pinned(name, version),
          null,
          `${name}@${version} retired`,
        );
      }
    }
    if (!boot) {
      await app.stop();
      app = await createApp({ directory });
    }
  }
});

test('retired contracts cannot silently become scratch or non-native work', () => {
  for (const version of [2, 5, 28, 29, 30, 36, 40, 999])
    assert.throws(() => nativeTask(version), { code: 'workflow_version_retired' });
  for (const version of [1, 5, 8, 25, 27, 33, 37, 999])
    assert.throws(() => nativeExperiment(version), { code: 'workflow_version_retired' });
});

test('retired work survives restart as readable history, with no new claims or mutations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-archived-work-'));
  let app = await createApp({ directory });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'History', actorName: 'Owner' });
  const owner = { projectId: boot.project.id, actorId: boot.actor.id };
  const actor = await app.ctx.scope.issueActor(owner, { name: 'Reviewer', role: 'reviewer' });
  const reviewer = { projectId: owner.projectId, actorId: actor.actor.id };
  const artifact = await app.ctx.artifacts.create(owner, {
    title: 'Evidence',
    content: 'Retained original bytes.',
  });
  const ids: string[] = [];
  const reviews: string[] = [];
  // Reproduce stored, pinned records from a former installation. No old owner code is loaded.
  for (const [name, version, active] of [
    ['task', 28, 31],
    ['experiment', 25, 28],
  ] as const) {
    const pinned = (await app.ctx.workflows.pinned(name, active))!;
    const handle = await app.ctx.workflows.register({ ...pinned.definition, version });
    const workflow = await handle.start(owner, {
      workflow: name,
      version,
      requestId: `historical-${name}`,
      data: { title: name, name, goal: 'Original goal' },
    });
    ids.push(workflow.id);
    const review = await app.ctx.reviews.request(owner, {
      subjectId: workflow.id,
      subjectRevision: 0,
      producerId: owner.actorId,
      artifactIds: [artifact.id],
      criteria: ['Original acceptance check'],
      requestId: `review-${name}`,
    });
    reviews.push(review.id);
    await app.ctx.state.transaction(async (tx) => {
      if (name === 'task') {
        await tx.run(
          'INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at,type_name,type_version,evidence_version,review_id,delivery_ids) VALUES(?,?,?,?,?,?,?,?,?,?,2,?,?)',
          workflow.id,
          owner.projectId,
          name,
          'Original goal',
          '["Original acceptance check"]',
          owner.actorId,
          artifact.id,
          workflow.createdAt,
          'task.work',
          3,
          review.id,
          JSON.stringify([artifact.id]),
        );
      } else {
        await tx.run(
          'INSERT INTO experiments(id,project_id,name,intent,details,owner_id,created_by,created_at,tested_claim_ids,attempt_index,review_id) VALUES(?,?,?,?,?,?,?,?,?,1,?)',
          workflow.id,
          owner.projectId,
          name,
          'Original intent',
          '',
          owner.actorId,
          owner.actorId,
          workflow.createdAt,
          '[]',
          review.id,
        );
        await tx.run(
          'INSERT INTO experiment_attempts(experiment_id,attempt_index,started_revision,feedback,created_at,feedback_review_ids) VALUES(?,1,0,?,?,?)',
          workflow.id,
          '[]',
          workflow.createdAt,
          '[]',
        );
      }
    });
    handle.dispose();
  }
  const [taskId, experimentId] = ids as [string, string];
  const before = await Promise.all(ids.map((id) => app.ctx.workflows.history(owner, id)));
  await app.stop();
  app = await createApp({ directory });
  assert.equal(
    (await app.ctx.artifacts.read(owner, artifact.id)).content,
    'Retained original bytes.',
  );
  const task = await app.ctx.tasks.get(owner, taskId);
  const experiment = await app.ctx.experiments.get(owner, experimentId);
  assert.equal(task.workflow.version, 28);
  assert.equal(task.workspace, undefined);
  assert.equal(task.guidance.available, false);
  assert.equal(experiment.workflow.version, 25);
  assert.equal(experiment.workspace, undefined);
  assert.equal(experiment.attempt.index, 1);
  assert.equal((await app.ctx.tasks.list(owner)).length, 1);
  assert.equal((await app.ctx.experiments.list(owner)).length, 1);
  assert.equal((await app.ctx.experiments.occupancy(owner)).active, 0);
  assert.equal((await app.ctx.tasks.running(owner)).length, 0);
  assert.equal((await app.ctx.experiments.running(owner)).length, 0);
  assert.ok(await app.ctx.tasks.runningPanel(owner, taskId));
  assert.ok(await app.ctx.experiments.runningPanel(owner, `work:${experimentId}`));
  assert.deepEqual(await app.ctx.workflows.dispatchCandidates(owner), []);
  for (const id of ids) {
    assert.equal((await app.ctx.workflows.evaluate(owner, id)).available, false);
    assert.ok(await app.ctx.workflows.process(owner, id));
  }
  const retired = { code: 'workflow_version_retired' };
  await assert.rejects(
    app.ctx.tasks.checkpoint(owner, {
      taskId,
      purpose: 'work',
      expectedRevision: 0,
      notes: 'New work',
      requestId: 'checkpoint',
    }),
    retired,
  );
  await assert.rejects(
    app.ctx.tasks.context(owner, {
      taskId,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'context',
    }),
    retired,
  );
  await assert.rejects(
    app.ctx.tasks.markFailed(owner, {
      taskId,
      expectedRevision: 0,
      reason: 'Changed',
      requestId: 'fail',
    }),
    retired,
  );
  await assert.rejects(
    app.ctx.tasks.submitDelivery(owner, {
      taskId,
      expectedRevision: 0,
      artifactIds: [artifact.id],
      confirmations: [],
      requestId: 'delivery',
    }),
    retired,
  );
  await assert.rejects(
    app.ctx.experiments.attach(owner, {
      experimentId,
      attemptIndex: 1,
      expectedRevision: 0,
      artifactId: artifact.id,
      role: 'plan',
      path: 'plan.md',
      requestId: 'attach',
    }),
    retired,
  );
  await assert.rejects(
    app.ctx.experiments.transition(owner, {
      experimentId,
      expectedRevision: 0,
      transition: 'abandon',
      evidence: { reason: 'Changed' },
      requestId: 'abandon',
    }),
    retired,
  );
  for (const reviewId of reviews) {
    await assert.rejects(app.ctx.reviews.start(reviewer, reviewId), retired);
    assert.equal((await app.ctx.reviews.get(owner, reviewId)).status, 'requested');
  }
  assert.deepEqual(
    await Promise.all(ids.map((id) => app.ctx.workflows.history(owner, id))),
    before,
  );
  assert.equal((await app.ctx.tasks.get(owner, taskId)).workflow.revision, 0);
  assert.deepEqual((await app.ctx.experiments.get(owner, experimentId)).evidence, []);
});

test('retired compute never launches after restart and retries cleanup without changing history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-retired-compute-'));
  let app = await createApp({ directory });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Retired compute',
    actorName: 'Owner',
  });
  const owner = { projectId: boot.project.id, actorId: boot.actor.id };
  const artifact = await app.ctx.artifacts.create(owner, {
    title: 'Original brief',
    content: 'Keep.',
  });
  const ids: string[] = [];
  // Restore ledger rows from a former deployment; no retired execution policy is installed.
  for (const [name, version, currentVersion, initial] of [
    ['task', 28, 31, 'in_progress'],
    ['experiment', 25, 28, 'running'],
  ] as const) {
    const pinned = (await app.ctx.workflows.pinned(name, currentVersion))!;
    const handle = await app.ctx.workflows.register({ ...pinned.definition, version, initial });
    const workflow = await handle.start(owner, {
      workflow: name,
      version,
      requestId: `archive-${name}`,
      data: {},
    });
    ids.push(workflow.id);
    await app.ctx.state.transaction(async (tx) => {
      if (name === 'task') {
        await tx.run(
          'INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at,type_name,type_version,evidence_version) VALUES(?,?,?,?,?,?,?,?,?,?,2)',
          workflow.id,
          owner.projectId,
          name,
          'Original goal',
          '["Original check"]',
          owner.actorId,
          artifact.id,
          workflow.createdAt,
          'task.work',
          3,
        );
      } else {
        await tx.run(
          'INSERT INTO experiments(id,project_id,name,intent,details,owner_id,created_by,created_at,tested_claim_ids,attempt_index) VALUES(?,?,?,?,?,?,?,?,?,1)',
          workflow.id,
          owner.projectId,
          name,
          'Original intent',
          '',
          owner.actorId,
          owner.actorId,
          workflow.createdAt,
          '[]',
        );
        await tx.run(
          'INSERT INTO experiment_attempts(experiment_id,attempt_index,started_revision,feedback,created_at,feedback_review_ids) VALUES(?,1,0,?,?,?)',
          workflow.id,
          '[]',
          workflow.createdAt,
          '[]',
        );
      }
      for (const [key, runId, state] of [
        ['pending', null, 'submitting'],
        ['live', `${name}-run`, 'running'],
      ] as const) {
        await tx.run(
          'INSERT INTO managed_compute_runs(project_id,owner_kind,owner_id,generation,key,input_hash,input_json,run_id,state,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          owner.projectId,
          name,
          workflow.id,
          name === 'task' ? 0 : 1,
          key,
          'stored-hash',
          JSON.stringify({
            command: 'echo retired',
            provider: 'test',
            offerId: 'gpu',
            minutes: 5,
            maxUsd: 1,
          }),
          runId,
          state,
          owner.actorId,
          workflow.createdAt,
          workflow.createdAt,
        );
      }
      for (const [key, sandboxId, state, attemptedAt] of [
        ['pending', null, 'queued', null],
        ['live', `${name}-machine`, 'ready', workflow.createdAt],
        ['uncertain', null, 'queued', workflow.createdAt],
      ] as const) {
        await tx.run(
          'INSERT INTO work_compute_machines(project_id,owner_kind,owner_id,key,input_json,sandbox_id,state,attempted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
          owner.projectId,
          name,
          workflow.id,
          key,
          JSON.stringify({ key, provider: 'test', offerId: 'gpu', minutes: 5 }),
          sandboxId,
          state,
          attemptedAt,
          workflow.createdAt,
        );
      }
    });
    handle.dispose();
  }
  const history = await Promise.all(ids.map((id) => app.ctx.workflows.history(owner, id)));
  await app.stop();
  app = await createApp({ directory });
  let retry = true;
  const cancelled: string[] = [],
    released: string[] = [];
  const rental = (sandboxId: string, state: string): SandboxRental => ({
    sandboxId,
    state,
    leaseExpiresAt: null,
    hourlyPrice: {},
    reason: null,
  });
  const adapter: SandboxCompute = {
    since: '2000-01-01T00:00:00Z',
    async offers() {
      throw new Error('Retired work must not request offers');
    },
    async allowance() {
      throw new Error('Cleanup must not need new allowance');
    },
    async submit() {
      assert.fail('Retired pending run launched');
    },
    async rent() {
      assert.fail('Retired pending rental launched');
    },
    async get() {
      assert.fail('Retired live run should be cancelled');
    },
    async inspectRental() {
      assert.fail('Retired live rental should be released');
    },
    async findRental(_projectId, key) {
      return rental(`recovered-${key}`, 'ready');
    },
    async cancel(_projectId, runId) {
      if (retry) throw new MervError('provider_retry', 'Try cleanup again', 503);
      cancelled.push(runId);
    },
    async releaseRental(_projectId, sandboxId) {
      if (retry) throw new MervError('provider_retry', 'Try cleanup again', 503);
      released.push(sandboxId);
      return rental(sandboxId, 'stopped');
    },
  };
  const unbindTask = (app.ctx.tasks as TaskService).bindCompute(adapter);
  const unbindExperiment = (app.ctx.experiments as ExperimentService).bindCompute(adapter);
  t.after(() => {
    unbindTask();
    unbindExperiment();
  });
  for (let pass = 0; pass < 2; pass++) {
    await app.ctx.tasks.computeTick();
    await app.ctx.experiments.computeTick();
    retry = false;
  }
  assert.deepEqual(cancelled.sort(), ['experiment-run', 'task-run']);
  assert.equal(released.length, 4);
  assert.deepEqual(released.filter((id) => !id.startsWith('recovered-')).sort(), [
    'experiment-machine',
    'task-machine',
  ]);
  assert.equal(new Set(released.filter((id) => id.startsWith('recovered-'))).size, 2);
  const ledger = await app.ctx.state.read(async (sql) => ({
    runs: await sql.all<{ state: string }>('SELECT state FROM managed_compute_runs'),
    rentals: await sql.all<{ state: string }>('SELECT state FROM work_compute_machines'),
  }));
  assert.equal(ledger.runs.length, 4);
  assert.ok(ledger.runs.every((row) => row.state === 'cancelled'));
  assert.equal(ledger.rentals.length, 6);
  assert.ok(ledger.rentals.every((row) => row.state === 'stopped'));
  assert.deepEqual(
    await Promise.all(ids.map((id) => app.ctx.workflows.history(owner, id))),
    history,
  );
  assert.equal((await app.ctx.tasks.get(owner, ids[0]!)).workflow.state, 'in_progress');
  assert.equal((await app.ctx.experiments.get(owner, ids[1]!)).workflow.state, 'running');
});
