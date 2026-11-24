import { createService, MervError, type Caller } from '@merv/contracts';
import type { ResearchCreate, ResearchDigest } from '@merv/research/types';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  automaticRequest,
  bindAutomatic,
  wakeAutomatic,
} from '../packages/research/src/automatic.js';
import { ResearchService } from '../packages/research/src/index.js';
import { createApp } from './fixtures/app.js';
import { currentExperiment } from './fixtures/current-experiment.js';
import { deliverCurrentTask } from './fixtures/current-task-delivery.js';
import { currentTask } from './fixtures/current-work.js';
import { hostedCode, providersOf } from './fixtures/research.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-automatic-research-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter(
    ({ id }: { id: string }) =>
      !['api', 'identity', 'ui', 'research', 'research-tools', 'research-ui'].includes(id) &&
      !id.endsWith('-api') &&
      !id.endsWith('-ui'),
  );
  let app = await createApp({ directory, config });
  const service = async () =>
    await createService(
      new ResearchService(app.ctx.state, app.ctx.scope, app.ctx.workflows, providersOf(app.ctx)),
    );
  let research = await service();
  let release: (() => void | Promise<void>) | undefined;
  let sequence = 0;
  const id = () => `research-test-${++sequence}`;
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Research without reflections',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer' | 'operator') => {
    const actor = await app.ctx.scope.credentials.issueActor(owner, { name: id(), role });
    return {
      projectId: owner.projectId,
      actorId: actor.actor.id,
      credentialId: actor.credential.id,
    };
  };
  const taskReviewer = await issue('operator');
  const define = async () =>
    await app.ctx.paper.patch(owner, {
      kind: 'problem',
      expectedRevision: (await app.ctx.paper.read(owner)).documents.problem.current.revision,
      requestId: id(),
      changes: [
        { id: 'problem', content: 'Can the available input answer the question?' },
        { id: 'scope', content: 'One bounded comparison.' },
        { id: 'goals', content: 'Learn from completed and failed work.' },
        { id: 'constraints', content: 'Use only verified inputs.' },
      ],
    });
  const task = async (dependsOn: string[] = [], caller = owner) =>
    await currentTask(app.ctx, caller, {
      title: id(),
      goal: 'Provide verified input.',
      checks: ['The input is available and verified'],
      dependsOn,
      requestId: id(),
    });
  const experiment = async (dependsOn: string[] = [], caller = owner) =>
    await currentExperiment(app.ctx, caller, {
      name: id(),
      intent: 'Test the available input.',
      dependsOn,
      requestId: id(),
    });
  const failTask = async (taskId: string) =>
    await app.ctx.tasks.markFailed(owner, {
      taskId,
      expectedRevision: (await app.ctx.tasks.get(owner, taskId)).workflow.revision,
      reason: 'The required data does not exist.',
      requestId: id(),
    });
  const failExperiment = async (experimentId: string) =>
    await app.ctx.experiments.transition(owner, {
      experimentId,
      expectedRevision: (await app.ctx.experiments.get(owner, experimentId)).workflow.revision,
      transition: 'mark_failed',
      evidence: { reason: 'The available resources cannot execute the design.' },
      requestId: id(),
    });
  const create = async (dependsOn: string[], extra: Partial<ResearchCreate> = {}, caller = owner) =>
    await research.create(caller, { name: id(), dependsOn, requestId: id(), ...extra });
  const advance = async (researchId: string, extra: { retryIntegration?: boolean } = {}) =>
    await research.advance(owner, {
      researchId,
      expectedRevision: (await research.get(owner, researchId)).workflow.revision,
      requestId: id(),
      ...extra,
    });
  const pump = async () => {
    await app.ctx.domainEvents.drain();
    const status = (await app.ctx.domainEvents.status()).find(
      (item) => item.id === 'research.automatic.v4',
    );
    assert.equal(status?.error ?? null, null, JSON.stringify(status));
  };
  const finishTask = async (taskId: string) =>
    await deliverCurrentTask(app.ctx, directory, owner, taskId, taskReviewer);
  const digestOf = async (researchId: string) => {
    const record = await research.get(owner, researchId);
    assert.ok(record.digest);
    return JSON.parse(
      (await app.ctx.artifacts.read(owner, record.digest.id)).content,
    ) as ResearchDigest;
  };
  const enable = async () => {
    if (!release) release = await bindAutomatic(research, app.ctx.domainEvents);
  };
  const disable = async () => {
    await release?.();
    release = undefined;
  };
  t.after(async () => {
    await disable();
    research.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    get research() {
      return research;
    },
    owner,
    id,
    issue,
    define,
    task,
    experiment,
    failTask,
    failExperiment,
    create,
    advance,
    pump,
    finishTask,
    digestOf,
    enable,
    disable,
    async restart() {
      await disable();
      research.close();
      await app.stop();
      app = await createApp({ directory, config });
      research = await service();
      await enable();
    },
  };
}

