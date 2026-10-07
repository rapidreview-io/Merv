import { deliverCurrentTask } from './fixtures/current-task-delivery.js';
import { currentWork } from './fixtures/current-work.js';
import type { ExperimentAttach, ExperimentTransition } from '@merv/experiments/types';
import { currentTask } from './fixtures/current-work.js';
import { currentExperiment } from './fixtures/current-experiment.js';
import {
  createService,
  MervError,
  recorded,
  type Caller,
  type ReviewApplication,
} from '@merv/contracts';
import type { ChangeSpec, Reflection } from '@merv/reflections/types';
import type { ResearchCreate } from '@merv/research/types';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ResearchService } from '../packages/research/src/index.js';
import { bindAutomatic, wakeAutomatic } from '../packages/research/src/automatic.js';
import { createApp } from './fixtures/app.js';
import { feasibilityStatement } from './feasibility-fixture.js';
import { hostedCode, providersOf, type Main } from './fixtures/research.js';
import { publicationBlockers, type PublicationStanding } from '@merv/code-work/unit-store';
import { confirmedDelivery } from './fixtures/task-evidence.js';

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

/** A consolidation pull request waiting on an operator, as Code reports it. */
const waiting: PublicationStanding = {
  destination: 'github',
  state: 'pending',
  pull: { number: 3, url: 'https://example.test/pull/3' },
};
const pending = { ...waiting, blockers: publicationBlockers(waiting) };

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

test('new manual cycles reflect on failed and abandoned work without weakening execution prerequisites', async (t) => {
  const f = await fixture(t);
  await f.define();
  const failed = await f.experiment(),
    abandoned = await f.experiment(),
    pending = await f.task();
  let cycle = await f.create([failed.id, abandoned.id, pending.id], { automatic: false });
  await f.failExperiment(failed.id);
  await f.failExperiment(abandoned.id, 'abandon');
  cycle = await f.research.advance(f.owner, {
    researchId: cycle.id,
    expectedRevision: cycle.workflow.revision,
    requestId: f.id(),
  });
  await assert.rejects(
    f.research.advance(f.owner, {
      researchId: cycle.id,
      expectedRevision: cycle.workflow.revision,
      requestId: f.id(),
    }),
    { code: 'dependencies_pending' },
  );
  const downstream = await f.task([failed.id]);
  await assert.rejects(
    f.app.ctx.workflows.begin(f.owner, {
      instanceId: downstream.id,
      expectedRevision: downstream.workflow.revision,
    }),
    { code: 'dependency_failed' },
  );
  await f.failTask(pending.id);
  cycle = await f.research.advance(f.owner, {
    researchId: cycle.id,
    expectedRevision: cycle.workflow.revision,
    requestId: f.id(),
  });
  assert.equal(cycle.workflow.state, 'reflecting');
  await f.approve(cycle.id);
  cycle = await f.research.advance(f.owner, {
    researchId: cycle.id,
    expectedRevision: cycle.workflow.revision,
    requestId: f.id(),
  });
  assert.equal(cycle.workflow.state, 'complete');
  assert.equal((await f.app.ctx.tasks.get(f.owner, downstream.id)).workflow.state, 'in_progress');
  const digest = JSON.parse((await f.app.ctx.artifacts.read(f.owner, cycle.digest!.id)).content);
  assert.ok(digest.dropped.includes(failed.id));
  assert.ok(digest.dropped.includes(abandoned.id));
});

