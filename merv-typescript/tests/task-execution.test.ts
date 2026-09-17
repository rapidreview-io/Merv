import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller, Data, TaskCheckpointInput, WorkflowExecution } from '@merv/contracts';
import { createApp } from '../src/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

const dispatch = (execution: WorkflowExecution, tool: string, input: Data = {}) => ({
  instanceId: execution.instanceId,
  expectedRevision: execution.revision,
  policyHash: execution.policyHash,
  registrationId: execution.registrationId,
  tool,
  input,
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-execution-'));
  const app = await createApp({ directory });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Execution', actorName: 'Operator' });
  const operator: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const issue = async (role: 'producer' | 'reviewer'): Promise<Caller> => {
    const identity = await app.ctx.scope.issueActor(operator, { name: role, role });
    return { ...operator, actorId: identity.actor.id, credentialId: identity.credential.id };
  };
  const producer = await issue('producer');
  const create = async (requestId: string) =>
    await app.ctx.tasks.create(producer, {
      title: 'Verify execution boundaries',
      goal: 'Keep workflow execution confined to its assignment.',
      checks: ['Only permitted sources and the current claim can be used.'],
      requestId,
    });
  const pending = async () => {
    const task = await create('review-task');
    const proof = await app.ctx.artifacts.create(producer, {
      title: 'Verification evidence',
      content: 'The fixture retains evidence for independent review.',
    });
    return await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery({
        taskId: task.id,
        expectedRevision: 0,
        artifactIds: [proof.id],
        requestId: 'submit',
      }),
    );
  };
  return { app, operator, producer, issue, create, pending };
}

test('policy-checked checkpoints cannot expose an unrelated artifact through assignment context', async (t) => {
  const { app, producer, create } = await fixture(t);
  const task = await create('work-task');
  const unrelated = await app.ctx.artifacts.create(producer, {
    title: 'Unrelated document',
    content: 'UNRELATED_CHECKPOINT_CONTENT_239807',
  });
  const execution = await app.ctx.workflows.execution(producer, {
    instanceId: task.id,
    expectedRevision: 0,
  });
  const reads = t.mock.method(app.ctx.artifacts, 'read');
  const writes = async () => {
    await app.ctx.domainEvents.drain();
    return await app.ctx.state.read(
      async (sql) => (await sql.get<{ n: number }>('SELECT total_changes() AS n'))!.n,
    );
  };
  const before = await writes();
  const head = await app.ctx.state.eventHead();
  await assert.rejects(
    async () => {
      const admitted = await app.ctx.workflows.authorizeDispatch(
        producer,
        dispatch(execution, 'task.checkpoint', {
          notes: 'Try adding a source outside the assignment.',
          artifactIds: [unrelated.id],
          requestId: 'unrelated',
        }),
      );
      await app.ctx.tasks.checkpoint(producer, admitted.input as unknown as TaskCheckpointInput);
    },
    { code: 'execution_arguments_forbidden' },
  );
  assert.equal(await writes(), before, 'Rejected admission must not reach the checkpoint mutation');
  assert.equal(await app.ctx.state.eventHead(), head);
  assert.equal(reads.mock.callCount(), 0, 'Admission must not fetch artifact bytes');
  const assignment = await app.ctx.workflows.assignment(producer, task.id);
  assert.doesNotMatch(assignment.context!.prompt, /UNRELATED_CHECKPOINT_CONTENT_239807/);
  assert.ok(reads.mock.calls.every((call) => call.arguments[1] !== unrelated.id));
  assert.equal(await writes(), before);

  const checkpoints: Data[] = [
    { notes: 'Text-only progress.', requestId: 'text' },
    { notes: 'Pinned source only.', artifactIds: [task.briefId], requestId: 'pinned' },
  ];
  for (const input of checkpoints) {
    const admitted = await app.ctx.workflows.authorizeDispatch(
      producer,
      dispatch(execution, 'task.checkpoint', input),
    );
    const checkpoint = await app.ctx.tasks.checkpoint(
      producer,
      admitted.input as unknown as TaskCheckpointInput,
    );
    assert.deepEqual(checkpoint.artifactIds, input.artifactIds ?? []);
  }
});

