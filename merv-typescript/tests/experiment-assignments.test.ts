import { createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import type {
  Artifact,
  Caller,
  Data,
  ReviewApplication,
  ReviewHistory,
  WorkflowExecution,
} from '@merv/contracts';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { ClaimService } from '@merv/claims';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { TaskService } from '@merv/tasks';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { ExperimentService } from '@merv/experiments';
import { CodeService } from '@merv/code/service';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentEvidence,
  ExperimentTransition,
} from '@merv/experiments/types';
import { feasibilityStatement } from './feasibility-fixture.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

const plan =
  '# Summary\nCompare two methods.\n# Objective & hypothesis\nA improves held-out accuracy.\n# Evaluation\nUse the same held-out examples, baseline, metric and denominator.\n';
const report =
  '# Summary\nThe qualitative result is retained.\n# Results\nThe control and intervention behaved alike.\n# Deviations from plan\nNone.\n# Conclusion\nThe observation does not support an improvement.\n';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-experiment-program-'));
  const state = new SqliteState(join(directory, 'state.sqlite'));
  const scope = await createService(new ProjectScope(state));
  const blobs = new DiskBlobs(join(directory, 'blobs'));
  const artifacts = await createService(new ArtifactStore(state, scope, blobs));
  const claims = await createService(new ClaimService(state, scope));
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const tasks = await createService(
    new TaskService(state, scope, artifacts, workflows, reviews, builder),
  );
  const events = await createService(new DurableEvents(state));
  const access = scope.toolPolicy;
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      sweepIntervalMs: 60_000,
    }),
  );
  const code = await createService(new CodeService(state, scope, sessions, artifacts));
  const boot = await scope.bootstrap({ projectName: 'Experiment assignments', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  let experiments = await createService(
    new ExperimentService(
      state,
      scope,
      artifacts,
      workflows,
      reviews,
      builder,
      claims,
      code,
      await createService(new PaperService(state, scope, artifacts)),
    ),
  );
  let sequence = 0;
  const request = () => `request-${++sequence}`;
  const issue = async (role: 'operator' | 'producer' | 'reviewer' | 'reader'): Promise<Caller> => {
    const issued = await scope.issueActor(source, { name: role, role });
    return {
      projectId: source.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    };
  };
  const reviewer = await issue('reviewer');
  const create = async (dependsOn: string[] = [], workspace?: 'git') =>
    await experiments.create(source, {
      name: `experiment-${++sequence}`,
      intent: 'Test the hypothesis using matched evidence.',
      dependsOn,
      ...(workspace ? { workspace } : {}),
      requestId: request(),
    });
  const attach = async (
    experiment: Experiment,
    role: ExperimentAttach['role'],
    content: string,
    caller = source,
    path = `${role}.md`,
  ): Promise<{ artifact: Artifact; association: ExperimentEvidence }> => {
    // A design is a plan and a feasibility statement; these tests are about the plan.
    if (role === 'plan')
      await attach(experiment, 'feasibility', feasibilityStatement(), caller, 'feasibility.json');
    const artifact = await artifacts.create(caller, {
      title: role,
      content,
      mediaType: role === 'feasibility' ? 'application/json' : 'text/markdown',
    });
    const association = await experiments.attach(caller, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      attemptIndex: experiment.attempt.index,
      artifactId: artifact.id,
      role,
      path,
      ...(role === 'result' ? { resultFormat: 'qualitative' as const } : {}),
      requestId: request(),
    });
    return { artifact, association };
  };
  const transition = async (
    experiment: Experiment,
    action: ExperimentTransition['transition'],
    caller = source,
  ) =>
    await experiments.transition(caller, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition: action,
      requestId: request(),
      ...(['retry_running', 'mark_failed', 'abandon'].includes(action)
        ? { evidence: { reason: 'Controlled fixture recovery' } }
        : {}),
    });
  const design = async (experiment?: Experiment) => {
    experiment ??= await create();
    const evidence = await attach(experiment, 'plan', plan);
    return { experiment: await transition(experiment, 'submit_design'), evidence };
  };
  const verdict = async (
    experiment: Experiment,
    value: 'pass' | 'needs_changes' | 'fail',
    returnTo?: string,
  ) => {
    const review = await reviews.start(reviewer, experiment.reviewId!);
    return await experiments.submitReview(reviewer, {
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      verdict: value,
      ...(returnTo ? { returnTo } : {}),
      notes: 'Independent fixture verification of the exact retained evidence.',
      expectedRevision: experiment.workflow.revision,
      requestId: request(),
    } as ReviewApplication);
  };
  const running = async () => await verdict((await design()).experiment, 'pass');
  const results = async (experiment: Experiment) => {
    await workflows.begin(source, {
      instanceId: experiment.id,
      expectedRevision: experiment.workflow.revision,
    });
    await attach(experiment, 'result', 'The retained observations show no difference.');
    await attach(experiment, 'report', report);
    return await transition(experiment, 'submit_results');
  };
  const offer = async (experiment: Experiment, caller = source) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    return {
      secret,
      session: await sessions.offer(caller, {
        instanceId: experiment.id,
        expectedRevision: experiment.workflow.revision,
        runnerId: 'assignment-test',
        requestId: request(),
        secret,
      }),
    };
  };
  const run = async <T>(
    caller: Caller,
    tool: string,
    input: Data,
    handler: (worker: Caller, bound: Data) => T | Promise<T>,
  ) => sessions.run(await sessions.prepare(caller, tool, input), handler);
  const release = async (sessionId: string, caller = source) => {
    await sessions.release(caller, { sessionId, runnerId: 'assignment-test' });
    await events.drain();
  };
  t.after(async () => {
    experiments.close();
    code.close();
    await sessions.close();
    tasks.dispose();
    await events.close();
    reviews.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    state,
    scope,
    artifacts,
    claims,
    workflows,
    reviews,
    builder,
    tasks,
    sessions,
    code,
    events,
    source,
    reviewer,
    issue,
    create,
    attach,
    transition,
    design,
    verdict,
    running,
    results,
    offer,
    run,
    release,
    request,
    get experiments() {
      return experiments;
    },
    async reload() {
      experiments.close();
      experiments = await createService(
        new ExperimentService(
          state,
          scope,
          artifacts,
          workflows,
          reviews,
          builder,
          claims,
          code,
          await createService(new PaperService(state, scope, artifacts)),
        ),
      );
    },
  };
}
const dispatch = (execution: WorkflowExecution, tool: string, input: Data = {}) => ({
  instanceId: execution.instanceId,
  expectedRevision: execution.revision,
  policyHash: execution.policyHash,
  registrationId: execution.registrationId,
  tool,
  input,
});