test('a wave closes the unstarted work between its selection and a failed input it never named', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const data = await f.task();
  const training = await f.experiment([data.id]);
  const evaluation = await f.task([training.id]);
  const cycle = await f.create([evaluation.id]);
  await f.pump();
  await f.failTask(data.id);
  await f.pump();
  assert.equal((await f.app.ctx.experiments.get(f.owner, training.id)).workflow.state, 'abandoned');
  assert.equal((await f.app.ctx.tasks.get(f.owner, evaluation.id)).workflow.state, 'failed');
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
  // Only the selected work is the cycle's to reflect on; what lay between is closed for it.
  const reasons = Object.fromEntries(
    (
      await f.app.ctx.state.read((sql) =>
        sql.all<{ data: string }>(
          "SELECT data_json AS data FROM events WHERE type='research.blocked_work_closed' AND subject_id=?",
          cycle.id,
        ),
      )
    ).map((row) => {
      const data = JSON.parse(row.data) as { workflowId: string; reason: string };
      return [data.workflowId, data.reason];
    }),
  );
  assert.match(reasons[evaluation.id]!, /Retained for reflection in /);
  assert.doesNotMatch(reasons[training.id]!, /Retained for reflection/);
  assert.match(reasons[training.id]!, /work selected by .* waits on it/);
});

test('an entirely failed wave closes blocked descendants, reflects, and waits for independent approval', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const data = await f.task();
  const training = await f.experiment([data.id]);
  const evaluation = await f.task([training.id]);
  const unselected = await f.task([data.id]);
  const cycle = await f.create([evaluation.id, training.id, data.id]);
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'researching');
  await f.failTask(data.id);
  await f.pump();
  assert.equal((await f.app.ctx.experiments.get(f.owner, training.id)).workflow.state, 'abandoned');
  const closed = await f.app.ctx.tasks.get(f.owner, evaluation.id);
  assert.equal(closed.workflow.state, 'failed');
  assert.match(closed.failure!.reason, /Not run: required input/);
  assert.equal((await f.app.ctx.tasks.get(f.owner, unselected.id)).workflow.state, 'in_progress');
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
  const wave = await f.lenses(cycle.id);
  await assert.rejects(f.submit(wave, 'Continue doing useful research.'), {
    code: 'reflection_plan_required',
  });
  const submitted = await f.submit(wave, stop);
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
  await assert.rejects(f.app.ctx.reviews.start(f.owner, submitted.review!.id), {
    code: 'review_independence',
  });
  await f.review(submitted.review!.id, submitted.workflow.revision, 'needs_changes');
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
  const revised = await f.submit(await f.app.ctx.reflections.get(f.owner, wave.id), stop);
  await f.review(revised.review!.id, revised.workflow.revision);
  await f.pump();
  const done = await f.research.get(f.owner, cycle.id);
  assert.equal(done.workflow.state, 'complete');
  assert.equal(done.successorId, null);
});

test('a last authorized cycle whose reflection chose to stop reports no cycle limit', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const input = await f.task();
  const only = await f.create([input.id], { maxCycles: 1 });
  await f.finishTask(input.id);
  hostedCode(f.research, f.app.ctx, f.owner, { unitIds: [] });
  await f.pump();
  await f.approve(only.id);
  const done = await f.research.get(f.owner, only.id);
  assert.equal(done.workflow.state, 'complete');
  assert.equal(done.successorId, null);
  assert.equal(done.automation!.blocker, null);
});

