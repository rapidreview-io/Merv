import { createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { currentWork } from './fixtures/current-work.js';
import { legacyReports } from './fixtures/legacy-reports.js';
import { managedServices } from './fixtures/managed-services.js';

import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { RecipeContextBuilder } from '@merv/context-builder';
import type { Artifact, Caller, Data, ReviewApplication } from '@merv/contracts';
import { ExperimentService } from '@merv/experiments';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentEvidence,
  ExperimentTransition,
} from '@merv/experiments/types';
import { ReviewService } from '@merv/reviews';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { feasibilityStatement } from './feasibility-fixture.js';
import { openState } from './fixtures/state.js';
import { reviewedFindings } from './fixtures/task-evidence.js';

const plan =
  '# Summary\nA paired comparison.\n# Objective & hypothesis\nTest whether the intervention changes the measured outcome.\n# Evaluation\nUse matched controls and report the uncertainty.\n';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-experiment-invariants-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Invariant probe',
    actorName: 'Owner',
  });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const managed = await managedServices(
    { state, scope, artifacts, workflows, reviews },
    directory,
    source,
  );
  const { events, sessions } = managed;
  const experiments = await createService(
    new ExperimentService(
      state,
      scope,
      artifacts,
      workflows,
      reviews,
      builder,
      managed.code,
      await createService(new PaperService(state, scope, artifacts)),
    ),
  );
  experiments.bindReports(legacyReports(state));
  const work = currentWork({ code: managed.code, sessions, events }, { directory, source });
  const issued = await scope.credentials.issueActor(source, {
    name: 'Independent reviewer',
    role: 'operator',
  });
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
  ): Promise<{ artifact: Artifact; evidence: ExperimentEvidence }> => {
    // A design is a plan and a feasibility statement; these tests are about the plan.
    if (role === 'plan') await attach(experiment, 'feasibility', feasibilityStatement(), caller);
    const artifact = await artifacts.create(caller, {
      title: role,
      content,
      mediaType: role === 'plan' || role === 'report' ? 'text/markdown' : 'application/json',
    });
    const evidence = await experiments.attach(caller, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      attemptIndex: experiment.attempt.index,
      artifactId: artifact.id,
      role,
      path: `${role}.${role === 'plan' || role === 'report' ? 'md' : 'json'}`,
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
    const producer = await work.lease(experiment);
    await attach(experiment, 'plan', plan, producer.worker);
    const pending = await work.run(
      producer,
      'experiment.transition',
      { transition: 'submit_design', requestId: request() },
      (caller, input) => experiments.transition(caller, input as unknown as ExperimentTransition),
    );
    await work.release(producer);
    const held = await work.lease(pending, reviewer);
    const review = await reviews.get(held.worker, pending.reviewId!);
    const accepted = await work.run(
      held,
      'review.submit',
      {
        ...reviewedFindings(review),
        reviewId: review.id,
        claimId: review.claimId!,
        expectedRevision: pending.workflow.revision,
        verdict: 'pass',
        notes: 'Checked the exact design and evaluation.',
        requestId: request(),
      },
      (caller, input) => experiments.submitReview(caller, input as unknown as ReviewApplication),
    );
    await work.release(held);
    await managed.code.submissions.reconcile();
    return accepted;
  };
  const offer = async (experiment: Experiment) => {
    const held = await work.lease(experiment);
    return { session: held.session, worker: held.worker };
  };
  const run = async <T>(
    worker: Caller,
    tool: string,
    input: Data,
    handler: (caller: Caller, input: Data) => T,
  ) => sessions.invocations.run(await sessions.invocations.prepare(worker, tool, input), handler);
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
    await work.close();
    await managed.close();
    experiments.close();
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

test('figure attachment rejects missing, foreign-project and post-offer images without widening frozen grants', async (t) => {
  const f = await fixture(t),
    experiment = await f.create();
  const foreign = await f.scope.credentials.bootstrap({
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
  const reads = t.mock.method(f.artifacts, 'bytes');
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
    async () =>
      await f.sessions.invocations.prepare(worker, 'artifact.read', { artifactId: lateImage.id }),
    {
      code: 'execution_arguments_forbidden',
    },
  );
  assert.equal((await f.experiments.get(f.source, experiment.id)).evidence.length, 0);
});