test('all four real assignments use distinct recipes; planning and execution wait for prerequisites', async (t) => {
  const f = await fixture(t);
  const prerequisite = await f.tasks.create(f.source, {
    title: 'Prerequisite',
    goal: 'Retain a prerequisite result.',
    checks: ['Result is present.'],
    requestId: f.request(),
  });
  const experiment = await f.create([prerequisite.id]);
  // A plan is written against its inputs: nothing is planned while a prerequisite is open.
  await assert.rejects(async () => await f.workflows.assignment(f.source, experiment.id), {
    code: 'dependencies_pending',
  });
  assert.ok(
    !(await f.workflows.dispatchCandidates(f.source)).some(
      (candidate) => candidate.instanceId === experiment.id,
    ),
  );
  const proof = await f.artifacts.create(f.source, {
    title: 'Prerequisite result',
    content: 'Result is present.',
  });
  const delivery = await f.tasks.submitDelivery(
    f.source,
    confirmedDelivery({
      taskId: prerequisite.id,
      expectedRevision: 0,
      artifactIds: [proof.id],
      requestId: f.request(),
    }),
  );
  const review = await f.reviews.start(f.reviewer, delivery.reviewId!);
  await f.tasks.submitReview(f.reviewer, {
    ...reviewedFindings(review),
    reviewId: review.id,
    claimId: review.claimId!,
    verdict: 'pass',
    notes: 'Verified the retained prerequisite result.',
    expectedRevision: delivery.workflow.revision,
    requestId: f.request(),
  } as ReviewApplication);
  const planned = await f.workflows.assignment(f.source, experiment.id);
  assert.equal(planned.context!.type, 'experiment.design');
  assert.equal(planned.execution.readOnly, false);
  assert.ok(
    (await f.workflows.dispatchCandidates(f.source)).some(
      (candidate) => candidate.instanceId === experiment.id,
    ),
  );
  const pending = (await f.design(experiment)).experiment;
  assert.equal(
    (await f.workflows.assignment(f.reviewer, pending.id)).context!.type,
    'experiment.design_review',
  );
  assert.ok(
    (await f.workflows.dispatchCandidates(f.source)).some(
      (candidate) => candidate.instanceId === experiment.id,
    ),
    'The source may delegate independent review of its own previous work',
  );
  const running = await f.verdict(pending, 'pass');
  assert.equal(running.workflow.state, 'running');
  assert.equal(running.attempt.startedAt, null);
  assert.equal(
    (await f.workflows.assignment(f.source, running.id)).context!.type,
    'experiment.execute',
  );
  const assessment = await f.results(running);
  const packet = await f.workflows.assignment(f.reviewer, assessment.id);
  assert.equal(packet.context!.type, 'experiment.attempt_review');
  assert.equal(packet.execution.readOnly, true);
  assert.match(packet.context!.prompt, /returnTo planned.*running/s);
  assert.match(packet.context!.prompt, /same held-out examples/);
});

test('a results review whose evidence outgrows the recipe lists it for the reviewer to read', async (t) => {
  const f = await fixture(t);
  const running = await f.verdict((await f.design(await f.create())).experiment, 'pass');
  await f.workflows.begin(f.source, {
    instanceId: running.id,
    expectedRevision: running.workflow.revision,
  });
  for (let part = 0; part < 12; part++)
    await f.attach(
      running,
      'result',
      `# Observations ${part}\n\n${'row,value\n'.repeat(1_500)}`,
      f.source,
      `result-${part}.md`,
    );
  await f.attach(running, 'report', report);
  const assessment = await f.transition(running, 'submit_results');
  const packet = await f.workflows.assignment(f.reviewer, assessment.id);
  assert.equal(packet.context!.type, 'experiment.attempt_review');
  assert.match(packet.context!.prompt, /Bytes are not included/);
  assert.doesNotMatch(packet.context!.prompt, /row,value/);
});