test('a run whose plan stops for its owner says so on the ended cycle until a cycle follows it', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const input = await f.task();
  const first = await f.create([input.id], { maxCycles: 5 });
  await f.finishTask(input.id);
  hostedCode(f.research, f.app.ctx, f.owner, { unitIds: [] });
  await f.pump();
  const rationale = 'The owner must choose between two datasets before any further work.';
  await f.approve(first.id, {
    ...stop,
    next: { decision: 'stop', reason: 'needs_owner', rationale },
  });
  const done = await f.research.get(f.owner, first.id);
  assert.equal(done.workflow.state, 'complete');
  assert.equal(done.successorId, null);
  assert.equal(done.automation!.blocker!.code, 'research_needs_owner');
  assert.match(done.automation!.blocker!.message, /choose between two datasets/);
  // The ended cycle is its owner's move, with the plan's reason beside it: Needs you reads this.
  const gate = (
    await f.app.ctx.workflows.overview(f.owner, undefined, { open: true })
  ).workflows.find((item) => item.instanceId === first.id);
  assert.ok(gate?.yours?.ask, JSON.stringify(gate));
  assert.match(gate!.providerBlockers[0].message, /choose between two datasets/);
  const writer = await f.issue('producer');
  assert.equal(
    (await f.app.ctx.workflows.overview(writer, undefined, { open: true })).workflows.find(
      (item) => item.instanceId === first.id,
    )?.yours,
    undefined,
  );
  // The cycle that follows it answers it.
  await f.research.create(f.owner, {
    name: 'Chosen dataset',
    previousCycleId: first.id,
    requestId: f.id(),
  });
  assert.equal((await f.research.get(f.owner, first.id)).automation!.blocker, null);
  assert.equal(
    (await f.app.ctx.workflows.overview(f.owner, undefined, { open: true })).workflows.some(
      (item) => item.instanceId === first.id,
    ),
    false,
  );
});

test('a cycle its owner starts by hand, naming none it follows, answers the latest run that stopped for them', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const input = await f.task();
  const first = await f.create([input.id], { maxCycles: 5 });
  await f.finishTask(input.id);
  hostedCode(f.research, f.app.ctx, f.owner, { unitIds: [] });
  await f.pump();
  await f.approve(first.id, {
    ...stop,
    next: { decision: 'stop', reason: 'needs_owner', rationale: 'Choose a dataset.' },
  });
  const asked = async () => (await f.research.get(f.owner, first.id)).automation!.blocker?.code;
  assert.equal(await asked(), 'research_needs_owner');
  // A writer who is not its owner starts a cycle: the owner's decision is still theirs.
  const writer = await f.issue('producer');
  await f.research.create(writer, { name: 'Unrelated', requestId: f.id() });
  assert.equal(await asked(), 'research_needs_owner');
  // The New cycle form, as the owner sends it without naming the ended cycle.
  await f.research.create(f.owner, { name: 'Chosen dataset', requestId: f.id() });
  assert.equal(await asked(), undefined);
  assert.equal(
    (await f.app.ctx.workflows.overview(f.owner, undefined, { open: true })).workflows.some(
      (item) => item.instanceId === first.id,
    ),
    false,
  );
});

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

test('expected handoff failures roll back child creation and recover without poisoning the event consumer', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const work = await f.experiment();
  const cycle = await f.create([work.id]);
  await f.pump();
  const original = f.app.ctx.reflections.create.bind(f.app.ctx.reflections);
  const broken = t.mock.method(
    f.app.ctx.reflections,
    'create',
    async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new MervError('reflection_unavailable', 'Provider withdrew after child creation', 503);
    },
  );
  await f.failExperiment(work.id);
  // A provider that may never come back blocks only its cycle, at once: the shared consumer
  // moves on, and the provider's bind wakes the cycle again.
  await f.pump();
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 0);
  const blocked = await f.research.get(f.owner, cycle.id);
  assert.equal(blocked.workflow.state, 'researching');
  assert.equal(blocked.automation!.blocker!.code, 'reflection_unavailable');
  broken.mock.restore();
  await wakeAutomatic(f.research);
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 1);
});

