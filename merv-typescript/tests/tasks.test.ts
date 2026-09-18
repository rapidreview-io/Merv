import { createService } from '@merv/contracts';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecipeContextBuilder } from '@merv/context-builder';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { TaskService } from '@merv/tasks';
import type { Caller, Workflows } from '@merv/contracts';

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'merv-task-test-'));
  const state = new SqliteState(join(path, 'state.db')),
    scope = await createService(new ProjectScope(state));
  const credentials = await scope.bootstrap({ projectName: 'Test', actorName: 'Operator' });
  const operator: Caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const issue = async (
    name: string,
    role: 'producer' | 'reviewer' | 'reader',
  ): Promise<Caller> => ({
    actorId: (await scope.issueActor(operator, { name, role })).actor.id,
    projectId: operator.projectId,
  });
  const producer = await issue('Producer', 'producer'),
    reviewer = await issue('Reviewer', 'reviewer'),
    reviewer2 = await issue('Other reviewer', 'reviewer'),
    reader = await issue('Reader', 'reader');
  const blobs = new DiskBlobs(join(path, 'blobs')),
    artifacts = await createService(new ArtifactStore(state, scope, blobs));
  const workflows = await createService(new WorkflowsService(state, scope)),
    reviews = await createService(new ReviewService(state, scope, artifacts));
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const tasks = await createService(
    new TaskService(state, scope, artifacts, workflows, reviews, builder),
  );
  const brief = await artifacts.create(producer, {
    title: 'Brief',
    content:
      '# Goal\nBuild an adder.\n# Done when\n- Adds two numbers.\n- Handles negative inputs.',
  });
  const create = async () =>
    await tasks.create(producer, {
      title: 'Adder',
      goal: 'Build an adder.',
      checks: ['Adds two numbers.', 'Handles negative inputs.'],
      briefId: brief.id,
      requestId: 'create',
    });
  const delivery = async (label = 'Delivery') =>
    await artifacts.create(producer, {
      title: label,
      content: `${label}\nAdds two numbers. Verified add(2,3)=5.\nHandles negative inputs. Verified add(-2,1)=-1.`,
    });
  const cleanup = async () => {
    tasks.dispose();
    await state.close();
    rmSync(path, { recursive: true, force: true });
  };
  return {
    path,
    state,
    scope,
    operator,
    producer,
    reviewer,
    reviewer2,
    reader,
    blobs,
    artifacts,
    workflows,
    reviews,
    tasks,
    brief,
    create,
    delivery,
    cleanup,
  };
}
const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test('task loop pins evidence, routes needs_changes and pass, and deduplicates mutations', async () => {
  const f = await fixture();
  try {
    const initial = await f.create();
    assert.equal(initial.workflow.state, 'in_progress');
    assert.deepEqual(await f.create(), initial);
    await assert.rejects(
      async () =>
        await f.tasks.create(f.producer, {
          title: 'Different',
          goal: initial.goal,
          checks: initial.checks,
          briefId: f.brief.id,
          requestId: 'create',
        }),
      code('request_conflict'),
    );
    await assert.rejects(
      async () =>
        await f.workflows.transition(f.producer, {
          instanceId: initial.id,
          action: 'submit_delivery',
          expectedRevision: 0,
          requestId: 'bypass',
        }),
      code('workflow_managed'),
    );
    await assert.rejects(
      async () =>
        await f.workflows.start(f.producer, { workflow: 'task', requestId: 'bypass-start' }),
      code('workflow_managed'),
    );
    const delivery = await f.delivery();
    const input = {
      taskId: initial.id,
      artifactIds: [delivery.id],
      expectedRevision: initial.workflow.revision,
      requestId: 'deliver',
    };
    const pending = await f.tasks.submitDelivery(f.producer, confirmedDelivery(input, 2));
    assert.equal(pending.workflow.state, 'in_review');
    assert.deepEqual(
      await f.tasks.submitDelivery(f.producer, confirmedDelivery(input, 2)),
      pending,
    );
    await assert.rejects(
      async () =>
        await f.tasks.submitDelivery(
          f.producer,
          confirmedDelivery({ ...input, artifactIds: [f.brief.id] }, 2),
        ),
      code('request_conflict'),
    );
    const pinned = await f.reviews.get(f.reviewer, pending.reviewId!);
    assert.deepEqual(pinned.artifactIds, [f.brief.id, ...pending.deliveryIds]);
    assert.equal(pending.deliveryIds[0], delivery.id);
    assert.equal(pending.deliveryIds.at(-1), pending.deliveryAssessmentId);
    assert.equal(pending.deliveryIds.length, 2);
    assert.equal(pinned.subjectRevision, pending.workflow.revision);
    assert.match(pinned.snapshotHash, /^[a-f0-9]{64}$/);
    await assert.rejects(
      async () => await f.reviews.start(f.producer, pinned.id),
      code('forbidden'),
    );
    await assert.rejects(async () => await f.reviews.start(f.reader, pinned.id), code('forbidden'));
    const claimed = await f.reviews.start(f.reviewer, pinned.id);
    assert.deepEqual(await f.reviews.start(f.reviewer, pinned.id), claimed);
    await assert.rejects(
      async () => await f.reviews.start(f.reviewer2, pinned.id),
      code('review_unavailable'),
    );
    await assert.rejects(
      async () =>
        await f.tasks.submitReview(f.reviewer2, {
          ...reviewedFindings(await f.reviews.get(f.operator, pinned.id)),
          reviewId: pinned.id,
          claimId: (await f.reviews.get(f.operator, pinned.id)).claimId!,
          verdict: 'pass',
          notes: 'Looks good',
          expectedRevision: pending.workflow.revision,
          requestId: 'wrong-reviewer',
        }),
      code('review_independence'),
    );
    await assert.rejects(
      async () =>
        await f.tasks.submitReview(f.reviewer, {
          ...reviewedFindings(await f.reviews.get(f.operator, pinned.id)),
          reviewId: pinned.id,
          claimId: (await f.reviews.get(f.operator, pinned.id)).claimId!,
          verdict: 'pass',
          notes: 'Verified',
          expectedRevision: 0,
          requestId: 'stale',
        }),
      code('revision_conflict'),
    );
    const revise = {
      ...reviewedFindings(await f.reviews.get(f.operator, pinned.id)),
      reviewId: pinned.id,
      claimId: (await f.reviews.get(f.operator, pinned.id)).claimId!,
      verdict: 'needs_changes' as const,
      notes: 'Include executable assertions.',
      expectedRevision: pending.workflow.revision,
      requestId: 'revise',
    };
    const revised = await f.tasks.submitReview(f.reviewer, revise);
    assert.equal(revised.workflow.state, 'in_progress');
    assert.equal(revised.workflow.data.revisionContext, revise.notes);
    assert.deepEqual(await f.tasks.submitReview(f.reviewer, revise), revised);
    await assert.rejects(
      async () => await f.tasks.submitReview(f.reviewer, { ...revise, verdict: 'pass' }),
      code('request_conflict'),
    );
    const second = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: initial.id,
          artifactIds: [(await f.delivery('Executable assertions')).id],
          expectedRevision: revised.workflow.revision,
          requestId: 'deliver2',
        },
        2,
      ),
    );
    assert.notEqual(second.reviewId, pinned.id);
    assert.deepEqual((await f.reviews.get(f.reviewer, pinned.id)).artifactIds, pinned.artifactIds);
    await assert.rejects(
      async () =>
        await f.tasks.submitReview(f.reviewer, {
          ...revise,
          requestId: 'obsolete',
          expectedRevision: second.workflow.revision,
        }),
      code('stale_review'),
    );
    await f.reviews.start(f.reviewer, second.reviewId!);
    const done = await f.tasks.submitReview(f.reviewer, {
      ...reviewedFindings(await f.reviews.get(f.operator, second.reviewId!)),
      reviewId: second.reviewId!,
      claimId: (await f.reviews.get(f.operator, second.reviewId!)).claimId!,
      verdict: 'pass',
      notes: 'Ran both checks successfully.',
      evidence: { outcome: 'Ran both checks successfully.' },
      expectedRevision: second.workflow.revision,
      requestId: 'accept',
    });
    assert.equal(done.workflow.state, 'done');
    assert.equal(done.workflow.data.outcome, 'Ran both checks successfully.');
    assert.equal(
      (await f.state.events(f.producer.projectId)).filter(
        (event) => event.type === 'task.review_applied',
      ).length,
      2,
    );
  } finally {
    await f.cleanup();
  }
});

