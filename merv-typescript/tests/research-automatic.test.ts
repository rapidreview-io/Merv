import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Data, SessionWorkspace } from '@merv/contracts';
import type { ConsolidationSubmit } from '@merv/consolidation/types';
import { feasibilityStatement } from './feasibility-fixture.js';
import { createService, MervError, type Caller, type ReviewApplication } from '@merv/contracts';
import { createApp } from '../src/app.js';
import { ResearchService } from '../packages/research/src/index.js';
import type { ResearchCreate, ResearchRecord } from '@merv/research/types';
import type { ChangeSpec, Reflection } from '@merv/reflections/types';
import { confirmedDelivery } from './fixtures/task-evidence.js';

const stop: ChangeSpec = {
  version: 1,
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
  version: 1,
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

async function fixture(t: TestContext, plugin = false) {
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
  const postgresSchema = process.env.MERV_TEST_POSTGRES_URL
    ? `automatic_${randomUUID().replaceAll('-', '')}`
    : null;
  if (postgresSchema)
    config.plugins.find((entry: { id: string }) => entry.id === 'state').config = {
      backend: 'postgres',
      connectionStringEnv: 'MERV_TEST_POSTGRES_URL',
      schema: postgresSchema,
    };
  let app = await createApp({ directory, config });
  const service = async () =>
    plugin
      ? (app.ctx.research as ResearchService)
      : await createService(
          new ResearchService(
            app.ctx.state,
            app.ctx.scope,
            app.ctx.workflows,
            app.ctx.paper,
            app.ctx.reflections,
            app.ctx.consolidation,
            app.ctx.knowledge,
            app.ctx.tasks,
            app.ctx.experiments,
            app.ctx.artifacts,
          ),
        );
  let research = await service();
  let release: (() => Promise<void>) | undefined;
  let sequence = 0;
  const id = () => `automatic-test-${++sequence}`;
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Continuous research',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer') => {
    const actor = await app.ctx.scope.issueActor(owner, { name: id(), role });
    return {
      projectId: owner.projectId,
      actorId: actor.actor.id,
      credentialId: actor.credential.id,
    };
  };
  const reviewer = await issue('reviewer');
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
    await app.ctx.tasks.create(caller, {
      title: id(),
      goal: 'Provide verified input.',
      checks: ['The input is available and verified'],
      dependsOn,
      requestId: id(),
    });
  const experiment = async (dependsOn: string[] = [], caller = owner) =>
    await app.ctx.experiments.create(caller, {
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
      (item) => item.id === 'research.automatic.v1',
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
    const task = await app.ctx.tasks.get(owner, taskId);
    const evidence = await artifact(owner, 'The input is available and verified.');
    const submitted = await app.ctx.tasks.submitDelivery(
      owner,
      confirmedDelivery({
        taskId,
        expectedRevision: task.workflow.revision,
        artifactIds: [evidence.id],
        requestId: id(),
      }),
    );
    await review(submitted.reviewId!, submitted.workflow.revision);
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
    if (!plugin && !release) release = await research.bindAutomatic(app.ctx.domainEvents);
  };
  const disable = async () => {
    await release?.();
    release = undefined;
  };
  t.after(async () => {
    await disable();
    if (!plugin) research.close();
    await app.stop();
    if (postgresSchema) {
      const pool = new Pool({ connectionString: process.env.MERV_TEST_POSTGRES_URL });
      try {
        await pool.query(`DROP SCHEMA ${postgresSchema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
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

test('two automatic waves preserve dependencies and lineage, then stop at the configured cycle limit', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const input = await f.task();
  const first = await f.create([input.id], { maxCycles: 2 });
  await f.finishTask(input.id);
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
    (await f.app.ctx.workflows.dependencies(f.owner, work.trial)).dependencies.map(
      (item) => item.id,
    ),
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
  await f.research.wakeAutomatic();
  await f.research.wakeAutomatic();
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
  await f.pump();
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 0);
  const blocked = await f.research.get(f.owner, cycle.id);
  assert.equal(blocked.workflow.state, 'researching');
  assert.equal(blocked.automation!.blocker!.code, 'reflection_unavailable');
  broken.mock.restore();
  await f.research.wakeAutomatic();
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
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
  await f.app.ctx.scope.revokeActor(f.owner, source.actorId);
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
  const attach = async (role: 'plan' | 'feasibility' | 'result' | 'report', content: string) => {
    const json = role === 'feasibility' || role === 'result';
    const artifact = await f.artifact(
      f.owner,
      content,
      json ? 'application/json' : 'text/markdown',
    );
    await f.app.ctx.experiments.attach(f.owner, {
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      expectedRevision: experiment.workflow.revision,
      artifactId: artifact.id,
      role,
      path: `${role}.${json ? 'json' : 'md'}`,
      ...(role === 'result' ? { resultFormat: 'json' as const } : {}),
      requestId: f.id(),
    });
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
  await attach('result', '{"baseline": 0.8, "treatment": 0.8}');
  await attach(
    'report',
    '# Summary\nThe result refuted the hypothesis.\n# Results\nmetrics_exhibit.json reports no improvement.\n# Deviations from plan\nNone.\n# Conclusion\nNo improvement was observed.',
  );
  experiment = await f.app.ctx.experiments.transition(f.owner, {
    experimentId: experiment.id,
    expectedRevision: experiment.workflow.revision,
    transition: 'submit_results',
    requestId: f.id(),
  });
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'researching');
  await f.review(experiment.reviewId!, experiment.workflow.revision);
  await f.pump();
  assert.equal(
    (await f.app.ctx.experiments.get(f.owner, experiment.id)).workflow.state,
    'complete',
  );
  assert.equal((await f.research.get(f.owner, cycle.id)).workflow.state, 'reflecting');
});

test('automatic continuation waits for the selected Git consolidation and its actual independent review', async (t) => {
  const f = await fixture(t);
  await f.define();
  await f.enable();
  const work = await f.task();
  const cycle = await f.create([work.id], { consolidationWorkspace: 'git', maxCycles: 2 });
  await f.failTask(work.id);
  await f.pump();
  await f.approve(cycle.id, next('aftergit'));
  const parent = await f.research.get(f.owner, cycle.id);
  assert.equal(parent.workflow.state, 'consolidating');
  assert.equal(parent.successorId, null);
  const consolidation = await f.app.ctx.consolidation.get(f.owner, parent.consolidationId!);
  const sessions = f.app.ctx.sessions;
  const offer = async (instanceId: string, expectedRevision: number, source: Caller) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(source, {
      instanceId,
      expectedRevision,
      runnerId: 'automatic-test',
      requestId: f.id(),
      secret,
    });
    return { session, caller: await sessions.authenticate(secret) };
  };
  const run = async <T>(
    caller: Caller,
    tool: string,
    input: Data,
    action: (caller: Caller) => Promise<T>,
  ) =>
    await sessions.run(
      await sessions.prepare(caller, tool, input),
      async (caller) => await action(caller),
    );
  const worker = await offer(consolidation.id, consolidation.workflow.revision, f.owner);
  const control = { sessionId: worker.session.id, runnerId: 'automatic-test', hostRef: 'launch' };
  const oid = (digit: string) => digit.repeat(40);
  const workspace: SessionWorkspace = {
    repositoryId: 'repo',
    workspaceId: 'workspace',
    mode: 'persistent',
    branch: 'codex/consolidation',
    baseOid: oid('a'),
    headOid: oid('a'),
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  await sessions.attach(f.owner, { ...control, workspace });
  const commit = {
    expectedHead: oid('a'),
    message: 'Consolidate reviewed findings',
    requestId: f.id(),
  };
  await run(
    worker.caller,
    'code.commit',
    commit,
    async (caller) => await f.app.ctx.code.commit(caller, commit),
  );
  const command = (await f.app.ctx.code.nextCommand(f.owner, control))!;
  await f.app.ctx.code.completeCommand(f.owner, {
    ...control,
    commandId: command.id,
    receipt: {
      commandId: command.id,
      repositoryId: 'repo',
      workspaceId: 'workspace',
      baseOid: oid('a'),
      parentOid: oid('a'),
      headOid: oid('b'),
      treeOid: oid('c'),
      stats: { commitCount: 1, filesChanged: 1, insertions: 2, deletions: 0 },
    },
  });
  const report = await run(
    worker.caller,
    'artifact.create',
    { title: 'Consolidation', content: 'Verified the proposed commit and retained tests.' },
    async (caller) =>
      await f.app.ctx.artifacts.create(caller, {
        title: 'Consolidation',
        content: 'Verified the proposed commit and retained tests.',
      }),
  );
  const submission: ConsolidationSubmit = {
    consolidationId: consolidation.id,
    expectedRevision: consolidation.workflow.revision,
    reportArtifactId: report.id,
    commandId: command.id,
    decisions: [],
    requestId: f.id(),
  };
  const submitted = await run(
    worker.caller,
    'consolidation.submit',
    JSON.parse(JSON.stringify(submission)) as Data,
    async (caller) => await f.app.ctx.consolidation.submit(caller, submission),
  );
  await sessions.release(f.owner, { sessionId: worker.session.id, runnerId: 'automatic-test' });
  await f.pump();
  assert.equal((await f.research.get(f.owner, cycle.id)).successorId, null);
  const reviewer = await offer(consolidation.id, submitted.workflow.revision, f.reviewer);
  const claim = await f.app.ctx.reviews.get(f.owner, submitted.reviewId!);
  const review: ReviewApplication = {
    reviewId: claim.id,
    claimId: claim.claimId!,
    expectedRevision: submitted.workflow.revision,
    verdict: 'pass',
    notes: 'Verified the exact retained proposal.',
    synopsis: 'The consolidation matches the approved reflection.',
    findings: claim.criteria.map((_, index) => ({
      criterionNumber: index + 1,
      status: 'met',
      evidenceIds: [report.id],
      notes: 'Verified retained evidence.',
    })),
    requestId: f.id(),
  };
  await run(
    reviewer.caller,
    'review.submit',
    { ...review },
    async (caller) => await f.app.ctx.reviews.apply(caller, review),
  );
  await f.pump();
  const completed = await f.research.get(f.owner, cycle.id);
  assert.equal(completed.workflow.state, 'complete');
  assert.ok(completed.successorId);
  assert.equal(
    (await f.research.get(f.owner, completed.successorId)).workflow.state,
    'researching',
  );
  assert.equal(
    (await f.app.ctx.consolidation.get(f.owner, consolidation.id)).completion!.centralGit,
    'not-published',
  );
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