test('dispatch and activation read metadata only; fixed grants do not depend on complete draft evidence', async (t) => {
  const f = await fixture(t);
  const experiment = await f.create();
  await f.attach(experiment, 'plan', 'INCOMPLETE_DRAFT_KEEP_WORKING');
  const reader = t.mock.method(f.artifacts, 'read', () => {
    assert.fail('Metadata admission must not read artifact bytes');
  });
  const evaluate = t.mock.method(f.workflows, 'evaluate', () => {
    assert.fail('Metadata admission must not evaluate exit guidance');
  });
  const execution = await f.workflows.execution(f.source, {
    instanceId: experiment.id,
    expectedRevision: 0,
  });
  assert.ok(
    (await f.workflows.dispatchCandidates(f.source)).some(
      (candidate) => candidate.instanceId === experiment.id,
    ),
  );
  assert.equal(
    (
      await f.workflows.authorizeDispatch(
        f.source,
        dispatch(execution, 'experiment.transition', { transition: 'submit_design' }),
      )
    ).input.expectedRevision,
    0,
  );
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(
        f.source,
        dispatch(execution, 'experiment.transition', { transition: 'submit_results' }),
      ),
    { code: 'execution_arguments_forbidden' },
  );
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(f.source, dispatch(execution, 'workflow.begin')),
    { code: 'execution_tool_forbidden' },
  );
  reader.mock.restore();
  evaluate.mock.restore();
  const offered = await f.offer(experiment);
  assert.match(offered.session.assignment.context!.prompt, /INCOMPLETE_DRAFT_KEEP_WORKING/);
  assert.equal(offered.session.assignment.workStart, null);
  t.mock.method(f.artifacts, 'read', () => {
    assert.fail('Activation must not rebuild context');
  });
  const worker = await f.sessions.authenticate(offered.secret);
  assert.deepEqual(await f.sessions.authenticate(offered.secret), worker);
  assert.equal((await f.workflows.workStarts(f.source, experiment.id)).length, 1);
  assert.equal(
    (await f.experiments.get(f.source, experiment.id)).attempt.startedAt,
    null,
    'Planning activation is not execution',
  );
});

test('offer freezes recovery inputs, fences interactive writes and permits only this worker’s new outputs', async (t) => {
  const f = await fixture(t);
  const experiment = await f.create();
  const inherited = await f.attach(experiment, 'plan', plan + '\nINHERITED_PLAN_4382\n');
  const offered = await f.offer(experiment);
  const worker = await f.sessions.authenticate(offered.secret);
  assert.match(offered.session.assignment.context!.prompt, /INHERITED_PLAN_4382/);
  const foreign = await f.artifacts.create(f.source, {
    title: 'Unrelated content',
    content: 'LATE_FOREIGN_BODY_87013',
  });
  await assert.rejects(
    async () =>
      await f.experiments.attach(f.source, {
        experimentId: experiment.id,
        expectedRevision: 0,
        attemptIndex: 1,
        artifactId: foreign.id,
        role: 'plan',
        path: 'late.md',
        requestId: f.request(),
      }),
    { code: 'experiment_leased' },
  );
  await assert.rejects(
    async () => await f.sessions.prepare(worker, 'artifact.read', { artifactId: foreign.id }),
    {
      code: 'execution_arguments_forbidden',
    },
  );
  await assert.rejects(
    async () =>
      await f.sessions.prepare(worker, 'experiment.attach', {
        artifactId: foreign.id,
        role: 'plan',
        path: 'late.md',
        attemptIndex: 1,
        requestId: f.request(),
      }),
    { code: 'execution_arguments_forbidden' },
  );
  // Fault-inject a later association independently of the normal owner-write fence.
  // Even historical/imported metadata must not enlarge an already issued lease.
  const lateReport = await f.artifacts.create(f.source, {
    title: 'Unrelated report',
    content: '# Summary\nLATE_FOREIGN_REPORT_254\n',
    mediaType: 'text/markdown',
  });
  await f.state.transaction(async (tx) => {
    for (const [artifact, role, sequence] of [
      [foreign, 'plan', 90],
      [lateReport, 'report', 91],
    ] as const) {
      const evidence = {
        ...inherited.association,
        id: `injected-${role}`,
        artifactId: artifact.id,
        hash: artifact.hash,
        role,
        path: `late-${role}.md`,
        sequence,
        current: true,
      };
      await tx.run(
        'INSERT INTO experiment_evidence VALUES(?,?,?,?,?,?,?)',
        evidence.id,
        experiment.id,
        1,
        role,
        evidence.path,
        sequence,
        JSON.stringify(evidence),
      );
      await tx.run(
        'INSERT INTO experiment_slots VALUES(?,?,?,?,?)',
        experiment.id,
        1,
        role,
        evidence.path,
        evidence.id,
      );
    }
  });
  assert.ok(
    (await f.experiments.get(worker, experiment.id)).evidence.some(
      (evidence) => evidence.artifactId === foreign.id,
    ),
    'General state remains an honest metadata view',
  );
  const noForeignReads = t.mock.method(f.artifacts, 'read');
  await assert.rejects(
    async () => await f.sessions.prepare(worker, 'artifact.read', { artifactId: lateReport.id }),
    { code: 'execution_arguments_forbidden' },
    'A late association must not enlarge an already issued lease',
  );
  assert.doesNotMatch(
    (await f.workflows.assignment(worker, experiment.id)).context!.prompt,
    /LATE_FOREIGN_BODY_87013|LATE_FOREIGN_REPORT_254/,
  );
  assert.ok(
    noForeignReads.mock.calls.every(
      (call) => call.arguments[1] !== foreign.id && call.arguments[1] !== lateReport.id,
    ),
  );
  noForeignReads.mock.restore();
  // Receiving the inherited draft does not turn its original author into this worker.
  await assert.rejects(
    async () =>
      f.run(
        worker,
        'experiment.transition',
        { transition: 'submit_design', requestId: f.request() },
        async (caller, input) =>
          await f.experiments.transition(caller, input as unknown as ExperimentTransition),
      ),
    { code: 'invalid_evidence_author' },
  );
  const own = await f.run(
    worker,
    'artifact.create',
    { title: 'Verified worker plan', content: plan + '\nNEW_WORKER_PLAN_2391\n' },
    async (caller, input) =>
      await f.artifacts.create(caller, input as unknown as { title: string; content: string }),
  );
  await f.run(
    worker,
    'experiment.attach',
    { artifactId: own.id, role: 'plan', path: 'plan.md', attemptIndex: 1, requestId: f.request() },
    async (caller, input) =>
      await f.experiments.attach(caller, input as unknown as ExperimentAttach),
  );
  assert.equal(
    (await f.sessions.prepare(worker, 'artifact.read', { artifactId: own.id })).input.artifactId,
    own.id,
  );
  assert.match(
    (await f.workflows.assignment(worker, experiment.id)).context!.prompt,
    /NEW_WORKER_PLAN_2391/,
  );
  assert.equal(
    (await f.artifacts.get(f.source, inherited.artifact.id)).createdBy,
    f.source.actorId,
  );
  await f.release(offered.session.id);
  const successor = await f.offer(experiment);
  assert.match(successor.session.assignment.context!.prompt, /NEW_WORKER_PLAN_2391/);
  assert.ok((successor.session.execution.references.artifacts as string[]).includes(own.id));
  assert.notEqual(successor.session.actorId, worker.actorId);
  // The successor's manifest holds only worker output; the review still excludes the owner
  // who directed the work, because exclusions may name the owner and the directing authority.
  const next = await f.sessions.authenticate(successor.secret);
  const verified = await f.run(
    next,
    'artifact.create',
    { title: 'Successor plan', content: plan + '\nSUCCESSOR_PLAN_2392\n' },
    async (caller, input) =>
      await f.artifacts.create(caller, input as unknown as { title: string; content: string }),
  );
  await f.run(
    next,
    'experiment.attach',
    {
      artifactId: verified.id,
      role: 'plan',
      path: 'plan.md',
      attemptIndex: 1,
      requestId: f.request(),
    },
    async (caller, input) =>
      await f.experiments.attach(caller, input as unknown as ExperimentAttach),
  );
  const submitted = (await f.run(
    next,
    'experiment.transition',
    { transition: 'submit_design', requestId: f.request() },
    async (caller, input) =>
      await f.experiments.transition(caller, input as unknown as ExperimentTransition),
  )) as Experiment;
  assert.equal(submitted.workflow.state, 'design_review');
  assert.deepEqual((await f.reviews.get(f.source, submitted.reviewId!)).excludedActorIds, [
    f.source.actorId,
  ]);
  // The feasibility statement is design evidence like the plan: the successor was offered the
  // predecessor's exact statement and submits it without having to measure everything again.
  const statement = submitted.submissions[0].evidence.find(
    (evidence) => evidence.role === 'feasibility',
  )!;
  assert.equal(statement.createdBy, f.source.actorId);
  assert.ok(
    (successor.session.execution.references.artifacts as string[]).includes(statement.artifactId),
  );
  assert.ok(
    (await f.reviews.get(f.source, submitted.reviewId!)).artifactIds.includes(statement.artifactId),
  );
});

