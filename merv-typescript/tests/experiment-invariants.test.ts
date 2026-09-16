import { createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { ClaimService } from '@merv/claims';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { ExperimentService } from '@merv/experiments';
import type { Caller, Data, ReviewApplication } from '@merv/contracts';
import type { Experiment, ExperimentAttach, ExperimentTransition } from '@merv/experiments/types';
import { reviewedFindings } from './fixtures/task-evidence.js';

const plan =
  '# Summary\nA paired comparison.\n# Objective & hypothesis\nTest whether the intervention changes the measured outcome.\n# Evaluation\nUse matched controls and report the uncertainty.\n';
const report =
  '# Summary\nA negative result.\n# Results\nmetrics_exhibit.json records the observations.\n# Deviations from plan\nNone.\n# Conclusion\nNo improvement was observed.\n';
const graph = '{"version":1,"nodes":[{"id":"result","label":"No improvement"}],"edges":[]}';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-experiment-invariants-'));
  const state = new SqliteState(join(directory, 'state.sqlite'));
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  const experiments = await createService(
    new ExperimentService(
      state,
      scope,
      artifacts,
      workflows,
      reviews,
      builder,
      await createService(new ClaimService(state, scope)),
      undefined,
      await createService(new PaperService(state, scope, artifacts)),
    ),
  );
  const boot = await scope.bootstrap({ projectName: 'Invariant probe', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(source, { name: 'Independent reviewer', role: 'reviewer' });
  const reviewer: Caller = {
    actorId: issued.actor.id,
    projectId: source.projectId,
    credentialId: issued.credential.id,
  };
  let sequence = 0;
  const request = () => `invariant-${++sequence}`;
  const create = async () =>
    await experiments.create(source, {
      name: `invariant-${++sequence}`,
      intent: 'Measure the effect.',
      requestId: request(),
    });
  const attach = async (
    experiment: Experiment,
    role: ExperimentAttach['role'],
    content: string,
    caller = source,
  ) => {
    const artifact = await artifacts.create(caller, {
      title: role,
      content,
      mediaType: ['graph', 'result'].includes(role) ? 'application/json' : 'text/markdown',
    });
    const evidence = await experiments.attach(caller, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      attemptIndex: experiment.attempt.index,
      artifactId: artifact.id,
      role,
      path: `${role}.${['graph', 'result'].includes(role) ? 'json' : 'md'}`,
      requestId: request(),
    });
    return { artifact, evidence };
  };
  const transition = async (
    experiment: Experiment,
    transition: ExperimentTransition['transition'],
  ) =>
    await experiments.transition(source, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition,
      requestId: request(),
    });
  const running = async () => {
    const experiment = await create();
    await attach(experiment, 'plan', plan);
    const pending = await transition(experiment, 'submit_design');
    const review = await reviews.start(reviewer, pending.reviewId!);
    return await experiments.submitReview(reviewer, {
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'pass',
      notes: 'Checked the exact design and evaluation.',
      requestId: request(),
    } as ReviewApplication);
  };
  const offer = async (experiment: Experiment) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(source, {
      instanceId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      runnerId: 'invariants',
      requestId: request(),
      secret,
    });
    return { session, worker: await sessions.authenticate(secret) };
  };
  const run = async <T>(
    worker: Caller,
    tool: string,
    input: Data,
    handler: (caller: Caller, input: Data) => T,
  ) => sessions.run(await sessions.prepare(worker, tool, input), handler);
  const workerAttach = async (
    worker: Caller,
    experiment: Experiment,
    input: Omit<ExperimentAttach, 'experimentId' | 'expectedRevision' | 'requestId'>,
  ) =>
    run(
      worker,
      'experiment.attach',
      { ...input, requestId: request() },
      async (caller, bound) =>
        await experiments.attach(caller, bound as unknown as ExperimentAttach),
    );
  const workerArtifact = async (worker: Caller, content: string) =>
    run(
      worker,
      'artifact.create',
      { title: 'Verified successor output', content },
      async (caller, input) =>
        await artifacts.create(caller, input as unknown as { title: string; content: string }),
    );
  t.after(async () => {
    await sessions.close();
    experiments.close();
    await events.close();
    reviews.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    state,
    scope,
    source,
    reviewer,
    artifacts,
    workflows,
    reviews,
    sessions,
    experiments,
    request,
    create,
    attach,
    running,
    offer,
    run,
    workerAttach,
    workerArtifact,
  };
}

