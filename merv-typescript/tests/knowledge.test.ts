import { canonical, createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { ClaimService } from '@merv/claims';
import { TaskService } from '@merv/tasks';
import { ExperimentService } from '@merv/experiments';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '../packages/code/src/service.js';
import { KnowledgeService } from '../packages/knowledge/src/index.js';
import {
  MervError,
  type ArtifactInput,
  type Caller,
  type Data,
  type ReviewApplication,
  type Transaction,
} from '@merv/contracts';
import type { Experiment, ExperimentAttach, ExperimentTransition } from '@merv/experiments/types';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

const plan =
  '# Summary\nA paired test.\n# Objective & hypothesis\nThe treatment improves accuracy.\n# Evaluation\nUse matched controls on two fixed seeds.';
const report =
  '# Summary\nThe treatment did not improve.\n# Results\nSee metrics_exhibit.json for retained results.\n# Deviations from plan\nNone.\n# Conclusion\nNo improvement was observed.';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-knowledge-'));
  const path = join(directory, 'state.sqlite');
  let state: SqliteState,
    scope: ProjectScope,
    artifacts: ArtifactStore,
    workflows: WorkflowsService,
    reviews: ReviewService,
    builder: RecipeContextBuilder,
    claims: ClaimService,
    tasks: TaskService,
    experiments: ExperimentService,
    events: DurableEvents,
    sessions: LeasedSessions,
    code: CodeService,
    knowledge: KnowledgeService;
  const open = async () => {
    state = new SqliteState(path);
    scope = await createService(new ProjectScope(state));
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
    );
    workflows = await createService(new WorkflowsService(state, scope));
    reviews = await createService(new ReviewService(state, scope, artifacts));
    builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
    claims = await createService(new ClaimService(state, scope));
    tasks = await createService(
      new TaskService(state, scope, artifacts, workflows, reviews, builder),
    );
    events = await createService(new DurableEvents(state));
    sessions = await createService(new LeasedSessions(state, scope, workflows, events));
    code = await createService(new CodeService(state, scope, sessions, artifacts));
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
    knowledge = await createService(
      new KnowledgeService(
        state,
        scope,
        claims,
        tasks,
        experiments,
        artifacts,
        reviews,
        workflows,
        code,
      ),
    );
  };
  const close = async () => {
    knowledge.close();
    experiments.close();
    code.close();
    await sessions.close();
    tasks.dispose();
    claims.close();
    builder.close();
    workflows.close();
    await events.close();
    await state.close();
  };
  await open();
  const boot = await scope!.bootstrap({ projectName: 'Knowledge corpus', actorName: 'Operator' });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const issued = await scope.issueActor(operator, { name: role, role });
    return {
      projectId: operator.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
  let sequence = 0;
  const id = () => `knowledge-fixture-${++sequence}`;
  const createExperiment = async (name?: string) =>
    await experiments.create(producer, {
      name: name ?? `Experiment-${sequence + 1}`,
      intent: 'Test the treatment.',
      requestId: id(),
    });
  const attach = async (e: Experiment, role: ExperimentAttach['role'], content: string) => {
    const artifact = await artifacts.create(producer, {
      title: role,
      content,
      mediaType: role === 'result' ? 'application/json' : 'text/markdown',
    });
    return await experiments.attach(producer, {
      experimentId: e.id,
      attemptIndex: e.attempt.index,
      expectedRevision: e.workflow.revision,
      artifactId: artifact.id,
      role,
      path: `${role}.${role === 'result' ? 'json' : 'md'}`,
      requestId: id(),
    });
  };
  const transition = async (
    e: Experiment,
    action: ExperimentTransition['transition'],
    reason?: string,
  ) =>
    await experiments.transition(producer, {
      experimentId: e.id,
      expectedRevision: e.workflow.revision,
      transition: action,
      requestId: id(),
      ...(reason ? { evidence: { reason } } : {}),
    });
  const verdict = async (
    e: Experiment,
    verdict: ReviewApplication['verdict'],
    returnTo?: string,
  ): Promise<Experiment> => {
    const review = await reviews.start(reviewer, e.reviewId!);
    return (await reviews.apply(reviewer, {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: e.workflow.revision,
      verdict,
      ...(returnTo ? { returnTo } : {}),
      notes: 'Independent evidence assessment.',
      synopsis: 'The submitted comparison was independently checked.',
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: verdict === 'pass' ? ('met' as const) : ('not_met' as const),
        evidenceIds: [review.artifactIds[0]!],
        notes: `Criterion ${index + 1} was checked against the retained evidence.`,
      })),
      requestId: id(),
    })) as Experiment;
  };
  const submitResults = async (e: Experiment) => {
    await attach(e, 'result', '{"accuracy":0.5,"raw":[1,0]}');
    await attach(e, 'report', report);
    return await transition(e, 'submit_results');
  };
  const completeExperiment = async () => {
    let e = await createExperiment();
    await attach(e, 'plan', plan);
    e = await transition(e, 'submit_design');
    e = await verdict(e, 'needs_changes');
    await attach(e, 'plan', `${plan}\nThe missing control is now explicit.`);
    e = await transition(e, 'submit_design');
    e = await verdict(e, 'pass');
    await workflows.begin(producer, { instanceId: e.id, expectedRevision: e.workflow.revision });
    e = await submitResults(e);
    e = await verdict(e, 'needs_changes', 'running');
    e = await submitResults(e);
    return await verdict(e, 'pass');
  };
  const createTask = async () =>
    await tasks.create(producer, {
      title: 'Research support',
      goal: 'Check the retained output.',
      checks: ['Retain reproducible evidence.'],
      requestId: id(),
    });
  const completeTask = async () => {
    const task = await createTask();
    const artifact = await artifacts.create(producer, {
      title: 'Delivery',
      content: 'Retain reproducible evidence. Verified output 2+2=4.',
    });
    const pending = await tasks.submitDelivery(
      producer,
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [artifact.id],
        expectedRevision: task.workflow.revision,
        requestId: id(),
      }),
    );
    const review = await reviews.start(reviewer, pending.reviewId!);
    return await tasks.submitReview(reviewer, {
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'pass',
      notes: 'The retained evidence passes.',
      requestId: id(),
    });
  };
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    operator,
    producer,
    reviewer,
    reader,
    id,
    createExperiment,
    completeExperiment,
    createTask,
    completeTask,
    attach,
    transition,
    verdict,
    get state() {
      return state;
    },
    get scope() {
      return scope;
    },
    get artifacts() {
      return artifacts;
    },
    get workflows() {
      return workflows;
    },
    get reviews() {
      return reviews;
    },
    get claims() {
      return claims;
    },
    get tasks() {
      return tasks;
    },
    get experiments() {
      return experiments;
    },
    get sessions() {
      return sessions;
    },
    get code() {
      return code;
    },
    get knowledge() {
      return knowledge;
    },
    async restart() {
      await close();
      await open();
    },
  };
}