test('a cycle a passing outage refused is tried again without another event', async (t) => {
  const f = await fixture(t, false, { afterMs: 50 });
  await f.define();
  await f.enable();
  const work = await f.experiment();
  const cycle = await f.create([work.id]);
  await f.pump();
  const original = f.app.ctx.reflections.create.bind(f.app.ctx.reflections);
  let failures = 1;
  t.mock.method(f.app.ctx.reflections, 'create', async (...args: Parameters<typeof original>) => {
    if (failures-- > 0) throw new MervError('code_git_timeout', 'Git did not answer in time', 503);
    return await original(...args);
  });
  await f.failExperiment(work.id);
  await f.pump();
  const blocked = await f.research.get(f.owner, cycle.id);
  assert.equal(blocked.automation!.blocker!.code, 'code_git_timeout');
  // Published where every reader of the cycle's gate sees it.
  assert.deepEqual(
    (await f.app.ctx.workflows.blockers(f.owner, cycle.id)).map((item) => [
      item.provider,
      item.code,
      item.status,
    ]),
    [['research', 'code_git_timeout', 503]],
  );
  for (let wait = 0; wait < 40; wait++) {
    await f.app.ctx.domainEvents.drain();
    if ((await f.research.get(f.owner, cycle.id)).workflow.state === 'reflecting') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
});

test('a retry that fails while the database is still down is tried again', async (t) => {
  const f = await fixture(t, false, { afterMs: 30 });
  await f.define();
  await f.enable();
  const work = await f.experiment();
  const cycle = await f.create([work.id]);
  await f.pump();
  const original = f.app.ctx.reflections.create.bind(f.app.ctx.reflections);
  let failures = 1;
  t.mock.method(f.app.ctx.reflections, 'create', async (...args: Parameters<typeof original>) => {
    if (failures-- > 0) throw new MervError('code_git_timeout', 'Git did not answer in time', 503);
    return await original(...args);
  });
  // The retry's own write finds the database down the first time.
  const append = f.app.ctx.state.appendEvent.bind(f.app.ctx.state);
  let down = 1;
  t.mock.method(f.app.ctx.state, 'appendEvent', async (...args: Parameters<typeof append>) => {
    if (args[1].type === 'research.resume' && down-- > 0)
      throw new MervError('state_unavailable', 'The database is unavailable', 503);
    return await append(...args);
  });
  await f.failExperiment(work.id);
  await f.pump();
  for (let wait = 0; wait < 40; wait++) {
    await f.app.ctx.domainEvents.drain();
    if ((await f.research.get(f.owner, cycle.id)).workflow.state === 'reflecting') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(down, -1, 'the first retry failed');
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
});

test('outages that alternate their codes are still tried again only for the bound, by one timer per project', async (t) => {
  const f = await fixture(t, false, { afterMs: 37, forMs: 400 });
  await f.define();
  await f.enable();
  const works = [await f.experiment(), await f.experiment()];
  for (const work of works) await f.create([work.id]);
  await f.pump();
  let calls = 0;
  t.mock.method(f.app.ctx.reflections, 'create', async () => {
    // Each refusal names another outage, so the published blocker's `since` keeps moving.
    throw new MervError(calls++ % 2 ? 'code_git_timeout' : 'sandbox_unavailable', 'Down', 503);
  });
  // Retry timers waiting at once, and the most there ever were.
  const timer = globalThis.setTimeout;
  let waiting = 0,
    most = 0;
  t.mock.method(globalThis, 'setTimeout', ((run: () => void, ms?: number) => {
    if (ms !== 37) return timer(run, ms);
    most = Math.max(most, ++waiting);
    return timer(() => {
      waiting--;
      run();
    }, ms);
  }) as typeof setTimeout);
  for (const work of works) await f.failExperiment(work.id);
  await f.pump();
  const settle = async () => {
    await new Promise((resolve) => timer(resolve, 300));
    await f.app.ctx.domainEvents.drain();
    return calls;
  };
  for (let round = 0; round < 5; round++) await settle();
  const after = await settle();
  assert.ok(after > 4, 'the outage was tried again while it was new');
  // Two cycles of one project refused in one pass: one resume tries both again.
  assert.equal(most, 1);
  assert.equal(await settle(), after, 'retries stop once the first outage is older than the bound');
});

test('a database briefly unavailable is retried with its event instead of blocking the cycle', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const work = await f.experiment();
  const cycle = await f.create([work.id]);
  await f.pump();
  const original = f.app.ctx.reflections.create.bind(f.app.ctx.reflections);
  let failures = 1;
  t.mock.method(f.app.ctx.reflections, 'create', async (...args: Parameters<typeof original>) => {
    if (failures-- > 0) throw new MervError('state_busy', 'Every connection is in use', 503);
    return await original(...args);
  });
  await f.failExperiment(work.id);
  for (let wait = 0; wait < 40; wait++) {
    await f.app.ctx.domainEvents.drain();
    if ((await f.research.get(f.owner, cycle.id)).workflow.state === 'reflecting') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const record = await f.research.get(f.owner, cycle.id);
  assert.equal(record.workflow.state, 'reflecting');
  assert.equal(record.automation!.blocker?.code, 'reflection_not_approved');
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 1);
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
});

test('publication-aware automation upgrades the durable subscription and wakes existing cycles', async (t) => {
  const f = await fixture(t);
  await f.define();
  const types = [
    'workflow.transition',
    'workflow.limit_extended',
    'research.created',
    'research.resume',
    'paper.patched',
    'actor.permissions_changed',
  ];
  // The consumers earlier releases left behind, before stale publications and departures woke it.
  for (const [id, more] of [
    ['research.automatic.v1', []],
    ['research.automatic.v2', ['code.publication_verified']],
    ['research.automatic.v3', ['code.publication_verified', 'code.publication_stale']],
  ] as const) {
    const release = await f.app.ctx.domainEvents.subscribe({
      id,
      from: 'beginning',
      types: [...types, ...more],
      handle: async () => {},
    });
    await release();
  }
  const work = await f.task();
  const cycle = await f.create([work.id]);
  await f.failTask(work.id);
  await f.enable();
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
  assert.ok(
    (await f.app.ctx.domainEvents.status()).some((item) => item.id === 'research.automatic.v2'),
  );
});

test('the normal plugin composition automatically starts reflection and restores after restart', async (t) => {
  const f = await fixture(t, true);
  await f.define();
  const work = await f.experiment();
  const cycle = await f.create([work.id]);
  await f.failExperiment(work.id);
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
  await f.restart();
  await f.pump();
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 1);
});