test('failed workflow routing rolls back verdict, request record, and events atomically', async () => {
  const f = await fixture();
  let alternative: TaskService | undefined;
  try {
    const task = await f.create(),
      delivery = await f.delivery();
    const pending = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [delivery.id],
          expectedRevision: task.workflow.revision,
          requestId: 'deliver',
        },
        2,
      ),
    );
    await f.reviews.start(f.reviewer, pending.reviewId!);
    f.tasks.dispose();
    let fail = true;
    const wrapped: Workflows = {
      registerReadReferences: f.workflows.registerReadReferences.bind(f.workflows),
      dispatchCandidates: f.workflows.dispatchCandidates.bind(f.workflows),
      leaseRole: f.workflows.leaseRole.bind(f.workflows),
      offerLease: f.workflows.offerLease.bind(f.workflows),
      checkLease: f.workflows.checkLease.bind(f.workflows),
      activateLease: f.workflows.activateLease.bind(f.workflows),
      releaseLease: f.workflows.releaseLease.bind(f.workflows),
      authorizeLeaseDispatch: f.workflows.authorizeLeaseDispatch.bind(f.workflows),
      register: async (definition, policy) => {
        const handle = await f.workflows.register(definition, policy);
        return {
          ...handle,
          transition: async (caller, input, tx) => {
            if (fail && input.action === 'accept') throw new Error('Injected route failure');
            return await handle.transition(caller, input, tx);
          },
        };
      },
      start: f.workflows.start.bind(f.workflows),
      transition: f.workflows.transition.bind(f.workflows),
      get: f.workflows.get.bind(f.workflows),
      list: f.workflows.list.bind(f.workflows),
      history: f.workflows.history.bind(f.workflows),
      catalog: f.workflows.catalog.bind(f.workflows),
      process: f.workflows.process.bind(f.workflows),
      evaluate: f.workflows.evaluate.bind(f.workflows),
      overview: f.workflows.overview.bind(f.workflows),
      dependencies: f.workflows.dependencies.bind(f.workflows),
      checkDependencies: f.workflows.checkDependencies.bind(f.workflows),
      assignment: f.workflows.assignment.bind(f.workflows),
      begin: f.workflows.begin.bind(f.workflows),
      workStarts: f.workflows.workStarts.bind(f.workflows),
      execution: f.workflows.execution.bind(f.workflows),
      authorizeDispatch: f.workflows.authorizeDispatch.bind(f.workflows),
    };
    alternative = await createService(
      new TaskService(
        f.state,
        f.scope,
        f.artifacts,
        wrapped,
        f.reviews,
        await createService(new RecipeContextBuilder(f.state, f.scope, f.artifacts)),
      ),
    );
    const before = await f.state.events(f.producer.projectId);
    const input = {
      ...reviewedFindings(await f.reviews.get(f.operator, pending.reviewId!)),
      reviewId: pending.reviewId!,
      claimId: (await f.reviews.get(f.operator, pending.reviewId!)).claimId!,
      verdict: 'pass' as const,
      notes: 'Verified both checks.',
      expectedRevision: pending.workflow.revision,
      requestId: 'accept',
    };
    await assert.rejects(
      async () => await alternative!.submitReview(f.reviewer, input),
      /Injected route failure/,
    );
    assert.equal((await f.reviews.get(f.reviewer, pending.reviewId!)).status, 'started');
    assert.equal((await f.tasks.get(f.producer, task.id)).workflow.state, 'in_review');
    assert.deepEqual(await f.state.events(f.producer.projectId), before);
    fail = false;
    assert.equal((await alternative.submitReview(f.reviewer, input)).workflow.state, 'done');
  } finally {
    alternative?.dispose();
    await f.cleanup();
  }
});

