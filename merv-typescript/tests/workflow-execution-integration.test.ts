import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, Data, WorkflowExecution } from '@merv/contracts';
import { createApp } from './fixtures/app.js';

const dispatch = (execution: WorkflowExecution, tool: string, input: Data = {}) => ({
  instanceId: execution.instanceId,
  expectedRevision: execution.revision,
  policyHash: execution.policyHash,
  registrationId: execution.registrationId,
  tool,
  input,
});

test('real Cordis program reload and application restart fence old execution handles', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-lifecycle-'));
  let app = await createApp({ directory });
  try {
    const boot = await app.ctx.scope.bootstrap({ projectName: 'Execution', actorName: 'Operator' });
    const caller: Caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const task = await app.ctx.tasks.create(caller, {
      title: 'Durable policy',
      goal: 'Keep the policy stable across restarts.',
      checks: ['An old registration handle cannot regain authority.'],
      requestId: 'create',
    });
    const target = { instanceId: task.id, expectedRevision: task.workflow.revision };
    const original = await app.ctx.workflows.execution(caller, target);
    assert.deepEqual(
      (await app.ctx.workflows.authorizeDispatch(caller, dispatch(original, 'task.get'))).input,
      { taskId: task.id },
    );

    const workflows = app.ctx.workflows;
    await app.setEnabled('tasks', false);
    assert.equal(app.ctx.workflows, workflows, 'Only the program should have been withdrawn');
    await assert.rejects(
      async () => await workflows.authorizeDispatch(caller, dispatch(original, 'task.get')),
    );
    assert.equal((await app.ctx.scope.require(caller, 'read')).id, caller.actorId);
    await app.setEnabled('tasks', true);
    const reloaded = await workflows.execution(caller, target);
    assert.equal(reloaded.policyHash, original.policyHash);
    assert.notEqual(reloaded.registrationId, original.registrationId);
    await assert.rejects(
      async () => await workflows.authorizeDispatch(caller, dispatch(original, 'task.get')),
    );
    assert.equal(
      (await workflows.authorizeDispatch(caller, dispatch(reloaded, 'task.get'))).input.taskId,
      task.id,
    );

    await app.stop();
    app = await createApp({ directory });
    const restarted = await app.ctx.workflows.execution(caller, target);
    assert.equal(restarted.policyHash, original.policyHash);
    assert.deepEqual(restarted.policy, original.policy);
    assert.notEqual(restarted.registrationId, reloaded.registrationId);
    await assert.rejects(
      async () => await app.ctx.workflows.authorizeDispatch(caller, dispatch(reloaded, 'task.get')),
    );
    assert.equal(
      (await app.ctx.workflows.authorizeDispatch(caller, dispatch(restarted, 'task.get'))).input
        .taskId,
      task.id,
    );
    const replacement = await app.ctx.scope.issueActorCredential(caller, {
      actorId: caller.actorId,
    });
    await app.ctx.scope.revokeCredential(
      { ...caller, credentialId: replacement.credential.id },
      boot.credential.id,
    );
    await assert.rejects(
      async () =>
        await app.ctx.workflows.authorizeDispatch(caller, dispatch(restarted, 'task.get')),
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('policy permission is stable across begin and cannot be expanded by checkpoint evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-checkpoints-'));
  const app = await createApp({ directory });
  try {
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Pinned authority',
      actorName: 'Operator',
    });
    const caller = { projectId: boot.project.id, actorId: boot.actor.id };
    const task = await app.ctx.tasks.create(caller, {
      title: 'Stable declarations',
      goal: 'Keep checkpoint text from granting document access.',
      checks: ['Checkpoint documents remain context, without adding execution grants.'],
      requestId: 'create',
    });
    const target = { instanceId: task.id, expectedRevision: task.workflow.revision };
    const original = await app.ctx.workflows.execution(caller, target);
    const before = await app.ctx.workflows.assignment(caller, task.id);
    assert.ok(original.policy.tools.some((tool) => tool.name === 'artifact.create'));
    assert.ok(original.policy.tools.some((tool) => tool.name === 'task.submit_delivery'));
    assert.equal(task.guidance.nextAction?.tool, 'workflow.begin');
    const begun = await app.ctx.workflows.begin(caller, target);
    assert.deepEqual(begun.execution, before.execution);
    assert.equal(
      (await app.ctx.tasks.get(caller, task.id)).guidance.nextAction?.tool,
      'task.submit_delivery',
    );

    const unrelated = await app.ctx.artifacts.create(caller, {
      title: 'Checkpoint attachment',
      content: 'This document is readable by this ordinary account.',
    });
    await app.ctx.tasks.checkpoint(caller, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: target.expectedRevision,
      notes: 'Useful continuity information.',
      artifactIds: [unrelated.id],
      requestId: 'checkpoint',
    });
    const current = await app.ctx.workflows.execution(caller, target);
    assert.deepEqual(current.policy, original.policy);
    assert.equal(current.policyHash, original.policyHash);
    await assert.rejects(
      async () =>
        await app.ctx.workflows.authorizeDispatch(
          caller,
          dispatch(current, 'artifact.read', { artifactId: unrelated.id }),
        ),
    );
    assert.equal(
      (
        await app.ctx.workflows.authorizeDispatch(
          caller,
          dispatch(current, 'artifact.read', { artifactId: task.briefId }),
        )
      ).input.artifactId,
      task.briefId,
    );
    assert.equal((await app.ctx.artifacts.read(caller, unrelated.id)).artifact.id, unrelated.id);
    await assert.rejects(
      async () =>
        await app.ctx.workflows.authorizeDispatch(caller, dispatch(current, 'task.create')),
    );
    await app.ctx.tasks.markFailed(caller, {
      taskId: task.id,
      expectedRevision: target.expectedRevision,
      reason: 'End the fixture assignment.',
      requestId: 'finish',
    });
    await assert.rejects(
      async () =>
        await app.ctx.workflows.authorizeDispatch(caller, dispatch(current, 'artifact.create')),
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