test('review execution binds the current claim before and after reviewer recovery', async (t) => {
  const { app, operator, issue, pending } = await fixture(t);
  const reviewer = await issue('reviewer');
  const replacement = await issue('reviewer');
  const task = await pending();
  const target = { instanceId: task.id, expectedRevision: task.workflow.revision };
  const open = await app.ctx.workflows.execution(reviewer, target);
  await assert.rejects(
    async () =>
      await app.ctx.workflows.authorizeDispatch(reviewer, dispatch(open, 'review.submit')),
    { code: 'execution_reference_unavailable' },
  );
  const start = await app.ctx.workflows.authorizeDispatch(reviewer, dispatch(open, 'review.start'));
  const claim = await app.ctx.reviews.start(reviewer, start.input.reviewId as string);
  assert.equal(
    (await app.ctx.workflows.authorizeDispatch(reviewer, dispatch(open, 'review.submit'))).input
      .claimId,
    claim.claimId,
    'The descriptor is not a lease: admission resolves the current claim',
  );

  await app.ctx.scope.revokeActor(operator, reviewer.actorId);
  await app.ctx.domainEvents.drain();
  await assert.rejects(
    async () =>
      await app.ctx.workflows.authorizeDispatch(reviewer, dispatch(open, 'review.submit')),
    { code: 'forbidden' },
  );
  const recovered = await app.ctx.workflows.execution(replacement, target);
  assert.equal(recovered.policyHash, open.policyHash);
  assert.equal(recovered.references.claimId, undefined);
  await assert.rejects(
    async () =>
      await app.ctx.workflows.authorizeDispatch(
        replacement,
        dispatch(recovered, 'review.submit', { claimId: claim.claimId! }),
      ),
    { code: 'execution_reference_unavailable' },
  );
  const next = await app.ctx.reviews.start(replacement, task.reviewId!);
  assert.notEqual(next.claimId, claim.claimId);
  await assert.rejects(
    async () =>
      await app.ctx.workflows.authorizeDispatch(
        replacement,
        dispatch(recovered, 'review.submit', { claimId: claim.claimId! }),
      ),
    { code: 'execution_arguments_forbidden' },
  );
  assert.equal(
    (await app.ctx.workflows.authorizeDispatch(replacement, dispatch(recovered, 'review.submit')))
      .input.claimId,
    next.claimId,
  );
});

test('metadata admission avoids rendering and does not grant an assisting operator delivery authority', async (t) => {
  const { app, operator, producer, issue, create, pending } = await fixture(t);
  const work = await create('work-task');
  const review = await pending();
  const reviewer = await issue('reviewer');
  await app.ctx.reviews.start(reviewer, review.reviewId!);
  t.mock.method(app.ctx.artifacts, 'read', () => {
    assert.fail('Execution admission must not read artifact bytes');
  });
  t.mock.method(app.ctx.workflows, 'evaluate', () => {
    assert.fail('Execution admission must not evaluate exit guidance or hydrate context');
  });
  for (const [caller, task] of [
    [producer, work],
    [reviewer, review],
    [operator, work],
  ] as const) {
    const execution = await app.ctx.workflows.execution(caller, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
    });
    assert.equal(
      (await app.ctx.workflows.authorizeDispatch(caller, dispatch(execution, 'task.get'))).input
        .taskId,
      task.id,
    );
    if (caller === operator)
      await assert.rejects(
        async () =>
          await app.ctx.workflows.authorizeDispatch(
            caller,
            dispatch(execution, 'task.submit_delivery'),
          ),
        { code: 'execution_reference_unavailable' },
      );
    // Every session reads whatever the project holds; only a read marked as one opens.
    const outside = dispatch(execution, 'artifact.read', { artifactId: 'art_outside_the_packet' });
    assert.equal(
      (await app.ctx.workflows.authorizeDispatch(caller, { ...outside, read: true })).input
        .artifactId,
      'art_outside_the_packet',
    );
    await assert.rejects(async () => await app.ctx.workflows.authorizeDispatch(caller, outside), {
      code: 'execution_arguments_forbidden',
    });
  }
});
