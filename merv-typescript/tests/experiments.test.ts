import { createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import { ReportService } from '@merv/reports';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { git } from './fixtures/code-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  experimentTransitionSchema,
  parseExperimentInput,
} from '../packages/experiments/src/input.js';
import { ReportRenderer } from '../packages/reports/src/render.js';
import { currentWork } from './fixtures/current-work.js';
import { legacyReports } from './fixtures/legacy-reports.js';
import { managedServices } from './fixtures/managed-services.js';
import { reportBrowser } from './fixtures/report-browser.js';

import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { RecipeContextBuilder } from '@merv/context-builder';
import { check, MervError, type Caller, type ReviewApplication } from '@merv/contracts';
import { ExperimentService } from '@merv/experiments';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentAttached,
  ExperimentReview,
  ExperimentTransition,
} from '@merv/experiments/types';
import { ReviewService } from '@merv/reviews';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
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
    boot = await scope.credentials.bootstrap({ projectName: 'Experiments', actorName: 'Operator' });
  const operator: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const result = await scope.credentials.issueActor(operator, {
      name: role,
      role: role === 'reviewer' ? 'operator' : role,
    });
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
  const managed = await managedServices(
    { state, scope, artifacts, workflows, reviews },
    dir,
    operator,
  );
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
  experiments.bindReports(legacyReports(state));
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
  ): Promise<ExperimentAttached> => {
    if (!active.has(experiment.id)) active.set(experiment.id, await work.lease(experiment));
    const author = active.get(experiment.id)!.worker;
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
    if (transition !== 'submit_results' && transition !== 'submit_design')
      return experiments.transition(active.get(experiment.id)?.worker ?? producer, input);
    const current = await experiments.get(producer, experiment.id);
    const held = active.get(current.id) ?? (await work.lease(current));
    for (const evidence of current.evidence.filter(
      (item) =>
        item.current &&
        item.attemptIndex === current.attempt.index &&
        (transition === 'submit_design' ? ['plan', 'feasibility'] : ['result', 'report']).includes(
          item.role,
        ) &&
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
    let submitted = false;
    try {
      const result = await work.run(
        held,
        'experiment.transition',
        { transition, requestId: input.requestId, ...extra },
        (caller, bound) => experiments.transition(caller, bound as unknown as ExperimentTransition),
      );
      submitted = true;
      return result;
    } finally {
      if (submitted) {
        active.delete(current.id);
        await work.release(held);
      }
    }
  };
  const reviewInput = async (
    experiment: Experiment,
    verdict: ReviewApplication['verdict'] = 'pass',
    returnTo?: string,
  ): Promise<ExperimentReview> => {
    const held = active.get(experiment.id) ?? (await work.lease(experiment, reviewer));
    active.set(experiment.id, held);
    const review = await reviews.get(held.worker, experiment.reviewId!);
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
  const applyReview = async (experiment: Experiment, input: ExperimentReview) => {
    const held = active.get(experiment.id)!;
    const next = (await work.run(
      held,
      'review.submit',
      input as unknown as import('@merv/contracts').Data,
      (caller, bound) => reviews.apply(caller, bound as unknown as ReviewApplication),
    )) as Experiment;
    active.delete(experiment.id);
    await work.release(held);
    await managed.code.submissions.reconcile();
    return next;
  };
  const submitReview = async (
    experiment: Experiment,
    verdict: ReviewApplication['verdict'] = 'pass',
    returnTo?: string,
  ) => applyReview(experiment, await reviewInput(experiment, verdict, returnTo));
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
    work,
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
    applyReview,
    running,
    results,
    execute,
    worker: (e: Experiment) => active.get(e.id)?.worker ?? producer,
    held: (e: Experiment) => active.get(e.id),
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
      experiments.bindReports(legacyReports(state));
      return old;
    },
  };
}

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
test('Attempt fail and needs_changes require explicit routes and distinguish new attempts from new rounds', async (t) => {
  const f = await fixture(t);
  let e = await f.running();
  const approved = e.attempt.approvedSubmissionId;
  e = await f.results(e);
  const input = await f.reviewInput(e, 'fail');
  const before = (await f.state.events(f.operator.projectId)).length;
  await assert.rejects(async () => await f.applyReview(e, input), code('invalid_review_return'));
  assert.equal((await f.state.events(f.operator.projectId)).length, before);
  e = (await f.applyReview(e, { ...input, returnTo: 'running' })) as Experiment;
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
    async () => await f.applyReview(e, { ...input, returnTo: 'running' }),
    code('invalid_review_return'),
  );
  e = (await f.applyReview(e, input)) as Experiment;
  assert.equal(e.attempt.index, 2);
  assert.equal(e.workflow.state, 'planned');
});
test('Missing bytes and invalid scoped figure references cannot seal a review', async (t) => {
  const f = await fixture(t),
    e = await f.create();
  await f.execute(e);
  const figure = await f.artifacts.create(f.worker(e), {
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
test('A fresh storage connection restores attempts, immutable review pins, figures and command receipts', async (t) => {
  const f = await fixture(t);
  let e = await f.create('Restart-proof');
  await f.execute(e);
  const image = await f.artifacts.create(f.worker(e), {
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
  e = (await f.applyReview(e, application)) as Experiment;
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
      { state, scope, artifacts, workflows, reviews },
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
  experiments.bindReports(legacyReports(state));
  try {
    assert.deepEqual(await experiments.get(f.producer, e.id), e);
    assert.deepEqual(e.attempt.feedbackReviewIds, [application.reviewId]);
    assert.deepEqual(e.submissions[0].figureIds, [image.id]);
    assert.equal((await reviews.get(f.reviewer, application.reviewId)).verdict, 'needs_changes');
    assert.ok(
      await state.read((sql) =>
        sql.get(
          'SELECT request_id FROM experiment_commands WHERE request_id=?',
          application.requestId,
        ),
      ),
    );
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

const REPORTED_PLAN = `## Summary
Question: Does the domain tokenizer improve NER?
## Objective & hypothesis
A domain tokenizer should split legal terms less and lift NER macro-F1.
## Evaluation
| Arm | What it varies |
|---|---|
| A | base tokenizer |
| B | domain tokenizer |
- Primary measure: NER macro-F1
- Success: at least +1.0 over arm A
- Budget: 10 GPU-hours
Risks:
- One vocabulary size`;

test(
  'experiment@45 submits its rendered report: drafted from the plan, final PDF, pages as figures',
  { skip: !reportBrowser() && 'no Chromium for rendering' },
  async (t) => {
    const f = await fixture(t);
    const reports = await createService(
      new ReportService(f.state, f.scope, f.artifacts, new ReportRenderer(reportBrowser())),
    );
    t.after(async () => await reports.close());
    f.experiments.bindReports(reports);
    let e = await f.create();
    assert.equal(e.workflow.version, 45);
    await f.attach(e, 'plan', REPORTED_PLAN);
    e = await f.transition(e, 'submit_design');
    e = await f.execute(await f.submitReview(e));

    // A Markdown report that Reports never rendered final is refused.
    await f.attach(e, 'result', '{"accuracy":0.5}');
    await f.attach(e, 'report', '# A report\nWritten by hand.');
    await assert.rejects(f.transition(e, 'submit_results'), code('experiment_report_required'));

    e = await f.execute(await f.experiments.get(f.producer, e.id));
    const worker = f.worker(e);
    const subject = { subjectKind: 'experiment' as const, subjectId: e.id };
    const draft = await reports.open(worker, subject);
    assert.match(draft.source, /^# Does the domain tokenizer improve NER\?$/m);
    assert.match(draft.source, /- Success: at least \+1\.0 over arm A/);
    assert.doesNotMatch(draft.source, /One vocabulary size/);
    // Another session, or the operator's reader, cannot edit the runner's report.
    await assert.rejects(
      reports.write(f.reader, {
        ...subject,
        expectedRevision: 1,
        requestId: f.id(),
        sections: [{ name: 'Method', content: 'x' }],
      }),
      code('forbidden'),
    );
    let rev = (
      await reports.write(worker, {
        ...subject,
        expectedRevision: draft.revision,
        requestId: f.id(),
        frontMatter:
          'id: "EXP-43"\ndate: "2026-10-14"\ncriteria:\n  - {metric: "NER macro-F1", bar: 1.0}',
        sections: [
          {
            name: 'Result',
            content:
              'Yes: NER improves by 1.8 F1.\n\n```chart\n{"id": "results", "message": "NER clears its bar.", "data": {"values": [{"metric": "NER macro-F1", "delta": 1.8, "lo": 1.1, "hi": 2.5}]}, "y": {"field": "metric"}, "x": {"title": "Δ vs baseline", "domain": [-1, 3]}, "layer": [{"mark": "rule", "x": "lo", "x2": "hi", "size": "l", "emphasis": "low", "color": {"field": "status", "map": {"met": "result", "not met": "warn"}}}, {"mark": "point", "x": "delta", "size": "l", "color": {"field": "status", "map": {"met": "result", "not met": "warn"}}}, {"mark": "tick", "x": "bar", "style": "dashed", "size": "s"}]}\n```',
          },
          {
            name: 'Method',
            content:
              'Both arms fine-tune identically over seeds 0–4; intervals are t-based over paired differences.',
          },
          { name: 'Execution', content: 'Ten jobs ran in 2 h: 6.1 of 10 GPU-hours.' },
          {
            name: 'Data',
            content:
              '| Dataset | Use | Train / test |\n|---|---|---|\n| LeNER-Br | NER | 7.8k / 1.4k |',
          },
          { name: 'Verification', content: 'Metrics were recomputed from the evaluation logs.' },
          { name: 'Limitations', content: '- One vocabulary size was tried.' },
        ],
      })
    ).revision;
    rev = (
      await reports.approveVisual(worker, {
        ...subject,
        chartId: 'results',
        expectedRevision: rev,
        requestId: f.id(),
      })
    ).revision;
    const rendered = await reports.render(worker, { ...subject, final: true, requestId: f.id() });
    const final = rendered.final!;
    await f.experiments.attach(worker, {
      experimentId: e.id,
      attemptIndex: e.attempt.index,
      expectedRevision: (await f.experiments.get(f.producer, e.id)).workflow.revision,
      artifactId: final.sourceArtifactId,
      role: 'report',
      path: 'report.md',
      requestId: f.id(),
    });
    await f.attach(e, 'result', '{"accuracy":0.5}');
    e = await f.transition(await f.experiments.get(f.producer, e.id), 'submit_results');
    assert.equal(e.workflow.state, 'experiment_review');
    const submission = e.submissions.at(-1)!;
    assert.deepEqual(submission.figureIds, final.pageArtifactIds);
    const review = await f.reviews.get(f.reviewer, e.reviewId!);
    assert.ok(review.artifactIds.includes(final.pdfArtifactId));
    assert.match(review.criteria.at(-1)!, /^Format: the report is the rendered one-page report/);
    e = await f.submitReview(e);
    assert.equal(e.conclusion, 'Yes: NER improves by 1.8 F1.');
  },
);

test('a leased planner recovers original request and paginated history through its granted read', async (t) => {
  const { experimentReminder, experimentHistory } = await import('@merv/experiments/read-view');
  const { experimentGetSchema } = await import('@merv/experiments/input');
  const { agentAssignment } = await import('@merv/contracts/agent-assignment');
  const f = await fixture(t);
  const experiment = await f.create();
  await f.attach(experiment, 'plan', plan + '\nOLD_PLAN');
  await f.attach(experiment, 'plan', plan + '\nNEW_PLAN');
  await f.work.release(f.held(experiment)!);
  const lease = await f.work.lease(await f.experiments.get(f.producer, experiment.id));
  const read = async (args: import('@merv/contracts').Data) =>
    f.work.run(lease, 'experiment.get_state', args, async (caller, raw) => {
      const input = experimentGetSchema.parse(raw);
      const value = await f.experiments.get(caller, input.experimentId);
      return input.history
        ? experimentHistory(value, input.history, input.offset, input.limit)
        : experimentReminder(value);
    });
  const reminder = (await read({ experimentId: experiment.id })) as ReturnType<
    typeof experimentReminder
  >;
  assert.equal(reminder.intent, experiment.intent);
  assert.equal(reminder.details, experiment.details);
  assert.ok(!('attempts' in reminder));
  assert.ok(reminder.references.some((r) => r.tool === 'workflow.assignment'));
  const seen: string[] = [];
  let args: import('@merv/contracts').Data | undefined = {
    experimentId: experiment.id,
    history: 'evidence',
    limit: 1,
  };
  while (args) {
    const page = (await read(args)) as ReturnType<typeof experimentHistory>;
    seen.push(...page.items.map((item) => ('id' in item ? item.id : String(item.index))));
    args = page.next?.arguments;
  }
  const full = await f.experiments.get(f.producer, experiment.id);
  assert.deepEqual(
    seen,
    full.evidence.map((e) => e.id),
  );
  const assignment = await f.work.run(
    lease,
    'workflow.assignment',
    { instanceId: experiment.id },
    (caller) => f.workflows.assignment(caller, experiment.id),
  );
  const before = JSON.stringify(assignment);
  const view = agentAssignment(assignment);
  assert.equal(
    JSON.stringify(assignment),
    before,
    'projection cannot mutate the frozen assignment',
  );
  assert.ok(JSON.stringify(view).length < before.length);
  assert.ok(!('policy' in view.execution));
  assert.deepEqual(
    agentAssignment(view as typeof assignment),
    view,
    'continuation projection is stable',
  );
  assert.ok(view.references.some((r) => r.id === reminder.evidence[0]!.artifactId));
  for (const tool of assignment.execution.tools)
    assert.ok(view.execution.tools.some((t) => t.name === tool.name));
  await f.work.release(lease);
});

test('planner and both reviewers receive the original request directly', async (t) => {
  const f = await fixture(t);
  let e = await f.create('original-request', {
    intent: 'Compare embedding widths; use experiment.read:get literally.',
    details: 'Use widths 64 and 128, seeds 1–3, and the retained baseline.',
  });
  const checkRequest = async (caller: Caller) => {
    const prompt = (await f.workflows.assignment(caller, e.id)).context!.prompt;
    assert.ok(prompt.includes(JSON.stringify({ intent: e.intent }).slice(1, -1)));
    assert.ok(prompt.includes(JSON.stringify({ details: e.details }).slice(1, -1)));
  };
  await checkRequest(f.producer);
  const planner = await f.work.lease(e);
  await checkRequest(planner.worker);
  await f.work.release(planner);
  await f.attach(e, 'plan', plan);
  e = await f.transition(e, 'submit_design');
  await checkRequest(f.reviewer);
  e = await f.submitReview(e);
  e = await f.results(e);
  await checkRequest(f.reviewer);
});

test('plan approval commits the exact frozen working tree and gates execution until Git retention completes', async (t) => {
  const f = await fixture(t);
  let experiment = await f.create('Frozen-plan-code');
  await f.attach(experiment, 'plan', plan);
  const planner = f.held(experiment)!;
  const parent = git(planner.workspace.path, ['rev-parse', 'HEAD']);
  const repository = f.managed.core.repositories.paths(f.producer.projectId).repository;
  const count = () => Number(git(repository, ['rev-list', '--all', '--count']));
  const before = count();
  writeFileSync(join(planner.workspace.path, 'plan.py'), 'print("reviewed plan")\n');
  experiment = await f.transition(experiment, 'submit_design');
  const submitted = await f.code.capture(
    f.producer,
    experiment.submissions.at(-1)!.codeCaptureRef!,
  );
  assert.equal(submitted.status, 'ready');
  assert.equal(submitted.workspace!.headOid, parent);
  assert.equal(count(), before, 'submitting the planner’s dirty work creates no commit');
  await f.reviewInput(experiment);
  const reviewer = f.held(experiment)!;
  assert.equal(reviewer.workspace.readOnly, true);
  assert.equal(git(reviewer.workspace.path, ['rev-parse', 'HEAD']), parent);
  assert.equal(
    readFileSync(join(reviewer.workspace.path, 'plan.py'), 'utf8'),
    'print("reviewed plan")\n',
  );
  assert.equal(reviewer.workspace.snapshot!.submission?.treeOid, submitted.workspace!.treeOid);
  const storage = f.code.gitRemote;
  let unavailable = true;
  f.code.bindSubmissionStorage({
    verifySubmission: (...args) => storage.verifySubmission(...args),
    materializeSubmission: (...args) => {
      if (unavailable) return Promise.reject(new Error('simulate unavailable Git storage'));
      return storage.materializeSubmission(...args);
    },
  });
  experiment = await f.submitReview(experiment);
  assert.equal(experiment.workflow.state, 'running');
  assert.equal(count(), before, 'a durable verdict alone does not claim durable code');
  await assert.rejects(
    f.state.transaction((tx) =>
      f.code.requireLeasable(f.producer, { unitId: experiment.id, writer: true }, tx),
    ),
    { code: 'code_approval_pending' },
  );
  unavailable = false;
  await f.code.submissions.reconcile();
  const head = await f.state.transaction((tx) => f.code.resumesFrom(f.producer, experiment.id, tx));
  assert.ok(head && head !== parent);
  assert.equal(git(repository, ['rev-parse', `${head}^{tree}`]), submitted.workspace!.treeOid);
  assert.equal(git(repository, ['show', `${head}:plan.py`]), 'print("reviewed plan")');
  assert.equal(count(), before + 1);
  await f.code.submissions.reconcile();
  assert.equal(count(), before + 1, 'approval replay is idempotent');
  await f.execute(experiment);
  assert.equal(git(f.held(experiment)!.workspace.path, ['rev-parse', 'HEAD']), head);
  assert.equal(
    (await f.code.unit(f.producer, experiment.id)).acceptance,
    null,
    'plan approval does not accept experiment results',
  );
});
