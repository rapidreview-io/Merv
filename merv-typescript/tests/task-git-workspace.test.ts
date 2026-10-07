import type { TaskDelivery, TaskReview } from '@merv/tasks/types';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveWorkspace, type Transaction } from '@merv/contracts';
import { reviewedFindings } from './fixtures/task-evidence.js';
import { currentTaskSuite as fixture } from './fixtures/current-task-suite.js';

test('current tasks use managed Git and accept only their own leased worker commit', async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  assert.equal(task.workflow.version, 39);
  const policy = (await f.app.ctx.workflows.assignment(f.owner, task.id)).execution.policy!;
  const workspace = effectiveWorkspace(policy);
  assert.equal(workspace.mode === 'none' ? undefined : workspace.driver, 'code.v2');
  assert.equal(workspace.mode === 'none' ? undefined : workspace.base, 'reference:base');
  const prepared = await f.delivery(task);
  await assert.rejects(
    f.app.ctx.tasks.submitDelivery(prepared.held.worker, {
      ...prepared.input,
      commandId: undefined,
    }),
    { code: 'task_commit_required' },
  );
  const other = await f.delivery(await f.create());
  await assert.rejects(
    f.app.ctx.tasks.submitDelivery(prepared.held.worker, {
      ...prepared.input,
      commandId: other.input.commandId,
    }),
    { code: 'task_commit_provenance' },
  );
  const before = await f.snapshot();
  const unrelated = await f.app.ctx.artifacts.create(f.owner, {
    title: 'Unrelated evidence',
    content: 'This actor did not produce the leased work.',
  });
  await assert.rejects(
    f.app.ctx.tasks.submitDelivery(prepared.held.worker, {
      ...prepared.input,
      artifactIds: [unrelated.id],
    }),
    { code: 'invalid_delivery' },
  );
  assert.deepEqual((await f.snapshot()).tasks, before.tasks);
  const pending = await f.submit(prepared);
  assert.equal(pending.workflow.state, 'in_review');
  assert.equal(pending.deliveryCode!.ref.commandId, prepared.input.commandId);
  assert.equal(pending.deliveryIds.length, 3);
  assert.ok(pending.deliveryIds.includes(pending.deliveryAssessmentId!));
});

test('current delivery assessment, review and transition roll back together after a late fault', async (t) => {
  const f = await fixture(t);
  const prepared = await f.delivery(await f.create());
  const before = await f.snapshot();
  const append = f.app.ctx.state.appendEvent.bind(f.app.ctx.state);
  t.mock.method(
    f.app.ctx.state,
    'appendEvent',
    async (tx: Transaction, event: Parameters<typeof append>[1]) => {
      const result = await append(tx, event);
      if (event.type === 'task.delivery_submitted') throw new Error('late delivery fault');
      return result;
    },
  );
  await assert.rejects(
    f.work.run(prepared.held, 'task.submit_delivery', prepared.input, (caller, input) =>
      f.app.ctx.tasks.submitDelivery(caller, input as unknown as TaskDelivery),
    ),
    /late delivery fault/,
  );
  assert.deepEqual(await f.snapshot(), before);
  t.mock.restoreAll();
  const pending = await f.submit(prepared);
  assert.equal(pending.workflow.state, 'in_review');
  assert.equal((await f.snapshot()).reviewCommands.length, before.reviewCommands.length + 1);
});

test('independent leased review rejects fabricated claims and atomically rolls back verdict routing', async (t) => {
  const f = await fixture(t);
  const pending = await f.submit(await f.delivery(await f.create()));
  await assert.rejects(f.app.ctx.reviews.start(f.reviewer, pending.reviewId!), {
    code: 'leased_review_required',
  });
  const { held, review } = await f.claim(pending);
  const input = {
    ...reviewedFindings(review),
    reviewId: review.id,
    claimId: review.claimId!,
    expectedRevision: pending.workflow.revision,
    verdict: 'pass',
    notes: 'Opened and checked the committed arithmetic evidence independently.',
    requestId: f.work.request(),
  };
  await assert.rejects(
    f.app.ctx.tasks.submitReview(held.worker, { ...input, claimId: 'fabricated' } as TaskReview),
    { code: 'stale_claim' },
  );
  const before = await f.snapshot();
  const append = f.app.ctx.state.appendEvent.bind(f.app.ctx.state);
  t.mock.method(
    f.app.ctx.state,
    'appendEvent',
    async (tx: Transaction, event: Parameters<typeof append>[1]) => {
      const result = await append(tx, event);
      if (event.type === 'task.review_applied') throw new Error('late verdict fault');
      return result;
    },
  );
  await assert.rejects(
    f.work.run(held, 'review.submit', input, (caller, bound) =>
      f.app.ctx.tasks.submitReview(caller, bound as unknown as TaskReview),
    ),
    /late verdict fault/,
  );
  assert.deepEqual(await f.snapshot(), before);
  t.mock.restoreAll();
  const done = await f.work.run(held, 'review.submit', input, (caller, bound) =>
    f.app.ctx.tasks.submitReview(caller, bound as unknown as TaskReview),
  );
  assert.equal(done.workflow.state, 'done');
  assert.equal((await f.app.ctx.reviews.get(f.owner, review.id)).verdict, 'pass');
  await f.work.release(held);
});

test('a returned current task carries findings and preserves its earlier immutable review evidence', async (t) => {
  const f = await fixture(t);
  const pending = await f.submit(await f.delivery(await f.create()));
  const { held, review } = await f.claim(pending);
  const revised = await f.work.run(
    held,
    'review.submit',
    {
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'needs_changes',
      notes: 'Add an independently reproducible negative-input execution.',
      requestId: f.work.request(),
    },
    (caller, input) => f.app.ctx.tasks.submitReview(caller, input as unknown as TaskReview),
  );
  await f.work.release(held);
  const saved = await f.app.ctx.reviews.get(f.owner, review.id);
  const context = await f.app.ctx.tasks.context(f.owner, {
    taskId: revised.id,
    purpose: 'work',
    expectedRevision: revised.workflow.revision,
    requestId: f.work.request(),
  });
  assert.match(context.prompt, /negative-input execution/);
  const next = await f.submit(await f.delivery(revised));
  assert.notEqual(next.reviewId, review.id);
  assert.deepEqual(await f.app.ctx.reviews.get(f.owner, review.id), saved);
  await assert.rejects(
    f.app.ctx.state.transaction((tx) =>
      tx.run('UPDATE reviews SET snapshot_hash=? WHERE id=?', 'changed', review.id),
    ),
    { code: 'state_constraint' },
  );
});
