import { canonical, createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { TaskService } from '@merv/tasks';
import { ExperimentService } from '@merv/experiments';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '../packages/code-research/src/service.js';
import { KnowledgeService } from '../packages/knowledge/src/index.js';
import {
  MervError,
  type ArtifactInput,
  type Caller,
  type Data,
  type Transaction,
} from '@merv/contracts';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { openState } from './fixtures/state.js';
import type { PostgresState } from '@merv/state';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-knowledge-'));
  const path = directory;
  let state: PostgresState,
    scope: ProjectScope,
    artifacts: ArtifactStore,
    workflows: WorkflowsService,
    reviews: ReviewService,
    builder: RecipeContextBuilder,
    tasks: TaskService,
    experiments: ExperimentService,
    events: DurableEvents,
    sessions: LeasedSessions,
    code: CodeService,
    knowledge: KnowledgeService;
  const open = async () => {
    state = await openState(path);
    scope = await createService(new ProjectScope(state));
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
    );
    workflows = await createService(new WorkflowsService(state, scope));
    reviews = await createService(new ReviewService(state, scope, artifacts));
    builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
    tasks = await createService(
      new TaskService(state, scope, artifacts, workflows, reviews, builder),
    );
    events = await createService(new DurableEvents(state));
    sessions = await createService(new LeasedSessions(state, scope, workflows, events));
    code = await createService(new CodeService(state, scope, sessions, artifacts, workflows));
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
    knowledge = await createService(
      new KnowledgeService(state, scope, tasks, experiments, artifacts, reviews, workflows, code),
    );
  };
  const close = async () => {
    knowledge.close();
    experiments.close();
    code.close();
    await sessions.close();
    tasks.dispose();
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
    createTask,
    completeTask,
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
  };
}

for (const name of ['knowledge', 'experiments'] as const) {
  test(`${name} Code binding disposal cannot withdraw a replacement binding of the same provider`, async (t) => {
    const f = await fixture(t);
    const service = f[name];
    const old = service.bindCode(f.code);
    const current = service.bindCode(f.code);
    const available = async () => {
      if (name === 'knowledge') {
        assert.equal(
          (await f.knowledge.resolve(f.reader, ['code-proposal:missing']))[0].status,
          'missing',
        );
      } else {
        await f.experiments.create(f.producer, {
          name: f.id(),
          intent: 'Exercise the current Code binding.',
          workspace: 'git',
          requestId: f.id(),
        });
      }
    };
    const unavailable = async () => {
      if (name === 'knowledge') {
        assert.equal(
          (await f.knowledge.resolve(f.reader, ['code-proposal:missing']))[0].status,
          'unavailable',
        );
      } else {
        await assert.rejects(
          f.experiments.create(f.producer, {
            name: f.id(),
            intent: 'Code has been withdrawn.',
            workspace: 'git',
            requestId: f.id(),
          }),
          { code: 'code_unavailable' },
        );
      }
    };
    old();
    await available();
    current();
    await unavailable();
    const replacement = service.bindCode(f.code);
    old();
    current();
    await available();
    replacement();
    await unavailable();
  });

  test(`${name} refuses new Code bindings after its own shutdown`, async (t) => {
    const f = await fixture(t);
    f[name].close();
    assert.throws(() => f[name].bindCode(f.code), { code: `${name}_unavailable` });
  });
}

test('Scoped references distinguish missing, unsupported and unpublished without guidance or bytes', async (t) => {
  const f = await fixture(t);
  const task = await f.completeTask(),
    experiment = await f.createExperiment();
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
    // Research claims are retired: an old claim reference is an unknown kind.
    'claim:claim_retired',
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
  const caller = { ...f.reader };
  const lookup = f.tasks.record.bind(f.tasks);
  t.mock.method(f.tasks, 'record', async (...args: Parameters<typeof lookup>) => {
    const result = await lookup(...args);
    Object.assign(caller, otherCaller);
    return result;
  });
  const results = await f.state.transaction(
    async (tx) => await f.knowledge.resolve(caller, refs, tx),
  );
  assert.deepEqual(
    results.map((item) => item.status),
    [
      'unsupported',
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
  assert.equal(results[0]!.kind, null);
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

test('Knowledge keeps one caller throughout its inventory and evidence reads', async (t) => {
  const f = await fixture(t);
  await f.createTask();
  const boot = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const other = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const project = f.scope.project.bind(f.scope);
  const expected = await f.knowledge.records(f.reader);
  const caller = { ...f.reader };
  f.scope.project = async (...args) => {
    const result = await project(...args);
    Object.assign(caller, other);
    return result;
  };
  try {
    assert.deepEqual(await f.knowledge.records(caller), expected);
  } finally {
    f.scope.project = project;
  }
  // Read authority is asked again once the records are read, so a revocation meanwhile refuses.
  const list = f.experiments.list.bind(f.experiments);
  t.mock.method(f.experiments, 'list', async (...args: Parameters<typeof list>) => {
    const result = await list(...args);
    await args[1]!.run(
      'UPDATE actor_credentials SET revoked_at=? WHERE id=?',
      new Date().toISOString(),
      f.reader.credentialId!,
    );
    return result;
  });
  await assert.rejects(f.knowledge.records(f.reader), { code: 'forbidden' });
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
