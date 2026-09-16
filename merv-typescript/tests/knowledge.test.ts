import { createService } from '@merv/contracts';
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
  canonicalKnowledge,
  knowledgeCaptureSchema,
  parseKnowledgeInput,
} from '../packages/knowledge/src/input.js';
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
const graph = JSON.stringify({
  version: 1,
  nodes: [{ id: 'observation', label: 'No improvement' }],
  edges: [],
});

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
      new KnowledgeService(state, scope, claims, tasks, experiments, artifacts, reviews, code),
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
      mediaType: role === 'graph' || role === 'result' ? 'application/json' : 'text/markdown',
    });
    return await experiments.attach(producer, {
      experimentId: e.id,
      attemptIndex: e.attempt.index,
      expectedRevision: e.workflow.revision,
      artifactId: artifact.id,
      role,
      path: `${role}.${role === 'graph' || role === 'result' ? 'json' : 'md'}`,
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
    await attach(e, 'graph', graph);
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

test('Knowledge inventories real records and freezes every terminal attempt, round, assessment and artifact metadata without bytes', async (t) => {
  const f = await fixture(t);
  const claim = await f.claims.create(f.producer, {
    statement: 'Treatment improves accuracy.',
    requestId: f.id(),
  });
  const complete = await f.completeExperiment();
  const active = await f.createExperiment();
  const abandoned = await f.transition(
    await f.createExperiment(),
    'abandon',
    'The resource is unavailable.',
  );
  const done = await f.completeTask(),
    working = await f.createTask();
  const failed = await f.tasks.markFailed(f.producer, {
    taskId: (await f.createTask()).id,
    expectedRevision: 0,
    reason: 'Cancelled support work.',
    requestId: f.id(),
  });
  const before = await f.state.eventHead();
  for (const name of ['read', 'list'] as const)
    t.mock.method(f.artifacts, name, () =>
      assert.fail('Knowledge must use exact metadata refs, never bytes or capped catalog'),
    );
  t.mock.method(f.workflows, 'evaluate', () => assert.fail('Knowledge must not evaluate guidance'));
  t.mock.method(f.sessions, 'get', () => assert.fail('Knowledge must not reconcile runner state'));
  t.mock.method(f.sessions, 'list', () =>
    assert.fail('Knowledge must not use source-scoped session history'),
  );
  t.mock.method(f.code, 'list', () => assert.fail('Knowledge must not use latest capped commands'));
  t.mock.method(f.code, 'proposals', () =>
    assert.fail('Knowledge must not use latest capped proposals'),
  );
  const records = await f.knowledge.records(f.reader);
  assert.equal(records.tasks.length, 3);
  assert.equal(records.experiments.length, 3);
  assert.deepEqual(records.claims, [claim]);
  assert.deepEqual(records.publication, {
    status: 'none',
    graph: null,
    reflection: null,
    lenses: [],
  });
  assert.equal(await f.state.eventHead(), before);
  const corpus = await f.knowledge.capture(f.producer, { requestId: 'first-corpus' });
  assert.deepEqual(
    new Set(corpus.selection.tasks.map((task) => task.id)),
    new Set([done.id, failed.id]),
  );
  assert.deepEqual(
    new Set(corpus.selection.experiments.map((e) => e.id)),
    new Set([complete.id, abandoned.id]),
  );
  assert.ok(!corpus.selection.tasks.some((task) => task.id === working.id));
  assert.ok(!corpus.selection.experiments.some((e) => e.id === active.id));
  const saved = corpus.selection.experiments.find((e) => e.id === complete.id)!;
  assert.deepEqual(saved, complete);
  assert.equal(saved.attempts.length, 2);
  assert.equal(saved.submissions.length, 4);
  assert.ok(saved.attempt.startedAt);
  assert.equal(corpus.selection.assessments.length, 5);
  for (const submission of saved.submissions) {
    assert.ok(
      corpus.selection.assessments.some(
        (entry) => entry.id === submission.reviewId && entry.status === 'retained',
      ),
    );
    for (const evidence of submission.evidence)
      assert.ok(
        corpus.selection.artifacts.some(
          (entry) =>
            entry.id === evidence.artifactId &&
            entry.status === 'retained' &&
            entry.artifact.hash === evidence.hash,
        ),
      );
  }
  assert.ok(
    corpus.selection.assessments.some(
      (entry) =>
        entry.status === 'retained' &&
        entry.review.verdict === 'needs_changes' &&
        entry.review.findings.length > 0,
    ),
  );
  assert.equal(corpus.selection.taskReviewCoverage, 'current-record-references');
  assert.equal(corpus.selection.projectFacts, 'pinned-at-capture');
  assert.equal(corpus.sourceEventHead, before);
  assert.equal(
    corpus.manifestHash,
    createHash('sha256')
      .update(canonicalKnowledge({ formatVersion: 1, selection: corpus.selection }))
      .digest('hex'),
  );
  assert.equal(
    (await f.state.events(f.operator.projectId)).filter((e) => e.type === 'knowledge.captured')
      .length,
    1,
  );
});

test('Corpus retries/restart retain the original selection as new work and claim revisions arrive', async (t) => {
  const f = await fixture(t);
  const claim = await f.claims.create(f.producer, {
    statement: 'An initial claim.',
    requestId: f.id(),
  });
  const first = await f.knowledge.capture(f.producer, { requestId: 'stable' });
  await f.claims.update(f.producer, {
    claimId: claim.id,
    expectedRevision: 0,
    confidence: 'high',
    requestId: f.id(),
  });
  const task = await f.tasks.markFailed(f.producer, {
    taskId: (await f.createTask()).id,
    expectedRevision: 0,
    reason: 'Stopped.',
    requestId: f.id(),
  });
  const second = await f.knowledge.capture(f.producer, { requestId: 'later' });
  assert.notEqual(first.manifestHash, second.manifestHash);
  assert.deepEqual(first.selection.tasks, []);
  assert.equal(second.selection.tasks[0]!.id, task.id);
  assert.equal(first.selection.claims[0]!.confidence, 'medium');
  assert.equal(second.selection.claims[0]!.confidence, 'high');
  assert.deepEqual(await f.knowledge.capture(f.producer, { requestId: 'stable' }), first);
  const old = f.knowledge;
  await f.restart();
  await assert.rejects(async () => await old.get(f.reader, first.id), {
    code: 'knowledge_unavailable',
  });
  assert.deepEqual(await f.knowledge.get(f.reader, first.id), first);
  assert.deepEqual(await f.knowledge.capture(f.producer, { requestId: 'stable' }), first);
  assert.deepEqual(await f.knowledge.get(f.reader, second.id), second);
  assert.equal(
    (await f.state.events(f.operator.projectId)).filter((e) => e.type === 'knowledge.captured')
      .length,
    2,
  );
  t.mock.method(f.claims, 'list', () => assert.fail('Saved reads must never reselect sources'));
  t.mock.method(f.experiments, 'list', () =>
    assert.fail('Saved reads must never reselect sources'),
  );
  assert.deepEqual(await f.knowledge.get(f.reader, first.id), first);
  const detached = await f.knowledge.get(f.reader, first.id);
  detached.selection.claims[0]!.statement = 'Caller mutation';
  assert.deepEqual(await f.knowledge.get(f.reader, first.id), first);
});

test('Corpus selection joins an owning domain writer and snapshot, receipt and event roll back together', async (t) => {
  const f = await fixture(t);
  const experiment = await f.createExperiment();
  const claim = await f.claims.create(f.producer, {
    statement: 'A transactional claim.',
    requestId: f.id(),
  });
  const head = await f.state.eventHead();
  let snapshotId = '';
  const abort = new Error('abort owner program');
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.experiments.transition(
          f.producer,
          {
            experimentId: experiment.id,
            expectedRevision: 0,
            transition: 'mark_failed',
            evidence: { reason: 'Stopped within owner transaction.' },
            requestId: f.id(),
          },
          tx,
        );
        await f.claims.update(
          f.producer,
          { claimId: claim.id, expectedRevision: 0, status: 'weakened', requestId: f.id() },
          tx,
        );
        const snapshot = await f.knowledge.capture(f.producer, { requestId: 'atomic' }, tx);
        snapshotId = snapshot.id;
        assert.equal(snapshot.selection.experiments[0]!.workflow.state, 'failed');
        assert.equal(snapshot.selection.claims[0]!.status, 'weakened');
        assert.deepEqual(await f.knowledge.get(f.reader, snapshot.id, tx), snapshot);
        throw abort;
      }),
    (error) => error === abort,
  );
  assert.equal(await f.state.eventHead(), head);
  assert.equal((await f.experiments.get(f.reader, experiment.id)).workflow.state, 'planned');
  assert.equal((await f.claims.get(f.reader, claim.id)).status, 'active');
  await assert.rejects(async () => await f.knowledge.get(f.reader, snapshotId), {
    code: 'knowledge_not_found',
  });
  const retried = await f.knowledge.capture(f.producer, { requestId: 'atomic' });
  assert.notEqual(retried.id, snapshotId);
  assert.deepEqual(retried.selection.experiments, []);
});

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
      'unpublished',
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

