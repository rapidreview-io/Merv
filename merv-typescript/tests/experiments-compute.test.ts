import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, MervError } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { PaperService } from '@merv/paper';
import { ExperimentService } from '@merv/experiments';
import { ExperimentCompute } from '../packages/experiments/src/compute.js';
import type { SandboxCompute, SandboxComputeRun, SandboxComputeSpec } from '@merv/sandboxes/types';
import { openState } from './fixtures/state.js';

const code = (wanted: string) => (error: unknown) =>
  error instanceof MervError && error.code === wanted;

async function fixture(t: TestContext, since = '2000-01-01T00:00:00Z') {
  const directory = mkdtempSync(join(tmpdir(), 'merv-experiment-compute-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const human = await scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'founder',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = async () => {
    const value = await scope.createProject(human, { name: randomUUID(), requestId: randomUUID() });
    return await scope.caller(human, value.id);
  };
  const caller = await project();
  const boot = await scope.bootstrap({ projectName: 'Bootstrap', actorName: 'Operator' });
  const bootstrap = { actorId: boot.actor.id, projectId: boot.project.id };
  const workflows = await createService(new WorkflowsService(state, scope));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const context = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const paper = await createService(new PaperService(state, scope, artifacts));
  const experiments = await createService(
    new ExperimentService(state, scope, artifacts, workflows, reviews, context, undefined, paper),
  );
  const calls: { projectId: string; spec: SandboxComputeSpec }[] = [];
  const cancelled: string[] = [];
  let response: SandboxComputeRun = {
    id: 'wf_one',
    state: 'running',
    reason: null,
    cost: null,
    result: null,
  };
  const adapter: SandboxCompute = {
    since,
    async offers() {
      return { offers: [{ provider: 'lambda', offer_id: 'gpu' }] };
    },
    async allowance() {
      return { cap: { amount: '50', currency: 'USD' }, month_to_date: [] };
    },
    async submit(projectId, spec) {
      calls.push({ projectId, spec });
      return `wf_${calls.length}`;
    },
    async get(_projectId, runId) {
      return { ...response, id: runId };
    },
    async cancel(_projectId, runId) {
      cancelled.push(runId);
    },
  };
  const unbind = experiments.bindCompute(adapter);
  const createRunning = async (who = caller) => {
    const experiment = await experiments.create(who, {
      name: randomUUID(),
      intent: 'Measure a GPU experiment.',
      requestId: randomUUID(),
    });
    await state.transaction((tx) =>
      tx.run("UPDATE wf_instances SET state='running' WHERE id=?", experiment.id),
    );
    return experiment.id;
  };
  t.after(async () => {
    unbind();
    experiments.close();
    await workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    state,
    scope,
    project,
    caller,
    bootstrap,
    experiments,
    adapter,
    createRunning,
    calls,
    cancelled,
    unbind,
    setResponse: (value: SandboxComputeRun) => {
      response = value;
    },
  };
}

const input = (experimentId: string, key = 'trial') => ({
  experimentId,
  attemptIndex: 1,
  key,
  provider: 'lambda',
  offerId: 'gpu',
  command: 'echo metrics',
  minutes: 10,
  maxUsd: 2,
});

test('offers answer normally without ML while run and cancel remain unavailable', async (t) => {
  const f = await fixture(t);
  f.unbind();
  assert.deepEqual(await f.experiments.computeOffers(f.caller), {
    entitled: false,
    available: false,
    allowance: null,
    offers: [],
  });
  await assert.rejects(
    f.experiments.computeRun(f.caller, input('exp_missing')),
    code('compute_unavailable'),
  );
  await assert.rejects(
    f.experiments.computeCancel(f.caller, 'exp_missing', 'run_missing'),
    code('compute_unavailable'),
  );
});

test('new human projects are entitled without a project-count limit; bootstrap and earlier projects are not', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.project();
  const fourth = await f.project();
  const id = await f.createRunning(fourth);
  assert.equal(
    ((await f.experiments.computeOffers(fourth)) as { entitled: boolean }).entitled,
    true,
  );
  assert.equal((await f.experiments.computeRun(fourth, input(id))).state, 'submitting');
  const bootstrapId = await f.createRunning(f.bootstrap);
  assert.equal(
    ((await f.experiments.computeOffers(f.bootstrap)) as { entitled: boolean }).entitled,
    false,
  );
  await assert.rejects(
    f.experiments.computeRun(f.bootstrap, input(bootstrapId)),
    code('compute_not_entitled'),
  );
});

test('projects before switch-on and attempts outside running cannot rent compute', async (t) => {
  const before = await fixture(t, '2999-01-01T00:00:00Z');
  const oldId = await before.createRunning();
  assert.equal(
    ((await before.experiments.computeOffers(before.caller)) as { entitled: boolean }).entitled,
    false,
  );
  await assert.rejects(
    before.experiments.computeRun(before.caller, input(oldId)),
    code('compute_not_entitled'),
  );
  const current = await fixture(t);
  const planned = await current.experiments.create(current.caller, {
    name: randomUUID(),
    intent: 'Plan compute.',
    requestId: randomUUID(),
  });
  await assert.rejects(
    current.experiments.computeRun(current.caller, input(planned.id)),
    code('compute_not_running'),
  );
  const running = await current.createRunning();
  const direct = new ExperimentCompute(
    current.state,
    { require: async () => undefined } as never,
    current.adapter,
    () => undefined,
  );
  t.after(() => direct.close());
  await assert.rejects(
    direct.run(
      {
        actorId: current.caller.actorId,
        projectId: current.caller.projectId,
        session: { id: 'expired-worker' },
      },
      input(running),
    ),
    code('stale_lease'),
  );
});

test('run keys replay across calls, bind cancellation to the experiment, and cap live runs at two', async (t) => {
  const f = await fixture(t);
  const id = await f.createRunning();
  const first = await f.experiments.computeRun(f.caller, input(id));
  assert.deepEqual(await f.experiments.computeRun(f.caller, input(id)), first);
  await assert.rejects(
    f.experiments.computeRun(f.caller, { ...input(id), command: 'changed' }),
    code('compute_key_conflict'),
  );
  await f.experiments.computeRun(f.caller, input(id, 'second'));
  await assert.rejects(
    f.experiments.computeRun(f.caller, input(id, 'third')),
    code('compute_busy'),
  );
  await assert.rejects(
    f.experiments.computeRun(f.caller, { ...input(id), attemptIndex: 2 }),
    code('compute_not_running'),
  );
  const other = await f.createRunning();
  await assert.rejects(
    f.experiments.computeCancel(f.caller, other, first.runId),
    code('compute_not_found'),
  );
  assert.equal((await f.experiments.computeCancel(f.caller, id, first.runId)).state, 'cancelling');
});

test('driver resumes a pending run, records output, and cancels it after the attempt ends', async (t) => {
  const f = await fixture(t);
  const id = await f.createRunning();
  await f.experiments.computeRun(f.caller, input(id));
  await f.experiments.computeTick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.spec.idempotencyKey.length, 64);
  f.setResponse({
    id: 'wf_one',
    state: 'completed',
    reason: null,
    cost: { amount: '1.25', currency: 'USD' },
    result: { exit: 0, bytes: 7, head: '', tail: 'metrics' },
  });
  await f.experiments.computeTick();
  const runs = (await f.experiments.get(f.caller, id)).compute!;
  assert.equal(runs[0]?.state, 'completed');
  assert.equal((runs[0]?.result as { tail: string }).tail, 'metrics');
  const second = await f.experiments.computeRun(f.caller, input(id, 'second'));
  await f.experiments.computeTick();
  await f.state.transaction((tx) =>
    tx.run("UPDATE wf_instances SET state='abandoned' WHERE id=?", id),
  );
  await f.experiments.computeTick();
  assert.ok(f.cancelled.includes('wf_2'));
  assert.equal(
    (await f.experiments.get(f.caller, id)).compute?.find((row) => row.key === second.key)?.state,
    'cancelled',
  );
});

