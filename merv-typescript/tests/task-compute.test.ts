import { currentTask, currentWork } from './fixtures/current-work.js';
import { createApp } from './fixtures/app.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MervError, type Caller } from '@merv/contracts';
import { TaskService } from '@merv/tasks';
import type { SandboxCompute, SandboxComputeRun, SandboxComputeSpec } from '@merv/sandboxes/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const code = (wanted: string) => (error: unknown) =>
  error instanceof MervError && error.code === wanted;

test('current leased tasks recover GPU runs, retain outputs and cancel outstanding work on closure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-compute-'));
  const app = await createApp({ directory, port: 0 });
  const { scope, tasks } = app.ctx;
  const human = await scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = await scope.createProject(human, { name: randomUUID(), requestId: randomUUID() });
  const caller = await scope.caller(human, project.id);
  const issued = await scope.issueActor(caller, { name: 'GPU runner', role: 'producer' });
  const producer: Caller = {
    projectId: caller.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const work = currentWork(app.ctx, { directory, source: producer });
  const submitted: { projectId: string; spec: SandboxComputeSpec }[] = [];
  const cancelled: string[] = [];
  let status: SandboxComputeRun = {
    id: 'wf_one',
    state: 'running',
    reason: null,
    cost: null,
    result: null,
  };
  const adapter: SandboxCompute = {
    since: '2000-01-01T00:00:00Z',
    async allowance() {
      return { cap: { amount: '50', currency: 'USD' }, month_to_date: [] };
    },
    async offers() {
      return { offers: [{ provider: 'test', offer_id: 'gpu' }] };
    },
    async submit(projectId, spec) {
      submitted.push({ projectId, spec });
      return `wf_${submitted.length}`;
    },
    async get(_projectId, runId) {
      return { ...status, id: runId };
    },
    async cancel(_projectId, runId) {
      cancelled.push(runId);
    },
    async download(projectId, objectId) {
      assert.equal(projectId, caller.projectId);
      assert.equal(objectId, 'obj_task_result');
      return { url: 'https://bucket.example/task-result' };
    },
  };
  const unbindTask = (tasks as TaskService).bindCompute(adapter);
  t.after(async () => {
    await work.close();
    unbindTask();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = await currentTask(app.ctx, producer, {
    title: 'GPU smoke',
    goal: 'Run bounded GPU smoke.',
    checks: ['Output captured.'],
    requestId: randomUUID(),
  });
  assert.equal(task.workflow.version, 31);
  const held = await work.lease(task);
  const worker = held.worker;
  const input = {
    taskId: task.id,
    expectedRevision: task.workflow.revision,
    key: 'smoke',
    provider: 'test',
    offerId: 'gpu',
    command: 'echo ok',
    minutes: 5,
    maxUsd: 1,
    outputs: { files: [{ name: 'result.json', path: '/tmp/result.json' }], maxBytes: 1000 },
  };
  const first = (await tasks.computeRun(worker, input)) as { state: string; runId: string };
  assert.equal(first.state, 'submitting');
  assert.deepEqual(await tasks.computeRun(worker, input), first);
  await assert.rejects(
    tasks.computeRun(worker, { ...input, command: 'echo changed' }),
    code('compute_key_conflict'),
  );
  await assert.rejects(tasks.computeRun(caller, { ...input, key: 'stale' }), code('stale_lease'));
  await tasks.computeTick();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.spec.idempotencyKey.length > 10, true);
  assert.deepEqual(submitted[0]!.spec.outputs, input.outputs);
  const third = (await tasks.computeRun(worker, { ...input, key: 'third' })) as {
    state: string;
  };
  assert.equal(third.state, 'submitting');
  status = {
    id: 'wf_one',
    state: 'completed',
    reason: null,
    cost: { amount: '0.1', currency: 'USD' },
    result: { exit: 0, bytes: 2, head: 'ok', tail: 'ok' },
    outputs: [
      {
        name: 'result.json',
        objectId: 'obj_task_result',
        sizeBytes: 2,
        sha256: 'a'.repeat(64),
        expiresAt: null,
      },
    ],
    outputState: 'committed',
  };
  await tasks.computeTick();
  assert.equal(
    ((await tasks.computeStatus(caller, task.id, 'wf_1')) as { state: string }).state,
    'completed',
  );
  assert.equal(
    (await tasks.get(caller, task.id)).compute?.find((run) => run.runId === 'wf_1')?.state,
    'completed',
  );
  assert.deepEqual(
    ((await tasks.computeStatus(caller, task.id, 'wf_1')) as { cost: unknown }).cost,
    { amount: '0.1', currency: 'USD', basis: 'unclassified_estimate' },
  );
  assert.equal(
    JSON.stringify((await tasks.get(caller, task.id)).compute).includes('"head"'),
    false,
  );
  assert.equal(
    ((await tasks.computeStatus(caller, task.id, 'wf_1')) as { result: { head: string } }).result
      .head,
    'ok',
  );
  await tasks.computeRun(worker, { ...input, key: 'next' });
  await tasks.computeTick();
  await work.run(
    held,
    'task.mark_failed',
    {
      taskId: task.id,
      expectedRevision: task.workflow.revision,
      reason: 'End the work and cancel outstanding GPU runs.',
      requestId: 'end-compute',
    },
    (caller, input) => tasks.markFailed(caller, input as never),
  );
  await tasks.computeTick();
  assert.ok(cancelled.includes('wf_3'));
  assert.equal(
    ((await tasks.computeOutput(caller, task.id, 'wf_1', 'result.json')) as { url: string }).url,
    'https://bucket.example/task-result',
  );
  const unrelatedTask = await currentTask(app.ctx, producer, {
    title: 'Other GPU work',
    goal: 'Keep compute outputs scoped to their task.',
    checks: ['Its output is independent.'],
    requestId: randomUUID(),
  });
  await assert.rejects(
    tasks.computeOutput(caller, unrelatedTask.id, 'wf_1', 'result.json'),
    code('compute_not_found'),
  );
  assert.equal(((await tasks.computeStatus(caller, task.id)) as { state: string }[]).length, 3);
  await assert.rejects(
    tasks.computeRun(worker, { ...input, key: 'late' }),
    (error: unknown) =>
      error instanceof MervError && ['session_completed', 'session_closed'].includes(error.code),
  );
});
