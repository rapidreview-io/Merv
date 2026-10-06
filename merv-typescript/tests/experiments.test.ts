import {
  experimentTransitionSchema,
  parseExperimentInput,
} from '../packages/experiments/src/input.js';
import { currentWork } from './fixtures/current-work.js';
import { managedServices } from './fixtures/managed-services.js';
import { nativeWorkFixture } from './fixtures/native-work.js';
import { createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { ExperimentService } from '@merv/experiments';
import { check, MervError, type Blobs, type Caller, type ReviewApplication } from '@merv/contracts';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentEvidence,
  ExperimentReview,
  ExperimentTransition,
} from '@merv/experiments/types';
import { citedEvidence, feasibilityStatement } from './feasibility-fixture.js';
import { openState } from './fixtures/state.js';
const plan =
  '# Summary\nA paired comparison.\n# Objective & hypothesis\nThe change should improve validation accuracy.\n# Evaluation\nCompare two fixed seeds and matched controls.';
const report =
  '# Summary\nThe result refuted the hypothesis.\n# Results\nmetrics_exhibit.json reports the retained observations.\n# Deviations from plan\nNone.\n# Conclusion\nNo improvement was observed.';
const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test('small uploaded evidence is readable and attachable while actual oversized downloads are rejected', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from(`${plan}\n${'Evidence for the paired comparison. '.repeat(1200)}`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  // Disk blobs that sign uploads; the signed PUT stores the bytes where put does.
  const blobs: Blobs = f.blobs;
  const get = blobs.get.bind(blobs);
  let requests = 0;
  blobs.get = async (namespace, hash) => {
    requests++;
    return await get(namespace, hash);
  };
  blobs.stored = async (namespace, hash) =>
    await get(namespace, hash).then(
      (stored) => stored.length,
      () => null,
    );
  blobs.upload = async () => ({ url: 'https://storage.test/put', headers: {}, expiresAt: '' });
  const begun = await f.artifacts.uploadBegin(f.producer, {
    title: 'plan.md',
    size: bytes.length,
    sha256: hash,
    mediaType: 'text/markdown',
  });
  await blobs.put(f.producer.projectId, bytes);
  const artifact = await f.artifacts.uploadComplete(f.producer, begun.uploadId);
  // Completion copies the verified bytes into the row: the one storage read happens there.
  assert.equal(requests, 1);
  assert.equal((await f.artifacts.read(f.producer, artifact.id)).content, bytes.toString());
  const outsider = await f.scope.credentials.bootstrap({
    projectName: 'Other project',
    actorName: 'Other owner',
  });
  await assert.rejects(
    f.artifacts.read({ actorId: outsider.actor.id, projectId: outsider.project.id }, artifact.id),
    code('not_found'),
  );
  assert.equal(requests, 1);
  const experiment = await f.create();
  const attached = await f.experiments.attach(f.producer, {
    experimentId: experiment.id,
    attemptIndex: experiment.attempt.index,
    expectedRevision: experiment.workflow.revision,
    artifactId: artifact.id,
    role: 'plan',
    path: 'plan.md',
    requestId: f.id(),
  });
  assert.equal(attached.artifactId, artifact.id);
  // Later reads never reach blobs again, even with the bytes gone from there.
  unlinkSync(join(f.directory, 'blobs', f.producer.projectId, hash.slice(0, 2), hash));
  assert.equal((await f.artifacts.read(f.producer, artifact.id)).content, bytes.toString());
  assert.equal(requests, 1);
});
async function fixture(t: TestContext, limits?: { designRounds: number; resultRounds: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'merv-experiments-core-')),
    state = await openState(dir);
  const scope = await createService(new ProjectScope(state)),
    boot = await scope.credentials.bootstrap({ projectName: 'Experiments', actorName: 'Operator' });
  const operator: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const result = await scope.credentials.issueActor(operator, { name: role, role });
    return {
      actorId: result.actor.id,
      projectId: operator.projectId,
      credentialId: result.credential.id,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader'),
    otherProducer = await issue('producer');
  const blobs = new DiskBlobs(join(dir, 'blobs')),
    artifacts = await createService(new ArtifactStore(state, scope, blobs)),
    workflows = await createService(new WorkflowsService(state, scope)),
    reviews = await createService(new ReviewService(state, scope, artifacts)),
    contextBuilder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const managed = await managedServices({ state, scope, artifacts, workflows }, dir, operator);
  let experiments = await createService(
      new ExperimentService(
        state,
        scope,
        artifacts,
        workflows,
        reviews,
        contextBuilder,
        managed.code,
        await createService(new PaperService(state, scope, artifacts)),
        limits,
      ),
    ),
    sequence = 0;
  const id = () => `request-${++sequence}`;
  const { events, sessions } = managed;
  const work = currentWork(
    { code: managed.code, sessions, events },
    { directory: dir, source: producer },
  );
  const active = new Map<string, Awaited<ReturnType<typeof work.lease>>>();
  const create = async (name = `Experiment-${sequence + 1}`, extra: Record<string, unknown> = {}) =>
    experiments.create(producer, {
      name,
      intent: 'Test the hypothesis.',
      requestId: id(),
      ...extra,
    });
  const attach = async (
    experiment: Experiment,
    role: ExperimentAttach['role'],
    content: string,
    extra: Partial<ExperimentAttach> = {},
  ): Promise<ExperimentEvidence> => {
    const author = active.get(experiment.id)?.worker ?? producer;
    const artifact = await artifacts.create(author, {
      title: role,
      content,
      mediaType: role === 'plan' || role === 'report' ? 'text/markdown' : 'application/json',
    });
    const attached = await experiments.attach(author, {
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      expectedRevision: experiment.workflow.revision,
      artifactId: artifact.id,
      role,
      path: `${role}.${role === 'plan' || role === 'report' ? 'md' : 'json'}`,
      requestId: id(),
      ...extra,
    });
    // A design is a plan and a feasibility statement; these tests are about the plan.
    if (role === 'plan') await attach(experiment, 'feasibility', feasibilityStatement());
    return attached;
  };
  const transition = async (
    experiment: Experiment,
    transition: ExperimentTransition['transition'],
    extra: Partial<ExperimentTransition> = {},
  ) => {
    const input = {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition,
      requestId: id(),
      ...extra,
    };
    parseExperimentInput(experimentTransitionSchema, input);
    if (transition !== 'submit_results') return experiments.transition(producer, input);
    const current = await experiments.get(producer, experiment.id);
    const held = active.get(current.id) ?? (await work.lease(current));
    for (const evidence of current.evidence.filter(
      (item) =>
        item.current &&
        item.attemptIndex === current.attempt.index &&
        ['result', 'report'].includes(item.role) &&
        item.createdBy !== held.worker.actorId,
    )) {
      let artifactId = evidence.artifactId;
      if (evidence.role === 'report') {
        const body = await artifacts.read(producer, artifactId);
        artifactId = (
          await work.run(
            held,
            'artifact.create',
            { title: 'Successor report', content: body.content, mediaType: 'text/markdown' },
            (caller, bound) => artifacts.create(caller, bound as any),
          )
        ).id;
      }
      await work.run(
        held,
        'experiment.attach',
        {
          artifactId,
          role: evidence.role,
          path: evidence.path,
          attemptIndex: current.attempt.index,
          requestId: id(),
          ...(evidence.resultFormat ? { resultFormat: evidence.resultFormat } : {}),
        },
        (caller, bound) => experiments.attach(caller, bound as unknown as ExperimentAttach),
      );
    }
    try {
      return await work.run(
        held,
        'experiment.transition',
        { transition, requestId: input.requestId, ...extra },
        (caller, bound) => experiments.transition(caller, bound as unknown as ExperimentTransition),
      );
    } finally {
      active.delete(current.id);
      await work.release(held);
    }
  };
  const reviewInput = async (
    experiment: Experiment,
    verdict: ReviewApplication['verdict'] = 'pass',
    returnTo?: string,
  ): Promise<ExperimentReview> => {
    const review = await reviews.start(reviewer, experiment.reviewId!);
    return {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: experiment.workflow.revision,
      verdict,
      notes: 'Independently checked the retained comparison.',
      synopsis: 'The comparison has been independently assessed.',
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: verdict === 'pass' ? 'met' : 'not_met',
        evidenceIds: citedEvidence(experiment, review, index + 1),
        notes: 'I inspected the retained evidence for this criterion.',
      })),
      requestId: id(),
      ...(returnTo ? { returnTo } : {}),
    };
  };
  const submitReview = async (
    experiment: Experiment,
    verdict: ReviewApplication['verdict'] = 'pass',
    returnTo?: string,
  ) => {
    const next = (await reviews.apply(
      reviewer,
      await reviewInput(experiment, verdict, returnTo),
    )) as Experiment;
    return next;
  };
  const execute = async (e: Experiment) => {
    if (!active.has(e.id)) active.set(e.id, await work.lease(e));
    return e;
  };
  const running = async () => {
    let e = await create();
    await attach(e, 'plan', plan);
    e = await transition(e, 'submit_design');
    return execute(await submitReview(e));
  };
  const results = async (e: Experiment) => {
    await execute(e);
    await attach(e, 'result', '{"accuracy":0.5,"nested":{"original":true}}');
    await attach(e, 'report', report);
    return await transition(e, 'submit_results');
  };
  t.after(async () => {
    await work.close();
    await managed.close();
    experiments.close();
    contextBuilder.close();
    workflows.close();
    reviews.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    directory: dir,
    state,
    scope,
    operator,
    producer,
    reviewer,
    reader,
    otherProducer,
    artifacts,
    blobs,
    code: managed.code,
    managed,
    workflows,
    reviews,
    create,
    attach,
    transition,
    reviewInput,
    submitReview,
    running,
    results,
    execute,
    worker: (e: Experiment) => active.get(e.id)?.worker ?? producer,
    id,
    get experiments() {
      return experiments;
    },
    async reload() {
      const old = experiments;
      old.close();
      experiments = await createService(
        new ExperimentService(
          state,
          scope,
          artifacts,
          workflows,
          reviews,
          contextBuilder,
          managed.code,
          await createService(new PaperService(state, scope, artifacts)),
        ),
      );
      return old;
    },
  };
}
test('Experiment reads retain their caller while pending', async (t) => {
  const f = await fixture(t);
  const experiment = await f.running();
  const other = await f.scope.credentials.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const foreign = { projectId: other.project.id, actorId: other.actor.id };
  for (const method of ['get', 'list', 'exhibit', 'process'] as const) {
    await t.test(method, async () => {
      const caller = { ...(method === 'process' ? f.producer : foreign) };
      const reading =
        method === 'list'
          ? f.experiments.list(caller)
          : f.experiments[method](caller, experiment.id);
      Object.assign(caller, method === 'process' ? foreign : f.producer);
      if (method === 'list') assert.deepEqual(await reading, []);
      else if (method === 'process') await reading;
      else await assert.rejects(reading, code('experiment_not_found'));
    });
  }
});

