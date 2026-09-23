import { createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { ExperimentService } from '@merv/experiments';
import { check, type Caller, type ReviewApplication, type Transaction } from '@merv/contracts';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentEvidence,
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
async function fixture(t: TestContext, limits?: { designRounds: number; resultRounds: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'merv-experiments-core-')),
    state = await openState(dir);
  const scope = await createService(new ProjectScope(state)),
    boot = await scope.bootstrap({ projectName: 'Experiments', actorName: 'Operator' });
  const operator: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const result = await scope.issueActor(operator, { name: role, role });
    return { actorId: result.actor.id, projectId: operator.projectId };
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
  let experiments = await createService(
      new ExperimentService(
        state,
        scope,
        artifacts,
        workflows,
        reviews,
        contextBuilder,
        undefined,
        await createService(new PaperService(state, scope, artifacts)),
        limits,
      ),
    ),
    sequence = 0;
  const id = () => `request-${++sequence}`;
  const create = async (name = `Experiment-${sequence + 1}`, extra: Record<string, unknown> = {}) =>
    await experiments.create(producer, {
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
    const artifact = await artifacts.create(producer, {
      title: role,
      content,
      mediaType: role === 'plan' || role === 'report' ? 'text/markdown' : 'application/json',
    });
    const attached = await experiments.attach(producer, {
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
  ) =>
    await experiments.transition(producer, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition,
      requestId: id(),
      ...extra,
    });
  const reviewInput = async (
    experiment: Experiment,
    verdict: ReviewApplication['verdict'] = 'pass',
    returnTo?: string,
  ): Promise<ReviewApplication> => {
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
  ) =>
    (await reviews.apply(reviewer, await reviewInput(experiment, verdict, returnTo))) as Experiment;
  const running = async () => {
    let e = await create();
    await attach(e, 'plan', plan);
    e = await transition(e, 'submit_design');
    return await submitReview(e);
  };
  const results = async (e: Experiment) => {
    await attach(e, 'result', '{"accuracy":0.5,"nested":{"original":true}}');
    await attach(e, 'report', report);
    return await transition(e, 'submit_results');
  };
  t.after(async () => {
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
    workflows,
    reviews,
    create,
    attach,
    transition,
    reviewInput,
    submitReview,
    running,
    results,
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
          undefined,
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
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
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
  await f.workflows.begin(f.producer, {
    instanceId: e.id,
    expectedRevision: e.workflow.revision,
  });
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
  e = await f.transition(e, 'abandon', { evidence: { reason: 'The design will not converge.' } });
  assert.equal(e.workflow.state, 'abandoned');
});

test('The experiment limits default to four design rounds and three result rounds', async (t) => {
  const f = await fixture(t);
  let e = await f.create();
  await f.attach(e, 'plan', plan);
  e = await f.transition(e, 'submit_design');
  assert.deepEqual(
    (await f.workflows.evaluate(f.producer, e.id)).limits.map((limit) => [limit.name, limit.max]),
    [['design_rounds', 4]],
  );
  e = await f.results(await f.submitReview(e));
  const [results] = (await f.workflows.evaluate(f.producer, e.id)).limits;
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
test('Active cap, name uniqueness and same-project dependencies fail atomically', async (t) => {
  const f = await fixture(t);
  const initial = await f.create('Case-name');
  await assert.rejects(async () => await f.create('case-NAME'), code('experiment_name_conflict'));
  // An ordering between two experiments is a task in between (founder, 2026-09-18).
  await assert.rejects(
    async () => await f.create('Chained', { dependsOn: [initial.id] }),
    code('invalid_dependency'),
  );
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' }),
    caller = { actorId: other.actor.id, projectId: other.project.id };
  await assert.rejects(
    async () => await f.create('Retired-field', { testedClaimIds: ['claim_retired'] }),
    code('invalid_experiment_input'),
  );
  for (let i = 0; i < 6; i++) await f.create(`Active-${i}`);
  await assert.rejects(async () => await f.create('Eighth'), code('experiment_limit'));
  await f.transition(initial, 'abandon', { evidence: { reason: 'Stop this line of work.' } });
  assert.ok(await f.create('Replacement'));
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
  const original = f.blobs.get.bind(f.blobs);
  f.blobs.get = async () => Buffer.from('wrong bytes');
  await assert.rejects(
    async () => await f.transition(e, 'submit_design'),
    code('artifact_hash_mismatch'),
  );
  f.blobs.get = original;
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
  await f.scope.revokeActor(f.operator, f.producer.actorId);
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
    (await f.workflows.evaluate(f.producer, e.id)).actions.find((item) => item.action === action)!;
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
  const state = await openState(f.directory),
    scope = await createService(new ProjectScope(state)),
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(f.directory, 'blobs'))),
    ),
    workflows = await createService(new WorkflowsService(state, scope)),
    reviews = await createService(new ReviewService(state, scope, artifacts)),
    builder = await createService(new RecipeContextBuilder(state, scope, artifacts)),
    experiments = await createService(
      new ExperimentService(
        state,
        scope,
        artifacts,
        workflows,
        reviews,
        builder,
        undefined,
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
        assert.equal((await paper.read(f.reader)).proposals.length, 0);
      });
    }
});