test('review leases claim before freezing, recover exactly once, and preserve same-source independence', async (t) => {
  const f = await fixture(t);
  const pending = (await f.design()).experiment;
  const offered = await f.offer(pending);
  const worker = await f.sessions.authenticate(offered.secret);
  const claimed = await f.reviews.get(worker, pending.reviewId!);
  assert.equal(offered.session.execution.references.claimId, claimed.claimId);
  assert.equal(claimed.reviewerId, worker.actorId);
  assert.equal(claimed.producerId, f.source.actorId);
  assert.notEqual(worker.actorId, f.source.actorId);
  assert.match(offered.session.assignment.context!.prompt, new RegExp(claimed.claimId!));
  await assert.rejects(
    async () =>
      await f.sessions.prepare(worker, 'artifact.create', { title: 'Forbidden', content: 'No' }),
    { code: 'execution_tool_forbidden' },
  );
  await f.release(offered.session.id);
  const released = await f.reviews.get(f.source, pending.reviewId!);
  assert.equal(released.status, 'requested');
  assert.equal(released.snapshotHash, claimed.snapshotHash);
  const next = await f.offer(pending);
  const replacement = await f.sessions.authenticate(next.secret);
  const current = await f.reviews.get(replacement, pending.reviewId!);
  assert.notEqual(current.claimId, claimed.claimId);
  assert.match(next.session.assignment.context!.prompt, /previousClaimId/);
  await f.workflows.releaseLease(offered.session.lease, { reason: 'Repeated stale cleanup' });
  assert.equal((await f.reviews.get(replacement, pending.reviewId!)).claimId, current.claimId);
  await assert.rejects(
    async () =>
      await f.sessions.prepare(replacement, 'review.submit', { claimId: claimed.claimId! }),
    { code: 'execution_arguments_forbidden' },
  );
});

test('context failure rolls back worker reservation and review claim; reload preserves only durable lease authority', async (t) => {
  const f = await fixture(t);
  const pending = (await f.design()).experiment;
  const before = await f.state.read(async (sql) => ({
    actors: await sql.all('SELECT id FROM actors'),
    leases: await sql.all('SELECT id FROM experiment_leases'),
    head: await f.state.eventHead(),
  }));
  const read = t.mock.method(f.artifacts, 'read', () => {
    throw new Error('Injected recipe read failure');
  });
  await assert.rejects(async () => await f.offer(pending), /Injected recipe read failure/);
  assert.deepEqual(
    await f.state.read(async (sql) => ({
      actors: await sql.all('SELECT id FROM actors'),
      leases: await sql.all('SELECT id FROM experiment_leases'),
      head: await f.state.eventHead(),
    })),
    before,
  );
  assert.equal((await f.reviews.get(f.source, pending.reviewId!)).status, 'requested');
  read.mock.restore();
  const offered = await f.offer(pending);
  const worker = await f.sessions.authenticate(offered.secret);
  const stale = await f.sessions.prepare(worker, 'experiment.get_state', {});
  const generation = offered.session.execution.registrationId;
  await f.reload();
  const again = await f.sessions.authenticate(offered.secret);
  assert.equal(again.actorId, worker.actorId);
  assert.equal((await f.workflows.workStarts(f.source, pending.id)).length, 1);
  const current = await f.workflows.execution(again, {
    instanceId: pending.id,
    expectedRevision: pending.workflow.revision,
  });
  assert.notEqual(current.registrationId, generation);
  await assert.rejects(
    async () =>
      f.sessions.run(stale, async (caller) => await f.experiments.get(caller, pending.id)),
    { code: 'execution_replaced' },
  );
  await f.release(offered.session.id);
  assert.equal((await f.reviews.get(f.source, pending.reviewId!)).status, 'requested');
});