test('brief and delivery gates enforce scope, authorship, check coverage, and fail routing', async () => {
  const f = await fixture();
  try {
    const credentials = await f.scope.bootstrap({
      projectName: 'Other',
      actorName: 'Other operator',
    });
    const other = { actorId: credentials.actor.id, projectId: credentials.project.id };
    await assert.rejects(
      async () =>
        await f.tasks.create(other, {
          title: 'Steal',
          goal: 'Build an adder.',
          checks: ['Adds two numbers.'],
          briefId: f.brief.id,
          requestId: 'cross-project',
        }),
      code('not_found'),
    );
    const bad = await f.artifacts.create(f.producer, {
      title: 'Missing checks',
      content: 'Build an adder.',
    });
    await assert.rejects(
      async () =>
        await f.tasks.create(f.producer, {
          title: 'Adder',
          goal: 'Build an adder.',
          checks: ['Adds two numbers.'],
          briefId: bad.id,
          requestId: 'bad-brief',
        }),
      code('invalid_brief'),
    );
    const task = await f.create();
    await assert.rejects(async () => await f.tasks.get(other, task.id), code('not_found'));
    await assert.rejects(
      async () => await f.tasks.get({ ...f.producer, projectId: other.projectId }, task.id),
      code('forbidden'),
    );
    const partial = await f.artifacts.create(f.producer, {
      title: 'Partial',
      content: 'Adds two numbers. Verified.',
    });
    await assert.rejects(
      async () =>
        await f.tasks.submitDelivery(f.producer, {
          taskId: task.id,
          ...confirmedDelivery({ artifactIds: [partial.id] }),
          expectedRevision: 0,
          requestId: 'partial',
        }),
      code('invalid_confirmations'),
    );
    assert.equal((await f.tasks.get(f.producer, task.id)).workflow.state, 'in_progress');
    assert.equal((await f.reviews.list(f.producer)).length, 0);
    const pending = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [(await f.delivery()).id],
          expectedRevision: 0,
          requestId: 'delivery',
        },
        2,
      ),
    );
    await f.reviews.start(f.reviewer, pending.reviewId!);
    await assert.rejects(
      async () =>
        await f.tasks.submitReview(f.reviewer, {
          ...reviewedFindings(await f.reviews.get(f.operator, pending.reviewId!)),
          reviewId: pending.reviewId!,
          claimId: (await f.reviews.get(f.operator, pending.reviewId!)).claimId!,
          verdict: 'fail',
          notes: '\u200b\u200b',
          expectedRevision: pending.workflow.revision,
          requestId: 'invisible',
        }),
      code('invalid_notes'),
    );
    const failed = await f.tasks.submitReview(f.reviewer, {
      ...reviewedFindings(await f.reviews.get(f.operator, pending.reviewId!)),
      reviewId: pending.reviewId!,
      claimId: (await f.reviews.get(f.operator, pending.reviewId!)).claimId!,
      verdict: 'fail',
      notes: 'Goal cannot be achieved within scope.',
      expectedRevision: pending.workflow.revision,
      requestId: 'fail',
    });
    assert.equal(failed.workflow.state, 'failed');
    assert.equal(failed.failure?.reviewId, pending.reviewId);
    assert.equal(failed.failure?.actorId, f.reviewer.actorId);
  } finally {
    await f.cleanup();
  }
});

