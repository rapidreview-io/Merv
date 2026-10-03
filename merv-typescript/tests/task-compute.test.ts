import { historicalExperiment } from './fixtures/historical-experiment.js';
import { historicalTask } from './fixtures/historical-task.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, MervError, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { PaperService } from '@merv/paper';
import { TaskService } from '@merv/tasks';
import { ExperimentService } from '@merv/experiments';
import type { SandboxCompute, SandboxComputeRun, SandboxComputeSpec } from '@merv/sandboxes/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openState } from './fixtures/state.js';

const code = (wanted: string) => (error: unknown) =>
  error instanceof MervError && error.code === wanted;

test('tasks and experiments share GPU admission, recover runs, and enforce work leases', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-compute-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const human = await scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = await scope.createProject(human, { name: randomUUID(), requestId: randomUUID() });
  const caller = await scope.caller(human, project.id);
  const issued = await scope.issueActor(caller, { name: 'GPU worker', role: 'producer' });
  const producer: Caller = {
    actorId: issued.actor.id,
    projectId: caller.projectId,
    credentialId: issued.credential.id,
  };
  const workflows = await createService(new WorkflowsService(state, scope));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const context = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const paper = await createService(new PaperService(state, scope, artifacts));
  const tasks = await createService(
    new TaskService(state, scope, artifacts, workflows, reviews, context, undefined, paper),
  );
  const experiments = await createService(
    new ExperimentService(state, scope, artifacts, workflows, reviews, context, undefined, paper),
  );
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
  const unbindTask = tasks.bindCompute(adapter);
  const unbindExperiment = experiments.bindCompute(adapter);
  t.after(async () => {
    unbindTask();
    unbindExperiment();
    tasks.dispose();
    experiments.close();
    paper.close();
    await workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = await historicalTask({ state, artifacts, tasks }, producer, {
    title: 'GPU smoke',
    goal: 'Run bounded GPU smoke.',
    checks: ['Output captured.'],
    requestId: randomUUID(),
  });
  assert.equal(task.workflow.version, 28);
  const source = await scope.delegationSource(producer);
  scope.registerSessionAuthority({ require: async () => source });
  const actor = await state.transaction((tx) =>
    scope.createSessionActor(
      source,
      {
        sessionId: 'task-compute-worker',
        role: 'producer',
        name: 'Task GPU worker',
      },
      tx,
    ),
  );
  const worker: Caller = {
    projectId: caller.projectId,
    actorId: actor.id,
    session: { id: 'task-compute-worker' },
  };
  await state.transaction((tx) =>
    tx.run(
      `INSERT INTO task_leases(id,project_id,task_id,revision,actor_id,source_actor_id,purpose,review_id,claim_id,receipt,pinned_artifacts,checkpoints)
     VALUES(?,?,?,?,?,?,'work',NULL,NULL,'{}','[]','[]')`,
      worker.session!.id,
      caller.projectId,
      task.id,
      task.workflow.revision,
      worker.actorId,
      producer.actorId,
    ),
  );
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
  const staleActor = await state.transaction((tx) =>
    scope.createSessionActor(
      source,
      {
        sessionId: 'stale-worker',
        role: 'producer',
        name: 'Stale GPU worker',
      },
      tx,
    ),
  );
  await assert.rejects(
    tasks.computeRun(
      { projectId: caller.projectId, actorId: staleActor.id, session: { id: 'stale-worker' } },
      { ...input, key: 'stale' },
    ),
    code('stale_lease'),
  );
  await tasks.computeTick();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.spec.idempotencyKey.length > 10, true);
  assert.deepEqual(submitted[0]!.spec.outputs, input.outputs);
  const experiment = await historicalExperiment({ state, experiments }, caller, {
    name: randomUUID(),
    intent: 'Independent GPU work alongside task runs.',
    requestId: randomUUID(),
  });
  await state.transaction((tx) =>
    tx.run("UPDATE wf_instances SET state='running' WHERE id=?", experiment.id),
  );
  const expInput = {
    experimentId: experiment.id,
    attemptIndex: 1,
    key: 'experiment',
    provider: 'test',
    offerId: 'gpu',
    command: 'echo exp',
    minutes: 5,
    maxUsd: 1,
  };
  await experiments.computeRun(caller, expInput);
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
  await state.transaction((tx) =>
    tx.run("UPDATE wf_instances SET state='in_review',revision=revision+1 WHERE id=?", task.id),
  );
  await tasks.computeTick();
  assert.ok(cancelled.includes('wf_3'));
  assert.equal(
    ((await tasks.computeOutput(caller, task.id, 'wf_1', 'result.json')) as { url: string }).url,
    'https://bucket.example/task-result',
  );
  await assert.rejects(
    tasks.computeOutput(caller, experiment.id, 'wf_1', 'result.json'),
    code('compute_not_found'),
  );
  await assert.rejects(
    experiments.computeOutput(caller, task.id, 'wf_1', 'result.json'),
    code('compute_not_found'),
  );
  assert.equal(((await tasks.computeStatus(caller, task.id)) as { state: string }[]).length, 3);
  await assert.rejects(
    tasks.computeRun(worker, { ...input, key: 'late' }),
    code('compute_not_running'),
  );
  // A key can be reused after review returns the task to work. Generation selects the old row.
  await state.transaction((tx) =>
    tx.run(
      `INSERT INTO managed_compute_runs
       SELECT project_id,owner_kind,owner_id,?,key,input_hash,input_json,NULL,state,cost,result,created_by,created_at,updated_at
       FROM managed_compute_runs WHERE project_id=? AND owner_kind='task' AND owner_id=? AND generation=? AND key='smoke'`,
      input.expectedRevision + 1,
      caller.projectId,
      task.id,
      input.expectedRevision,
    ),
  );
  assert.equal(
    (
      (await tasks.computeStatus(caller, task.id, 'smoke', input.expectedRevision)) as {
        generation: number;
      }
    ).generation,
    input.expectedRevision,
  );
  assert.equal(
    (
      (await tasks.computeStatus(caller, task.id, 'smoke', input.expectedRevision + 1)) as {
        generation: number;
      }
    ).generation,
    input.expectedRevision + 1,
  );
});
