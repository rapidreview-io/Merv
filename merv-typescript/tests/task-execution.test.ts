import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller, Data, SessionToolPolicy, Task, TaskCheckpointInput } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { countWrites } from './fixtures/state.js';
import type { PostgresState } from '@merv/state';
import { confirmedDelivery } from './fixtures/task-evidence.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-execution-'));
  const app = await createApp({ directory });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Execution', actorName: 'Operator' });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const { sessions } = app.ctx;
  let sequence = 0;
  /** A session as a runner takes one, and its worker. */
  const offer = async (task: Task) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(operator, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
      runnerId: 'test',
      requestId: `offer-${++sequence}`,
      secret,
    });
    return { session, worker: await sessions.authenticate(secret) };
  };
  const release = async (sessionId: string) => {
    await sessions.release(operator, { sessionId, runnerId: 'test' });
    await app.ctx.domainEvents.drain();
  };
  const run = async <T>(
    worker: Caller,
    tool: string,
    input: Data,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ) => await sessions.run(await sessions.prepare(worker, tool, input), handler);
  const create = async (requestId: string) =>
    await app.ctx.tasks.create(operator, {
      title: 'Verify execution boundaries',
      goal: 'Keep workflow execution confined to its assignment.',
      checks: ['Only permitted sources and the current claim can be used.'],
      requestId,
    });
  const pending = async () => {
    const { session, worker } = await offer(await create('review-task'));
    const proof = await run(
      worker,
      'artifact.create',
      {
        title: 'Verification evidence',
        content: 'The fixture retains evidence for independent review.',
      },
      async (caller, input) =>
        await app.ctx.artifacts.create(caller, input as { title: string; content: string }),
    );
    const delivered = await run(
      worker,
      'task.submit_delivery',
      confirmedDelivery({ artifactIds: [proof.id], requestId: 'submit' }),
      async (caller, input) => await app.ctx.tasks.submitDelivery(caller, input as never),
    );
    await release(session.id);
    return delivered;
  };
  return { app, operator, offer, release, run, create, pending };
}

test('policy-checked checkpoints cannot expose an unrelated artifact through assignment context', async (t) => {
  const { app, operator, offer, run, create } = await fixture(t);
  const task = await create('work-task');
  const unrelated = await app.ctx.artifacts.create(operator, {
    title: 'Unrelated document',
    content: 'UNRELATED_CHECKPOINT_CONTENT_239807',
  });
  const { worker } = await offer(task);
  const reads = t.mock.method(app.ctx.artifacts, 'bytes');
  // INSERT/UPDATE/DELETE statements issued through the state, rolled back or not.
  const written = countWrites(app.ctx.state as PostgresState);
  const writes = async () => {
    await app.ctx.domainEvents.drain();
    return written();
  };
  const before = await writes();
  const head = await app.ctx.state.eventHead();
  await assert.rejects(
    async () =>
      await run(
        worker,
        'task.checkpoint',
        {
          notes: 'Try adding a source outside the assignment.',
          artifactIds: [unrelated.id],
          requestId: 'unrelated',
        },
        async (caller, input) =>
          await app.ctx.tasks.checkpoint(caller, input as unknown as TaskCheckpointInput),
      ),
    { code: 'execution_arguments_forbidden' },
  );
  assert.equal(await writes(), before, 'Rejected admission must not reach the checkpoint mutation');
  assert.equal(await app.ctx.state.eventHead(), head);
  assert.equal(reads.mock.callCount(), 0, 'Admission must not fetch artifact bytes');
  const assignment = await app.ctx.workflows.assignment(worker, task.id);
  assert.doesNotMatch(assignment.context!.prompt, /UNRELATED_CHECKPOINT_CONTENT_239807/);
  assert.ok(reads.mock.calls.every((call) => call.arguments[1] !== unrelated.id));
  assert.equal(await writes(), before);

  const checkpoints: Data[] = [
    { notes: 'Text-only progress.', requestId: 'text' },
    { notes: 'Pinned source only.', artifactIds: [task.briefId], requestId: 'pinned' },
  ];
  for (const input of checkpoints) {
    const checkpoint = await run(
      worker,
      'task.checkpoint',
      input,
      async (caller, bound) =>
        await app.ctx.tasks.checkpoint(caller, bound as unknown as TaskCheckpointInput),
    );
    assert.deepEqual(checkpoint.artifactIds, input.artifactIds ?? []);
  }
});

test('a review session binds the claim its lease took, and a successor binds only its own', async (t) => {
  const { app, operator, offer, release, pending } = await fixture(t);
  const task = await pending();
  const first = await offer(task);
  const claim = (await app.ctx.reviews.get(operator, task.reviewId!)).claimId!;
  assert.ok(claim);
  assert.equal(
    (await app.ctx.sessions.prepare(first.worker, 'review.submit', {})).input.claimId,
    claim,
  );
  await release(first.session.id);
  const next = await offer(task);
  const current = (await app.ctx.reviews.get(operator, task.reviewId!)).claimId!;
  assert.notEqual(current, claim);
  await assert.rejects(
    async () => await app.ctx.sessions.prepare(next.worker, 'review.submit', { claimId: claim }),
    { code: 'execution_arguments_forbidden' },
  );
  assert.equal(
    (await app.ctx.sessions.prepare(next.worker, 'review.submit', {})).input.claimId,
    current,
  );
});

test('metadata admission avoids rendering, binds each session to its own record and leaves reads open', async (t) => {
  const { app, offer, create, pending } = await fixture(t);
  const review = await pending();
  const work = await create('work-task');
  const sessions = [
    { task: work, worker: (await offer(work)).worker },
    { task: review, worker: (await offer(review)).worker },
  ];
  t.mock.method(app.ctx.artifacts, 'read', () => {
    assert.fail('Execution admission must not read artifact bytes');
  });
  t.mock.method(app.ctx.workflows, 'evaluate', () => {
    assert.fail('Execution admission must not evaluate exit guidance or hydrate context');
  });
  // As the tool registry calls it, which marks a read tool.
  const policy: SessionToolPolicy = app.ctx.sessions;
  for (const { task, worker } of sessions) {
    assert.equal((await app.ctx.sessions.prepare(worker, 'task.get', {})).input.taskId, task.id);
    // Leaving the instance out asks what the whole project is doing. Filling it in from the
    // binding would answer for this worker's own record — a different question.
    assert.deepEqual(
      (await policy.prepare(worker, 'workflow.status_and_next', {}, true)).input,
      {},
    );
    assert.deepEqual(
      (await policy.prepare(worker, 'workflow.status_and_next', { instanceId: task.id }, true))
        .input,
      { instanceId: task.id },
    );
    // Without the read mark the published binding holds, and fills in what was left out.
    assert.deepEqual(
      (await app.ctx.sessions.prepare(worker, 'workflow.status_and_next', {})).input,
      { instanceId: task.id },
    );
    // Every session reads whatever the project holds; only a read marked as one opens.
    const outside = { artifactId: 'art_outside_the_packet' };
    assert.equal(
      (await policy.prepare(worker, 'artifact.read', outside, true)).input.artifactId,
      'art_outside_the_packet',
    );
    await assert.rejects(
      async () => await app.ctx.sessions.prepare(worker, 'artifact.read', outside),
      { code: 'execution_arguments_forbidden' },
    );
  }
});