test('generic reviews work without a workflow engine or task program and reject operator self-review', async () => {
  const path = mkdtempSync(join(tmpdir(), 'merv-review-only-'));
  const state = new SqliteState(join(path, 'state.db')),
    scope = await createService(new ProjectScope(state));
  const credential = await scope.bootstrap({
    projectName: 'Standalone review',
    actorName: 'Operator',
  });
  const operator = { actorId: credential.actor.id, projectId: credential.project.id };
  const reviewer = {
    actorId: (await scope.issueActor(operator, { name: 'Reviewer', role: 'reviewer' })).actor.id,
    projectId: operator.projectId,
  };
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(path, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const f = {
    operator,
    reviewer,
    artifacts,
    reviews,
    cleanup: async () => {
      await state.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
  try {
    const artifact = await f.artifacts.create(f.operator, {
      title: 'Assessment input',
      content: 'Assess this.',
    });
    const input = {
      subjectId: 'opaque-external-subject',
      subjectRevision: 7,
      producerId: f.operator.actorId,
      artifactIds: [artifact.id],
      criteria: ['Correctness'],
      requestId: 'standalone',
    };
    const requested = await f.reviews.request(f.operator, input);
    assert.deepEqual(await f.reviews.request(f.operator, input), requested);
    await assert.rejects(
      async () => await f.reviews.request(f.operator, { ...input, criteria: ['Different'] }),
      code('request_conflict'),
    );
    await assert.rejects(
      async () => await f.reviews.start(f.operator, requested.id),
      code('review_independence'),
    );
    await f.reviews.start(f.reviewer, requested.id);
    const submit = {
      ...reviewedFindings(await f.reviews.get(f.operator, requested.id)),
      reviewId: requested.id,
      claimId: (await f.reviews.get(f.operator, requested.id)).claimId!,
      verdict: 'pass' as const,
      notes: 'Assessed independently.',
      requestId: 'verdict',
    };
    assert.equal((await f.reviews.submit(f.reviewer, submit)).verdict, 'pass');
    assert.equal((await f.reviews.submit(f.reviewer, submit)).verdict, 'pass');
    await assert.rejects(
      async () => await f.reviews.submit(f.reviewer, { ...submit, requestId: 'new-verdict' }),
      code('review_closed'),
    );
  } finally {
    await f.cleanup();
  }
});

test('task and pinned review resume after SQLite reopen', async () => {
  const f = await fixture();
  let reopened: SqliteState | undefined, restarted: TaskService | undefined;
  try {
    const task = await f.create(),
      delivery = await f.delivery();
    const content = (await f.artifacts.read(f.producer, delivery.id)).content;
    const pending = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [delivery.id],
          expectedRevision: 0,
          requestId: 'deliver',
        },
        2,
      ),
    );
    const snapshot = await f.reviews.start(f.reviewer, pending.reviewId!);
    const beforeRestart = await f.tasks.get(f.producer, task.id);
    f.tasks.dispose();
    await f.state.close();
    reopened = new SqliteState(join(f.path, 'state.db'));
    const scope = await createService(new ProjectScope(reopened)),
      artifacts = await createService(new ArtifactStore(reopened, scope, f.blobs));
    const workflows = await createService(new WorkflowsService(reopened, scope)),
      reviews = await createService(new ReviewService(reopened, scope, artifacts));
    restarted = await createService(
      new TaskService(
        reopened,
        scope,
        artifacts,
        workflows,
        reviews,
        await createService(new RecipeContextBuilder(reopened, scope, artifacts)),
      ),
    );
    assert.deepEqual(await restarted.get(f.producer, task.id), beforeRestart);
    assert.deepEqual(await reviews.get(f.reviewer, snapshot.id), snapshot);
    assert.equal((await artifacts.read(f.reviewer, delivery.id)).content, content);
    assert.equal(
      (
        await restarted.submitReview(f.reviewer, {
          ...reviewedFindings(snapshot),
          reviewId: snapshot.id,
          claimId: snapshot.claimId!,
          verdict: 'pass',
          notes: 'Verified after restart.',
          expectedRevision: pending.workflow.revision,
          requestId: 'accept-after-restart',
        })
      ).workflow.state,
      'done',
    );
  } finally {
    restarted?.dispose();
    await reopened?.close();
    await f.cleanup();
  }
});

