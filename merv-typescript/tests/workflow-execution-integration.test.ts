import { currentTask } from './fixtures/current-work.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';

test('a real Cordis program reload and application restart keep the pinned policy under a new generation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-lifecycle-'));
  let app = await createApp({ directory });
  try {
    const boot = await app.ctx.scope.credentials.bootstrap({
      projectName: 'Execution',
      actorName: 'Operator',
    });
    const caller: Caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const task = await currentTask(app.ctx, caller, {
      title: 'Durable policy',
      goal: 'Keep the policy stable across restarts.',
      checks: ['An old registration handle cannot regain authority.'],
      requestId: 'create',
    });
    const execution = async () => (await app.ctx.workflows.assignment(caller, task.id)).execution;
    const original = await execution();

    const workflows = app.ctx.workflows;
    await app.setEnabled('tasks', false);
    assert.equal(app.ctx.workflows, workflows, 'Only the program should have been withdrawn');
    await assert.rejects(async () => await workflows.assignment(caller, task.id), {
      code: 'workflow_unavailable',
    });
    assert.equal((await app.ctx.scope.require(caller, 'read')).id, caller.actorId);
    await app.setEnabled('tasks', true);
    const reloaded = await execution();
    assert.equal(reloaded.policyHash, original.policyHash);
    assert.notEqual(reloaded.registrationId, original.registrationId);

    await app.stop();
    app = await createApp({ directory });
    const restarted = await execution();
    assert.equal(restarted.policyHash, original.policyHash);
    assert.deepEqual(restarted.policy, original.policy);
    assert.notEqual(restarted.registrationId, reloaded.registrationId);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the pinned policy is stable across begin and checkpoint evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-checkpoints-'));
  const app = await createApp({ directory });
  try {
    const boot = await app.ctx.scope.credentials.bootstrap({
      projectName: 'Pinned authority',
      actorName: 'Operator',
    });
    const caller = { projectId: boot.project.id, actorId: boot.actor.id };
    const task = await currentTask(app.ctx, caller, {
      title: 'Stable declarations',
      goal: 'Keep checkpoint text from granting document access.',
      checks: ['Checkpoint documents remain context, without adding execution grants.'],
      requestId: 'create',
    });
    const target = { instanceId: task.id, expectedRevision: task.workflow.revision };
    const before = await app.ctx.workflows.assignment(caller, task.id);
    const original = before.execution;
    assert.ok(original.policy!.tools.some((tool) => tool.name === 'artifact.create'));
    assert.ok(original.policy!.tools.some((tool) => tool.name === 'task.submit_delivery'));
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
    const current = (await app.ctx.workflows.assignment(caller, task.id)).execution;
    assert.deepEqual(current.policy, original.policy);
    assert.equal(current.policyHash, original.policyHash);
    assert.equal((await app.ctx.artifacts.read(caller, unrelated.id)).artifact.id, unrelated.id);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
