import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Caller } from '@merv/contracts';
import type { ApplicationConfig } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { s3Blobs } from './fixtures/s3-blobs.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

/** The default composition, over S3 blobs when `s3` is set and its own disk blobs otherwise. */
async function app(t: TestContext, s3: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-large-workflows-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  if (s3) {
    const { entry } = await s3Blobs(t);
    config.plugins = config.plugins.map((plugin) => (plugin.id === 'blobs' ? entry : plugin));
  }
  const started = await createApp({ directory, config, port: 0 });
  t.after(async () => {
    await started.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await started.ctx.scope.bootstrap({ projectName: 'Research', actorName: 'Owner' });
  const owner: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  await waitForManagedCode(started.ctx.codeWork, owner);
  return { app: started, owner };
}

test('without signed uploads, new tasks keep the version that grants none', async (t) => {
  const { app: disk, owner } = await app(t, false);
  assert.deepEqual(await disk.ctx.tools.call('compute.offers', owner, {}), {
    entitled: false,
    available: false,
    allowance: null,
    offers: [],
  });
  const run = {
    experimentId: 'exp_missing',
    attemptIndex: 1,
    key: 'trial',
    provider: 'lambda',
    offerId: 'gpu',
    command: 'echo',
    minutes: 5,
    maxUsd: 1,
  };
  await assert.rejects(disk.ctx.tools.call('compute.run', owner, run), {
    code: 'compute_unavailable',
  });
  // Compute stages no artifacts: the schema refuses inputs.
  await assert.rejects(
    disk.ctx.tools.call('compute.run', owner, {
      ...run,
      inputs: [{ artifactId: 'art_data', path: 'data.csv' }],
    }),
    { code: 'invalid_input' },
  );
  const ordinary = await disk.ctx.tasks.create(owner, {
    title: 'Original',
    goal: 'Retain one result',
    checks: ['Result retained'],
    requestId: 'original',
  });
  assert.equal(ordinary.workflow.version, 31);
});

test('S3 blobs give new producers upload grants while reviewers stay read-only', async (t) => {
  const { app: s3, owner } = await app(t, true);
  const task = await s3.ctx.tasks.create(owner, {
    title: 'Large result',
    goal: 'Retain all rows',
    checks: ['Rows retained'],
    requestId: 'large',
  });
  assert.equal(task.workflow.version, 35);
  const experiment = await s3.ctx.experiments.create(owner, {
    name: 'large_experiment',
    intent: 'Analyze retained rows',
    requestId: 'experiment',
  });
  assert.equal(experiment.workflow.version, 32);
  const taskPolicy = await s3.ctx.workflows.assignment(owner, task.id);
  const experimentPolicy = await s3.ctx.workflows.assignment(owner, experiment.id);
  for (const assignment of [taskPolicy, experimentPolicy]) {
    const tools = JSON.stringify(assignment);
    assert.match(tools, /artifact.upload_begin/);
    assert.match(tools, /artifact.upload_complete/);
  }
});
