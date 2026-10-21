import { createService, type Caller, type ReviewApplication } from '@merv/contracts';
import type { ChangeSpec, Reflection } from '@merv/reflections/types';
import type { ResearchCreate } from '@merv/research/types';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { bindAutomatic, wakeAutomatic } from '../packages/research/src/automatic.js';
import { ResearchService } from '../packages/research/src/index.js';
import { createApp } from './fixtures/app.js';
import { currentExperiment } from './fixtures/current-experiment.js';
import { deliverCurrentTask } from './fixtures/current-task-delivery.js';
import { currentTask } from './fixtures/current-work.js';
import { hostedCode, providersOf } from './fixtures/research.js';

const stop: ChangeSpec = {
  version: 3,
  changes: 'Retain the failure and what remains untested.',
  next: {
    decision: 'stop',
    reason: 'no_worthwhile_next_step',
    rationale: 'Available inputs cannot answer the question.',
  },
  items: [],
  carriedOver: [],
  rejected: [],
};
const next = (name: string): ChangeSpec => ({
  version: 3,
  changes: 'Try a smaller, independently verified input first.',
  next: { decision: 'continue', name, rationale: 'The earlier failure was an input limitation.' },
  items: [
    {
      key: 'input',
      kind: 'task',
      title: 'Verify smaller input',
      goal: 'Prepare a usable input.',
      checks: ['The input is available and verified'],
      dependsOn: [],
      rationale: 'Training needs usable data.',
    },
    {
      key: 'trial',
      kind: 'experiment',
      name: `${name}-trial`,
      question: 'Does the smaller input suffice?',
      details: 'Run after input verification.',
      dependsOn: ['input'],
      rationale: 'Test the surviving hypothesis.',
    },
  ],
  carriedOver: [],
  rejected: [],
});

async function fixture(
  t: TestContext,
  plugin = false,
  retry: { afterMs?: number; forMs?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-automatic-research-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter(
    ({ id }: { id: string }) =>
      ![
        'api',
        'identity',
        'ui',
        ...(!plugin ? ['research', 'research-tools', 'research-ui'] : []),
      ].includes(id) &&
      !id.endsWith('-api') &&
      !id.endsWith('-ui'),
  );
  let app = await createApp({ directory, config });
  const service = async () =>
    plugin
      ? (app.ctx.research as ResearchService)
      : await createService(
          new ResearchService(
            app.ctx.state,
            app.ctx.scope,
            app.ctx.workflows,
            providersOf(app.ctx),
            retry.afterMs,
            retry.forMs,
          ),
        );
  let research = await service();
  let release: (() => void | Promise<void>) | undefined;
  let sequence = 0;
  const id = () => `automatic-test-${++sequence}`;
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Continuous research',
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
  const reviewer = await issue('reviewer');
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
  const failExperiment = async (
    experimentId: string,
    transition: 'abandon' | 'mark_failed' = 'mark_failed',
  ) =>
    await app.ctx.experiments.transition(owner, {
      experimentId,
      expectedRevision: (await app.ctx.experiments.get(owner, experimentId)).workflow.revision,
      transition,
      evidence: { reason: 'The available resources cannot execute the design.' },
      requestId: id(),
    });
  const create = async (dependsOn: string[], extra: Partial<ResearchCreate> = {}, caller = owner) =>
    await research.create(caller, {
      name: id(),
      dependsOn,
      automatic: true,
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
  const artifact = async (caller: Caller, content: string, mediaType = 'text/markdown') =>
    await app.ctx.artifacts.create(caller, { title: id(), content, mediaType });
  const review = async (
    reviewId: string,
    expectedRevision: number,
    verdict: 'pass' | 'needs_changes' = 'pass',
  ) => {
    const claim = await app.ctx.reviews.start(reviewer, reviewId);
    const input: ReviewApplication = {
      reviewId,
      claimId: claim.claimId!,
      expectedRevision,
      verdict,
      notes: 'Checked the retained inputs and the actual failure records.',
      synopsis: 'The report accurately describes the available evidence.',
      findings: claim.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: verdict === 'pass' ? ('met' as const) : ('not_met' as const),
        evidenceIds: claim.artifactIds,
        notes: 'Verified against the retained records.',
      })),
      ...(verdict === 'needs_changes' ? { returnTo: 'synthesizing' } : {}),
      requestId: id(),
    };
    return await app.ctx.reviews.apply(reviewer, input);
  };
  const finishTask = async (taskId: string) => {
    await deliverCurrentTask(app.ctx, directory, owner, taskId, taskReviewer);
  };
  const lenses = async (researchId: string) => {
    const record = await research.get(owner, researchId);
    let wave = await app.ctx.reflections.get(owner, record.reflectionId!);
    for (const lens of wave.lenses) {
      const author = await issue('producer');
      await app.ctx.reflections.submitLens(author, {
        lensId: lens.id,
        expectedRevision: lens.workflow.revision,
        artifactId: (
          await artifact(author, '# Summary\nThe failed input leaves the hypothesis untested.')
        ).id,
        requestId: id(),
      });
    }
    return await app.ctx.reflections.get(owner, wave.id);
  };
  const submit = async (wave: Reflection, plan: ChangeSpec | string) =>
    await app.ctx.reflections.submit(owner, {
      reflectionId: wave.id,
      expectedRevision: wave.workflow.revision,
      reportArtifactId: (
        await artifact(
          owner,
          '# Summary\nThe failed work is retained. The hypothesis remains untested.',
        )
      ).id,
      changeSpecArtifactId: (
        await artifact(
          owner,
          typeof plan === 'string' ? plan : JSON.stringify(plan),
          typeof plan === 'string' ? 'text/markdown' : 'application/json',
        )
      ).id,
      requestId: id(),
    });
  const approve = async (researchId: string, plan = stop) => {
    const wave = await submit(await lenses(researchId), plan);
    await review(wave.review!.id, wave.workflow.revision);
    await pump();
  };
  const enable = async () => {
    if (!plugin && !release) release = await bindAutomatic(research, app.ctx.domainEvents);
  };
  const disable = async () => {
    await release?.();
    release = undefined;
  };
  t.after(async () => {
    await disable();
    if (!plugin) research.close();
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
    reviewer,
    id,
    issue,
    define,
    task,
    experiment,
    failTask,
    failExperiment,
    create,
    pump,
    artifact,
    review,
    finishTask,
    lenses,
    submit,
    approve,
    enable,
    disable,
    async restart() {
      await disable();
      if (!plugin) research.close();
      await app.stop();
      app = await createApp({ directory, config });
      research = await service();
      await enable();
    },
  };
}

test('two automatic waves preserve dependencies and lineage, then stop at the configured cycle limit', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const input = await f.task();
  const first = await f.create([input.id], { maxCycles: 2 });
  await f.finishTask(input.id);
  // This orchestration test starts from an already integrated main.
  hostedCode(f.research, f.app.ctx, f.owner, { unitIds: [] });
  await f.pump();
  await f.approve(first.id, next('second'));
  const done = await f.research.get(f.owner, first.id);
  assert.equal(done.workflow.state, 'complete');
  assert.ok(done.successorId);
  let second = await f.research.get(f.owner, done.successorId);
  assert.equal(second.workflow.state, 'researching');
  assert.equal(second.automation!.cycle, 2);
  assert.equal(second.automation!.rootId, first.id);
  assert.equal(second.previousCycleId, first.id);
  const work = Object.fromEntries(second.origin!.items.map((item) => [item.key, item.id]));
  assert.deepEqual(
    (await f.app.ctx.workflows.prerequisites(f.owner, [work.trial]))
      .get(work.trial)!
      .map((item) => item.id),
    [work.input],
  );
  await f.failTask(work.input);
  await f.pump();
  await f.approve(second.id, next('third'));
  second = await f.research.get(f.owner, second.id);
  assert.equal(second.workflow.state, 'complete');
  assert.equal(second.successorId, null);
  assert.equal(second.automation!.blocker!.code, 'research_cycle_limit');
  assert.equal((await f.research.list(f.owner)).length, 2);
  assert.equal((await f.app.ctx.experiments.list(f.owner)).length, 1);
  await f.restart();
  await f.pump();
  assert.equal((await f.research.list(f.owner)).length, 2);
});