test('an accepted negative experimental finding automatically opens reflection', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  let experiment = await f.experiment();
  const cycle = await f.create([experiment.id]);
  const directory = mkdtempSync(join(tmpdir(), 'merv-negative-current-'));
  const work = currentWork(f.app.ctx, { directory, source: f.owner });
  let execution: Awaited<ReturnType<typeof work.lease>> | undefined;
  try {
    const attach = async (role: 'plan' | 'feasibility' | 'result' | 'report', content: string) => {
      const json = role === 'feasibility' || role === 'result';
      const artifact = execution
        ? await work.run(
            execution,
            'artifact.create',
            { title: role, content, mediaType: json ? 'application/json' : 'text/markdown' },
            (caller, input) => f.app.ctx.artifacts.create(caller, input as never),
          )
        : await f.artifact(f.owner, content, json ? 'application/json' : 'text/markdown');
      const input = {
        experimentId: experiment.id,
        attemptIndex: experiment.attempt.index,
        expectedRevision: experiment.workflow.revision,
        artifactId: artifact.id,
        role,
        path: `${role}.${json ? 'json' : 'md'}`,
        ...(role === 'result' ? { resultFormat: 'json' as const } : {}),
        requestId: f.id(),
      };
      if (execution)
        await work.run(execution, 'experiment.attach', input, (caller, bound) =>
          f.app.ctx.experiments.attach(caller, bound as unknown as ExperimentAttach),
        );
      else await f.app.ctx.experiments.attach(f.owner, input);
    };
    await attach(
      'plan',
      '# Summary\nA paired comparison.\n# Objective & hypothesis\nThe change improves accuracy.\n# Evaluation\nCompare two fixed seeds and matched controls.',
    );
    await attach('feasibility', feasibilityStatement());
    experiment = await f.app.ctx.experiments.transition(f.owner, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition: 'submit_design',
      requestId: f.id(),
    });
    await f.review(experiment.reviewId!, experiment.workflow.revision);
    experiment = await f.app.ctx.experiments.get(f.owner, experiment.id);
    execution = await work.lease(experiment);
    await attach('result', '{"baseline": 0.8, "treatment": 0.8}');
    await attach(
      'report',
      '# Summary\nThe result refuted the hypothesis.\n# Results\nmetrics_exhibit.json reports no improvement.\n# Deviations from plan\nNone.\n# Conclusion\nNo improvement was observed.',
    );
    experiment = await work.run(
      execution,
      'experiment.transition',
      { transition: 'submit_results', requestId: f.id() },
      (caller, bound) =>
        f.app.ctx.experiments.transition(caller, bound as unknown as ExperimentTransition),
    );
    await work.release(execution);
    await f.pump();
    assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'researching');
    await f.review(experiment.reviewId!, experiment.workflow.revision);
    await f.pump();
    assert.equal(
      (await f.app.ctx.experiments.get(f.owner, experiment.id)).workflow.state,
      'complete',
    );
    assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
  } finally {
    await work.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an automatic cycle waits on its consolidation task and its publication as blockers, never as failures', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const work = await f.task();
  const cycle = await f.create([work.id], { maxCycles: 3 });
  await f.finishTask(work.id);
  await f.pump();
  const main: Main = { unitIds: [work.id] };
  hostedCode(f.research, f.app.ctx, f.owner, main);
  await f.approve(cycle.id, next('after-main'));
  // The driver advances inside its consumer transaction, where Git cannot say what main
  // lacks; the same advance runs again on its own once that has committed, and injects.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await f.pump();
  let record = await f.research.get(f.owner, cycle.id);
  assert.equal(record.workflow.state, 'consolidating');
  assert.equal(record.successorId, null);
  const [taskId] = record.integrations;
  assert.equal(
    (await f.research.get(f.owner, cycle.id)).automation!.blocker!.code,
    'dependencies_pending',
  );
  main.publication = pending;
  await f.finishTask(taskId);
  await f.pump();
  record = await f.research.get(f.owner, cycle.id);
  assert.equal(record.workflow.state, 'consolidating');
  assert.deepEqual(record.automation!.blocker!.code, 'code_publication_pending');
  assert.match(record.automation!.blocker!.message, /merges pull request #3/);
  assert.equal(record.automation!.cycle, 1);
  const commitSha = 'd'.repeat(40);
  main.publication = { blockers: [], state: 'published', mergeCommit: commitSha };
  // Publication must wake the cycle itself, without a restart or a manual advance.
  await f.app.ctx.state.transaction((tx) =>
    recorded(f.app.ctx.state, tx, f.owner, 'code.publication_verified', 'codeprop_test', {
      unitId: taskId,
      commitSha,
    }),
  );
  await f.pump();
  record = await f.research.get(f.owner, cycle.id);
  assert.equal(record.workflow.state, 'complete');
  assert.equal(record.automation!.blocker, null);
  assert.equal(
    (await f.research.get(f.owner, record.successorId!)).automation!.cycle,
    2,
    'the waits cost no cycle',
  );
});