test('new attempts reset the execution clock while execution repair retains its approved plan and first activation', async (t) => {
  const f = await fixture(t);
  let experiment = await f.running();
  assert.equal(experiment.attempt.startedAt, null);
  await f.workflows.begin(f.source, {
    instanceId: experiment.id,
    expectedRevision: experiment.workflow.revision,
  });
  const started = (await f.experiments.get(f.source, experiment.id)).attempt.startedAt;
  assert.ok(started);
  const approval = experiment.attempt.approvedSubmissionId;
  // Asking whether a retry is ready is answered against the call: it needs the reason for
  // the interruption, exactly as the tool does.
  assert.ok(
    (
      await f.workflows.evaluate(f.source, experiment.id, {
        action: 'retry_running',
        input: { expectedRevision: experiment.workflow.revision, evidence: {} },
      })
    ).blockers.some((blocker) => blocker.code === 'reason_required'),
  );
  experiment = await f.transition(experiment, 'retry_running');
  assert.equal(experiment.attempt.index, 1);
  assert.equal(experiment.attempt.startedAt, started);
  assert.equal(experiment.attempt.approvedSubmissionId, approval);
  experiment = await f.verdict(await f.results(experiment), 'needs_changes', 'running');
  assert.equal(experiment.attempt.index, 1);
  assert.equal(experiment.attempt.startedAt, started);
  assert.equal(experiment.attempt.approvedSubmissionId, approval);
  experiment = await f.verdict(await f.results(experiment), 'fail', 'planned');
  assert.equal(experiment.attempt.index, 2);
  assert.equal(experiment.attempt.startedAt, null);
  assert.equal(experiment.attempt.approvedSubmissionId, null);
  assert.equal(experiment.attempts[0].startedAt, started);
  assert.equal(
    experiment.submissions.filter((submission) => submission.stage === 'results').length,
    2,
  );
  assert.equal(
    (await f.workflows.assignment(f.source, experiment.id)).context!.type,
    'experiment.design',
  );
});

test('revoking the source fences its live reviewer before recovery and an authorized successor keeps the same evidence', async (t) => {
  const f = await fixture(t);
  const replacementSource = await f.issue('operator');
  const pending = (await f.design()).experiment;
  const offered = await f.offer(pending);
  const worker = await f.sessions.authenticate(offered.secret);
  const claim = await f.reviews.get(worker, pending.reviewId!);
  await f.scope.revokeActor(replacementSource, f.source.actorId);
  await assert.rejects(async () => await f.sessions.prepare(worker, 'review.submit', {}), {
    code: 'forbidden',
  });
  await f.events.drain();
  const reopened = await f.reviews.get(replacementSource, pending.reviewId!);
  assert.equal(reopened.status, 'requested');
  assert.equal(reopened.snapshotHash, claim.snapshotHash);
  assert.deepEqual(reopened.artifactIds, claim.artifactIds);
  const next = await f.offer(pending, replacementSource);
  const replacement = await f.sessions.authenticate(next.secret);
  assert.notEqual(next.session.actorId, worker.actorId);
  assert.notEqual((await f.reviews.get(replacement, pending.reviewId!)).claimId, claim.claimId);
  assert.equal(next.session.source.actorId, replacementSource.actorId);
  assert.match(next.session.assignment.context!.prompt, /previousClaimId/);
});

test('a design rejected three times gives the fourth attempt every earlier round while the attempt names only the latest', async (t) => {
  const f = await fixture(t);
  let experiment = (await f.design()).experiment;
  // No rejected round yet: the feedback section carries no history key at all.
  assert.doesNotMatch(
    (await f.workflows.assignment(f.reviewer, experiment.id)).context!.prompt,
    /"history"/,
  );
  const rejected: string[] = [];
  for (const round of [1, 2, 3]) {
    rejected.push(experiment.reviewId!);
    experiment = await f.verdict(experiment, 'needs_changes', 'planned');
    assert.equal(experiment.attempt.index, round + 1);
    assert.deepEqual(experiment.attempt.feedbackReviewIds, [rejected.at(-1)]);
    if (round < 3) experiment = (await f.design(experiment)).experiment;
  }
  const prompt = (await f.workflows.assignment(f.source, experiment.id)).context!.prompt;
  const feedback = JSON.parse(
    prompt.slice(prompt.indexOf('{"interruptions":')).split('\n')[0]!,
  ) as { previousReviews: { id: string }[]; history: ReviewHistory };
  assert.deepEqual(
    feedback.previousReviews.map((review) => review.id),
    [rejected[2]],
  );
  assert.equal(feedback.history.omittedRounds, 0);
  assert.deepEqual(
    feedback.history.rounds.map(({ round, reviewId, label, verdict, returnTo }) => ({
      round,
      reviewId,
      label,
      verdict,
      returnTo,
    })),
    rejected.map((reviewId, index) => ({
      round: index + 1,
      reviewId,
      label: `design attempt ${index + 1} round 1`,
      verdict: 'needs_changes',
      returnTo: 'planned',
    })),
  );
  assert.ok(!JSON.stringify(feedback.history).includes(f.reviewer.actorId));
  const references = (
    await f.workflows.execution(f.source, {
      instanceId: experiment.id,
      expectedRevision: experiment.workflow.revision,
    })
  ).references;
  assert.ok(rejected.every((id) => (references.reviews as string[]).includes(id)));
  // A reviewer judges the submission in front of them and is shown no earlier attempts' verdicts.
  experiment = (await f.design(experiment)).experiment;
  assert.doesNotMatch(
    (await f.workflows.assignment(f.reviewer, experiment.id)).context!.prompt,
    /"history"/,
  );
});