test('failure after verdict and transition writes rolls back the complete transaction', async () => {
  const f = await fixture();
  try {
    const task = await f.create(),
      delivery = await f.delivery();
    const pending = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [delivery.id],
          expectedRevision: 0,
          requestId: 'delivery',
        },
        2,
      ),
    );
    await f.reviews.start(f.reviewer, pending.reviewId!);
    const events = await f.state.events(f.producer.projectId),
      history = await f.workflows.history(f.producer, task.id);
    const append = f.state.appendEvent.bind(f.state);
    f.state.appendEvent = async (tx, event) => {
      const result = await append(tx, event);
      if (event.type === 'task.review_applied') throw new Error('Injected final event failure');
      return result;
    };
    const input = {
      ...reviewedFindings(await f.reviews.get(f.operator, pending.reviewId!)),
      reviewId: pending.reviewId!,
      claimId: (await f.reviews.get(f.operator, pending.reviewId!)).claimId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'pass' as const,
      notes: 'Verified.',
      requestId: 'accept',
    };
    await assert.rejects(
      async () => await f.tasks.submitReview(f.reviewer, input),
      /Injected final event failure/,
    );
    assert.equal((await f.reviews.get(f.reviewer, pending.reviewId!)).status, 'started');
    assert.equal((await f.tasks.get(f.producer, task.id)).workflow.state, 'in_review');
    assert.deepEqual(await f.workflows.history(f.producer, task.id), history);
    assert.deepEqual(await f.state.events(f.producer.projectId), events);
    f.state.appendEvent = append;
    assert.equal((await f.tasks.submitReview(f.reviewer, input)).workflow.state, 'done');
    await assert.rejects(
      async () =>
        await f.artifacts.create(f.reviewer, { title: 'Unauthorized', content: 'Cannot write.' }),
      code('forbidden'),
    );
    await assert.rejects(
      async () =>
        await f.tasks.create(f.reviewer, {
          title: 'Unauthorized',
          goal: task.goal,
          checks: task.checks,
          briefId: task.briefId,
          requestId: 'reviewer-create',
        }),
      code('forbidden'),
    );
  } finally {
    await f.cleanup();
  }
});