test('a publication main overtook wakes an automatic cycle to inject its successor', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const work = await f.task();
  const cycle = await f.create([work.id], { maxCycles: 3 });
  await f.finishTask(work.id);
  await f.pump();
  const main: Main = { unitIds: [work.id] };
  hostedCode(f.research, f.app.ctx, f.owner, main);
  await f.approve(cycle.id, next('after-main'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await f.pump();
  const [taskId] = (await f.research.get(f.owner, cycle.id)).integrations;
  main.publication = pending;
  await f.finishTask(taskId);
  await f.pump();
  assert.equal(
    (await f.research.get(f.owner, cycle.id)).automation!.blocker!.code,
    'code_publication_pending',
  );
  // Main moved first: Code marks the publication stale, and says so.
  main.publication = { blockers: [], state: 'stale' };
  main.unitIds = [work.id, taskId];
  await f.app.ctx.state.transaction((tx) =>
    recorded(f.app.ctx.state, tx, f.owner, 'code.publication_stale', 'codeprop_test', {
      unitId: taskId,
    }),
  );
  // The advance asks Git outside the consumer's transaction and commits on its own, after the
  // delivery that woke it, so its successor's start is delivered in a later pass.
  const deadline = Date.now() + 5000;
  do {
    await f.pump();
    const woken = await f.research.get(f.owner, cycle.id);
    if (
      woken.integrations.length === 2 &&
      woken.automation?.blocker?.code === 'dependencies_pending'
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  const record = await f.research.get(f.owner, cycle.id);
  assert.equal(record.workflow.state, 'consolidating');
  assert.equal(record.integrations.length, 2, 'the stale publication woke the cycle');
  assert.equal(record.automation!.blocker!.code, 'dependencies_pending');
});

test('changed definitions wait for owner acceptance and ending a cycle stops subsequent handoffs', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const work = await f.task();
  const cycle = await f.create([work.id]);
  await f.pump();
  await f.define();
  await f.failTask(work.id);
  await f.pump();
  await f.approve(cycle.id, next('changed'));
  const previous = await f.research.get(f.owner, cycle.id);
  let successor = await f.research.get(f.owner, previous.successorId!);
  assert.equal(successor.workflow.state, 'defining');
  assert.equal(successor.automation!.blocker!.code, 'research_definition_changed');
  successor = await f.research.advance(f.owner, {
    researchId: successor.id,
    expectedRevision: successor.workflow.revision,
    requestId: f.id(),
  });
  assert.equal(successor.workflow.state, 'researching');
  await f.research.end(f.owner, {
    researchId: successor.id,
    expectedRevision: successor.workflow.revision,
    outcome: 'abandoned',
    reason: 'The owner stopped this run.',
    requestId: f.id(),
  });
  const input = successor.origin!.items.find((item) => item.key === 'input')!;
  await f.failTask(input.id);
  await f.pump();
  assert.equal((await f.research.get(f.owner, successor.id)).workflow.state, 'abandoned');
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 1);
});

/** What the caller is asked of a record on Needs you, as Workflows' overview answers it. */
const yoursOn = async (
  f: Awaited<ReturnType<typeof fixture>>,
  caller: Caller,
  instanceId: string,
) =>
  (await f.app.ctx.workflows.overview(caller, undefined, { open: true })).workflows.find(
    (item) => item.instanceId === instanceId,
  )?.yours;

test('a run stopped by a changed definition is its owner’s move', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const work = await f.task();
  const cycle = await f.create([work.id]);
  await f.pump();
  await f.define();
  await f.failTask(work.id);
  await f.pump();
  await f.approve(cycle.id, next('changed'));
  const successor = (await f.research.get(f.owner, cycle.id)).successorId!;
  assert.equal(
    (await f.research.get(f.owner, successor)).automation!.blocker!.code,
    'research_definition_changed',
  );
  assert.match((await yoursOn(f, f.owner, successor))?.ask ?? '', /changed definition/);
});