test('captured experiment files survive service rebind and remain scoped after review handoff', async (t) => {
  const f = await fixture(t);
  const id = await f.createRunning();
  const outputs = {
    files: [{ name: 'adapter.tar.gz', path: '/tmp/adapter.tar.gz' }],
    maxBytes: 1000,
  };
  const requested = { ...input(id), outputs };
  await f.experiments.computeRun(f.caller, requested);
  await assert.rejects(
    f.experiments.computeRun(f.caller, { ...requested, outputs: { ...outputs, maxBytes: 2000 } }),
    code('compute_key_conflict'),
  );
  await f.experiments.computeTick();
  assert.deepEqual(f.calls[0]?.spec.outputs, outputs);
  const output = {
    name: 'adapter.tar.gz',
    objectId: 'obj_adapter',
    sizeBytes: 900,
    sha256: 'b'.repeat(64),
    expiresAt: null,
  };
  f.setResponse({
    id: 'wf_1',
    state: 'completed',
    reason: null,
    cost: null,
    result: { exit: 0, bytes: 2, head: 'ok', tail: 'ok' },
    outputs: [output],
    outputState: 'committed',
  });
  // The provider completed, but the worker handed off before Merv's next poll.
  await f.state.transaction((tx) =>
    tx.run("UPDATE wf_instances SET state='experiment_review' WHERE id=?", id),
  );
  await f.experiments.computeTick();
  assert.deepEqual((await f.experiments.get(f.caller, id)).compute?.[0]?.outputs, [output]);
  f.unbind();
  const downloads: string[] = [];
  const unbind = f.experiments.bindCompute({
    ...f.adapter,
    async download(projectId, objectId) {
      downloads.push(`${projectId}/${objectId}`);
      return { url: 'https://bucket.example/fresh' };
    },
  });
  t.after(unbind);
  await f.state.transaction((tx) =>
    tx.run("UPDATE wf_instances SET state='experiment_review' WHERE id=?", id),
  );
  assert.deepEqual(await f.experiments.computeOutput(f.caller, id, 'wf_1', output.name, 1), {
    ...output,
    url: 'https://bucket.example/fresh',
  });
  const otherProject = await f.project();
  const otherExperiment = await f.createRunning();
  await assert.rejects(
    f.experiments.computeOutput(otherProject, id, 'wf_1', output.name),
    code('compute_not_found'),
  );
  await assert.rejects(
    f.experiments.computeOutput(f.caller, otherExperiment, 'wf_1', output.name),
    code('compute_not_found'),
  );
  await assert.rejects(
    f.experiments.computeOutput(f.caller, id, 'wf_1', output.name, 2),
    code('compute_not_found'),
  );
  await assert.rejects(
    f.experiments.computeOutput(f.caller, id, 'wf_1', 'obj_adapter'),
    code('compute_output_not_found'),
  );
  assert.deepEqual(
    downloads,
    [`${f.caller.projectId}/obj_adapter`],
    'rejected requests must not reach the provider',
  );
});

