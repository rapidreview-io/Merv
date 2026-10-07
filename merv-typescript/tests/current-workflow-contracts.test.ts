import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '@merv/contracts';
import { taskWorkspace } from '@merv/tasks';
import { currentExperiment } from '../packages/experiments/src/program.js';
import { createApp } from './fixtures/app.js';

// Captured before retirement. These include the graph, success states and every fixed
// execution manifest: pruning history must not change current worker permissions.
const current = {
  'task@11': 'c01c239aec645fcff44e7727737c332a8086ecd2ea022df5e5c8d6b1680e5d60',
  'task@43': 'c1f2f37f67bc6ee96c86d7345419b6708d6938fd4f535c55f29720a84d22779b',
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

test('retired contracts cannot silently become current work', () => {
  for (const version of [2, 5, 6, 28, 29, 30, 31, 35, 36, 39, 40, 999])
    assert.throws(() => taskWorkspace(version), { code: 'workflow_version_retired' });
  for (const version of [1, 5, 8, 25, 27, 28, 32, 33, 36, 37, 999])
    assert.equal(currentExperiment(version), false);
});

test('retired work survives restart as readable history, with no new claims or mutations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-archived-work-'));
  let app = await createApp({ directory });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'History',
    actorName: 'Owner',
  });
  const owner = { projectId: boot.project.id, actorId: boot.actor.id };
  const actor = await app.ctx.scope.credentials.issueActor(owner, {
    name: 'Reviewer',
    role: 'reviewer',
  });
  const reviewer = { projectId: owner.projectId, actorId: actor.actor.id };
  const artifact = await app.ctx.artifacts.create(owner, {
    title: 'Evidence',
    content: 'Retained original bytes.',
  });
  const ids: string[] = [];
  const reviews: string[] = [];
  // Reproduce stored, pinned records from a former installation. No old owner code is loaded.
  for (const [name, version, active] of [
    ['task', 28, 43],
    ['experiment', 25, 40],
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
          'INSERT INTO experiments(id,project_id,name,intent,details,owner_id,created_by,created_at,attempt_index,review_id) VALUES(?,?,?,?,?,?,?,?,1,?)',
          workflow.id,
          owner.projectId,
          name,
          'Original intent',
          '',
          owner.actorId,
          owner.actorId,
          workflow.createdAt,
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