test('Capture enforces current authorization before replay and after writes; read surfaces remain project scoped', async (t) => {
  const f = await fixture(t);
  const saved = await f.knowledge.capture(f.producer, { requestId: 'authority' });
  const other = await f.scope.bootstrap({
    projectName: 'Other corpus',
    actorName: 'Other operator',
  });
  const otherCaller: Caller = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  await assert.rejects(async () => await f.knowledge.get(otherCaller, saved.id), {
    code: 'knowledge_not_found',
  });
  await assert.rejects(async () => await f.knowledge.capture(f.reader, { requestId: 'reader' }), {
    code: 'forbidden',
  });
  const originalRequire = f.scope.require.bind(f.scope);
  let writes = 0;
  const scopeCheck = t.mock.method(
    f.scope,
    'require',
    async (...[caller, permission, tx]: Parameters<ProjectScope['require']>) => {
      const actor = await originalRequire(caller, permission, tx);
      if (permission === 'write' && ++writes === 3)
        throw new MervError('forbidden', 'Authority withdrawn before commit', 403);
      return actor;
    },
  );
  const head = await f.state.eventHead();
  await assert.rejects(
    async () => await f.knowledge.capture(f.producer, { requestId: 'withdraw-during-writer' }),
    {
      code: 'forbidden',
    },
  );
  assert.equal(await f.state.eventHead(), head);
  scopeCheck.mock.restore();
  await f.scope.revokeActor(f.operator, f.producer.actorId);
  await assert.rejects(
    async () => await f.knowledge.capture(f.producer, { requestId: 'authority' }),
    {
      code: 'forbidden',
    },
  );
  await assert.rejects(async () => await f.knowledge.records(f.producer), { code: 'forbidden' });
  await assert.rejects(async () => await f.knowledge.resolve(f.producer, []), {
    code: 'forbidden',
  });
  assert.deepEqual(await f.knowledge.get(f.reader, saved.id), saved);
});