test('task briefs, review snapshots, and completed verdicts are immutable in storage', async () => {
  const f = await fixture();
  try {
    const task = await f.create(),
      delivery = await f.delivery();
    const pending = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [delivery.id],
          expectedRevision: 0,
          requestId: 'delivery',
        },
        2,
      ),
    );
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) =>
            await tx.run('UPDATE tasks SET goal = ? WHERE id = ?', 'Changed goal', task.id),
        ),
      /brief is immutable/,
    );
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) =>
            await tx.run(
              'UPDATE reviews SET subject_revision = ? WHERE id = ?',
              9,
              pending.reviewId!,
            ),
        ),
      /snapshot is immutable/,
    );
    await f.reviews.start(f.reviewer, pending.reviewId!);
    await f.tasks.submitReview(f.reviewer, {
      ...reviewedFindings(await f.reviews.get(f.operator, pending.reviewId!)),
      reviewId: pending.reviewId!,
      claimId: (await f.reviews.get(f.operator, pending.reviewId!)).claimId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'pass',
      notes: 'Verified.',
      requestId: 'accept',
    });
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) =>
            await tx.run("UPDATE reviews SET verdict = 'fail' WHERE id = ?", pending.reviewId!),
        ),
      /verdict is immutable/,
    );
  } finally {
    await f.cleanup();
  }
});