test('successors receive exact rejected findings and manifests across both return routes without inheriting output authorship', async (t) => {
  const f = await fixture(t);
  for (const destination of ['planned', 'running'] as const) {
    const pending =
      destination === 'planned'
        ? (await f.design()).experiment
        : await f.results(await f.running());
    const review = await f.reviews.start(f.reviewer, pending.reviewId!);
    const marker = `EXACT_REVIEW_FINDING_${destination.toUpperCase()}_73982`;
    const returned = await f.experiments.submitReview(f.reviewer, {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'needs_changes',
      returnTo: destination,
      requestId: f.request(),
      notes: 'The exact retained evidence requires correction before this experiment may proceed.',
      synopsis:
        'The review found an unresolved issue in the pinned evidence and returns the work for correction.',
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: 'not_met' as const,
        evidenceIds: review.artifactIds,
        notes: `${marker}: inspect and correct criterion ${index + 1}.`,
      })),
    });
    assert.equal(returned.reviewId, null);
    assert.deepEqual(returned.attempt.feedbackReviewIds, [review.id]);
    const offered = await f.offer(returned);
    const worker = await f.sessions.authenticate(offered.secret);
    assert.match(offered.session.assignment.context!.prompt, new RegExp(marker));
    assert.ok(
      review.artifactIds.every((id) =>
        (offered.session.execution.references.artifacts as string[]).includes(id),
      ),
    );
    assert.equal(
      (await f.sessions.prepare(worker, 'review.get', { reviewId: review.id })).input.reviewId,
      review.id,
    );
    if (destination === 'planned') {
      const recovery = await f.state.read(async (sql) =>
        JSON.parse(
          (await sql.get<{ recovery: string }>(
            'SELECT recovery FROM experiment_leases WHERE id=?',
            offered.session.id,
          ))!.recovery,
        ),
      );
      assert.deepEqual(
        recovery,
        [],
        'Prior-attempt context does not become current-attempt output evidence',
      );
      const oldPlan = returned.evidence.find((evidence) => evidence.role === 'plan')!;
      await assert.rejects(
        async () =>
          f.run(
            worker,
            'experiment.attach',
            {
              artifactId: oldPlan.artifactId,
              role: 'plan',
              path: oldPlan.path,
              attemptIndex: returned.attempt.index,
              requestId: f.request(),
            },
            async (caller, input) =>
              await f.experiments.attach(caller, input as unknown as ExperimentAttach),
          ),
        { code: 'invalid_evidence_author' },
      );
    }
    await f.release(offered.session.id);
  }
});

test('declared producer terminal actions and owner cancellation close active work without relaxing evidence ownership', async (t) => {
  const f = await fixture(t);
  const experiment = await f.create();
  const offered = await f.offer(experiment);
  const worker = await f.sessions.authenticate(offered.secret);
  const abandoned = await f.run(
    worker,
    'experiment.transition',
    {
      transition: 'abandon',
      evidence: {
        reason: 'The assigned worker identified an explicit reason to end this experiment.',
      },
      requestId: f.request(),
    },
    async (caller, input) =>
      await f.experiments.transition(caller, input as unknown as ExperimentTransition),
  );
  assert.equal(abandoned.workflow.state, 'abandoned');
  const next = await f.create();
  const active = await f.offer(next);
  const failed = await f.transition(next, 'mark_failed');
  assert.equal(
    failed.workflow.state,
    'failed',
    'The owner can end work without first releasing its worker',
  );
  await f.sessions.get(f.source, offered.session.id);
  await f.sessions.get(f.source, active.session.id);
  await f.events.drain();
  assert.equal(
    await f.state.read(
      async (sql) =>
        (await sql.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM experiment_leases WHERE released_at IS NULL',
        ))!.count,
    ),
    0,
  );
});

test('a lease freezes its project Introduction without changing the registered recipe', async (t) => {
  const f = await fixture(t);
  await f.scope.updateProjectContext(f.source, {
    summary: 'ORIGINAL_PROJECT_INTRO_723',
    expectedSummary: '',
    requestId: f.request(),
  });
  const experiment = await f.create();
  const offered = await f.offer(experiment);
  assert.match(offered.session.assignment.context!.prompt, /ORIGINAL_PROJECT_INTRO_723/);
  const worker = await f.sessions.authenticate(offered.secret);
  await f.scope.updateProjectContext(f.source, {
    summary: 'CHANGED_PROJECT_INTRO_840',
    expectedSummary: 'ORIGINAL_PROJECT_INTRO_723',
    requestId: f.request(),
  });
  const refreshed = await f.workflows.assignment(worker, experiment.id);
  assert.match(refreshed.context!.prompt, /ORIGINAL_PROJECT_INTRO_723/);
  assert.doesNotMatch(refreshed.context!.prompt, /CHANGED_PROJECT_INTRO_840/);
  await f.reload();
  assert.match(
    (await f.workflows.assignment(worker, experiment.id)).context!.prompt,
    /ORIGINAL_PROJECT_INTRO_723/,
  );
  await f.release(offered.session.id);
  const successor = await f.offer(experiment);
  assert.match(successor.session.assignment.context!.prompt, /CHANGED_PROJECT_INTRO_840/);
});