test('Experiments run both independent gates, pin exact evidence/exhibit without research claims', async (t) => {
  const f = await fixture(t);
  let e = await f.create('Paired-test');
  assert.equal(Object.hasOwn(e, 'testedClaimIds'), false);
  assert.equal(e.attempt.index, 1);
  assert.equal(e.workflow.revision, 0);
  const p = await f.attach(e, 'plan', plan);
  e = await f.transition(e, 'submit_design');
  assert.equal(e.workflow.state, 'design_review');
  assert.equal(e.submissions[0].evidence[0].artifactId, p.artifactId);
  assert.equal((await f.reviews.get(f.reviewer, e.reviewId!)).formatVersion, 2);
  await assert.rejects(
    async () =>
      await f.experiments.attach(f.producer, {
        experimentId: e.id,
        artifactId: p.artifactId,
        role: 'plan',
        path: 'plan.md',
        attemptIndex: 1,
        expectedRevision: e.workflow.revision,
        requestId: f.id(),
      }),
    code('experiment_not_writable'),
  );
  e = await f.submitReview(e);
  assert.equal(e.workflow.state, 'running');
  assert.equal(e.attempt.startedAt, null);
  await f.execute(e);
  e = await f.experiments.get(f.producer, e.id);
  assert.ok(e.attempt.startedAt);
  await f.attach(e, 'result', 'null');
  await f.attach(e, 'report', report);
  const preview = await f.experiments.exhibit(f.producer, e.id);
  assert.equal(preview.willPin, true);
  assert.equal(preview.startedAt, e.attempt.startedAt);
  e = await f.transition(e, 'submit_results');
  const round = e.submissions.find((s) => s.stage === 'results')!;
  const exhibit = round.evidence.find((a) => a.role === 'exhibit')!;
  assert.equal(exhibit.systemGenerated, true);
  assert.equal(exhibit.hash, preview.hash);
  assert.equal((await f.artifacts.read(f.producer, exhibit.artifactId)).content, preview.content);
  assert.ok(round.evidence.some((a) => a.artifactId === p.artifactId));
  e = await f.submitReview(e);
  assert.equal(e.workflow.state, 'complete');
  assert.equal(e.conclusion, 'No improvement was observed.');
});