test('brief text rejects invalid UTF-8 while structured deliveries can cite binary evidence', async () => {
  const f = await fixture();
  try {
    const invalid = await f.artifacts.create(f.producer, {
      title: 'Invalid UTF8',
      content: '/w==',
      encoding: 'base64',
      mediaType: 'text/plain',
    });
    assert.equal((await f.artifacts.read(f.producer, invalid.id)).encoding, 'base64');
    await assert.rejects(
      async () =>
        await f.tasks.create(f.producer, {
          title: 'Invalid brief',
          goal: '/w',
          checks: ['/w'],
          briefId: invalid.id,
          requestId: 'invalid-brief',
        }),
      code('invalid_brief'),
    );
    const brief = await f.artifacts.create(f.producer, {
      title: 'Valid brief',
      content: 'Goal: Validate bytes.\nCheck: /w',
    });
    const task = await f.tasks.create(f.producer, {
      title: 'Bytes',
      goal: 'Validate bytes.',
      checks: ['/w'],
      briefId: brief.id,
      requestId: 'bytes',
    });
    const submitted = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [invalid.id],
        expectedRevision: 0,
        requestId: 'binary-delivery',
      }),
    );
    assert.equal(submitted.workflow.state, 'in_review');
    assert.equal(submitted.deliveryIds[0], invalid.id);
    assert.equal(submitted.deliveryIds.at(-1), submitted.deliveryAssessmentId);
    assert.equal((await f.artifacts.read(f.producer, invalid.id)).encoding, 'base64');
  } finally {
    await f.cleanup();
  }
});