test('a run whose delegation lapsed with its owner is an admin’s move', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const source = await f.issue('producer');
  const work = await f.task([], source);
  const blocked = await f.create([work.id], {}, source);
  await f.pump();
  await f.app.ctx.scope.credentials.revokeActor(f.owner, source.actorId);
  await f.failTask(work.id);
  await f.pump();
  assert.ok((await f.research.get(f.owner, blocked.id)).automation!.blocker);
  assert.match((await yoursOn(f, f.owner, blocked.id))?.ask ?? '', /delegation/);
});

test('an owner who decides to stop clears research_needs_owner by ending the cycle', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const input = await f.task();
  const first = await f.create([input.id], { maxCycles: 5 });
  await f.finishTask(input.id);
  hostedCode(f.research, f.app.ctx, f.owner, { unitIds: [] });
  await f.pump();
  await f.approve(first.id, {
    ...stop,
    next: { decision: 'stop', reason: 'needs_owner', rationale: 'Choose a dataset.' },
  });
  const done = await f.research.get(f.owner, first.id);
  assert.equal(done.automation!.blocker!.code, 'research_needs_owner');
  const end = {
    researchId: first.id,
    expectedRevision: done.workflow.revision,
    outcome: 'abandoned' as const,
    reason: 'Decided to stop here.',
    requestId: f.id(),
  };
  const ended = await f.research.end(f.owner, end);
  assert.equal(ended.workflow.state, 'complete');
  assert.equal(ended.automation!.blocker, null);
  assert.equal(await yoursOn(f, f.owner, first.id), undefined);
  // The same request replays; a cycle that asks nothing still cannot be ended again.
  assert.equal((await f.research.end(f.owner, end)).automation!.blocker, null);
  await assert.rejects(f.research.end(f.owner, { ...end, requestId: f.id() }), {
    code: 'invalid_transition',
  });
});