test('Missing exact evidence is explicit while provider outages and hash contradictions abort capture', async (t) => {
  const f = await fixture(t);
  const task = await f.tasks.markFailed(f.producer, {
    taskId: (await f.createTask()).id,
    expectedRevision: 0,
    reason: 'Stopped.',
    requestId: f.id(),
  });
  const originalGet = f.artifacts.get.bind(f.artifacts);
  const missing = t.mock.method(
    f.artifacts,
    'get',
    async (...[caller, id, tx]: Parameters<ArtifactStore['get']>) => {
      if (id === task.briefId)
        throw new MervError('not_found', 'Artifact unavailable in this project', 404);
      return await originalGet(caller, id, tx);
    },
  );
  const snapshot = await f.knowledge.capture(f.producer, { requestId: 'missing' });
  assert.deepEqual(snapshot.selection.artifacts, [{ id: task.briefId, status: 'missing' }]);
  missing.mock.restore();
  const unavailable = t.mock.method(f.artifacts, 'get', () => {
    throw new MervError('artifact_unavailable', 'Provider unavailable', 503);
  });
  const head = await f.state.eventHead();
  await assert.rejects(async () => await f.knowledge.capture(f.producer, { requestId: 'outage' }), {
    code: 'artifact_unavailable',
  });
  await assert.rejects(async () => await f.knowledge.resolve(f.reader, [task.briefId]), {
    code: 'artifact_unavailable',
  });
  assert.equal(await f.state.eventHead(), head);
  unavailable.mock.restore();
  let experiment = await f.createExperiment();
  const evidence = await f.attach(experiment, 'plan', plan);
  experiment = await f.transition(experiment, 'abandon', 'The draft is preserved.');
  t.mock.method(
    f.artifacts,
    'get',
    async (...[caller, id, tx]: Parameters<ArtifactStore['get']>) => {
      const artifact = await originalGet(caller, id, tx);
      return id === evidence.artifactId ? { ...artifact, hash: '0'.repeat(64) } : artifact;
    },
  );
  const beforeConflict = await f.state.eventHead();
  await assert.rejects(
    async () => await f.knowledge.capture(f.producer, { requestId: 'contradiction' }),
    {
      code: 'knowledge_source_conflict',
    },
  );
  assert.equal(await f.state.eventHead(), beforeConflict);
});