test('results review embeds approved design bodies once while retaining every pinned evidence reference', async (t) => {
  const f = await fixture(t);
  const submitted = await f.results(await f.running());
  const review = await f.reviews.get(f.reviewer, submitted.reviewId!);
  const assignment = await f.workflows.assignment(f.reviewer, submitted.id);
  const prompt = assignment.context!.prompt;
  const approved = prompt.split('## Exact approved plan\n')[1]!.split('## Pinned review')[0]!;
  const evidence = prompt
    .split('\n## Selected evidence and retained work\n')[1]!
    .split('\n## ')[0]!;
  const design = submitted.submissions.find((item) => item.stage === 'design')!;
  const planId = design.evidence.find((item) => item.role === 'plan')!.artifactId;
  const feasibilityId = design.evidence.find((item) => item.role === 'feasibility')!.artifactId;
  const feasibility = (await f.artifacts.read(f.reviewer, feasibilityId)).content;

  assert.ok(review.artifactIds.includes(planId));
  assert.ok(review.artifactIds.includes(feasibilityId));
  assert.ok(approved.includes(plan));
  assert.ok(approved.includes(feasibility));
  assert.ok(!evidence.includes(plan));
  assert.ok(!evidence.includes(feasibility));
  assert.ok(evidence.includes(report), 'current result and report evidence remains inline');
  assert.ok(prompt.includes(review.criteria[0]!));
  assert.deepEqual(
    new Set(assignment.context!.sources.map((artifact) => artifact.id)),
    new Set(review.artifactIds),
    'frozen source metadata still names every pinned artifact',
  );
  assert.deepEqual(
    new Set(assignment.references.filter((ref) => ref.kind === 'artifact').map((ref) => ref.id)),
    new Set(review.artifactIds),
    'the assignment still offers every pinned artifact to the reviewer',
  );
});
test('Attempt fail and needs_changes require explicit routes and distinguish new attempts from new rounds', async (t) => {
  const f = await fixture(t);
  let e = await f.running();
  const approved = e.attempt.approvedSubmissionId;
  e = await f.results(e);
  const input = await f.reviewInput(e, 'fail');
  const before = (await f.state.events(f.operator.projectId)).length;
  await assert.rejects(
    async () => await f.reviews.apply(f.reviewer, input),
    code('invalid_review_return'),
  );
  assert.equal((await f.state.events(f.operator.projectId)).length, before);
  e = (await f.reviews.apply(f.reviewer, { ...input, returnTo: 'running' })) as Experiment;
  assert.equal(e.workflow.state, 'running');
  assert.equal(e.attempt.index, 1);
  assert.equal(e.attempt.approvedSubmissionId, approved);
  e = await f.results(e);
  assert.deepEqual(
    e.submissions.filter((s) => s.stage === 'results').map((s) => s.round),
    [1, 2],
  );
  e = await f.submitReview(e, 'needs_changes', 'planned');
  assert.equal(e.workflow.state, 'planned');
  assert.equal(e.attempt.index, 2);
  assert.equal(e.attempt.approvedSubmissionId, null);
  assert.equal(e.attempt.startedAt, null);
  assert.equal(e.attempts[0].endedRevision, e.workflow.revision - 1);
  assert.equal(e.submissions.length, 3);
  assert.equal(e.attempt.feedback.length, 1);
});
test('Design rejection starts a new attempt; invalid routes and self review cannot commit', async (t) => {
  const f = await fixture(t);
  let e = await f.create();
  await f.attach(e, 'plan', plan);
  e = await f.transition(e, 'submit_design');
  await assert.rejects(
    async () => await f.reviews.start(f.producer, e.reviewId!),
    code('forbidden'),
  );
  const input = await f.reviewInput(e, 'fail');
  await assert.rejects(
    async () => await f.reviews.apply(f.reviewer, { ...input, returnTo: 'running' }),
    code('invalid_review_return'),
  );
  e = (await f.reviews.apply(f.reviewer, input)) as Experiment;
  assert.equal(e.attempt.index, 2);
  assert.equal(e.workflow.state, 'planned');
});
test('A design returned as often as its limit allows waits for a human; the refused verdict leaves no trace', async (t) => {
  const f = await fixture(t, { designRounds: 1, resultRounds: 3 });
  let e = await f.create();
  await f.attach(e, 'plan', plan);
  e = await f.submitReview(await f.transition(e, 'submit_design'), 'needs_changes');
  assert.equal(e.attempt.index, 2);
  await f.attach(e, 'plan', plan);
  e = await f.transition(e, 'submit_design');
  const guidance = await f.workflows.evaluate(f.producer, e.id);
  assert.equal(guidance.currentGate, 'loop_limit_reached');
  assert.deepEqual(
    guidance.limits.map((limit) => [limit.name, limit.used, limit.max]),
    [['design_rounds', 1, 1]],
  );
  assert.deepEqual((await f.workflows.overview(f.operator)).escalated, [e.id]);
  const verdict = await f.reviewInput(e, 'needs_changes');
  const events = (await f.state.events(f.operator.projectId)).length;
  await assert.rejects(
    async () => await f.reviews.apply(f.reviewer, verdict),
    code('loop_limit_reached'),
  );
  // The review, the attempt and the record are as they were: nothing of the verdict was kept.
  assert.equal((await f.state.events(f.operator.projectId)).length, events);
  assert.equal((await f.reviews.get(f.reviewer, e.reviewId!)).verdict, null);
  assert.deepEqual(await f.experiments.get(f.producer, e.id), e);
  // The work is not failed, and its owner may still end it.
  assert.deepEqual([e.settled, e.failed], [false, false]);
  e = await f.transition(e, 'abandon', { evidence: { reason: 'The design will not converge.' } });
  assert.equal(e.workflow.state, 'abandoned');
  // Workflows' word for its end, on the record and on the list Home reads.
  assert.deepEqual([e.settled, e.failed], [false, true]);
  const [summary] = await f.experiments.summaries(f.producer);
  assert.deepEqual([summary.settled, summary.failed], [false, true]);
});