test('a cycle completes once its tasks and experiments end, with no reflection step', async (t) => {
  const f = await fixture(t);
  await f.define();
  const input = await f.task();
  const trial = await f.experiment([input.id]);
  const cycle = await f.create([input.id, trial.id]);
  assert.equal(cycle.workflow.workflow, 'research');
  assert.equal(cycle.workflow.version, 7);
  assert.equal(cycle.workflow.state, 'defining');
  assert.equal('reflectionId' in cycle, false);
  assert.equal((await f.advance(cycle.id)).workflow.state, 'researching');
  // The cycle waits on its own work, and on nothing else.
  await assert.rejects(f.advance(cycle.id), { code: 'dependencies_pending' });
  await f.finishTask(input.id);
  await assert.rejects(f.advance(cycle.id), { code: 'dependencies_pending' });
  // A failed experiment is an outcome of the cycle, not a reason it cannot end.
  await f.failExperiment(trial.id);
  // This test starts from an already integrated main; the hosted case has its own test.
  hostedCode(f.research, f.app.ctx, f.owner, { unitIds: [] });
  const done = await f.advance(cycle.id);
  assert.equal(done.workflow.state, 'complete');
  assert.deepEqual(done.integrations, []);
  assert.deepEqual(done.progress, { settled: 1, total: 2 });
  const digest = await f.digestOf(cycle.id);
  assert.equal(digest.formatVersion, 2);
  assert.equal(digest.cycle.outcome, 'complete');
  assert.deepEqual(
    digest.tasks.map((item) => item.id),
    [input.id],
  );
  assert.deepEqual(
    digest.experiments.map((item) => item.id),
    [trial.id],
  );
  assert.deepEqual(digest.dropped, [trial.id]);
  assert.equal('reflection' in digest, false);
  // The project goes on: new work and a cycle that follows this one start at once.
  const more = await f.task();
  const next = await f.create([more.id], { previousCycleId: cycle.id });
  assert.equal(next.previousCycleId, cycle.id);
  assert.equal((await f.research.get(f.owner, cycle.id)).successorId, next.id);
  const lineage = await f.research.lineage(f.owner, next.id);
  assert.deepEqual(
    lineage.cycles.map((item) => item.id),
    [cycle.id, next.id],
  );
  assert.equal(lineage.cycles[0]!.digest!.id, done.digest!.id);
});