test('a successor can reattach exact frozen result/graph tuples and submit its own verified report', async (t) => {
  const f = await fixture(t),
    experiment = await f.running();
  const result = await f.attach(experiment, 'result', '{"observations":[0,0],"improved":false}');
  const predecessorGraph = await f.attach(experiment, 'graph', graph);
  const { worker } = await f.offer(experiment);
  await assert.rejects(
    async () =>
      f.workerAttach(worker, experiment, {
        attemptIndex: 1,
        artifactId: result.artifact.id,
        role: 'result',
        path: result.evidence.path,
        resultFormat: 'qualitative',
      }),
    { code: 'invalid_evidence_author' },
  );
  const resultCopy = await f.workerAttach(worker, experiment, {
    attemptIndex: 1,
    artifactId: result.artifact.id,
    role: 'result',
    path: result.evidence.path,
  });
  const graphCopy = await f.workerAttach(worker, experiment, {
    attemptIndex: 1,
    artifactId: predecessorGraph.artifact.id,
    role: 'graph',
    path: predecessorGraph.evidence.path,
  });
  assert.notEqual(resultCopy.id, result.evidence.id);
  assert.notEqual(graphCopy.id, predecessorGraph.evidence.id);
  const ownReport = await f.workerArtifact(worker, report);
  await f.workerAttach(worker, experiment, {
    attemptIndex: 1,
    artifactId: ownReport.id,
    role: 'report',
    path: 'report.md',
  });
  const pending = await f.run(
    worker,
    'experiment.transition',
    { transition: 'submit_results', requestId: f.request() },
    async (caller, input) =>
      await f.experiments.transition(caller, input as unknown as ExperimentTransition),
  );
  assert.equal(pending.workflow.state, 'experiment_review');
  const submission = pending.submissions.find((item) => item.stage === 'results')!;
  assert.equal(submission.producerId, worker.actorId);
  assert.ok(submission.evidence.some((item) => item.id === resultCopy.id));
  assert.equal((await f.artifacts.get(f.source, result.artifact.id)).createdBy, f.source.actorId);
  const review = await f.reviews.get(f.source, submission.reviewId);
  assert.ok(review.artifactIds.includes(result.artifact.id));
});

test('draft figures survive a producer handoff as exact readable inputs of the successor', async (t) => {
  const f = await fixture(t),
    experiment = await f.create();
  const figure = await f.artifacts.create(f.source, {
    title: 'Retained chart',
    content:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=',
    encoding: 'base64',
    mediaType: 'image/png',
  });
  const withFigure = `${plan}\n![Observed effect](${figure.id})\n`;
  await f.attach(experiment, 'plan', withFigure);
  const { worker, session } = await f.offer(experiment);
  assert.ok(
    (session.execution.references.artifacts as string[]).includes(figure.id),
    'A frozen draft figure must remain available to its replacement worker',
  );
  const read = await f.run(
    worker,
    'artifact.read',
    { artifactId: figure.id },
    async (caller) => await f.artifacts.read(caller, figure.id),
  );
  assert.equal(read.artifact.hash, figure.hash);
  const ownPlan = await f.workerArtifact(worker, withFigure);
  await f.workerAttach(worker, experiment, {
    attemptIndex: 1,
    artifactId: ownPlan.id,
    role: 'plan',
    path: 'plan.md',
  });
  const pending = await f.run(
    worker,
    'experiment.transition',
    { transition: 'submit_design', requestId: f.request() },
    async (caller, input) =>
      await f.experiments.transition(caller, input as unknown as ExperimentTransition),
  );
  assert.deepEqual(pending.submissions.at(-1)!.figureIds, [figure.id]);
  assert.ok((await f.reviews.get(f.source, pending.reviewId!)).artifactIds.includes(figure.id));
});

test('figure attachment rejects missing, foreign-project and post-offer images without widening frozen grants', async (t) => {
  const f = await fixture(t),
    experiment = await f.create();
  const foreign = await f.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other owner',
  });
  const foreignCaller: Caller = {
    actorId: foreign.actor.id,
    projectId: foreign.project.id,
    credentialId: foreign.credential.id,
  };
  const foreignImage = await f.artifacts.create(foreignCaller, {
    title: 'Foreign chart',
    content: 'separate project',
    mediaType: 'image/png',
  });
  for (const target of ['art_missing', foreignImage.id]) {
    const draft = await f.artifacts.create(f.source, {
      title: 'Draft',
      content: `Draft sections may be unfinished.\n![Unavailable](${target})`,
    });
    const before = await f.state.eventHead();
    await assert.rejects(
      async () =>
        await f.experiments.attach(f.source, {
          experimentId: experiment.id,
          expectedRevision: 0,
          attemptIndex: 1,
          artifactId: draft.id,
          role: 'plan',
          path: 'plan.md',
          requestId: f.request(),
        }),
      { code: 'not_found' },
    );
    assert.equal(await f.state.eventHead(), before);
    assert.equal((await f.experiments.get(f.source, experiment.id)).evidence.length, 0);
  }
  const { worker } = await f.offer(experiment);
  const lateImage = await f.artifacts.create(f.source, {
    title: 'Late chart',
    content: 'must not be read',
    mediaType: 'image/png',
  });
  const ownPlan = await f.workerArtifact(
    worker,
    `${plan}\n![Outside frozen scope](${lateImage.id})`,
  );
  const reads = t.mock.method(f.artifacts, 'read');
  const before = await f.state.eventHead();
  await assert.rejects(
    async () =>
      await f.workerAttach(worker, experiment, {
        attemptIndex: 1,
        artifactId: ownPlan.id,
        role: 'plan',
        path: 'plan.md',
      }),
    { code: 'forbidden' },
  );
  assert.equal(await f.state.eventHead(), before);
  assert.ok(reads.mock.calls.every((call) => call.arguments[1] !== lateImage.id));
  await assert.rejects(
    async () => await f.sessions.prepare(worker, 'artifact.read', { artifactId: lateImage.id }),
    {
      code: 'execution_arguments_forbidden',
    },
  );
  assert.equal((await f.experiments.get(f.source, experiment.id)).evidence.length, 0);
});