test('Git Experiments keep the scratch program version and wait for their exact late final capture before independent review', async (t) => {
  const f = await fixture(t);
  const oldInput = {
    name: 'legacy-workspace-input',
    intent: 'Preserve prior create normalization.',
    requestId: f.request(),
  };
  const old = await f.experiments.create(f.source, oldInput);
  const oldPolicy = await f.workflows.execution(f.source, {
    instanceId: old.id,
    expectedRevision: 0,
  });
  assert.equal(old.workflow.version, 5);
  assert.equal(Object.hasOwn(old, 'workspace'), false);
  assert.deepEqual(oldPolicy.policy.workspace, { mode: 'none' });
  const experiment = await f.create([], 'git');
  assert.equal(experiment.workflow.version, 6);
  assert.equal(experiment.workspace, 'git');
  const pendingDesign = (await f.design(experiment)).experiment;
  assert.deepEqual(
    (await f.workflows.execution(f.reviewer, { instanceId: experiment.id, expectedRevision: 1 }))
      .policy.workspace,
    { mode: 'none' },
  );
  const running = await f.verdict(pendingDesign, 'pass');
  const offered = await f.offer(running);
  assert.deepEqual(offered.session.execution.policy.workspace, {
    mode: 'persistent',
    namespace: 'experiments',
    base: 'central',
    perBase: false,
    retain: true,
    advancesCentral: false,
  });
  const attachment = {
    repositoryId: 'test-runner-private-repository',
    workspaceId: 'test-owned-workspace',
    mode: 'persistent' as const,
    branch: 'codex/merv/experiment',
    baseOid: 'a'.repeat(40),
    headOid: 'a'.repeat(40),
    treeOid: 'b'.repeat(40),
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  const control = {
    sessionId: offered.session.id,
    runnerId: 'assignment-test',
    hostRef: 'owned-test-launch',
  };
  await f.sessions.attach(f.source, { ...control, workspace: attachment });
  const worker = await f.sessions.authenticate(offered.secret);
  for (const [role, content] of [
    ['result', 'The independently retained observation.'],
    ['report', report],
  ] as const) {
    const artifact = await f.run(
      worker,
      'artifact.create',
      { title: role, content, mediaType: 'text/markdown' },
      async (caller, input) =>
        await f.artifacts.create(
          caller,
          input as unknown as { title: string; content: string; mediaType: string },
        ),
    );
    f.run(
      worker,
      'experiment.attach',
      {
        artifactId: artifact.id,
        role,
        path: `${role}.md`,
        attemptIndex: 1,
        ...(role === 'result' ? { resultFormat: 'qualitative' } : {}),
        requestId: f.request(),
      },
      async (caller, input) =>
        await f.experiments.attach(caller, input as unknown as ExperimentAttach),
    );
  }
  const pending = await f.run(
    worker,
    'experiment.transition',
    { transition: 'submit_results', requestId: f.request() },
    async (caller, input) =>
      await f.experiments.transition(caller, input as unknown as ExperimentTransition),
  );
  assert.equal(pending.workflow.state, 'experiment_review');
  const submission = pending.submissions.find((entry) => entry.stage === 'results')!;
  const ref = { kind: 'session-final' as const, sessionId: offered.session.id };
  assert.deepEqual(submission.codeCaptureRef, ref);
  assert.equal(submission.producerId, worker.actorId);
  assert.equal(submission.subjectRevision - 1, offered.session.expectedRevision);
  assert.equal((await f.code.capture(f.source, ref)).status, 'pending');
  await f.reload();
  assert.deepEqual(
    await f.experiments.create(f.source, oldInput),
    old,
    'Legacy semantic replay has not acquired a new default field',
  );
  assert.equal(
    (await f.workflows.execution(f.source, { instanceId: old.id, expectedRevision: 0 })).policyHash,
    oldPolicy.policyHash,
  );
  const noBytes = t.mock.method(f.artifacts, 'read', () => {
    assert.fail('Capture/candidate metadata must not render evidence');
  });
  const beforeHead = await f.state.eventHead();
  assert.equal(
    (await f.workflows.dispatchCandidates(f.source)).some(
      (candidate) => candidate.instanceId === pending.id,
    ),
    false,
  );
  await assert.rejects(
    async () =>
      await f.workflows.leaseRole(f.source, {
        instanceId: pending.id,
        expectedRevision: pending.workflow.revision,
      }),
    { code: 'experiment_capture_pending' },
  );
  assert.equal((await f.code.capture(f.source, ref)).status, 'pending');
  assert.equal(
    await f.state.eventHead(),
    beforeHead,
    'Reads never reconcile or mutate a closed session',
  );
  noBytes.mock.restore();
  await f.release(offered.session.id);
  const final = {
    ...attachment,
    headOid: 'c'.repeat(40),
    treeOid: 'd'.repeat(40),
    stats: { commitCount: 1, filesChanged: 2, insertions: 4, deletions: 1 },
  };
  await f.sessions.workspaceResult(f.source, { ...control, workspace: final });
  await f.sessions.workspaceResult(f.source, { ...control, workspace: final });
  const capture = await f.code.capture(f.reviewer, ref);
  assert.equal(capture.status, 'ready');
  assert.deepEqual(capture.workspace, final);
  assert.equal(capture.provenance.actorId, worker.actorId);
  assert.equal(
    capture.provenance.workflow.registrationId,
    offered.session.execution.registrationId,
  );
  assert.equal(capture.provenance.revision, running.workflow.revision);
  assert.equal(
    (await f.state.events(f.source.projectId)).filter(
      (event) => event.type === 'session.workspace_result',
    ).length,
    1,
  );
  assert.ok(
    (await f.workflows.dispatchCandidates(f.source)).some(
      (candidate) => candidate.instanceId === pending.id,
    ),
  );
  const reviewOffer = await f.offer(pending);
  assert.equal(reviewOffer.session.execution.references.code, final.headOid);
  assert.deepEqual(reviewOffer.session.execution.policy.workspace, {
    mode: 'ephemeral',
    namespace: 'experiment-reviews',
    base: 'reference:code',
    retain: false,
  });
  assert.match(reviewOffer.session.assignment.context!.prompt, new RegExp(final.headOid));
  assert.match(reviewOffer.session.assignment.context!.prompt, new RegExp(final.treeOid));
  const reviewWorkspace = {
    ...final,
    workspaceId: 'review-checkout',
    mode: 'ephemeral' as const,
    branch: null,
    baseOid: final.headOid,
  };
  const reviewControl = {
    sessionId: reviewOffer.session.id,
    runnerId: 'assignment-test',
    hostRef: 'owned-review-launch',
  };
  await assert.rejects(
    async () =>
      await f.sessions.attach(f.source, {
        ...reviewControl,
        workspace: { ...reviewWorkspace, baseOid: attachment.baseOid },
      }),
    { code: 'workspace_base_conflict' },
  );
  await f.sessions.attach(f.source, { ...reviewControl, workspace: reviewWorkspace });
  const reviewer = await f.sessions.authenticate(reviewOffer.secret);
  const review = await f.reviews.get(reviewer, pending.reviewId!);
  const done = await f.run(
    reviewer,
    'review.submit',
    {
      ...reviewedFindings(review),
      verdict: 'pass',
      notes: 'Verified the exact final code capture and retained evidence.',
      requestId: f.request(),
    } as Data,
    async (caller, input) =>
      await f.experiments.submitReview(caller, input as unknown as ReviewApplication),
  );
  assert.equal(done.workflow.state, 'complete');
  assert.equal(
    done.submissions.find((entry) => entry.id === submission.id)!.manifestHash,
    submission.manifestHash,
  );
  await f.release(reviewOffer.session.id);
  await f.sessions.workspaceResult(f.source, { ...reviewControl, workspace: reviewWorkspace });
  assert.deepEqual(
    await f.code.capture(f.source, ref),
    capture,
    'A later reviewer capture cannot overwrite the exact producer observation',
  );
});

test('historical observations stay project-scoped and pure after source revocation', async (t) => {
  const f = await fixture(t);
  const ordinary = await f.offer(await f.create());
  const ref = { kind: 'session-final' as const, sessionId: ordinary.session.id };
  assert.equal((await f.code.capture(f.source, ref)).status, 'none');
  const other = await f.scope.bootstrap({
    projectName: 'Unrelated project',
    actorName: 'Other operator',
  });
  const foreign = {
    actorId: other.actor.id,
    projectId: other.project.id,
    credentialId: other.credential.id,
  };
  await assert.rejects(async () => await f.code.capture(foreign, ref), {
    code: 'session_not_found',
  });
  let getters = 0;
  await assert.rejects(
    async () =>
      await f.code.capture(f.source, {
        kind: 'session-final',
        get sessionId() {
          getters++;
          return ordinary.session.id;
        },
      }),
    { code: 'invalid_code_input' },
  );
  assert.equal(getters, 0);
  const operator = await f.issue('operator');
  const before = await f.code.capture(f.reviewer, ref);
  await f.scope.revokeCredential(operator, f.source.credentialId!);
  await assert.rejects(async () => await f.code.capture(f.source, ref), { code: 'forbidden' });
  for (const method of ['get', 'list', 'describe'] as const)
    t.mock.method(f.sessions, method, () => {
      assert.fail('Historical reads must not reconcile or impersonate source authority');
    });
  const eventHead = await f.state.eventHead();
  const after = await f.code.capture(f.reviewer, ref);
  assert.deepEqual(after, before);
  assert.equal(await f.state.eventHead(), eventHead);
  assert.equal(Object.hasOwn(after, 'assignment'), false);
  assert.equal(Object.hasOwn(after, 'token'), false);
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ status: string }>(
          'SELECT status FROM worker_sessions WHERE id=?',
          ordinary.session.id,
        ),
    ))!.status,
    'offered',
  );
  after.provenance.actorId = 'mutated-return';
  assert.equal(
    (await f.code.capture(f.reviewer, ref)).provenance.actorId,
    ordinary.session.actorId,
  );
});