test('research_needs_owner goes to admins once its owner has left', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const writer = await f.issue('producer');
  const input = await f.task([], writer);
  const first = await f.create([input.id], { maxCycles: 5 }, writer);
  await f.finishTask(input.id);
  hostedCode(f.research, f.app.ctx, f.owner, { unitIds: [] });
  await f.pump();
  await f.approve(first.id, {
    ...stop,
    next: { decision: 'stop', reason: 'needs_owner', rationale: 'Choose a dataset.' },
  });
  assert.equal(
    (await f.research.get(f.owner, first.id)).automation!.blocker!.code,
    'research_needs_owner',
  );
  assert.ok((await yoursOn(f, writer, first.id))?.ask);
  // An owner's move is a project admin's too, so the admin reads it before the owner leaves.
  assert.match((await yoursOn(f, f.owner, first.id))?.ask ?? '', /Decide what comes next/);
  await f.app.ctx.scope.credentials.revokeActor(f.owner, writer.actorId);
  await f.pump();
  // Once its owner has left, it is the admins' own move, and it still asks them.
  assert.match((await yoursOn(f, f.owner, first.id))?.ask ?? '', /Decide what comes next/);
  // An admin's cycle that follows it answers it, and no later departure brings it back.
  await f.research.create(f.owner, {
    name: 'Chosen dataset',
    previousCycleId: first.id,
    requestId: f.id(),
  });
  await f.app.ctx.scope.credentials.revokeActor(f.owner, (await f.issue('producer')).actorId);
  await f.pump();
  assert.equal((await f.research.get(f.owner, first.id)).automation!.blocker, null);
  assert.equal(await yoursOn(f, f.owner, first.id), undefined);
});

test('each owner closes only its own work that nobody started', async (t) => {
  const f = await fixture(t);
  const task = await f.task();
  const experiment = await f.experiment();
  const close = async (owner: 'tasks' | 'experiments', id: string) =>
    await f.app.ctx.state.transaction(
      async (tx) => await f.app.ctx[owner].closeUnstarted(f.owner, id, 'Not run.', f.id(), tx),
    );
  assert.equal(await close('tasks', experiment.id), false);
  assert.equal(await close('experiments', task.id), false);
  assert.equal(await close('tasks', task.id), true);
  assert.equal(await close('experiments', experiment.id), true);
  assert.equal((await f.app.ctx.tasks.get(f.owner, task.id)).workflow.state, 'failed');
  assert.equal(
    (await f.app.ctx.experiments.get(f.owner, experiment.id)).workflow.state,
    'abandoned',
  );
  // Ended work is not closed again.
  assert.equal(await close('tasks', task.id), false);
  assert.equal(await close('experiments', experiment.id), false);
});