test('an automatic cycle advances to complete on its work ending, and a restart does not repeat it', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const input = await f.task();
  const trial = await f.experiment();
  const cycle = await f.create([input.id, trial.id], { automatic: true });
  await f.pump();
  const researching = await f.research.get(f.owner, cycle.id);
  assert.equal(researching.workflow.state, 'researching');
  // What it waits on is said, as Research publishes it.
  assert.equal(researching.automation!.blocker!.code, 'dependencies_pending');
  await f.failExperiment(trial.id);
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'researching');
  // The last outcome lands while nothing listens; the restart's wake finds it.
  await f.disable();
  await f.failTask(input.id);
  await f.restart();
  await f.pump();
  const done = await f.research.get(f.owner, cycle.id);
  assert.equal(done.workflow.state, 'complete');
  assert.equal(done.automation!.blocker, null);
  await wakeAutomatic(f.research);
  await wakeAutomatic(f.research);
  await f.pump();
  const again = await f.research.get(f.owner, cycle.id);
  assert.equal(again.workflow.revision, done.workflow.revision);
  assert.equal((await f.research.list(f.owner)).length, 1);
  // The completed advance's replay does not consult Git for the stage it moved into.
  const replay = {
    researchId: cycle.id,
    expectedRevision: researching.workflow.revision,
    requestId: automaticRequest(cycle.id, researching.workflow.revision, 'advance'),
  };
  const committed = await f.research.advance(f.owner, replay);
  let gitCalls = 0;
  f.research.providers.code = {
    ...f.research.providers.code,
    hosted: async () => true,
    acceptedSince: async () => {
      gitCalls++;
      throw new MervError('code_unavailable', 'Git is temporarily unavailable', 503);
    },
  };
  assert.deepEqual(await f.research.advance(f.owner, replay), committed);
  await assert.rejects(f.research.advance(f.owner, { ...replay, retryIntegration: true }), {
    code: 'request_conflict',
  });
  assert.equal(gitCalls, 0);
});

test('a hosted cycle consolidates accepted code that main lacks, then completes', async (t) => {
  const f = await fixture(t);
  await f.define();
  const input = await f.task();
  const cycle = await f.create([input.id]);
  await f.advance(cycle.id);
  await f.finishTask(input.id);
  const main: Parameters<typeof hostedCode>[3] = { unitIds: [input.id] };
  const published = hostedCode(f.research, f.app.ctx, f.owner, main);
  const consolidating = await f.advance(cycle.id);
  assert.equal(consolidating.workflow.state, 'consolidating');
  assert.equal(consolidating.integrations.length, 1);
  const [integration] = consolidating.integrations;
  assert.deepEqual(published, [integration]);
  // The consolidation task is the cycle's own child, never part of its selection.
  assert.deepEqual(consolidating.researchDependencies, [input.id]);
  await assert.rejects(f.advance(cycle.id), { code: 'dependencies_pending' });
  await f.failTask(integration!);
  await assert.rejects(f.advance(cycle.id), { code: 'integration_failed' });
  const retried = await f.advance(cycle.id, { retryIntegration: true });
  assert.equal(retried.workflow.state, 'consolidating');
  assert.equal(retried.integrations.length, 2);
  await f.finishTask(retried.integrations[1]!);
  main.publication = { state: 'published' } as typeof main.publication;
  const done = await f.advance(cycle.id);
  assert.equal(done.workflow.state, 'complete');
  assert.deepEqual((await f.digestOf(cycle.id)).integration, {
    taskId: retried.integrations[1],
    publication: 'published',
  });
});

test('a revoked source cannot advance, while another authorized cycle keeps moving', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const source = await f.issue('producer');
  const work = await f.task([], source);
  const blocked = await f.create([work.id], { automatic: true }, source);
  await f.pump();
  await f.app.ctx.scope.credentials.revokeActor(f.owner, source.actorId);
  await f.failTask(work.id);
  const otherWork = await f.task();
  const other = await f.create([otherWork.id], { automatic: true });
  await f.failTask(otherWork.id);
  await f.pump();
  assert.equal((await f.research.get(f.owner, blocked.id)).workflow.state, 'researching');
  assert.ok((await f.research.get(f.owner, blocked.id)).automation!.blocker);
  assert.equal((await f.research.get(f.owner, other.id)).workflow.state, 'complete');
  assert.equal(
    JSON.stringify(await f.research.get(f.owner, blocked.id)).includes(source.credentialId),
    false,
  );
});