test('Persisted corpus and receipt cannot be rewritten or deleted; foreign transactions are rejected', async (t) => {
  const f = await fixture(t);
  const saved = await f.knowledge.capture(f.producer, { requestId: 'immutable' });
  for (const sql of [
    'UPDATE knowledge_snapshots SET manifest_hash=? WHERE id=?',
    'DELETE FROM knowledge_snapshots WHERE id=?',
  ]) {
    await assert.rejects(
      async () =>
        await f.state.transaction(async (tx) =>
          sql.startsWith('UPDATE')
            ? await tx.run(sql, '0'.repeat(64), saved.id)
            : await tx.run(sql, saved.id),
        ),
      /immutable|retained/,
    );
  }
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE knowledge_commands SET snapshot_id=? WHERE project_id=?',
            saved.id,
            f.operator.projectId,
          ),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('DELETE FROM knowledge_commands WHERE project_id=?', f.operator.projectId),
      ),
    /retained/,
  );
  const expired = await f.state.transaction(async (tx) => tx);
  const refuse = async (tx: Transaction) => {
    await assert.rejects(async () => await f.knowledge.records(f.reader, tx), {
      code: 'invalid_transaction',
    });
    await assert.rejects(
      async () => await f.knowledge.capture(f.producer, { requestId: 'expired' }, tx),
      {
        code: 'invalid_transaction',
      },
    );
    await assert.rejects(async () => await f.knowledge.get(f.reader, saved.id, tx), {
      code: 'invalid_transaction',
    });
    await assert.rejects(async () => await f.knowledge.resolve(f.reader, [], tx), {
      code: 'invalid_transaction',
    });
  };
  await refuse(expired);
  const other = new SqliteState(':memory:');
  try {
    await other.transaction(refuse);
  } finally {
    await other.close();
  }
  assert.deepEqual(await f.knowledge.get(f.reader, saved.id), saved);
});

test('Knowledge input bounds reject accessors, proxies and sparse arrays without execution', async (t) => {
  const f = await fixture(t);
  let touched = 0;
  const input = Object.defineProperty({}, 'requestId', {
    enumerable: true,
    get() {
      touched++;
      return 'bad';
    },
  });
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        touched++;
        throw new Error('trap');
      },
      getPrototypeOf() {
        touched++;
        throw new Error('trap');
      },
    },
  );
  const inherited = Object.create(proxy);
  for (const value of [
    input,
    proxy,
    inherited,
    { requestId: 'bad', extra: 'x' },
    { requestId: ' ' },
  ])
    assert.throws(() => parseKnowledgeInput(knowledgeCaptureSchema, value), {
      code: 'invalid_knowledge_input',
    });
  const refs = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      touched++;
      return 'art_bad';
    },
  });
  for (const value of [refs, new Array(2), new Proxy([], {}), Array(201).fill('art_unknown')])
    await assert.rejects(async () => await f.knowledge.resolve(f.reader, value), {
      code: 'invalid_knowledge_input',
    });
  assert.equal(touched, 0);
  await assert.rejects(async () => await f.knowledge.get(f.reader, 'bad id'), {
    code: 'invalid_knowledge_input',
  });
  assert.equal(canonicalKnowledge({ '\u00e9': 1, z: 2, Z: 3 }), '{"Z":3,"z":2,"é":1}');
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

