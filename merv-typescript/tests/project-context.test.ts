import type { TaskContext } from '@merv/tasks/types';
import { waitForManagedCode } from './fixtures/managed-code.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Data } from '@merv/contracts';
import { createApp } from './fixtures/app.js';

test('Task contexts freeze the Problem at lease offer, carry it once, and retain saved packets across project changes and restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-introduction-'));
  let app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Frozen context',
    actorName: 'Owner',
  });
  const source = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, source);
  await app.ctx.sessions.dispatch.heartbeatRunner(source, {
    runnerId: 'context-test',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  // Paper writes the Introduction from the Problem; the paper's items carry the Problem.
  const problem = async (content: string, expectedRevision: number) =>
    await app.ctx.paper.patch(source, {
      kind: 'problem',
      expectedRevision,
      requestId: `problem-${expectedRevision}`,
      changes: [{ id: 'problem', content }],
    });
  await problem('INTRO_AT_OFFER_731', 0);
  const task = await app.ctx.tasks.create(source, {
    title: 'Observe intent',
    goal: 'Verify the result.',
    checks: ['The result is 42.'],
    requestId: 'task',
  });
  const contextInput: TaskContext = {
    taskId: task.id,
    purpose: 'work',
    expectedRevision: task.workflow.revision,
    requestId: 'before-offer',
  };
  const saved = await app.ctx.tasks.context(source, contextInput);
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const offered = await app.ctx.sessions.offer(source, {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
    runnerId: 'context-test',
    requestId: 'offer',
    secret,
  });
  assert.equal(offered.assignment.context!.prompt.split('INTRO_AT_OFFER_731').length, 2);
  assert.equal(offered.assignment.context!.recipeHash, saved.recipeHash);
  const pin = { ...boot.project };
  assert.deepEqual(offered.lease.receipt.project, pin);
  await problem('INTRO_AFTER_OFFER_942', 1);
  assert.deepEqual(
    await app.ctx.tasks.context(source, contextInput),
    saved,
    'A saved ordinary context replays without rebuilding live Introduction',
  );
  // While the worker holds the revision, the source is told so instead of a fresh assignment.
  await assert.rejects(async () => await app.ctx.workflows.assignment(source, task.id), {
    code: 'task_leased',
  });
  async function workerContext(requestId: string) {
    const worker = await app.ctx.sessions.authenticate(secret);
    const invocation = await app.ctx.sessions.invocations.prepare(worker, 'task.context', {
      requestId,
    });
    return app.ctx.sessions.invocations.run(
      invocation,
      async (caller, input: Data) =>
        await app.ctx.tasks.context(caller, input as unknown as TaskContext),
    );
  }
  const workerSaved = await workerContext('worker-first');
  assert.match(workerSaved.prompt, /INTRO_AT_OFFER_731/);
  assert.doesNotMatch(workerSaved.prompt, /INTRO_AFTER_OFFER_942/);
  const frozenPacket = offered.assignment;
  await app.stop();
  app = await createApp({ directory, api: false });
  assert.deepEqual((await app.ctx.sessions.get(source, offered.id)).assignment, frozenPacket);
  assert.deepEqual(await workerContext('worker-first'), workerSaved);
  const freshWorkerContext = await workerContext('worker-after-restart');
  assert.match(freshWorkerContext.prompt, /INTRO_AT_OFFER_731/);
  assert.doesNotMatch(freshWorkerContext.prompt, /INTRO_AFTER_OFFER_942/);
  assert.equal(freshWorkerContext.recipeHash, saved.recipeHash);
  assert.equal((await app.ctx.paper.documents(source)).problem.current.revision, 2);
});
