import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LargeArtifactStorage } from '@merv/contracts';
import { createApp } from './fixtures/app.js';

test('configured storage gives new producers upload grants while reviewers stay read-only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-large-workflows-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Research', actorName: 'Owner' });
  const owner = { actorId: boot.actor.id, projectId: boot.project.id };
  assert.deepEqual(await app.ctx.tools.call('compute.offers', owner, {}), {
    entitled: false,
    available: false,
    allowance: null,
    offers: [],
  });
  await assert.rejects(
    app.ctx.tools.call('compute.run', owner, {
      experimentId: 'exp_missing',
      attemptIndex: 1,
      key: 'trial',
      provider: 'lambda',
      offerId: 'gpu',
      command: 'echo',
      minutes: 5,
      maxUsd: 1,
    }),
    { code: 'compute_unavailable' },
  );
  const ordinary = await app.ctx.tasks.create(owner, {
    title: 'Original',
    goal: 'Retain one result',
    checks: ['Result retained'],
    requestId: 'original',
  });
  assert.equal(ordinary.workflow.version, 2);
  const storage = {
    begin: async () => {
      throw new Error('not used');
    },
    resume: async () => {
      throw new Error('not used');
    },
    complete: async () => {
      throw new Error('not used');
    },
    download: async () => {
      throw new Error('not used');
    },
  } as LargeArtifactStorage;
  const unbind = app.ctx.artifacts.bindLarge(storage);
  t.after(unbind);
  const task = await app.ctx.tasks.create(owner, {
    title: 'Large result',
    goal: 'Retain all rows',
    checks: ['Rows retained'],
    requestId: 'large',
  });
  assert.equal(task.workflow.version, 7);
  const experiment = await app.ctx.experiments.create(owner, {
    name: 'large_experiment',
    intent: 'Analyze retained rows',
    requestId: 'experiment',
  });
  assert.equal(experiment.workflow.version, 13);
  const taskPolicy = await app.ctx.workflows.assignment(owner, task.id);
  const experimentPolicy = await app.ctx.workflows.assignment(owner, experiment.id);
  for (const assignment of [taskPolicy, experimentPolicy]) {
    const tools = JSON.stringify(assignment);
    assert.match(tools, /artifact.upload_begin/);
    assert.match(tools, /artifact.upload_complete/);
  }
});
