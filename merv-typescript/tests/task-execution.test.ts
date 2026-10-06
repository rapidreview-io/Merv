import type { Task, TaskCheckpointInput } from '@merv/tasks/types';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { nativeWorkFixture } from './fixtures/native-work.js';
import type { TaskService } from '@merv/tasks';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller, Data, SessionToolPolicy } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { countWrites } from './fixtures/state.js';
import type { PostgresState } from '@merv/state';
import { confirmedDelivery } from './fixtures/task-evidence.js';

async function fixture(t: TestContext, api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-execution-'));
  const app = await createApp({ directory, api, port: 0 });
  t.after(async () => {
    await work.close();
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
  const work = currentWork(app.ctx, { directory, source: operator });
  const held = new Map<string, Awaited<ReturnType<typeof work.lease>>>();
  const offer = async (task: Task) => {
    const lease = await work.lease(task);
    held.set(lease.session.id, lease);
    return lease;
  };
  const release = async (sessionId: string) => {
    await work.release(held.get(sessionId)!);
  };
  const run = async <T>(
    worker: Caller,
    tool: string,
    input: Data,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ) =>
    await sessions.invocations.run(
      await sessions.invocations.prepare(worker, tool, input),
      handler,
    );
  const create = async (requestId: string) =>
    await currentTask(app.ctx, operator, {
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
      confirmedDelivery({
        artifactIds: [proof.id],
        commandId: await work.commit(held.get(session.id)!),
        requestId: 'submit',
      }),
      async (caller, input) => await app.ctx.tasks.submitDelivery(caller, input as never),
    );
    await release(session.id);
    return delivered;
  };
  return { app, operator, offer, release, run, create, pending, work, held };
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
  // Finish asynchronous project initialization before measuring this read-only boundary.
  await waitForManagedCode(app.ctx.codeWork, operator);
  await app.ctx.domainEvents.drain();
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
    (await app.ctx.sessions.invocations.prepare(first.worker, 'review.submit', {})).input.claimId,
    claim,
  );
  await release(first.session.id);
  const next = await offer(task);
  const current = (await app.ctx.reviews.get(operator, task.reviewId!)).claimId!;
  assert.notEqual(current, claim);
  await assert.rejects(
    async () =>
      await app.ctx.sessions.invocations.prepare(next.worker, 'review.submit', { claimId: claim }),
    { code: 'execution_arguments_forbidden' },
  );
  assert.equal(
    (await app.ctx.sessions.invocations.prepare(next.worker, 'review.submit', {})).input.claimId,
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
  const policy: SessionToolPolicy = app.ctx.sessions.invocations;
  for (const { task, worker } of sessions) {
    assert.equal(
      (await app.ctx.sessions.invocations.prepare(worker, 'task.get', {})).input.taskId,
      task.id,
    );
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
      (await app.ctx.sessions.invocations.prepare(worker, 'workflow.status_and_next', {})).input,
      { instanceId: task.id },
    );
    // Every session reads whatever the project holds; only a read marked as one opens.
    const outside = { artifactId: 'art_outside_the_packet' };
    assert.equal(
      (await policy.prepare(worker, 'artifact.read', outside, true)).input.artifactId,
      'art_outside_the_packet',
    );
    await assert.rejects(
      async () => await app.ctx.sessions.invocations.prepare(worker, 'artifact.read', outside),
      { code: 'execution_arguments_forbidden' },
    );
  }
});

test('current native task leases leave compute to Sandboxes and admit registered capture evidence', async (t) => {
  const { app, operator, offer, release, run, create, work, held } = await fixture(t);
  const native = nativeWorkFixture();
  t.after((app.ctx.tasks as TaskService).bindSandboxes(native.service));
  const task = await create('native-connected');
  assert.equal(task.workflow.version, 39);
  const first = await offer(task);
  // Sandboxes derives compute from the lease itself: the unit names no scope or profile.
  assert.equal(first.session.execution.references.sandboxConnectionId, undefined);
  assert.equal(first.session.execution.references.computeProfile, undefined);
  assert.ok(
    !first.session.execution.policy.tools.some((tool) => tool.name.startsWith('task.compute_')),
  );
  assert.match(first.session.assignment.brief, /native Sandboxes MCP/);
  assert.doesNotMatch(first.session.assignment.brief, /task\.compute_/);
  await release(first.session.id);
  const second = await offer(task);
  const commandId = await work.commit(held.get(second.session.id)!);
  assert.deepEqual(second.session.execution.references, first.session.execution.references);
  const service = await app.ctx.scope.serviceActor('sandboxes', operator.projectId);
  const capture = await app.ctx.artifacts.createCollection!(service, {
    title: 'Captured evidence',
    sourceKey: 'native-test',
    files: [
      {
        name: 'result.txt',
        hash: 'a'.repeat(64),
        size: 10,
        provider: 'sandboxes',
        reference: 'verified-object',
      },
    ],
  });
  const unverified = await app.ctx.artifacts.createCollection!(service, {
    title: 'Other capture',
    sourceKey: 'native-other',
    files: [
      {
        name: 'other.txt',
        hash: 'b'.repeat(64),
        size: 12,
        provider: 'sandboxes',
        reference: 'other-object',
      },
    ],
    metadata: { ownerId: task.id },
  });
  native.verified.set(task.id, [capture.id]);
  await assert.rejects(
    app.ctx.tasks.submitDelivery(
      second.worker,
      confirmedDelivery({
        taskId: task.id,
        expectedRevision: task.workflow.revision,
        artifactIds: [unverified.id],
        requestId: 'unverified',
        commandId,
      }),
    ),
    { code: 'invalid_delivery' },
  );
  await run(
    second.worker,
    'task.checkpoint',
    { notes: 'Verified capture', artifactIds: [capture.id], requestId: 'capture-checkpoint' },
    (caller, input) => app.ctx.tasks.checkpoint(caller, input as unknown as TaskCheckpointInput),
  );
  const delivered = await run(
    second.worker,
    'task.submit_delivery',
    confirmedDelivery({ artifactIds: [capture.id], commandId, requestId: 'native-delivery' }),
    (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
  );
  assert.equal(delivered.workflow.state, 'in_review');
  await release(second.session.id);
  const independent = await app.ctx.scope.issueActor(operator, {
    name: 'Independent',
    role: 'operator',
  });
  const reviewer = {
    actorId: independent.actor.id,
    projectId: operator.projectId,
    credentialId: independent.credential.id,
  };
  const reviewLease = await work.lease(delivered, reviewer);
  const reviewSession = reviewLease.session;
  assert.match(reviewSession.assignment.brief, /brief verification only/);
  assert.ok((reviewSession.execution.references.artifacts as string[]).includes(capture.id));
  await work.release(reviewLease);
  await app.ctx.domainEvents.drain();
  await app.ctx.tasks.markFailed(operator, {
    taskId: task.id,
    expectedRevision: delivered.workflow.revision,
    reason: 'End fixture work',
    requestId: 'native-close',
  });
});