test('The experiment limits default to four design rounds and three result rounds', async (t) => {
  const f = await fixture(t);
  let e = await f.create();
  await f.attach(e, 'plan', plan);
  e = await f.transition(e, 'submit_design');
  assert.deepEqual(
    (await f.workflows.evaluate(f.worker(e), e.id)).limits.map((limit) => [limit.name, limit.max]),
    [['design_rounds', 4]],
  );
  e = await f.results(await f.submitReview(e));
  const [results] = (await f.workflows.evaluate(f.worker(e), e.id)).limits;
  assert.deepEqual(
    [results.name, results.actions, results.max],
    ['result_rounds', ['revise_plan', 'revise_execution'], 3],
  );
});

test('Immutable role/path versions, strict attempt/revision and actual submitting author are enforced', async (t) => {
  const f = await fixture(t);
  const e = await f.create();
  const first = await f.attach(e, 'plan', 'Draft without headings');
  await assert.rejects(
    async () => await f.transition(e, 'submit_design'),
    code('invalid_experiment_evidence'),
  );
  const caller = { ...f.producer };
  const input: ExperimentAttach = {
    experimentId: e.id,
    attemptIndex: 1,
    expectedRevision: 0,
    artifactId: (await f.artifacts.create(f.producer, { title: 'Plan', content: plan })).id,
    role: 'plan',
    path: 'plan.md',
    requestId: f.id(),
  };
  const attaching = f.experiments.attach(caller, input);
  Object.assign(caller, f.operator);
  input.path = 'replacement.md';
  const second = await attaching;
  assert.equal(second.path, 'plan.md');
  const current = await f.experiments.get(f.producer, e.id);
  const plans = current.evidence.filter((evidence) => evidence.role === 'plan');
  assert.equal(plans.length, 2);
  assert.equal(plans[0].current, false);
  assert.equal(plans[1].current, true);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('UPDATE experiment_evidence SET record=? WHERE id=?', '{}', first.id),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await f.experiments.attach(f.producer, {
        experimentId: e.id,
        artifactId: second.artifactId,
        role: 'plan',
        path: 'other.md',
        attemptIndex: 2,
        expectedRevision: 0,
        requestId: f.id(),
      }),
    code('attempt_conflict'),
  );
  await assert.rejects(
    async () =>
      await f.experiments.attach(f.otherProducer, {
        experimentId: e.id,
        artifactId: second.artifactId,
        role: 'plan',
        path: 'plan.md',
        attemptIndex: 1,
        expectedRevision: 0,
        requestId: f.id(),
      }),
    code('forbidden'),
  );
  await assert.rejects(
    async () =>
      await f.experiments.attach(f.operator, {
        experimentId: e.id,
        artifactId: second.artifactId,
        role: 'plan',
        path: 'plan.md',
        attemptIndex: 1,
        expectedRevision: 0,
        requestId: f.id(),
      }),
    code('invalid_evidence_author'),
  );
  await assert.rejects(
    async () =>
      await f.experiments.create(f.reader, {
        name: 'Reader-attempt',
        intent: 'No',
        requestId: 'reader',
      }),
    code('forbidden'),
  );
});
test('Command receipts replay exact results across reload and rollback all composed writes', async (t) => {
  const f = await fixture(t);
  const input = { name: 'Replay', intent: 'Replay after interruption.', requestId: 'stable' };
  const caller = { ...f.producer },
    request = { ...input };
  const creating = f.experiments.create(caller, request);
  Object.assign(caller, f.otherProducer);
  request.name = 'Replacement';
  const e = await creating,
    events = (await f.state.events(f.operator.projectId)).length;
  assert.equal(e.createdBy, f.producer.actorId);
  assert.equal(e.name, input.name);
  assert.deepEqual(await f.experiments.create(f.producer, input), e);
  assert.equal((await f.state.events(f.operator.projectId)).length, events);
  // What waits on an experiment names it, so the instance carries the name.
  assert.equal((await f.workflows.get(f.producer, e.id)).data.name, 'Replay');
  await assert.rejects(
    async () => await f.experiments.create(f.producer, { ...input, intent: 'Different' }),
    code('request_conflict'),
  );
  await f.attach(e, 'plan', plan);
  const transition: ExperimentTransition = {
    experimentId: e.id,
    expectedRevision: e.workflow.revision,
    transition: 'submit_design',
    requestId: f.id(),
  };
  Object.assign(caller, f.producer);
  const transitioning = f.experiments.transition(caller, transition);
  Object.assign(caller, f.otherProducer);
  transition.transition = 'abandon';
  transition.evidence = { reason: 'Replacement reason' };
  const submitted = await transitioning,
    snapshot = submitted.submissions[0];
  assert.equal(submitted.workflow.state, 'design_review');
  const old = await f.reload();
  await assert.rejects(
    async () => await old.get(f.producer, e.id),
    code('experiments_unavailable'),
  );
  assert.deepEqual((await f.experiments.get(f.producer, e.id)).submissions[0], snapshot);
  assert.deepEqual(await f.experiments.create(f.producer, input), e);
  const application = await f.reviewInput(submitted);
  const count = (await f.state.events(f.operator.projectId)).length;
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.experiments.submitReview(f.reviewer, application, tx);
        throw new Error('rollback');
      }),
    /rollback/,
  );
  assert.equal((await f.state.events(f.operator.projectId)).length, count);
  assert.equal((await f.reviews.get(f.reviewer, submitted.reviewId!)).status, 'started');
  assert.equal((await f.experiments.get(f.producer, e.id)).workflow.state, 'design_review');
  const reviewInput = structuredClone(application);
  Object.assign(caller, f.reviewer);
  const accepting = f.experiments.submitReview(caller, reviewInput);
  Object.assign(caller, f.operator);
  reviewInput.reviewId = 'replacement-review';
  const accepted = await accepting;
  assert.deepEqual(await f.reviews.apply(f.reviewer, application), accepted);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('DELETE FROM experiment_submissions WHERE id=?', snapshot.id),
      ),
    { code: 'state_constraint' },
  );
});
test('The longest requestId the tools accept still names the requests an experiment makes', async (t) => {
  const f = await fixture(t);
  const long = (tag: string) => tag.padEnd(200, 'x');
  let e = await f.create('Long', { requestId: long('create') });
  await f.attach(e, 'plan', plan);
  e = await f.transition(e, 'submit_design', { requestId: long('design') });
  assert.equal(e.workflow.state, 'design_review');
  const application = { ...(await f.reviewInput(e)), requestId: long('review') };
  e = (await f.reviews.apply(f.reviewer, application)) as Experiment;
  assert.equal(e.workflow.state, 'running');
  assert.deepEqual(await f.reviews.apply(f.reviewer, application), e);
});
test('Active cap, name uniqueness and same-project dependencies fail atomically', async (t) => {
  const f = await fixture(t);
  const create = (name: string, extra: Record<string, unknown> = {}) =>
    f.experiments.create(f.producer, {
      name,
      intent: 'Test the hypothesis.',
      requestId: f.id(),
      ...extra,
    });
  const initial = await create('Case-name');
  await assert.rejects(async () => await create('case-NAME'), code('experiment_name_conflict'));
  // An ordering between two experiments is a task in between (founder, 2026-09-18).
  await assert.rejects(
    async () => await create('Chained', { dependsOn: [initial.id] }),
    code('invalid_dependency'),
  );
  const other = await f.scope.credentials.bootstrap({
      projectName: 'Other',
      actorName: 'Other operator',
    }),
    caller = { actorId: other.actor.id, projectId: other.project.id };
  await assert.rejects(
    async () => await create('Retired-field', { testedClaimIds: ['claim_retired'] }),
    code('invalid_experiment_input'),
  );
  for (let i = 0; i < 6; i++) await create(`Active-${i}`);
  await assert.rejects(async () => await create('Eighth'), code('experiment_limit'));
  await f.transition(initial, 'abandon', { evidence: { reason: 'Stop this line of work.' } });
  // Creating several at once is admitted as creating each would be, all or none.
  await assert.rejects(f.experiments.admits(f.producer, ['One', 'Two']), code('experiment_limit'));
  await assert.rejects(
    f.experiments.admits(f.producer, ['ACTIVE-0']),
    code('experiment_name_conflict'),
  );
  await f.experiments.admits(f.producer, ['Replacement']);
  assert.ok(await create('Replacement'));
  assert.equal((await f.experiments.list(caller)).length, 0);
});
test('Missing bytes and invalid scoped figure references cannot seal a review', async (t) => {
  const f = await fixture(t),
    e = await f.create();
  const figure = await f.artifacts.create(f.producer, {
    title: 'Figure',
    content: 'not actually an image',
    mediaType: 'text/plain',
  });
  await assert.rejects(
    async () => await f.attach(e, 'plan', `${plan}\n![Comparison](${figure.id})`),
    code('invalid_experiment_evidence'),
  );
  const attached = await f.attach(e, 'plan', plan),
    events = (await f.state.events(f.operator.projectId)).length;
  // Artifacts verifies its bytes (its own suite covers how); a refusal here must seal nothing.
  const original = f.artifacts.bytes;
  f.artifacts.bytes = async () => {
    throw new MervError('blob_corrupt', 'Stored artifact bytes do not match their metadata', 500);
  };
  await assert.rejects(async () => await f.transition(e, 'submit_design'), code('blob_corrupt'));
  f.artifacts.bytes = original;
  assert.equal((await f.state.events(f.operator.projectId)).length, events);
  assert.equal((await f.experiments.get(f.producer, e.id)).submissions.length, 0);
  assert.equal(
    (await f.experiments.get(f.producer, e.id)).evidence.findLast(
      (evidence) => evidence.role === 'plan',
    )!.id,
    attached.id,
  );
});
test('Source revocation is checked before replay and before a composed writer commits', async (t) => {
  const f = await fixture(t),
    input = { name: 'Authorized', intent: 'Test authority.', requestId: 'auth' };
  await f.experiments.create(f.producer, input);
  await f.scope.credentials.revokeActor(f.operator, f.producer.actorId);
  await assert.rejects(
    async () => await f.experiments.create(f.producer, input),
    code('forbidden'),
  );
  const second = { name: 'Final-check', intent: 'Check the final writer.', requestId: 'final' },
    before = (await f.experiments.list(f.operator)).length;
  const append = f.state.appendEvent.bind(f.state);
  const originalRequire = f.scope.require.bind(f.scope);
  let authorityLost = false;
  f.scope.require = async (caller, permission, tx) => {
    check(
      !(authorityLost && caller.actorId === f.otherProducer.actorId),
      'forbidden',
      'Authority changed during the writer',
      403,
    );
    return await originalRequire(caller, permission, tx);
  };
  f.state.appendEvent = async (tx, event) => {
    const result = await append(tx, event);
    if (event.type === 'experiment.created') authorityLost = true;
    return result;
  };
  await assert.rejects(
    async () => await f.experiments.create(f.otherProducer, second),
    code('forbidden'),
  );
  f.state.appendEvent = append;
  f.scope.require = originalRequire;
  assert.equal((await f.experiments.list(f.operator)).length, before);
  assert.ok(await f.scope.require(f.otherProducer, 'write'));
});
test('Workflow exit guidance checks the same plan and exhibit gates without creating artifacts or events', async (t) => {
  const f = await fixture(t);
  let e = await f.create();
  await f.attach(e, 'plan', '# Summary\nDraft.\n# Objective & hypothesis\nA hypothesis.');
  const status = async (action: string) =>
    (await f.workflows.evaluate(f.worker(e), e.id)).actions.find((item) => item.action === action)!;
  const before = async () => ({
    events: (await f.state.events(f.operator.projectId)).length,
    artifacts: (await f.artifacts.list(f.producer)).length,
    submissions: (await f.experiments.get(f.producer, e.id)).submissions.length,
  });
  let unchanged = await before();
  assert.equal((await status('submit_design')).status, 'blocked');
  assert.ok((await status('submit_design')).blockers.some((b) => b.message.includes('Evaluation')));
  assert.deepEqual(await before(), unchanged);
  await assert.rejects(
    async () => await f.transition(e, 'submit_design'),
    code('invalid_experiment_evidence'),
  );
  await f.attach(e, 'plan', plan);
  assert.equal((await status('submit_design')).status, 'ready');
  e = await f.submitReview(await f.transition(e, 'submit_design'));
  await f.execute(e);
  await f.attach(e, 'result', '{"accuracy":0.5}');
  await f.attach(e, 'report', report.replace('metrics_exhibit.json', 'the local output'));
  unchanged = await before();
  assert.equal((await status('submit_results')).status, 'blocked');
  assert.ok((await status('submit_results')).blockers.some((b) => b.message.includes('exhibit')));
  assert.deepEqual(await before(), unchanged);
  await f.attach(e, 'report', report);
  unchanged = await before();
  assert.equal((await status('submit_results')).status, 'ready');
  assert.deepEqual(await before(), unchanged);
  e = await f.transition(e, 'submit_results');
  assert.equal(e.workflow.state, 'experiment_review');
});
test('A fresh storage connection restores attempts, immutable review pins, figures and command receipts', async (t) => {
  const f = await fixture(t);
  let e = await f.create('Restart-proof');
  const image = await f.artifacts.create(f.producer, {
    title: 'Retained figure',
    mediaType: 'image/png',
    encoding: 'base64',
    content:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  });
  const evidence = await f.attach(e, 'plan', `${plan}\n![Retained comparison](${image.id})`);
  assert.deepEqual(evidence.figureIds, [image.id]);
  e = await f.transition(e, 'submit_design');
  const application = await f.reviewInput(e, 'needs_changes', 'planned');
  e = (await f.reviews.apply(f.reviewer, application)) as Experiment;
  await f.managed.close();
  const state = await openState(f.directory),
    scope = await createService(new ProjectScope(state)),
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(f.directory, 'blobs'))),
    ),
    workflows = await createService(new WorkflowsService(state, scope)),
    reviews = await createService(new ReviewService(state, scope, artifacts)),
    builder = await createService(new RecipeContextBuilder(state, scope, artifacts)),
    restoredManaged = await managedServices(
      { state, scope, artifacts, workflows },
      f.directory,
      f.producer,
    ),
    experiments = await createService(
      new ExperimentService(
        state,
        scope,
        artifacts,
        workflows,
        reviews,
        builder,
        restoredManaged.code,
        await createService(new PaperService(state, scope, artifacts)),
      ),
    );
  try {
    assert.deepEqual(await experiments.get(f.producer, e.id), e);
    assert.deepEqual(e.attempt.feedbackReviewIds, [application.reviewId]);
    assert.deepEqual(e.submissions[0].figureIds, [image.id]);
    assert.deepEqual(await reviews.apply(f.reviewer, application), e);
    const assignment = await workflows.assignment(f.producer, e.id);
    assert.ok(JSON.stringify(assignment).includes(application.reviewId));
    assert.ok(JSON.stringify(assignment).includes(image.id));
  } finally {
    experiments.close();
    await restoredManaged.close();
    builder.close();
    workflows.close();
    reviews.close();
    await state.close();
  }
});