test('A real Git Experiment submission freezes its pending exact capture and a later corpus observes the final receipt', async (t) => {
  const f = await fixture(t);
  let experiment = await f.experiments.create(f.producer, {
    name: 'Declared-Git-capture',
    intent: 'Retain exact code provenance.',
    workspace: 'git',
    requestId: f.id(),
  });
  await f.attach(experiment, 'plan', plan);
  experiment = await f.verdict(await f.transition(experiment, 'submit_design'), 'pass');
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const session = await f.sessions.offer(f.producer, {
    instanceId: experiment.id,
    expectedRevision: experiment.workflow.revision,
    runnerId: 'corpus-git-fixture',
    requestId: f.id(),
    secret,
  });
  // Synthetic source-authenticated Runner metadata: this test does not assert a real Git execution.
  const attachment = {
    repositoryId: 'corpus-fixture-repo',
    workspaceId: 'corpus-fixture-workspace',
    mode: 'persistent' as const,
    branch: 'codex/knowledge-test',
    baseOid: 'a'.repeat(40),
    headOid: 'a'.repeat(40),
    treeOid: 'b'.repeat(40),
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  const control = {
    sessionId: session.id,
    runnerId: session.runnerId,
    hostRef: 'corpus-fixture-host',
  };
  await f.sessions.attach(f.producer, { ...control, workspace: attachment });
  const worker = await f.sessions.authenticate(secret);
  const run = async <T>(
    tool: string,
    input: Data,
    handler: (caller: Caller, bound: Data) => T | Promise<T>,
  ) => f.sessions.run(await f.sessions.prepare(worker, tool, input), handler);
  for (const [role, content] of [
    ['result', '{"result":1}'],
    ['report', report],
    ['graph', graph],
  ] as const) {
    const artifact = await run(
      'artifact.create',
      { title: role, content, mediaType: role === 'report' ? 'text/markdown' : 'application/json' },
      async (caller, bound) => await f.artifacts.create(caller, bound as unknown as ArtifactInput),
    );
    run(
      'experiment.attach',
      {
        role,
        artifactId: artifact.id,
        path: `${role}.${role === 'report' ? 'md' : 'json'}`,
        attemptIndex: 1,
        requestId: f.id(),
      },
      async (caller, bound) =>
        await f.experiments.attach(caller, bound as unknown as ExperimentAttach),
    );
  }
  const submitted = await run(
    'experiment.transition',
    { transition: 'submit_results', requestId: f.id() },
    async (caller, bound) =>
      await f.experiments.transition(caller, bound as unknown as ExperimentTransition),
  );
  const submission = submitted.submissions.find((entry) => entry.stage === 'results')!;
  assert.deepEqual(submission.codeCaptureRef, { kind: 'session-final', sessionId: session.id });
  await f.transition(
    submitted,
    'abandon',
    'Retain a terminal attempt while its late Runner capture is pending.',
  );
  const pending = await f.knowledge.capture(f.producer, { requestId: 'before-final-capture' });
  assert.equal(pending.selection.captures.length, 1);
  const pendingCapture = pending.selection.captures[0]!;
  assert.equal(pendingCapture.status, 'observed');
  assert.equal(pendingCapture.status === 'observed' && pendingCapture.capture.status, 'pending');
  await f.sessions.release(f.producer, { sessionId: session.id, runnerId: session.runnerId });
  const final = {
    ...attachment,
    headOid: 'c'.repeat(40),
    treeOid: 'd'.repeat(40),
    stats: { commitCount: 1, filesChanged: 1, insertions: 3, deletions: 0 },
  };
  await f.sessions.workspaceResult(f.producer, { ...control, workspace: final });
  const after = await f.knowledge.capture(f.producer, { requestId: 'after-final-capture' });
  const capture = after.selection.captures[0]!;
  assert.equal(capture.status, 'observed');
  if (capture.status !== 'observed') assert.fail('Expected a recorded capture');
  assert.equal(capture.capture.status, 'ready');
  assert.deepEqual(capture.capture.workspace, final);
  assert.equal(capture.capture.provenance.actorId, worker.actorId);
  assert.equal(capture.capture.provenance.revision, submission.subjectRevision - 1);
  assert.ok(capture.capture.eventId);
  assert.notEqual(after.manifestHash, pending.manifestHash);
  assert.deepEqual(await f.knowledge.get(f.reader, pending.id), pending);
  assert.deepEqual(
    await f.knowledge.capture(f.producer, { requestId: 'before-final-capture' }),
    pending,
  );
  const unbind = f.knowledge.bindCode(f.code);
  unbind();
  const unavailable = await f.knowledge.capture(f.producer, { requestId: 'code-unloaded' });
  assert.deepEqual(unavailable.selection.captures, [
    { ref: submission.codeCaptureRef, status: 'unavailable' },
  ]);
  assert.equal(
    (await f.knowledge.resolve(f.reader, [`session-final:${session.id}`]))[0].status,
    'unavailable',
  );
  assert.deepEqual(await f.knowledge.get(f.reader, after.id), after);
  f.knowledge.bindCode(f.code);
  assert.equal(
    (await f.knowledge.resolve(f.reader, [`session-final:${session.id}`]))[0].capture?.status,
    'ready',
  );
  const originalCapture = f.code.capture.bind(f.code);
  t.mock.method(f.code, 'capture', async (...args: Parameters<CodeService['capture']>) => {
    const value = await originalCapture(...args);
    return { ...value, provenance: { ...value.provenance, actorId: f.producer.actorId } };
  });
  const head = await f.state.eventHead();
  await assert.rejects(
    async () => await f.knowledge.capture(f.producer, { requestId: 'wrong-worker' }),
    {
      code: 'knowledge_capture_provenance',
    },
  );
  assert.equal(await f.state.eventHead(), head);
});