test('a continuing agent can acquire successive experiment leases without inheriting unpinned outputs', async (t) => {
  const f = await fixture(t),
    token = `ms_${randomBytes(32).toString('base64url')}`;
  const agent = await f.sessions.registerAgent(f.source, {
    name: 'Continuing researcher',
    runnerId: 'external',
    requestId: f.request(),
    secret: token,
  });
  const first = await f.create(),
    second = await f.create();
  const a = await f.sessions.assignAgent(token, {
    instanceId: first.id,
    expectedRevision: 0,
    requestId: f.request(),
  });
  const callerA = await f.sessions.authenticate(token);
  const artifact = await f.run(
    callerA,
    'artifact.create',
    { title: 'Private draft', content: plan },
    async (worker) => await f.artifacts.create(worker, { title: 'Private draft', content: plan }),
  );
  await f.sessions.releaseAgentAssignment(token, a.id);
  const b = await f.sessions.assignAgent(token, {
    instanceId: second.id,
    expectedRevision: 0,
    requestId: f.request(),
  });
  const callerB = await f.sessions.authenticate(token);
  assert.equal(b.actorId, agent.actorId);
  assert.equal(a.agentSessionId, b.agentSessionId);
  await assert.rejects(
    async () => await f.sessions.prepare(callerB, 'artifact.read', { artifactId: artifact.id }),
  );
  assert.equal(
    (
      await f.state.read(
        async (sql) =>
          await sql.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM experiment_leases WHERE actor_id=?',
            agent.actorId,
          ),
      )
    )?.n,
    2,
  );
});