test('plan and results reviewers write the paper with every verdict, atomically and replayably', async (t) => {
  for (const stage of ['design', 'results'] as const)
    for (const decision of ['pass', 'needs_changes', 'fail'] as const) {
      await t.test(`${stage}: ${decision}`, async (t) => {
        const f = await fixture(t),
          paper = await createService(new PaperService(f.state, f.scope, f.artifacts));
        let e = await f.create();
        await f.attach(e, 'plan', plan);
        e = await f.transition(e, 'submit_design');
        if (stage === 'results') {
          e = await f.submitReview(e);
          await f.attach(e, 'result', '{"accuracy":0.5}');
          await f.attach(e, 'report', report);
          await assert.rejects(
            f.transition(e, 'submit_results', {
              paperChangesArtifactId: 'producer-paper',
            } as Partial<ExperimentTransition>),
            code('invalid_experiment_input'),
          );
          e = await f.transition(e, 'submit_results');
        }
        const verdict = await f.reviewInput(
          e,
          decision,
          stage === 'results' && decision !== 'pass' ? 'running' : undefined,
        );
        verdict.paperChanges = {
          documents: (['methods', 'results'] as const).map((kind) => ({
            kind,
            expectedRevision: 0,
            changes: [
              {
                id: e.id,
                title: stage === 'design' ? 'Planned comparison' : 'Completed comparison',
                content:
                  stage === 'design'
                    ? 'We plan to test the hypothesis; there are no results yet.'
                    : 'Accuracy was 0.5; no improvement observed.',
              },
            ],
          })),
        };
        await assert.rejects(
          f.experiments.submitReview(f.otherProducer, verdict),
          code('forbidden'),
        );
        const conflict = structuredClone(verdict);
        conflict.paperChanges!.documents[1].expectedRevision = 99;
        await assert.rejects(
          f.experiments.submitReview(f.reviewer, conflict),
          code('paper_revision_conflict'),
        );
        const preflight = await f.workflows.evaluate(f.reviewer, e.id, {
          action: stage === 'design' ? 'submit_design_review' : 'submit_experiment_review',
          input: conflict as never,
        });
        assert.ok(
          preflight.actions.some((a) =>
            a.blockers.some((b) => b.code === 'paper_revision_conflict'),
          ),
        );
        await assert.rejects(
          f.state.transaction(async (tx) => {
            await f.experiments.submitReview(f.reviewer, verdict, tx);
            throw Error('abort combined verdict');
          }),
          /abort combined verdict/,
        );
        assert.equal((await paper.read(f.reader)).documents.methods.current.revision, 0);
        assert.equal((await f.reviews.get(f.reviewer, verdict.reviewId)).status, 'started');
        e = await f.experiments.submitReview(f.reviewer, verdict);
        assert.deepEqual(await f.experiments.submitReview(f.reviewer, verdict), e);
        for (const kind of ['methods', 'results'] as const) {
          const doc = (await paper.read(f.reader)).documents[kind];
          assert.equal(doc.current.revision, 1);
          assert.equal(doc.current.updatedBy, f.reviewer.actorId);
          assert.equal(doc.published!.publication.reviewId, verdict.reviewId);
          assert.equal(doc.published!.publication.source.id, e.id);
          assert.equal(doc.published!.publication.verdict, decision);
        }
      });
    }
});

