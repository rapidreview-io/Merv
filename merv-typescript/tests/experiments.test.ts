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
import { type Caller, type ReviewApplication } from '@merv/contracts';
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
  const scope = await createService(new ProjectScope(state));
  const principal = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://example.test/auth',
    subject: 'experiment-owner',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = await scope.members.createProject(principal, {
    name: 'Experiments',
    requestId: 'project',
  });
  const operator = await scope.caller(principal, project.id);
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
  'experiment@46 submits its rendered report: drafted from the plan, final PDF, pages as figures',
  { skip: !reportBrowser() && 'no Chromium for rendering' },
  async (t) => {
    const f = await fixture(t);
    const reports = await createService(
      new ReportService(f.state, f.scope, f.artifacts, new ReportRenderer(reportBrowser())),
    );
    t.after(async () => await reports.close());
    f.experiments.bindReports(reports);
    let e = await f.create();
    assert.equal(e.workflow.version, 46);
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
  // Results returned to a new design: its writer attaches at the pinned base with the approved
  // commit on it, not at a base the write manifest never reports.
  experiment = await f.results(experiment);
  experiment = await f.submitReview(experiment, 'needs_changes', 'planned');
  assert.equal(experiment.workflow.state, 'planned');
  await f.attach(experiment, 'plan', plan);
  assert.equal(git(f.held(experiment)!.workspace.path, ['rev-parse', 'HEAD']), head);
  experiment = await f.transition(experiment, 'submit_design');
  const override = await f.reviews.start(f.operator, experiment.reviewId!, undefined, true);
  const approved = await f.experiments.submitReview(f.operator, {
    reviewId: override.id,
    claimId: override.claimId!,
    expectedRevision: experiment.workflow.revision,
    verdict: 'pass',
    notes: 'Inspected the revised plan as the project owner.',
    synopsis: 'The revised plan is approved by the project owner.',
    findings: override.criteria.map((_, i) => ({
      criterionNumber: i + 1,
      status: 'met',
      evidenceIds: citedEvidence(experiment, override, i + 1),
      notes: 'Inspected the retained plan and feasibility evidence.',
    })),
    requestId: f.id(),
  });
  assert.equal(approved.workflow.state, 'running');
  assert.equal((await f.reviews.get(f.operator, override.id)).override, true);
  await f.code.submissions.reconcile();
});