test('restart and repeated wakeups recover a missed completion without duplicate reflections', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const work = await f.experiment();
  const cycle = await f.create([work.id]);
  await f.pump();
  await f.disable();
  await f.failExperiment(work.id);
  await f.restart();
  await f.pump();
  const record = await f.research.get(f.owner, cycle.id);
  assert.equal(record.workflow.state, 'reflecting');
  await wakeAutomatic(f.research);
  await wakeAutomatic(f.research);
  await f.pump();
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 1);
  assert.equal((await f.research.get(f.owner, cycle.id)).reflectionId, record.reflectionId);
});

test('a revoked source cannot advance, while another authorized cycle keeps moving', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const source = await f.issue('producer');
  const work = await f.task([], source);
  const blocked = await f.create([work.id], {}, source);
  await f.pump();
  await f.app.ctx.scope.credentials.revokeActor(f.owner, source.actorId);
  await f.failTask(work.id);
  const otherWork = await f.task();
  const other = await f.create([otherWork.id]);
  await f.failTask(otherWork.id);
  await f.pump();
  assert.equal((await f.research.get(f.owner, blocked.id)).workflow.state, 'researching');
  assert.ok((await f.research.get(f.owner, blocked.id)).automation!.blocker);
  assert.equal((await f.research.get(f.owner, other.id)).workflow.state, 'reflecting');
  assert.equal(
    JSON.stringify(await f.research.get(f.owner, blocked.id)).includes(source.credentialId),
    false,
  );
});

test('worker sessions cannot authorize automatic research or advance the outer cycle', async (t) => {
  const f = await fixture(t);
  const work = await f.task();
  const session = { ...f.owner, session: { id: 'worker' } };
  await assert.rejects(f.create([work.id], {}, session));
  const cycle = await f.create([work.id]);
  await assert.rejects(
    f.research.advance(session, {
      researchId: cycle.id,
      expectedRevision: cycle.workflow.revision,
      nextWave: 'create',
      requestId: f.id(),
    }),
  );
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'defining');
  await assert.rejects(f.create([]), { code: 'research_work_required' });
  // Nor can a replan leave an automatic cycle without a task or experiment, or add other work.
  const replan = (dependsOn: string[]) =>
    f.research.replan(f.owner, {
      researchId: cycle.id,
      expectedRevision: cycle.workflow.revision,
      dependsOn,
      requestId: f.id(),
    });
  await assert.rejects(replan([]), { code: 'research_work_required' });
  const manual = await f.create([], { automatic: false });
  await assert.rejects(replan([work.id, manual.id]), { code: 'invalid_research_input' });
  assert.deepEqual((await replan([work.id])).researchDependencies, [work.id]);
});