test('a retry keeps the compute epoch of work started before Experiments recorded one', async (t) => {
  const f = await fixture(t);
  // Work started before Experiments recorded an epoch ran under attempt:state.
  let experiment = await f.create();
  await f.attach(experiment, 'plan', plan);
  experiment = await f.submitReview(await f.transition(experiment, 'submit_design'));
  await f.state.transaction((tx) =>
    tx.run(
      `UPDATE wf_instances SET data_json=(data_json::jsonb - 'computeEpoch')::text WHERE id=?`,
      experiment.id,
    ),
  );
  experiment = await f.experiments.get(f.producer, experiment.id);
  for (let retry = 0; retry < 2; retry++) {
    experiment = await f.transition(experiment, 'retry_running', {
      evidence: { reason: 'Fixture recovery' },
    });
    assert.equal(experiment.workflow.data.computeEpoch, '1:running');
  }
});

test('native experiments fence compute by attempt and state and retain service captures', async (t) => {
  const f = await fixture(t);
  const native = nativeWorkFixture();
  t.after(f.experiments.bindSandboxes(native.service));
  let experiment = await f.create('Native');
  assert.equal(experiment.workflow.version, 36);
  assert.equal(experiment.workflow.data.computeEpoch, '1:planned');
  const planning = await f.workflows.assignment(f.producer, experiment.id);
  assert.match(planning.brief, /native Sandboxes MCP/);
  assert.ok(!planning.execution.tools.some((tool) => tool.name.startsWith('compute.')));
  await f.attach(experiment, 'plan', plan);
  experiment = await f.transition(experiment, 'submit_design');
  assert.equal(experiment.workflow.data.computeEpoch, '1:design_review');
  experiment = await f.submitReview(experiment, 'needs_changes', 'planned');
  assert.equal(experiment.workflow.data.computeEpoch, '2:planned');
  await f.attach(experiment, 'plan', plan);
  experiment = await f.transition(experiment, 'submit_design');
  experiment = await f.submitReview(experiment);
  assert.equal(experiment.workflow.data.computeEpoch, '2:running');
  const service = await f.scope.serviceActor('sandboxes', f.producer.projectId);
  const capture = await f.artifacts.createCollection(service, {
    title: 'Retained output',
    sourceKey: 'native-experiment-capture',
    files: [
      {
        name: 'results.txt',
        hash: 'c'.repeat(64),
        size: 10,
        provider: 'sandboxes',
        reference: 'verified-object',
      },
    ],
  });
  const attach = {
    experimentId: experiment.id,
    attemptIndex: experiment.attempt.index,
    expectedRevision: experiment.workflow.revision,
    artifactId: capture.id,
    role: 'result' as const,
    resultFormat: 'qualitative' as const,
    path: 'result.json',
    requestId: f.id(),
  };
  await assert.rejects(f.experiments.attach(f.producer, attach), code('invalid_evidence_author'));
  native.verified.set(experiment.id, [capture.id]);
  assert.equal(
    (await f.experiments.attach(f.producer, { ...attach, requestId: f.id() })).artifactId,
    capture.id,
  );
  experiment = await f.transition(experiment, 'retry_running', {
    evidence: { reason: 'Fixture recovery' },
  });
  assert.equal(experiment.workflow.data.computeEpoch, '2:running');
  experiment = await f.transition(experiment, 'abandon', {
    evidence: { reason: 'End fixture work' },
  });
  assert.equal(experiment.workflow.data.computeEpoch, '2:abandoned');
});