test('review reissue recovers revoked claims, preserves evidence, fences old revisions, and checks authority', async () => {
  const f = await fixture();
  try {
    const task = await f.create();
    const pending = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [(await f.delivery()).id],
          expectedRevision: 0,
          requestId: 'delivery',
        },
        2,
      ),
    );
    const original = await f.reviews.start(f.reviewer, pending.reviewId!);
    await f.scope.revokeActor(f.operator, f.reviewer.actorId);
    await assert.rejects(
      async () =>
        await f.tasks.submitReview(f.reviewer, {
          ...reviewedFindings(await f.reviews.get(f.operator, original.id)),
          reviewId: original.id,
          claimId: (await f.reviews.get(f.operator, original.id)).claimId!,
          expectedRevision: pending.workflow.revision,
          verdict: 'pass',
          notes: 'Verified.',
          requestId: 'revoked',
        }),
      code('forbidden'),
    );
    const input = {
      taskId: task.id,
      expectedRevision: pending.workflow.revision,
      reason: 'The reviewer credential was revoked.',
      requestId: 'reissue',
    };
    await assert.rejects(
      async () => await f.tasks.reissueReview(f.reviewer2, input),
      code('forbidden'),
    );
    const otherActor = await f.scope.issueActor(f.operator, {
      name: 'Another producer',
      role: 'producer',
    });
    const otherProducer = { actorId: otherActor.actor.id, projectId: f.operator.projectId };
    await assert.rejects(
      async () => await f.tasks.reissueReview(otherProducer, input),
      code('forbidden'),
    );
    await assert.rejects(
      async () => await f.tasks.reissueReview(f.producer, { ...input, expectedRevision: 0 }),
      code('revision_conflict'),
    );
    const reissued = await f.tasks.reissueReview(f.producer, input);
    assert.equal(reissued.workflow.state, 'in_review');
    assert.equal(reissued.workflow.revision, pending.workflow.revision + 1);
    assert.notEqual(reissued.reviewId, original.id);
    assert.deepEqual(await f.tasks.reissueReview(f.producer, input), reissued);
    await assert.rejects(
      async () =>
        await f.tasks.reissueReview(f.producer, { ...input, reason: 'Different reason.' }),
      code('request_conflict'),
    );
    assert.equal((await f.reviews.get(f.producer, original.id)).status, 'superseded');
    const current = await f.reviews.get(f.producer, reissued.reviewId!);
    assert.deepEqual(current.artifactIds, original.artifactIds);
    assert.deepEqual(current.criteria, original.criteria);
    assert.equal(current.producerId, original.producerId);
    assert.equal(current.subjectRevision, reissued.workflow.revision);
    assert.notEqual(current.snapshotHash, original.snapshotHash);
    await assert.rejects(
      async () =>
        await f.tasks.submitReview(f.reviewer2, {
          ...reviewedFindings(await f.reviews.get(f.operator, original.id)),
          reviewId: original.id,
          claimId: (await f.reviews.get(f.operator, original.id)).claimId!,
          expectedRevision: reissued.workflow.revision,
          verdict: 'pass',
          notes: 'Old snapshot.',
          requestId: 'stale',
        }),
      code('stale_review'),
    );
    // Project operators can also recover on behalf of an unavailable producer.
    const operatorReissued = await f.tasks.reissueReview(f.operator, {
      taskId: task.id,
      expectedRevision: reissued.workflow.revision,
      reason: 'Operator recovery.',
      requestId: 'operator-reissue',
    });
    assert.equal(
      (await f.reviews.get(f.operator, operatorReissued.reviewId!)).producerId,
      f.producer.actorId,
    );
    await f.reviews.start(f.reviewer2, operatorReissued.reviewId!);
    const done = await f.tasks.submitReview(f.reviewer2, {
      ...reviewedFindings(await f.reviews.get(f.operator, operatorReissued.reviewId!)),
      reviewId: operatorReissued.reviewId!,
      claimId: (await f.reviews.get(f.operator, operatorReissued.reviewId!)).claimId!,
      expectedRevision: operatorReissued.workflow.revision,
      verdict: 'pass',
      notes: 'Replacement independently verified the same evidence.',
      requestId: 'accept',
    });
    assert.equal(done.workflow.state, 'done');
    await assert.rejects(
      async () =>
        await f.tasks.reissueReview(f.producer, {
          taskId: task.id,
          expectedRevision: done.workflow.revision,
          reason: 'Too late.',
          requestId: 'after-done',
        }),
      code('invalid_transition'),
    );
  } finally {
    await f.cleanup();
  }
});

test('review reissue rollback restores original claim and target revision', async () => {
  const f = await fixture();
  try {
    const task = await f.create();
    const pending = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [(await f.delivery()).id],
          expectedRevision: 0,
          requestId: 'delivery',
        },
        2,
      ),
    );
    const original = await f.reviews.start(f.reviewer, pending.reviewId!);
    const beforeReissue = await f.tasks.get(f.producer, task.id);
    const before = await f.state.events(f.producer.projectId);
    const append = f.state.appendEvent.bind(f.state);
    f.state.appendEvent = async (tx, event) => {
      const result = await append(tx, event);
      if (event.type === 'task.review_reissued') throw new Error('Injected reissue failure');
      return result;
    };
    const input = {
      taskId: task.id,
      expectedRevision: pending.workflow.revision,
      reason: 'Reviewer unavailable.',
      requestId: 'reissue',
    };
    await assert.rejects(
      async () => await f.tasks.reissueReview(f.producer, input),
      /Injected reissue failure/,
    );
    assert.deepEqual(await f.tasks.get(f.producer, task.id), beforeReissue);
    assert.deepEqual(await f.reviews.get(f.producer, original.id), original);
    assert.equal((await f.reviews.list(f.producer)).length, 1);
    assert.deepEqual(await f.state.events(f.producer.projectId), before);
    f.state.appendEvent = append;
    assert.notEqual((await f.tasks.reissueReview(f.producer, input)).reviewId, original.id);
  } finally {
    await f.cleanup();
  }
});
