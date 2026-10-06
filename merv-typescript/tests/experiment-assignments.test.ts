import type { TaskDelivery } from '@merv/tasks/types';
import { CodeService as CoreCodeService } from '@merv/code/service';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { git } from './fixtures/code-store.js';
import { nativeWorkFixture } from './fixtures/native-work.js';
import { createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import type { Artifact, Caller, Data, ReviewApplication } from '@merv/contracts';
import type { ReviewHistory } from '@merv/reviews/rules';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { TaskService } from '@merv/tasks';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { ExperimentService } from '@merv/experiments';
import { captureEpochs } from '@merv/experiments/program';
import { CodeService } from '@merv/code-work/service';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentEvidence,
  ExperimentTransition,
} from '@merv/experiments/types';
import { feasibilityStatement } from './feasibility-fixture.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { openState } from './fixtures/state.js';
import { blankPaper } from './fixtures/blank-paper.js';

const plan =
  '# Summary\nCompare two methods.\n# Objective & hypothesis\nA improves held-out accuracy.\n# Evaluation\nUse the same held-out examples, baseline, metric and denominator.\n';
const report =
  '# Summary\nThe qualitative result is retained.\n# Results\nThe control and intervention behaved alike.\n# Deviations from plan\nNone.\n# Conclusion\nThe observation does not support an improvement.\n';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-experiment-program-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const blobs = new DiskBlobs(join(directory, 'blobs'));
  const artifacts = await createService(new ArtifactStore(state, scope, blobs));
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      sweepIntervalMs: 60_000,
    }),
  );
  const core = await createService(
    new CoreCodeService(state, scope, {
      repositories: {
        root: join(directory, 'code'),
        quotaBytes: 10 * 1024 ** 3,
        reservedFreeBytes: 1,
      },
    }),
  );
  const code = await createService(new CodeService(state, scope, sessions, workflows, core));
  const tasks = await createService(
    new TaskService(state, scope, artifacts, workflows, reviews, builder, code, blankPaper),
  );
  const boot = await scope.credentials.bootstrap({
    projectName: 'Experiment assignments',
    actorName: 'Owner',
  });
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
      code,
      await createService(new PaperService(state, scope, artifacts)),
    ),
  );
  let sequence = 0;
  const request = () => `request-${++sequence}`;
  const issue = async (role: 'operator' | 'producer' | 'reviewer' | 'reader'): Promise<Caller> => {
    const issued = await scope.credentials.issueActor(source, { name: role, role });
    if (role === 'operator')
      await sessions.dispatch.heartbeatRunner(
        {
          projectId: source.projectId,
          actorId: issued.actor.id,
          credentialId: issued.credential.id,
        },
        {
          runnerId: 'assignment-test',
          machine: { hostname: 'test', system: process.platform, architecture: process.arch },
          platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 1 }],
          capacity: 4,
          capabilities: ['code.v2'],
        },
      );
    return {
      projectId: source.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    };
  };
  const reviewer = await issue('reviewer');
  await state.transaction((tx) => code.ensureRepository(source, tx));
  await (code as any).store.maintain();
  const work = currentWork({ sessions, code, events }, { directory, source });
  const held = new Map<string, Awaited<ReturnType<typeof work.attach>>>();
  const create = async (dependsOn: string[] = [], workspace?: 'git') =>
    experiments.create(source, {
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
  ) => {
    if (action === 'submit_results') {
      const current = await experiments.get(caller, experiment.id);
      const lease = await work.lease(current, caller);
      for (const evidence of current.evidence.filter(
        (entry) =>
          entry.current &&
          entry.attemptIndex === current.attempt.index &&
          ['result', 'report'].includes(entry.role),
      )) {
        let artifactId = evidence.artifactId;
        if (evidence.role === 'report') {
          const body = await artifacts.read(caller, artifactId);
          artifactId = (
            await work.run(
              lease,
              'artifact.create',
              { title: 'Successor report', content: body.content, mediaType: 'text/markdown' },
              (worker, input) => artifacts.create(worker, input as any),
            )
          ).id;
        }
        await work.run(
          lease,
          'experiment.attach',
          {
            artifactId,
            role: evidence.role,
            path: evidence.path,
            attemptIndex: current.attempt.index,
            requestId: request(),
            ...(evidence.resultFormat ? { resultFormat: evidence.resultFormat } : {}),
          },
          (worker, input) => experiments.attach(worker, input as unknown as ExperimentAttach),
        );
      }
      const next = await work.run(
        lease,
        'experiment.transition',
        { transition: action, requestId: request() },
        (worker, input) => experiments.transition(worker, input as unknown as ExperimentTransition),
      );
      await work.release(lease);
      return next;
    }
    return await experiments.transition(caller, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition: action,
      requestId: request(),
      ...(['retry_running', 'mark_failed', 'abandon'].includes(action)
        ? { evidence: { reason: 'Controlled fixture recovery' } }
        : {}),
    });
  };
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
    const lease = await work.lease(experiment);
    for (const [role, content] of [
      ['result', 'The retained observations show no difference.'],
      ['report', report],
    ] as const) {
      const artifact = await work.run(
        lease,
        'artifact.create',
        { title: role, content, mediaType: 'text/markdown' },
        (caller, input) => artifacts.create(caller, input as any),
      );
      await work.run(
        lease,
        'experiment.attach',
        {
          artifactId: artifact.id,
          role,
          path: `${role}.md`,
          attemptIndex: experiment.attempt.index,
          requestId: request(),
          ...(role === 'result' ? { resultFormat: 'qualitative' } : {}),
        },
        (caller, input) => experiments.attach(caller, input as unknown as ExperimentAttach),
      );
    }
    const next = await work.run(
      lease,
      'experiment.transition',
      { transition: 'submit_results', requestId: request() },
      (caller, input) => experiments.transition(caller, input as unknown as ExperimentTransition),
    );
    await work.release(lease);
    return next;
  };
  const heartbeat = (caller: Caller) =>
    sessions.dispatch.heartbeatRunner(caller, {
      runnerId: 'assignment-test',
      machine: { hostname: 'test', system: process.platform, architecture: process.arch },
      platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 1 }],
      capacity: 4,
      capabilities: ['code.v2'],
    });
  await heartbeat(source);
  const offer = async (experiment: Experiment, caller = source) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(caller, {
      instanceId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      runnerId: 'assignment-test',
      requestId: request(),
      secret,
    });
    if (experiment.workflow.state === 'running') {
      const attached = await work.attach(session, caller);
      attached.worker = await sessions.authenticate(secret);
      held.set(session.id, attached);
    }
    return { secret, session };
  };
  const run = async <T>(
    caller: Caller,
    tool: string,
    input: Data,
    handler: (worker: Caller, bound: Data) => T | Promise<T>,
  ) => sessions.invocations.run(await sessions.invocations.prepare(caller, tool, input), handler);
  const release = async (sessionId: string, caller = source) => {
    if (held.has(sessionId)) {
      await work.release(held.get(sessionId)!);
      held.delete(sessionId);
    } else await sessions.release(caller, { sessionId, runnerId: 'assignment-test' });
    await events.drain();
  };
  t.after(async () => {
    await work.close();
    experiments.close();
    await code.close();
    await core.close();
    await sessions.close();
    tasks.dispose();
    await events.close();
    reviews.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    work,
    state,
    scope,
    artifacts,
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
          code,
          await createService(new PaperService(state, scope, artifacts)),
        ),
      );
    },
  };
}
test('all four real assignments use distinct recipes; planning and execution wait for prerequisites', async (t) => {
  const f = await fixture(t);
  const prerequisite = await currentTask(f, f.source, {
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
  const prerequisiteWork = await f.work.lease(prerequisite);
  const proof = await f.artifacts.create(prerequisiteWork.worker, {
    title: 'Prerequisite result',
    content: 'Result is present.',
  });
  const commandId = await f.work.commit(prerequisiteWork);
  const delivery = await f.work.run(
    prerequisiteWork,
    'task.submit_delivery',
    confirmedDelivery({ artifactIds: [proof.id], commandId, requestId: f.request() }),
    (caller, input) => f.tasks.submitDelivery(caller, input as unknown as TaskDelivery),
  );
  await f.work.release(prerequisiteWork);
  const taskReviewer = await f.work.lease(delivery, await f.issue('operator'));
  const review = await f.reviews.get(taskReviewer.worker, delivery.reviewId!);
  await f.work.run(
    taskReviewer,
    'review.submit',
    {
      ...reviewedFindings(review),
      verdict: 'pass',
      notes: 'Verified the retained prerequisite result.',
      requestId: f.request(),
    },
    (caller, input) => f.tasks.submitReview(caller, input as unknown as ReviewApplication),
  );
  await f.work.release(taskReviewer);
  const planned = await f.workflows.assignment(f.source, experiment.id);
  assert.equal(planned.context!.type, 'experiment.design');
  assert.equal(planned.execution.readOnly, false);
  assert.match(planned.brief, /native Sandboxes MCP/);
  assert.match(planned.brief, /brief verification only/);
  assert.match(planned.brief, /Plan batching, multiple GPUs or concurrent independent jobs/);
  assert.match(planned.brief, /reviewers must independently verify pivotal claims/);
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
    !(await f.workflows.dispatchCandidates(f.source)).some(
      (candidate) => candidate.instanceId === experiment.id,
    ),
    'The source never directs the review of a design it submitted itself',
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

test('an experiment assignment refuses a reader and the other role', async (t) => {
  // Context Builder only checks that the caller may read the project; the program's own
  // producer and reviewer checks are what refuse these callers.
  const f = await fixture(t);
  const [reader, producer] = [await f.issue('reader'), await f.issue('producer')];
  const planned = await f.create();
  for (const caller of [reader, f.reviewer])
    await assert.rejects(async () => await f.workflows.assignment(caller, planned.id), {
      code: 'forbidden',
    });
  const pending = (await f.design()).experiment;
  for (const caller of [reader, producer])
    await assert.rejects(async () => await f.workflows.assignment(caller, pending.id), {
      code: 'forbidden',
    });
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
  const context = packet.context!;
  assert.equal(context.type, 'experiment.attempt_review');
  assert.ok(context.prompt.length <= 160_000);
  // What fits is embedded whole; every other result keeps one line naming how to read it.
  assert.match(context.prompt, /row,value/);
  const listed = context.omitted.filter((id) => id.startsWith('artifact:'));
  assert.ok(listed.length > 0);
  for (const id of listed)
    assert.ok(
      context.prompt.includes(`\n- ${id} — result (artifact ${id.slice('artifact:'.length)}, `),
    );
});

test('a figure in the evidence is listed on a live render and its bytes are never read', async (t) => {
  const f = await fixture(t);
  const running = await f.verdict((await f.design(await f.create())).experiment, 'pass');
  await f.workflows.begin(f.source, {
    instanceId: running.id,
    expectedRevision: running.workflow.revision,
  });
  const figure = await f.artifacts.create(f.source, {
    title: 'Retained comparison',
    mediaType: 'image/png',
    encoding: 'base64',
    content:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  });
  await f.attach(running, 'result', 'Observed alike.', f.source, 'result.md');
  await f.attach(running, 'report', `${report}\n![Retained comparison](${figure.id})\n`);
  const assessment = await f.transition(running, 'submit_results');
  const read = f.artifacts.read.bind(f.artifacts);
  const reads: string[] = [];
  t.mock.method(f.artifacts, 'read', async (...args: Parameters<typeof f.artifacts.read>) => {
    reads.push(args[1]);
    return await read(...args);
  });
  const context = (await f.workflows.assignment(f.reviewer, assessment.id)).context!;
  assert.ok(reads.length > 0, 'the report itself is read');
  assert.ok(!reads.includes(figure.id));
  assert.ok(
    context.prompt.includes(
      `\n- artifact:${figure.id} — Retained comparison (artifact ${figure.id}, image/png, `,
    ),
  );
  assert.ok(context.sources.some((source) => source.id === figure.id));
});

test('results review keeps JSON observations inline and lists the generated exhibit without reading it', async (t) => {
  const f = await fixture(t);
  const running = await f.verdict((await f.design(await f.create())).experiment, 'pass');
  await f.workflows.begin(f.source, {
    instanceId: running.id,
    expectedRevision: running.workflow.revision,
  });
  const content = '{"seed":20,"coverage":0.9,"width":0.47}';
  const result = await f.artifacts.create(f.source, {
    title: 'Development summary',
    content,
    mediaType: 'application/json',
  });
  await f.experiments.attach(f.source, {
    experimentId: running.id,
    expectedRevision: running.workflow.revision,
    attemptIndex: running.attempt.index,
    artifactId: result.id,
    role: 'result',
    path: 'dev-summary.json',
    resultFormat: 'json',
    requestId: f.request(),
  });
  await f.attach(running, 'report', `${report}\nThe metrics_exhibit.json pins the summary.\n`);
  const assessment = await f.transition(running, 'submit_results');
  const packet = await f.workflows.assignment(f.reviewer, assessment.id);
  const exhibit = assessment.evidence.find((item) => item.role === 'exhibit')!;
  const exhibitRead = await f.artifacts.read(f.reviewer, exhibit.artifactId);
  assert.equal(packet.context!.typeVersion, 12);
  assert.match(packet.context!.prompt, /"coverage":0\.9/);
  assert.match(packet.context!.prompt, /## Metrics exhibit \(read the retained artifact/);
  assert.ok(
    packet.context!.prompt.includes(
      `\n- artifact:${exhibit.artifactId} — Metrics exhibit: ${running.name} (artifact ${exhibit.artifactId}, application/json, `,
    ),
  );
  assert.ok(
    packet.context!.prompt.includes(
      // experiment.exhibit answers only while the experiment runs; the review reads the artifact.
      `retrieve: artifact.read {"artifactId":"${exhibit.artifactId}"}\n`,
    ),
  );
  assert.doesNotMatch(packet.context!.prompt, /"resultFiles":/);
  assert.ok(packet.context!.sources.some((artifact) => artifact.id === exhibit.artifactId));
  assert.equal(JSON.parse(exhibitRead.content).resultFiles[0].data.coverage, 0.9);
});

test('dispatch and activation read metadata only; fixed grants do not depend on complete draft evidence', async (t) => {
  const f = await fixture(t);
  const experiment = await f.create();
  await f.attach(experiment, 'plan', 'INCOMPLETE_DRAFT_KEEP_WORKING');
  assert.ok(
    (await f.workflows.dispatchCandidates(f.source)).some(
      (candidate) => candidate.instanceId === experiment.id,
    ),
  );
  const offered = await f.offer(experiment);
  assert.match(offered.session.assignment.context!.prompt, /INCOMPLETE_DRAFT_KEEP_WORKING/);
  assert.equal(offered.session.assignment.workStart, null);
  t.mock.method(f.artifacts, 'bytes', () => {
    assert.fail('Activation and admission must not read artifact bytes');
  });
  const worker = await f.sessions.authenticate(offered.secret);
  assert.deepEqual(await f.sessions.authenticate(offered.secret), worker);
  assert.equal((await f.workflows.workStarts(f.source, experiment.id)).length, 1);
  assert.equal(
    (await f.experiments.get(f.source, experiment.id)).attempt.startedAt,
    null,
    'Planning activation is not execution',
  );
  t.mock.method(f.workflows, 'evaluate', () => {
    assert.fail('Metadata admission must not evaluate exit guidance');
  });
  assert.equal(
    (
      await f.sessions.invocations.prepare(worker, 'experiment.transition', {
        transition: 'submit_design',
      })
    ).input.expectedRevision,
    0,
  );
  await assert.rejects(
    async () =>
      await f.sessions.invocations.prepare(worker, 'experiment.transition', {
        transition: 'submit_results',
      }),
    { code: 'execution_arguments_forbidden' },
  );
  await assert.rejects(
    async () => await f.sessions.invocations.prepare(worker, 'workflow.begin', {}),
    {
      code: 'execution_tool_forbidden',
    },
  );
});

test('project evidence can be saved without an experiment worker, while a lease fences association', async (t) => {
  const f = await fixture(t);
  const experiment = await f.create();
  const artifact = await f.artifacts.create(f.source, {
    title: 'Independent observation',
    content: plan,
  });
  assert.equal(artifact.createdBy, f.source.actorId);
  assert.deepEqual((await f.experiments.get(f.source, experiment.id)).evidence, []);

  const association = await f.experiments.attach(f.source, {
    experimentId: experiment.id,
    expectedRevision: experiment.workflow.revision,
    attemptIndex: experiment.attempt.index,
    artifactId: artifact.id,
    role: 'plan',
    path: 'observation.md',
    requestId: f.request(),
  });
  assert.equal(association.artifactId, artifact.id);
  assert.equal(association.sessionId, null);

  await f.offer(experiment);
  const later = await f.artifacts.create(f.source, {
    title: 'Later independent observation',
    content: plan + '\nLater observation.\n',
  });
  assert.equal(later.createdBy, f.source.actorId);
  await assert.rejects(
    () =>
      f.experiments.attach(f.source, {
        experimentId: experiment.id,
        expectedRevision: experiment.workflow.revision,
        attemptIndex: experiment.attempt.index,
        artifactId: later.id,
        role: 'plan',
        path: 'later.md',
        requestId: f.request(),
      }),
    { code: 'experiment_leased' },
  );
  assert.deepEqual(
    (await f.experiments.get(f.source, experiment.id)).evidence.map(
      (evidence) => evidence.artifactId,
    ),
    [artifact.id],
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
    async () =>
      await f.sessions.invocations.prepare(worker, 'artifact.read', { artifactId: foreign.id }),
    {
      code: 'execution_arguments_forbidden',
    },
  );
  await assert.rejects(
    async () =>
      await f.sessions.invocations.prepare(worker, 'experiment.attach', {
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
  const noForeignReads = t.mock.method(f.artifacts, 'bytes');
  await assert.rejects(
    async () =>
      await f.sessions.invocations.prepare(worker, 'artifact.read', { artifactId: lateReport.id }),
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
    (await f.sessions.invocations.prepare(worker, 'artifact.read', { artifactId: own.id })).input
      .artifactId,
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

test('review leases claim before freezing, recover exactly once, and claim as the worker, not its source', async (t) => {
  const f = await fixture(t);
  const pending = (await f.design()).experiment;
  const lead = await f.issue('operator');
  const offered = await f.offer(pending, lead);
  const worker = await f.sessions.authenticate(offered.secret);
  const claimed = await f.reviews.get(worker, pending.reviewId!);
  assert.equal(offered.session.execution.references.claimId, claimed.claimId);
  assert.equal(claimed.reviewerId, worker.actorId);
  assert.equal(claimed.producerId, f.source.actorId);
  assert.notEqual(worker.actorId, lead.actorId);
  assert.match(offered.session.assignment.context!.prompt, new RegExp(claimed.claimId!));
  await assert.rejects(
    async () =>
      await f.sessions.invocations.prepare(worker, 'artifact.create', {
        title: 'Forbidden',
        content: 'No',
      }),
    { code: 'execution_tool_forbidden' },
  );
  await f.release(offered.session.id, lead);
  const released = await f.reviews.get(f.source, pending.reviewId!);
  assert.equal(released.status, 'requested');
  assert.equal(released.snapshotHash, claimed.snapshotHash);
  const next = await f.offer(pending, lead);
  const replacement = await f.sessions.authenticate(next.secret);
  const current = await f.reviews.get(replacement, pending.reviewId!);
  assert.notEqual(current.claimId, claimed.claimId);
  assert.match(next.session.assignment.context!.prompt, /previousClaimId/);
  await f.workflows.releaseLease(offered.session.lease, { reason: 'Repeated stale cleanup' });
  assert.equal((await f.reviews.get(replacement, pending.reviewId!)).claimId, current.claimId);
  await assert.rejects(
    async () =>
      await f.sessions.invocations.prepare(replacement, 'review.submit', {
        claimId: claimed.claimId!,
      }),
    { code: 'execution_arguments_forbidden' },
  );
});

test('context failure rolls back worker reservation and review claim; reload preserves only durable lease authority', async (t) => {
  const f = await fixture(t);
  const pending = (await f.design()).experiment;
  const lead = await f.issue('operator');
  const before = await f.state.read(async (sql) => ({
    actors: await sql.all('SELECT id FROM actors'),
    leases: await sql.all('SELECT id FROM wf_leases'),
    head: await f.state.eventHead(),
  }));
  const read = t.mock.method(f.artifacts, 'read', () => {
    throw new Error('Injected recipe read failure');
  });
  await assert.rejects(async () => await f.offer(pending, lead), /Injected recipe read failure/);
  assert.deepEqual(
    await f.state.read(async (sql) => ({
      actors: await sql.all('SELECT id FROM actors'),
      leases: await sql.all('SELECT id FROM wf_leases'),
      head: await f.state.eventHead(),
    })),
    before,
  );
  assert.equal((await f.reviews.get(f.source, pending.reviewId!)).status, 'requested');
  read.mock.restore();
  const offered = await f.offer(pending, lead);
  const worker = await f.sessions.authenticate(offered.secret);
  const stale = await f.sessions.invocations.prepare(worker, 'experiment.get_state', {});
  const generation = offered.session.execution.registrationId;
  await f.reload();
  const again = await f.sessions.authenticate(offered.secret);
  assert.equal(again.actorId, worker.actorId);
  assert.equal((await f.workflows.workStarts(f.source, pending.id)).length, 1);
  const current = await f.workflows.checkLease(again, offered.session.lease);
  assert.notEqual(current.registrationId, generation);
  await assert.rejects(
    async () =>
      f.sessions.invocations.run(
        stale,
        async (caller) => await f.experiments.get(caller, pending.id),
      ),
    { code: 'execution_replaced' },
  );
  await f.release(offered.session.id, lead);
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
  const [reviewSource, replacementSource] = [await f.issue('operator'), await f.issue('operator')];
  const pending = (await f.design()).experiment;
  const offered = await f.offer(pending, reviewSource);
  const worker = await f.sessions.authenticate(offered.secret);
  const claim = await f.reviews.get(worker, pending.reviewId!);
  await f.scope.credentials.revokeActor(replacementSource, reviewSource.actorId);
  await assert.rejects(
    async () => await f.sessions.invocations.prepare(worker, 'review.submit', {}),
    {
      code: 'forbidden',
    },
  );
  await f.sessions.sweep();
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
  const leased = await f.offer(experiment);
  const references = leased.session.execution.references;
  assert.ok(rejected.every((id) => (references.reviews as string[]).includes(id)));
  await f.release(leased.session.id);
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
      (await f.sessions.invocations.prepare(worker, 'review.get', { reviewId: review.id })).input
        .reviewId,
      review.id,
    );
    if (destination === 'planned') {
      const recovery = await f.state.read(
        async (sql) =>
          JSON.parse(
            (await sql.get<{ details: string }>(
              'SELECT details FROM wf_leases WHERE id=?',
              offered.session.id,
            ))!.details,
          ).recovery,
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

test('a returned execution references prior result bodies while retaining the pinned approved plan', async (t) => {
  const f = await fixture(t);
  const running = await f.running();
  await f.workflows.begin(f.source, {
    instanceId: running.id,
    expectedRevision: running.workflow.revision,
  });
  const oldBody = 'PRIOR_ROUND_RESULT_BODY_73982 '.repeat(1200);
  const prior = await f.attach(running, 'result', oldBody);
  await f.attach(running, 'report', report);
  const pending = await f.transition(running, 'submit_results');
  // The current reviewer still receives the exact selected submission.
  assert.match(
    (await f.workflows.assignment(f.reviewer, pending.id)).context!.prompt,
    /PRIOR_ROUND_RESULT_BODY_73982/,
  );
  const returned = await f.verdict(pending, 'needs_changes', 'running');
  const offer = await f.offer(returned);
  const prompt = offer.session.assignment.context!.prompt;
  assert.doesNotMatch(prompt, /PRIOR_ROUND_RESULT_BODY_73982/);
  assert.match(prompt, /Compare two methods/);
  assert.match(prompt, new RegExp(prior.artifact.id));
  assert.match(prompt, new RegExp(prior.artifact.hash));
  assert.ok(
    offer.session.assignment.references.some(
      (reference) => reference.kind === 'artifact' && reference.id === prior.artifact.id,
    ),
  );
  assert.ok((offer.session.execution.references.artifacts as string[]).includes(prior.artifact.id));
  const worker = await f.sessions.authenticate(offer.secret);
  assert.equal(
    (
      await f.sessions.invocations.prepare(worker, 'artifact.read', {
        artifactId: prior.artifact.id,
      })
    ).input.artifactId,
    prior.artifact.id,
  );
  assert.equal((await f.artifacts.read(worker, prior.artifact.id)).content, oldBody);
});

test('a new planning round and its next design review reference earlier plan bodies', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  const oldBody = `${plan}\n${'PRIOR_ROUND_PLAN_BODY_73982 '.repeat(1200)}`;
  const prior = await f.attach(first, 'plan', oldBody);
  const pending = await f.transition(first, 'submit_design');
  assert.match(
    (await f.workflows.assignment(f.reviewer, pending.id)).context!.prompt,
    /PRIOR_ROUND_PLAN_BODY_73982/,
  );
  const returned = await f.verdict(pending, 'needs_changes', 'planned');
  const offered = await f.offer(returned);
  assert.doesNotMatch(offered.session.assignment.context!.prompt, /PRIOR_ROUND_PLAN_BODY_73982/);
  assert.match(offered.session.assignment.context!.prompt, new RegExp(prior.artifact.id));
  assert.match(offered.session.assignment.context!.prompt, new RegExp(prior.artifact.hash));
  const worker = await f.sessions.authenticate(offered.secret);
  assert.doesNotMatch(
    (await f.workflows.assignment(worker, returned.id)).context!.prompt,
    /PRIOR_ROUND_PLAN_BODY_73982/,
  );
  assert.equal(
    (
      await f.sessions.invocations.prepare(worker, 'artifact.read', {
        artifactId: prior.artifact.id,
      })
    ).input.artifactId,
    prior.artifact.id,
  );
  await f.release(offered.session.id);
  await f.attach(returned, 'plan', `${plan}\nCURRENT_PLAN_4872`);
  const nextReview = await f.transition(returned, 'submit_design');
  const prompt = (await f.workflows.assignment(f.reviewer, nextReview.id)).context!.prompt;
  assert.match(prompt, /CURRENT_PLAN_4872/);
  assert.doesNotMatch(prompt, /PRIOR_ROUND_PLAN_BODY_73982/);
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
  await f.sessions.sweep();
  await f.events.drain();
  assert.equal(
    await f.state.read(
      async (sql) =>
        (await sql.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM wf_leases WHERE released_at IS NULL',
        ))!.count,
    ),
    0,
  );
});

test('a lease freezes the Problem, carried once, without changing the registered recipe', async (t) => {
  const f = await fixture(t);
  const paper = await createService(new PaperService(f.state, f.scope, f.artifacts));
  // Paper writes the Introduction from the Problem, so the Problem reaches the prompt once.
  const problem = async (content: string, expectedRevision: number) =>
    await paper.patch(f.source, {
      kind: 'problem',
      expectedRevision,
      requestId: f.request(),
      changes: [{ id: 'problem', content }],
    });
  await problem('ORIGINAL_PROJECT_INTRO_723', 0);
  const experiment = await f.create();
  const offered = await f.offer(experiment);
  const prompt = offered.session.assignment.context!.prompt;
  assert.equal(prompt.split('ORIGINAL_PROJECT_INTRO_723').length, 2);
  const worker = await f.sessions.authenticate(offered.secret);
  await problem('CHANGED_PROJECT_INTRO_840', 1);
  // A leased worker's paper is the one its lease froze: the current paper is not read.
  const reads = t.mock.method(PaperService.prototype, 'contextInput');
  const refreshed = await f.workflows.assignment(worker, experiment.id);
  assert.equal(reads.mock.callCount(), 0);
  reads.mock.restore();
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

test('historical observations stay project-scoped and pure after source revocation', async (t) => {
  const f = await fixture(t);
  const ordinary = await f.offer(await f.create());
  const ref = { kind: 'session-final' as const, sessionId: ordinary.session.id };
  assert.equal((await f.code.capture(f.source, ref)).status, 'none');
  const other = await f.scope.credentials.bootstrap({
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
  // Stop durable delivery before the revocation, so no consumer reacts to it concurrently with
  // the reads measured below.
  await f.events.close();
  await f.scope.credentials.revokeCredential(operator, f.source.credentialId!);
  await assert.rejects(async () => await f.code.capture(f.source, ref), { code: 'forbidden' });
  for (const method of ['get', 'list', 'session'] as const)
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

test('an assigned reviewer updates the paper through its scoped verdict only', async (t) => {
  const f = await fixture(t);
  const pending = (await f.design()).experiment;
  const lead = await f.issue('operator');
  const offered = await f.offer(pending, lead);
  const worker = await f.sessions.authenticate(offered.secret);
  const paper = await createService(new PaperService(f.state, f.scope, f.artifacts));
  assert.match(offered.session.assignment.context!.prompt, /You are responsible for updating/);
  await assert.rejects(
    f.sessions.invocations.prepare(worker, 'paper.patch', {
      kind: 'methods',
      expectedRevision: 0,
      requestId: 'direct-review-edit',
      changes: [{ id: pending.id, title: 'Method', content: 'Bypass the verdict' }],
    }),
    { code: 'execution_tool_forbidden' },
  );
  const review = await f.reviews.get(worker, pending.reviewId!);
  const edit = {
    documents: [
      {
        kind: 'methods',
        expectedRevision: 0,
        changes: [
          {
            id: pending.id,
            title: 'Comparison',
            content: 'Planned comparison; results pending.',
          },
        ],
      },
    ],
  };
  const completed = await f.run(
    worker,
    'review.submit',
    {
      ...reviewedFindings(review),
      verdict: 'pass',
      notes: 'Verified the evidence and updated Methods.',
      paperChanges: edit,
      requestId: f.request(),
    } as Data,
    (caller, input) => f.experiments.submitReview(caller, input as unknown as ReviewApplication),
  );
  assert.equal(completed.workflow.state, 'running');
  const document = (await paper.read(f.source)).documents.methods;
  assert.equal(document.current.updatedBy, worker.actorId);
  assert.equal(document.published?.publication.reviewId, review.id);
  assert.equal(document.current.sections[0].content, edit.documents[0].changes[0].content);
  await f.release(offered.session.id, lead);
});

test('Hosted experiments reject explicit legacy bases before creating work', async (t) => {
  const f = await fixture(t);
  const prerequisite = await currentTask(f, f.source, {
    title: 'Retained baseline',
    goal: 'Keep the baseline in Git',
    checks: ['Evidence retained'],
    requestId: f.request(),
  });
  const input = {
    name: 'hosted-follow-up',
    intent: 'Compare against retained evidence.',
    workspace: 'git' as const,
    dependsOn: [prerequisite.id],
    requestId: f.request(),
  };
  // The retired baseTaskId is no longer part of the create input.
  const legacy = { ...input, baseTaskId: prerequisite.id };
  await assert.rejects(f.experiments.create(f.source, legacy), {
    code: 'invalid_experiment_input',
  });
  const rows = await f.state.read((sql) =>
    sql.all('SELECT id FROM experiments WHERE project_id=?', f.source.projectId),
  );
  assert.equal(rows.length, 0);
  const created = await f.experiments.create(f.source, { ...input, requestId: f.request() });
  assert.equal(created.workflow.version, 36);
  assert.equal(created.workflow.data.baseTaskId, undefined);
});

test('every experiment lease admits verified captures and leaves compute to Sandboxes', async (t) => {
  const f = await fixture(t);
  const native = nativeWorkFixture();
  f.experiments.bindSandboxes(native.service);
  const experiment = await f.create();
  const first = await f.offer(experiment);
  // Sandboxes derives compute from the lease itself: the unit names no scope or profile.
  assert.equal(first.session.execution.references.sandboxConnectionId, undefined);
  assert.equal(first.session.execution.references.computeProfile, undefined);
  assert.equal(experiment.workflow.data.computeEpoch, '1:planned');
  assert.match(first.session.assignment.brief, /brief verification only/);
  assert.ok(!first.session.execution.policy.tools.some((tool) => tool.name.startsWith('compute.')));
  const worker = await f.sessions.authenticate(first.secret);
  const service = await f.scope.serviceActor('sandboxes', f.source.projectId);
  const capture = await f.artifacts.createCollection(service, {
    title: 'Capture',
    sourceKey: 'native-lease',
    files: [
      {
        name: 'checks/result.txt',
        size: 1,
        hash: 'a'.repeat(64),
        provider: 'sandboxes',
        reference: 'private',
      },
    ],
  });
  await assert.rejects(
    f.run(worker, 'artifact.get', { artifactId: capture.id }, (caller) =>
      f.artifacts.get(caller, capture.id),
    ),
    { code: 'execution_arguments_forbidden' },
  );
  native.verified.set(experiment.id, [capture.id]);
  assert.equal(
    (
      await f.run(worker, 'artifact.get', { artifactId: capture.id }, (caller) =>
        f.artifacts.get(caller, capture.id),
      )
    ).id,
    capture.id,
  );
  await f.release(first.session.id);
  const next = await f.offer(experiment);
  assert.equal(next.session.execution.references.sandboxConnectionId, undefined);
  assert.ok((next.session.execution.references.artifacts as string[]).includes(capture.id));
  await f.release(next.session.id);
});

test('a lease admits the captures of its own attempt only', async (t) => {
  const f = await fixture(t);
  const native = nativeWorkFixture();
  f.experiments.bindSandboxes(native.service);
  const experiment = await f.create();
  const first = await f.offer(experiment);
  const worker = await f.sessions.authenticate(first.secret);
  const service = await f.scope.serviceActor('sandboxes', f.source.projectId);
  const capture = async (sourceKey: string) =>
    await f.artifacts.createCollection(service, {
      title: sourceKey,
      sourceKey,
      files: [
        { name: 'r.txt', size: 1, hash: 'a'.repeat(64), provider: 'sandboxes', reference: 'x' },
      ],
    });
  const own = await capture('own-attempt');
  const other = await capture('other-attempt');
  native.verified.set(experiment.id, [own.id, other.id]);
  native.attempts.set(own.id, '1:planned');
  native.attempts.set(other.id, '2:planned');
  const get = (id: string) =>
    f.run(worker, 'artifact.get', { artifactId: id }, (caller) => f.artifacts.get(caller, id));
  assert.equal((await get(own.id)).id, own.id);
  await assert.rejects(get(other.id), { code: 'execution_arguments_forbidden' });
  await f.release(first.session.id);
});

test('work pinned before Experiments recorded an epoch keeps the revision epochs of its own attempt only', () => {
  // Sandboxes derived the epoch of such work from its revision, so each revision the attempt
  // passed through had its own; a move, which records an epoch from then on, loses none of
  // them, and no other attempt's revisions leak in.
  const second = { index: 2, startedRevision: 4, endedRevision: null };
  for (const data of [{}, { computeEpoch: '2:running' }] as Data[]) {
    const epochs = captureEpochs(second, { data, revision: 7 });
    for (const revision of ['4', '5', '7']) assert.ok(epochs.includes(revision));
    assert.ok(epochs.includes('2:running'));
    for (const other of ['1', '3', '8', '1:running']) assert.ok(!epochs.includes(other), other);
  }
  // An ended attempt keeps the revisions it ran through, and none after.
  const first = captureEpochs(
    { index: 1, startedRevision: 1, endedRevision: 3 },
    {
      data: { computeEpoch: '2:running' },
      revision: 7,
    },
  );
  assert.deepEqual(
    ['1', '2', '3', '4', '7'].filter((revision) => first.includes(revision)),
    ['1', '2', '3'],
  );
});

test('a context embeds only the newest interruptions, each clipped, and counts the earlier ones', async (t) => {
  const f = await fixture(t);
  let experiment = await f.running();
  for (let index = 0; index < 11; index++)
    experiment = await f.experiments.transition(f.source, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition: 'retry_running',
      requestId: `interruption-${index}`,
      evidence: { reason: `Interruption ${index}`, detail: 'd'.repeat(16000) },
    });
  assert.equal(experiment.attempt.feedback.length, 11);
  const prompt = (await f.workflows.assignment(f.source, experiment.id)).context!.prompt;
  const feedback = JSON.parse(
    prompt.slice(prompt.indexOf('{"interruptions":')).split('\n')[0]!,
  ) as { interruptions: string[]; earlierInterruptions: number };
  assert.equal(feedback.earlierInterruptions, 6);
  assert.deepEqual(
    feedback.interruptions.map((note) => note.slice(0, 38)),
    [6, 7, 8, 9, 10].map((index) => `Infrastructure recovery: Interruption ${index}`.slice(0, 38)),
  );
  assert.ok(feedback.interruptions.every((note) => note.length <= 2000));
  assert.ok(!prompt.includes('Interruption 5.'), 'older notes stay with experiment.get_state');
});

test('a results review whose final capture never landed takes the last admitted commit once its writer is fenced', async (t) => {
  const f = await fixture(t);
  const experiment = await f.running();
  const lease = await f.work.lease(experiment);
  await f.work.commit(lease, { 'result.txt': 'retained\n' });
  for (const [role, content] of [
    ['result', 'The retained observations show no difference.'],
    ['report', report],
  ] as const) {
    const artifact = await f.work.run(
      lease,
      'artifact.create',
      { title: role, content, mediaType: 'text/markdown' },
      (caller, input) => f.artifacts.create(caller, input as never),
    );
    await f.work.run(
      lease,
      'experiment.attach',
      {
        artifactId: artifact.id,
        role,
        path: `${role}.md`,
        attemptIndex: experiment.attempt.index,
        requestId: f.request(),
        ...(role === 'result' ? { resultFormat: 'qualitative' } : {}),
      },
      (caller, input) => f.experiments.attach(caller, input as never),
    );
  }
  const pending = await f.work.run(
    lease,
    'experiment.transition',
    { transition: 'submit_results', requestId: f.request() },
    (caller, input) => f.experiments.transition(caller, input as never),
  );
  // The machine dies after the submission: it never hands over its final capture.
  t.mock.method(lease.driver, 'capture', async () => null);
  t.mock.method(lease.driver, 'close', async () => {});
  await f.work.release(lease);
  await assert.rejects(f.workflows.assignment(f.reviewer, pending.id), {
    code: 'experiment_capture_pending',
  });
  const principal = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://issuer.example.test',
    subject: 'operator',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  await f.scope.members.adoptProject(principal, f.source.projectId);
  const human = await f.scope.caller(principal, f.source.projectId);
  await f.code.fenceUnit(human, { unitId: pending.id, requestId: f.request() });
  const unit = await f.code.unit(f.source, pending.id);
  assert.equal(unit.writerState, 'closed');
  assert.ok(unit.canonicalHead);
  const offered = await f.offer(pending, await f.issue('operator'));
  assert.equal(offered.session.execution.references.code, unit.canonicalHead);
  assert.ok(
    offered.session.assignment.context!.prompt.includes(`"headOid":"${unit.canonicalHead}"`),
  );
  // The pass accepts exactly that admitted commit.
  const worker = await f.sessions.authenticate(offered.secret);
  const review = await f.reviews.get(worker, pending.reviewId!);
  const done = await f.run(
    worker,
    'review.submit',
    {
      ...reviewedFindings(review),
      verdict: 'pass',
      notes: 'Verified the retained commit.',
      requestId: f.request(),
    } as Data,
    (caller, input) => f.experiments.submitReview(caller, input as unknown as ReviewApplication),
  );
  assert.equal(done.workflow.state, 'complete');
  assert.equal((await f.code.unit(f.source, pending.id)).acceptance?.reference, unit.canonicalHead);
});

test("a final capture Code admitted is the review's, though the machine died before it posted the result", async (t) => {
  const f = await fixture(t);
  const experiment = await f.running();
  const lease = await f.work.lease(experiment);
  for (const [role, content] of [
    ['result', 'The retained observations show no difference.'],
    ['report', report],
  ] as const) {
    const artifact = await f.work.run(
      lease,
      'artifact.create',
      { title: role, content, mediaType: 'text/markdown' },
      (caller, input) => f.artifacts.create(caller, input as never),
    );
    await f.work.run(
      lease,
      'experiment.attach',
      {
        artifactId: artifact.id,
        role,
        path: `${role}.md`,
        attemptIndex: experiment.attempt.index,
        requestId: f.request(),
        ...(role === 'result' ? { resultFormat: 'qualitative' } : {}),
      },
      (caller, input) => f.experiments.attach(caller, input as never),
    );
  }
  const pending = await f.work.run(
    lease,
    'experiment.transition',
    { transition: 'submit_results', requestId: f.request() },
    (caller, input) => f.experiments.transition(caller, input as never),
  );
  // The session left uncommitted work: Code admits the final capture of it, which closes the
  // writer, and the machine dies before it posts the session's result. A fence would do
  // nothing to a closed writer, so Code's own record of that capture must stand for it.
  writeFileSync(join(lease.workspace.path, 'final.txt'), 'final\n');
  const posted = t.mock.method(f.sessions, 'workspaceResult', async () => {});
  await f.work.release(lease);
  assert.equal(posted.mock.callCount(), 1);
  const unit = await f.code.unit(f.source, pending.id);
  assert.equal(unit.writerState, 'closed');
  assert.notEqual(unit.canonicalHead, lease.workspace.snapshot!.headOid);
  const tree = git(lease.workspace.path, ['rev-parse', `${unit.canonicalHead}^{tree}`]);
  const capture = await f.code.capture(f.source, {
    kind: 'session-final',
    sessionId: lease.session.id,
  });
  assert.equal(capture.status, 'ready');
  assert.equal(capture.workspace?.headOid, unit.canonicalHead);
  assert.equal(capture.workspace?.treeOid, tree);
  // Its changes are the admitted head's from the base, not the head the session attached at.
  const [base, head] = [capture.workspace!.baseOid, unit.canonicalHead!];
  const numstat = git(lease.workspace.path, ['diff', '--numstat', base, head])
    .trim()
    .split('\n')
    .map((line) => line.split('\t').map(Number));
  assert.deepEqual(capture.workspace?.stats, {
    commitCount: Number(
      git(lease.workspace.path, ['rev-list', '--count', `${base}..${head}`]).trim(),
    ),
    filesChanged: numstat.length,
    insertions: numstat.reduce((sum, [added]) => sum + added!, 0),
    deletions: numstat.reduce((sum, [, removed]) => sum + removed!, 0),
  });
  assert.notEqual(capture.workspace?.stats.filesChanged, 0);
  // A base the repository does not hold is an error, never a capture with no changes.
  const store = (f.code as unknown as { store: { stats: Function } }).store;
  await assert.rejects(store.stats(f.source.projectId, 'a'.repeat(40), head), /git/);
  const offered = await f.offer(pending, await f.issue('operator'));
  assert.equal(offered.session.execution.references.code, unit.canonicalHead);
});

test('a fenced results review whose session admitted no commit reviews the head the fence kept', async (t) => {
  const f = await fixture(t);
  const experiment = await f.running();
  const lease = await f.work.lease(experiment);
  for (const [role, content] of [
    ['result', 'The retained observations show no difference.'],
    ['report', report],
  ] as const) {
    const artifact = await f.work.run(
      lease,
      'artifact.create',
      { title: role, content, mediaType: 'text/markdown' },
      (caller, input) => f.artifacts.create(caller, input as never),
    );
    await f.work.run(
      lease,
      'experiment.attach',
      {
        artifactId: artifact.id,
        role,
        path: `${role}.md`,
        attemptIndex: experiment.attempt.index,
        requestId: f.request(),
        ...(role === 'result' ? { resultFormat: 'qualitative' } : {}),
      },
      (caller, input) => f.experiments.attach(caller, input as never),
    );
  }
  const pending = await f.work.run(
    lease,
    'experiment.transition',
    { transition: 'submit_results', requestId: f.request() },
    (caller, input) => f.experiments.transition(caller, input as never),
  );
  // The machine dies after the submission: it never hands over its final capture.
  t.mock.method(lease.driver, 'capture', async () => null);
  t.mock.method(lease.driver, 'close', async () => {});
  await f.work.release(lease);
  await assert.rejects(f.workflows.assignment(f.reviewer, pending.id), {
    code: 'experiment_capture_pending',
  });
  const principal = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://issuer.example.test',
    subject: 'operator',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  await f.scope.members.adoptProject(principal, f.source.projectId);
  const human = await f.scope.caller(principal, f.source.projectId);
  await f.code.fenceUnit(human, { unitId: pending.id, requestId: f.request() });
  const unit = await f.code.unit(f.source, pending.id);
  assert.equal(unit.writerState, 'closed');
  // Nothing was admitted, so the fence kept the base the unit's branch started from.
  assert.equal(unit.canonicalHead, null);
  const head = unit.base!.reference;
  const offered = await f.offer(pending, await f.issue('operator'));
  assert.equal(offered.session.execution.references.code, head);
  assert.ok(offered.session.assignment.context!.prompt.includes(`"headOid":"${head}"`));
  // The pass accepts exactly that base.
  const worker = await f.sessions.authenticate(offered.secret);
  const review = await f.reviews.get(worker, pending.reviewId!);
  const done = await f.run(
    worker,
    'review.submit',
    {
      ...reviewedFindings(review),
      verdict: 'pass',
      notes: 'Verified the unchanged base.',
      requestId: f.request(),
    } as Data,
    (caller, input) => f.experiments.submitReview(caller, input as unknown as ReviewApplication),
  );
  assert.equal(done.workflow.state, 'complete');
  assert.equal((await f.code.unit(f.source, pending.id)).acceptance?.reference, head);
});