test('a result submission may select a verified sandbox capture its worker attached', async (t) => {
  const f = await fixture(t);
  const native = nativeWorkFixture();
  t.after(f.experiments.bindSandboxes(native.service));
  let experiment = await f.create('Captured');
  await f.attach(experiment, 'plan', plan);
  experiment = await f.submitReview(await f.transition(experiment, 'submit_design'));
  const service = await f.scope.serviceActor('sandboxes', f.producer.projectId);
  const capture = await f.artifacts.createCollection(service, {
    title: 'Retained output',
    sourceKey: 'captured-result',
    files: [
      {
        name: 'results.txt',
        hash: 'c'.repeat(64),
        size: 10,
        provider: 'sandboxes',
        reference: 'verified-object',
      },
    ],
  });
  native.verified.set(experiment.id, [capture.id]);
  // The running worker attaches the capture its sandbox retained; nobody authored it.
  await f.execute(experiment);
  await f.experiments.attach(f.worker(experiment), {
    experimentId: experiment.id,
    attemptIndex: experiment.attempt.index,
    expectedRevision: experiment.workflow.revision,
    artifactId: capture.id,
    role: 'result',
    resultFormat: 'qualitative',
    path: 'result.txt',
    requestId: f.id(),
  });
  await f.attach(experiment, 'report', report);
  experiment = await f.transition(experiment, 'submit_results');
  assert.equal(experiment.workflow.state, 'experiment_review');
  const review = await f.reviews.get(f.producer, experiment.reviewId!);
  assert.ok(review.artifactIds.includes(capture.id));
});