test('cancelled capture runs keep polling after the owner leaves running', async (t) => {
  const f = await fixture(t);
  const id = await f.createRunning();
  await f.experiments.computeRun(f.caller, {
    ...input(id),
    outputs: { files: [{ name: 'diagnostic.log', path: '/tmp/diagnostic.log' }], maxBytes: 1000 },
  });
  await f.experiments.computeTick();
  await f.experiments.computeCancel(f.caller, id, 'wf_1');
  await f.state.transaction((tx) =>
    tx.run("UPDATE wf_instances SET state='experiment_review' WHERE id=?", id),
  );
  await f.experiments.computeTick();
  assert.equal((await f.experiments.get(f.caller, id)).compute?.[0]?.state, 'cancelling');
  const output = {
    name: 'diagnostic.log',
    objectId: 'obj_log',
    sizeBytes: 500,
    sha256: 'c'.repeat(64),
    expiresAt: null,
  };
  f.setResponse({
    id: 'wf_1',
    state: 'cancelled',
    reason: 'cancelled',
    result: null,
    cost: null,
    outputs: [output],
    outputState: 'partial',
  });
  await f.experiments.computeTick();
  const final = (await f.experiments.get(f.caller, id)).compute?.[0];
  assert.equal(final?.state, 'cancelled');
  assert.deepEqual(final?.outputs, [output]);
  assert.equal(final?.outputState, 'partial');
  assert.deepEqual(f.cancelled, ['wf_1', 'wf_1']);
});