test('Scoped references distinguish missing, unsupported and unpublished without guidance or bytes', async (t) => {
  const f = await fixture(t);
  const task = await f.completeTask(),
    experiment = await f.createExperiment();
  const claim = await f.claims.create(f.producer, {
    statement: 'A referenced claim.',
    requestId: f.id(),
  });
  const other = await f.scope.bootstrap({
    projectName: 'Private other project',
    actorName: 'Other operator',
  });
  const otherCaller: Caller = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  const privateArtifact = await f.artifacts.create(otherCaller, {
    title: 'Never expose this title',
    content: 'Private.',
  });
  const refs = [
    claim.id,
    task.id,
    `experiment:${experiment.id}`,
    task.briefId,
    `review:${task.reviewId}`,
    'art_absent',
    privateArtifact.id,
    'published-graph',
    'published-reflection:latest',
    'published-lens:critic',
    'paper:unknown',
    'session_absent',
    'codecmd_absent',
    'codeprop_absent',
  ];
  t.mock.method(f.artifacts, 'read', () => assert.fail('Metadata resolver must not read bytes'));
  t.mock.method(f.workflows, 'evaluate', () => assert.fail('Resolver must not evaluate guidance'));
  const head = await f.state.eventHead();
  const results = await f.state.transaction(
    async (tx) => await f.knowledge.resolve(f.reader, refs, tx),
  );
  assert.deepEqual(
    results.map((item) => item.status),
    [
      'resolved',
      'resolved',
      'resolved',
      'resolved',
      'resolved',
      'missing',
      'missing',
      'unsupported',
      'unpublished',
      'unpublished',
      'unsupported',
      'missing',
      'missing',
      'missing',
    ],
  );
  assert.equal(results[0]!.label, claim.statement);
  assert.equal(results[1]!.kind, 'task');
  assert.equal(results[2]!.kind, 'experiment');
  assert.equal(results[3]!.hash, (await f.artifacts.get(f.reader, task.briefId)).hash);
  assert.equal(results[7]!.kind, null, 'a retired published-graph ref still parses, unsupported');
  assert.ok(!JSON.stringify(results).includes(privateArtifact.title));
  assert.deepEqual(
    results.map((item) => item.ref),
    refs,
  );
  assert.equal(await f.state.eventHead(), head);
  f.knowledge.close();
  await assert.rejects(async () => await f.knowledge.resolve(f.reader, refs), {
    code: 'knowledge_unavailable',
  });
});

test('Historical session capture reference resolves for current readers without reauthorizing the former source', async (t) => {
  const f = await fixture(t);
  const task = await f.createTask();
  const session = await f.sessions.offer(f.producer, {
    instanceId: task.id,
    expectedRevision: 0,
    runnerId: 'knowledge-test',
    requestId: f.id(),
    secret: `ms_${randomBytes(32).toString('base64url')}`,
  });
  await f.sessions.release(f.producer, { sessionId: session.id, runnerId: session.runnerId });
  await f.scope.revokeActor(f.operator, f.producer.actorId);
  t.mock.method(f.sessions, 'get', () =>
    assert.fail('Historical resolution must not reconcile a lease'),
  );
  t.mock.method(f.sessions, 'list', () =>
    assert.fail('Historical resolution must not require the old source'),
  );
  const before = await f.state.eventHead();
  const [resolved] = await f.knowledge.resolve(f.reader, [`session-final:${session.id}`]);
  assert.equal(resolved!.status, 'resolved');
  assert.equal(resolved!.capture!.provenance.actorId, session.actorId);
  assert.equal(resolved!.capture!.provenance.instanceId, task.id);
  assert.equal(resolved!.capture!.status, 'none');
  assert.equal(resolved!.capture!.workspace, null);
  assert.equal(await f.state.eventHead(), before);
});