test('a worker cannot attach a sandbox capture another attempt retained', async (t) => {
  const f = await fixture(t);
  const native = nativeWorkFixture();
  t.after(f.experiments.bindSandboxes(native.service));
  const experiment = await f.running();
  const service = await f.scope.serviceActor('sandboxes', f.producer.projectId);
  const capture = await f.artifacts.createCollection(service, {
    title: 'Earlier output',
    sourceKey: 'earlier-result',
    files: [
      { name: 'r.txt', hash: 'c'.repeat(64), size: 10, provider: 'sandboxes', reference: 'old' },
    ],
  });
  native.verified.set(experiment.id, [capture.id]);
  native.attempts.set(capture.id, `${experiment.attempt.index + 1}:running`);
  await assert.rejects(
    f.experiments.attach(f.worker(experiment), {
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      expectedRevision: experiment.workflow.revision,
      artifactId: capture.id,
      role: 'result',
      resultFormat: 'qualitative',
      path: 'result.txt',
      requestId: f.id(),
    }),
    code('invalid_evidence_author'),
  );
});

test('an attempt refuses its 101st result file when it is attached', async (t) => {
  const f = await fixture(t);
  const experiment = await f.running();
  for (let index = 0; index < 100; index++)
    await f.attach(experiment, 'result', `{"index":${index}}`, { path: `results/${index}.json` });
  await assert.rejects(
    f.attach(experiment, 'result', '{"index":100}', { path: 'results/100.json' }),
    code('invalid_experiment_evidence'),
  );
  // A newer version at a path the attempt already holds replaces it.
  await f.attach(experiment, 'result', '{"index":0,"rerun":true}', { path: 'results/0.json' });
  const current = await f.experiments.get(f.producer, experiment.id);
  assert.equal(current.evidence.filter((e) => e.current && e.role === 'result').length, 100);
});

test('an attempt refuses a result its metrics exhibit could not hold beside the others', async (t) => {
  const f = await fixture(t);
  const experiment = await f.running();
  // Each file is within its own limits; some dozens of them pass the exhibit's total.
  const scores = JSON.stringify({ scores: Array.from({ length: 8000 }, (_, i) => i % 2) });
  let refused = 0;
  for (let index = 0; index < 40; index++)
    await f
      .attach(experiment, 'result', scores, { path: `results/${index}.json` })
      .catch((error: { code?: string }) => {
        assert.equal(error.code, 'invalid_experiment_evidence');
        refused++;
      });
  assert.ok(refused > 0 && refused < 40);
  // What the attempt kept still makes an exhibit.
  await f.experiments.exhibit(f.producer, experiment.id);
});

test('guidance never offers a person the results submission only the attempt’s worker can make', async (t) => {
  const f = await fixture(t);
  let experiment = await f.create();
  await f.attach(experiment, 'plan', plan);
  experiment = await f.submitReview(await f.transition(experiment, 'submit_design'));
  await f.attach(experiment, 'result', '{"accuracy":0.5}');
  await f.attach(experiment, 'report', report);
  const decision = await f.workflows.evaluate(f.producer, experiment.id, {
    action: 'submit_results',
    input: { expectedRevision: experiment.workflow.revision },
  });
  const action = decision.actions.find((item) => item.action === 'submit_results')!;
  assert.equal(action.status, 'blocked');
  assert.ok(action.blockers.some((blocker) => blocker.code === 'session_required'));
});
