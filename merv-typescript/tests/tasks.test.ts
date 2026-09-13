import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { TaskService } from '@merv/tasks';
import type { Caller, Workflows } from '@merv/contracts';

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'merv-task-test-'));
  const state = new SqliteState(join(path, 'state.db')),
    scope = new ProjectScope(state);
  const credentials = scope.bootstrap({ projectName: 'Test', actorName: 'Operator' });
  const operator: Caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const issue = (name: string, role: 'producer' | 'reviewer' | 'reader'): Caller => ({
    actorId: scope.issueActor(operator, { name, role }).actor.id,
    projectId: operator.projectId,
  });
  const producer = issue('Producer', 'producer'),
    reviewer = issue('Reviewer', 'reviewer'),
    reviewer2 = issue('Other reviewer', 'reviewer'),
    reader = issue('Reader', 'reader');
  const blobs = new DiskBlobs(join(path, 'blobs')),
    artifacts = new ArtifactStore(state, scope, blobs);
  const workflows = new WorkflowsService(state, scope),
    reviews = new ReviewService(state, scope, artifacts);
  const tasks = new TaskService(state, scope, artifacts, workflows, reviews);
  const brief = artifacts.create(producer, {
    title: 'Brief',
    content:
      '# Goal\nBuild an adder.\n# Done when\n- Adds two numbers.\n- Handles negative inputs.',
  });
  const create = () =>
    tasks.create(producer, {
      title: 'Adder',
      goal: 'Build an adder.',
      checks: ['Adds two numbers.', 'Handles negative inputs.'],
      briefId: brief.id,
      requestId: 'create',
    });
  const delivery = (label = 'Delivery') =>
    artifacts.create(producer, {
      title: label,
      content: `${label}\nAdds two numbers. Verified add(2,3)=5.\nHandles negative inputs. Verified add(-2,1)=-1.`,
    });
  const cleanup = () => {
    tasks.dispose();
    state.close();
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

test('task loop pins evidence, routes needs_changes and pass, and deduplicates mutations', () => {
  const f = fixture();
  try {
    const initial = f.create();
    assert.equal(initial.workflow.state, 'in_progress');
    assert.deepEqual(f.create(), initial);
    assert.throws(
      () =>
        f.tasks.create(f.producer, {
          title: 'Different',
          goal: initial.goal,
          checks: initial.checks,
          briefId: f.brief.id,
          requestId: 'create',
        }),
      code('request_conflict'),
    );
    assert.throws(
      () =>
        f.workflows.transition(f.producer, {
          instanceId: initial.id,
          action: 'submit_delivery',
          expectedRevision: 0,
          requestId: 'bypass',
        }),
      code('workflow_managed'),
    );
    assert.throws(
      () => f.workflows.start(f.producer, { workflow: 'task', requestId: 'bypass-start' }),
      code('workflow_managed'),
    );
    const delivery = f.delivery();
    const input = {
      taskId: initial.id,
      artifactIds: [delivery.id],
      expectedRevision: initial.workflow.revision,
      requestId: 'deliver',
    };
    const pending = f.tasks.submitDelivery(f.producer, input);
    assert.equal(pending.workflow.state, 'in_review');
    assert.deepEqual(f.tasks.submitDelivery(f.producer, input), pending);
    assert.throws(
      () => f.tasks.submitDelivery(f.producer, { ...input, artifactIds: [f.brief.id] }),
      code('request_conflict'),
    );
    const pinned = f.reviews.get(f.reviewer, pending.reviewId!);
    assert.deepEqual(pinned.artifactIds, [f.brief.id, delivery.id]);
    assert.equal(pinned.subjectRevision, pending.workflow.revision);
    assert.match(pinned.snapshotHash, /^[a-f0-9]{64}$/);
    assert.throws(() => f.reviews.start(f.producer, pinned.id), code('forbidden'));
    assert.throws(() => f.reviews.start(f.reader, pinned.id), code('forbidden'));
    const claimed = f.reviews.start(f.reviewer, pinned.id);
    assert.deepEqual(f.reviews.start(f.reviewer, pinned.id), claimed);
    assert.throws(() => f.reviews.start(f.reviewer2, pinned.id), code('review_unavailable'));
    assert.throws(
      () =>
        f.tasks.submitReview(f.reviewer2, {
          reviewId: pinned.id,
          verdict: 'pass',
          notes: 'Looks good',
          expectedRevision: pending.workflow.revision,
          requestId: 'wrong-reviewer',
        }),
      code('review_independence'),
    );
    assert.throws(
      () =>
        f.tasks.submitReview(f.reviewer, {
          reviewId: pinned.id,
          verdict: 'pass',
          notes: 'Verified',
          expectedRevision: 0,
          requestId: 'stale',
        }),
      code('revision_conflict'),
    );
    const revise = {
      reviewId: pinned.id,
      verdict: 'needs_changes' as const,
      notes: 'Include executable assertions.',
      expectedRevision: pending.workflow.revision,
      requestId: 'revise',
    };
    const revised = f.tasks.submitReview(f.reviewer, revise);
    assert.equal(revised.workflow.state, 'in_progress');
    assert.equal(revised.workflow.data.revisionContext, revise.notes);
    assert.deepEqual(f.tasks.submitReview(f.reviewer, revise), revised);
    assert.throws(
      () => f.tasks.submitReview(f.reviewer, { ...revise, verdict: 'pass' }),
      code('request_conflict'),
    );
    const second = f.tasks.submitDelivery(f.producer, {
      taskId: initial.id,
      artifactIds: [f.delivery('Executable assertions').id],
      expectedRevision: revised.workflow.revision,
      requestId: 'deliver2',
    });
    assert.notEqual(second.reviewId, pinned.id);
    assert.deepEqual(f.reviews.get(f.reviewer, pinned.id).artifactIds, pinned.artifactIds);
    assert.throws(
      () =>
        f.tasks.submitReview(f.reviewer, {
          ...revise,
          requestId: 'obsolete',
          expectedRevision: second.workflow.revision,
        }),
      code('stale_review'),
    );
    f.reviews.start(f.reviewer, second.reviewId!);
    const done = f.tasks.submitReview(f.reviewer, {
      reviewId: second.reviewId!,
      verdict: 'pass',
      notes: 'Ran both checks successfully.',
      expectedRevision: second.workflow.revision,
      requestId: 'accept',
    });
    assert.equal(done.workflow.state, 'done');
    assert.equal(done.workflow.data.outcome, 'Ran both checks successfully.');
    assert.equal(
      f.state.events(f.producer.projectId).filter((event) => event.type === 'task.review_applied')
        .length,
      2,
    );
  } finally {
    f.cleanup();
  }
});

test('failed workflow routing rolls back verdict, request record, and events atomically', () => {
  const f = fixture();
  let alternative: TaskService | undefined;
  try {
    const task = f.create(),
      delivery = f.delivery();
    const pending = f.tasks.submitDelivery(f.producer, {
      taskId: task.id,
      artifactIds: [delivery.id],
      expectedRevision: task.workflow.revision,
      requestId: 'deliver',
    });
    f.reviews.start(f.reviewer, pending.reviewId!);
    f.tasks.dispose();
    let fail = true;
    const wrapped: Workflows = {
      register: (definition) => {
        const handle = f.workflows.register(definition);
        return {
          ...handle,
          transition: (caller, input, tx) => {
            if (fail && input.action === 'accept') throw new Error('Injected route failure');
            return handle.transition(caller, input, tx);
          },
        };
      },
      start: f.workflows.start.bind(f.workflows),
      transition: f.workflows.transition.bind(f.workflows),
      get: f.workflows.get.bind(f.workflows),
      list: f.workflows.list.bind(f.workflows),
      history: f.workflows.history.bind(f.workflows),
      catalog: f.workflows.catalog.bind(f.workflows),
    };
    alternative = new TaskService(f.state, f.scope, f.artifacts, wrapped, f.reviews);
    const before = f.state.events(f.producer.projectId);
    const input = {
      reviewId: pending.reviewId!,
      verdict: 'pass' as const,
      notes: 'Verified both checks.',
      expectedRevision: pending.workflow.revision,
      requestId: 'accept',
    };
    assert.throws(() => alternative!.submitReview(f.reviewer, input), /Injected route failure/);
    assert.equal(f.reviews.get(f.reviewer, pending.reviewId!).status, 'started');
    assert.equal(f.tasks.get(f.producer, task.id).workflow.state, 'in_review');
    assert.deepEqual(f.state.events(f.producer.projectId), before);
    fail = false;
    assert.equal(alternative.submitReview(f.reviewer, input).workflow.state, 'done');
  } finally {
    alternative?.dispose();
    f.cleanup();
  }
});

test('brief and delivery gates enforce scope, authorship, check coverage, and fail routing', () => {
  const f = fixture();
  try {
    const credentials = f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
    const other = { actorId: credentials.actor.id, projectId: credentials.project.id };
    assert.throws(
      () =>
        f.tasks.create(other, {
          title: 'Steal',
          goal: 'Build an adder.',
          checks: ['Adds two numbers.'],
          briefId: f.brief.id,
          requestId: 'cross-project',
        }),
      code('not_found'),
    );
    const bad = f.artifacts.create(f.producer, {
      title: 'Missing checks',
      content: 'Build an adder.',
    });
    assert.throws(
      () =>
        f.tasks.create(f.producer, {
          title: 'Adder',
          goal: 'Build an adder.',
          checks: ['Adds two numbers.'],
          briefId: bad.id,
          requestId: 'bad-brief',
        }),
      code('invalid_brief'),
    );
    const task = f.create();
    assert.throws(() => f.tasks.get(other, task.id), code('not_found'));
    assert.throws(
      () => f.tasks.get({ ...f.producer, projectId: other.projectId }, task.id),
      code('forbidden'),
    );
    const partial = f.artifacts.create(f.producer, {
      title: 'Partial',
      content: 'Adds two numbers. Verified.',
    });
    assert.throws(
      () =>
        f.tasks.submitDelivery(f.producer, {
          taskId: task.id,
          artifactIds: [partial.id],
          expectedRevision: 0,
          requestId: 'partial',
        }),
      code('invalid_delivery'),
    );
    assert.equal(f.tasks.get(f.producer, task.id).workflow.state, 'in_progress');
    assert.equal(f.reviews.list(f.producer).length, 0);
    const pending = f.tasks.submitDelivery(f.producer, {
      taskId: task.id,
      artifactIds: [f.delivery().id],
      expectedRevision: 0,
      requestId: 'delivery',
    });
    f.reviews.start(f.reviewer, pending.reviewId!);
    assert.equal(
      f.tasks.submitReview(f.reviewer, {
        reviewId: pending.reviewId!,
        verdict: 'fail',
        notes: 'Goal cannot be achieved within scope.',
        expectedRevision: pending.workflow.revision,
        requestId: 'fail',
      }).workflow.state,
      'failed',
    );
  } finally {
    f.cleanup();
  }
});

test('generic reviews work without a workflow engine or task program and reject operator self-review', () => {
  const path = mkdtempSync(join(tmpdir(), 'merv-review-only-'));
  const state = new SqliteState(join(path, 'state.db')),
    scope = new ProjectScope(state);
  const credential = scope.bootstrap({ projectName: 'Standalone review', actorName: 'Operator' });
  const operator = { actorId: credential.actor.id, projectId: credential.project.id };
  const reviewer = {
    actorId: scope.issueActor(operator, { name: 'Reviewer', role: 'reviewer' }).actor.id,
    projectId: operator.projectId,
  };
  const artifacts = new ArtifactStore(state, scope, new DiskBlobs(join(path, 'blobs')));
  const reviews = new ReviewService(state, scope, artifacts);
  const f = {
    operator,
    reviewer,
    artifacts,
    reviews,
    cleanup: () => {
      state.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
  try {
    const artifact = f.artifacts.create(f.operator, {
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
    const requested = f.reviews.request(f.operator, input);
    assert.deepEqual(f.reviews.request(f.operator, input), requested);
    assert.throws(
      () => f.reviews.request(f.operator, { ...input, criteria: ['Different'] }),
      code('request_conflict'),
    );
    assert.throws(() => f.reviews.start(f.operator, requested.id), code('review_independence'));
    f.reviews.start(f.reviewer, requested.id);
    const submit = {
      reviewId: requested.id,
      verdict: 'pass' as const,
      notes: 'Assessed independently.',
      requestId: 'verdict',
    };
    assert.equal(f.reviews.submit(f.reviewer, submit).verdict, 'pass');
    assert.equal(f.reviews.submit(f.reviewer, submit).verdict, 'pass');
    assert.throws(
      () => f.reviews.submit(f.reviewer, { ...submit, requestId: 'new-verdict' }),
      code('review_closed'),
    );
  } finally {
    f.cleanup();
  }
});

test('task and pinned review resume after SQLite reopen', () => {
  const f = fixture();
  let reopened: SqliteState | undefined, restarted: TaskService | undefined;
  try {
    const task = f.create(),
      delivery = f.delivery();
    const content = f.artifacts.read(f.producer, delivery.id).content;
    const pending = f.tasks.submitDelivery(f.producer, {
      taskId: task.id,
      artifactIds: [delivery.id],
      expectedRevision: 0,
      requestId: 'deliver',
    });
    const snapshot = f.reviews.start(f.reviewer, pending.reviewId!);
    f.tasks.dispose();
    f.state.close();
    reopened = new SqliteState(join(f.path, 'state.db'));
    const scope = new ProjectScope(reopened),
      artifacts = new ArtifactStore(reopened, scope, f.blobs);
    const workflows = new WorkflowsService(reopened, scope),
      reviews = new ReviewService(reopened, scope, artifacts);
    restarted = new TaskService(reopened, scope, artifacts, workflows, reviews);
    assert.deepEqual(restarted.get(f.producer, task.id), pending);
    assert.deepEqual(reviews.get(f.reviewer, snapshot.id), snapshot);
    assert.equal(artifacts.read(f.reviewer, delivery.id).content, content);
    assert.equal(
      restarted.submitReview(f.reviewer, {
        reviewId: snapshot.id,
        verdict: 'pass',
        notes: 'Verified after restart.',
        expectedRevision: pending.workflow.revision,
        requestId: 'accept-after-restart',
      }).workflow.state,
      'done',
    );
  } finally {
    restarted?.dispose();
    reopened?.close();
    f.cleanup();
  }
});

test('failure after verdict and transition writes rolls back the complete transaction', () => {
  const f = fixture();
  try {
    const task = f.create(),
      delivery = f.delivery();
    const pending = f.tasks.submitDelivery(f.producer, {
      taskId: task.id,
      artifactIds: [delivery.id],
      expectedRevision: 0,
      requestId: 'delivery',
    });
    f.reviews.start(f.reviewer, pending.reviewId!);
    const events = f.state.events(f.producer.projectId),
      history = f.workflows.history(f.producer, task.id);
    const append = f.state.appendEvent.bind(f.state);
    f.state.appendEvent = (tx, event) => {
      const result = append(tx, event);
      if (event.type === 'task.review_applied') throw new Error('Injected final event failure');
      return result;
    };
    const input = {
      reviewId: pending.reviewId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'pass' as const,
      notes: 'Verified.',
      requestId: 'accept',
    };
    assert.throws(() => f.tasks.submitReview(f.reviewer, input), /Injected final event failure/);
    assert.equal(f.reviews.get(f.reviewer, pending.reviewId!).status, 'started');
    assert.equal(f.tasks.get(f.producer, task.id).workflow.state, 'in_review');
    assert.deepEqual(f.workflows.history(f.producer, task.id), history);
    assert.deepEqual(f.state.events(f.producer.projectId), events);
    f.state.appendEvent = append;
    assert.equal(f.tasks.submitReview(f.reviewer, input).workflow.state, 'done');
    assert.throws(
      () => f.artifacts.create(f.reviewer, { title: 'Unauthorized', content: 'Cannot write.' }),
      code('forbidden'),
    );
    assert.throws(
      () =>
        f.tasks.create(f.reviewer, {
          title: 'Unauthorized',
          goal: task.goal,
          checks: task.checks,
          briefId: task.briefId,
          requestId: 'reviewer-create',
        }),
      code('forbidden'),
    );
  } finally {
    f.cleanup();
  }
});

test('task briefs, review snapshots, and completed verdicts are immutable in storage', () => {
  const f = fixture();
  try {
    const task = f.create(),
      delivery = f.delivery();
    const pending = f.tasks.submitDelivery(f.producer, {
      taskId: task.id,
      artifactIds: [delivery.id],
      expectedRevision: 0,
      requestId: 'delivery',
    });
    assert.throws(
      () =>
        f.state.transaction((tx) =>
          tx.run('UPDATE tasks SET goal = ? WHERE id = ?', 'Changed goal', task.id),
        ),
      /brief is immutable/,
    );
    assert.throws(
      () =>
        f.state.transaction((tx) =>
          tx.run('UPDATE reviews SET subject_revision = ? WHERE id = ?', 9, pending.reviewId!),
        ),
      /snapshot is immutable/,
    );
    f.reviews.start(f.reviewer, pending.reviewId!);
    f.tasks.submitReview(f.reviewer, {
      reviewId: pending.reviewId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'pass',
      notes: 'Verified.',
      requestId: 'accept',
    });
    assert.throws(
      () =>
        f.state.transaction((tx) =>
          tx.run("UPDATE reviews SET verdict = 'fail' WHERE id = ?", pending.reviewId!),
        ),
      /verdict is immutable/,
    );
  } finally {
    f.cleanup();
  }
});

test('brief and delivery text gates reject invalid UTF-8 even when base64 contains check wording', () => {
  const f = fixture();
  try {
    const invalid = f.artifacts.create(f.producer, {
      title: 'Invalid UTF8',
      content: '/w==',
      encoding: 'base64',
      mediaType: 'text/plain',
    });
    assert.equal(f.artifacts.read(f.producer, invalid.id).encoding, 'base64');
    assert.throws(
      () =>
        f.tasks.create(f.producer, {
          title: 'Invalid brief',
          goal: '/w',
          checks: ['/w'],
          briefId: invalid.id,
          requestId: 'invalid-brief',
        }),
      code('invalid_brief'),
    );
    const brief = f.artifacts.create(f.producer, {
      title: 'Valid brief',
      content: 'Goal: Validate bytes.\nCheck: /w',
    });
    const task = f.tasks.create(f.producer, {
      title: 'Bytes',
      goal: 'Validate bytes.',
      checks: ['/w'],
      briefId: brief.id,
      requestId: 'bytes',
    });
    assert.throws(
      () =>
        f.tasks.submitDelivery(f.producer, {
          taskId: task.id,
          artifactIds: [invalid.id],
          expectedRevision: 0,
          requestId: 'invalid-delivery',
        }),
      code('invalid_delivery'),
    );
    assert.equal(f.tasks.get(f.producer, task.id).workflow.state, 'in_progress');
  } finally {
    f.cleanup();
  }
});

test('review reissue recovers revoked claims, preserves evidence, fences old revisions, and checks authority', () => {
  const f = fixture();
  try {
    const task = f.create();
    const pending = f.tasks.submitDelivery(f.producer, {
      taskId: task.id,
      artifactIds: [f.delivery().id],
      expectedRevision: 0,
      requestId: 'delivery',
    });
    const original = f.reviews.start(f.reviewer, pending.reviewId!);
    f.scope.revokeActor(f.operator, f.reviewer.actorId);
    assert.throws(
      () =>
        f.tasks.submitReview(f.reviewer, {
          reviewId: original.id,
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
    assert.throws(() => f.tasks.reissueReview(f.reviewer2, input), code('forbidden'));
    const otherActor = f.scope.issueActor(f.operator, {
      name: 'Another producer',
      role: 'producer',
    });
    const otherProducer = { actorId: otherActor.actor.id, projectId: f.operator.projectId };
    assert.throws(() => f.tasks.reissueReview(otherProducer, input), code('forbidden'));
    assert.throws(
      () => f.tasks.reissueReview(f.producer, { ...input, expectedRevision: 0 }),
      code('revision_conflict'),
    );
    const reissued = f.tasks.reissueReview(f.producer, input);
    assert.equal(reissued.workflow.state, 'in_review');
    assert.equal(reissued.workflow.revision, pending.workflow.revision + 1);
    assert.notEqual(reissued.reviewId, original.id);
    assert.deepEqual(f.tasks.reissueReview(f.producer, input), reissued);
    assert.throws(
      () => f.tasks.reissueReview(f.producer, { ...input, reason: 'Different reason.' }),
      code('request_conflict'),
    );
    assert.equal(f.reviews.get(f.producer, original.id).status, 'superseded');
    const current = f.reviews.get(f.producer, reissued.reviewId!);
    assert.deepEqual(current.artifactIds, original.artifactIds);
    assert.deepEqual(current.criteria, original.criteria);
    assert.equal(current.producerId, original.producerId);
    assert.equal(current.subjectRevision, reissued.workflow.revision);
    assert.notEqual(current.snapshotHash, original.snapshotHash);
    assert.throws(
      () =>
        f.tasks.submitReview(f.reviewer2, {
          reviewId: original.id,
          expectedRevision: reissued.workflow.revision,
          verdict: 'pass',
          notes: 'Old snapshot.',
          requestId: 'stale',
        }),
      code('stale_review'),
    );
    // Project operators can also recover on behalf of an unavailable producer.
    const operatorReissued = f.tasks.reissueReview(f.operator, {
      taskId: task.id,
      expectedRevision: reissued.workflow.revision,
      reason: 'Operator recovery.',
      requestId: 'operator-reissue',
    });
    assert.equal(
      f.reviews.get(f.operator, operatorReissued.reviewId!).producerId,
      f.producer.actorId,
    );
    f.reviews.start(f.reviewer2, operatorReissued.reviewId!);
    const done = f.tasks.submitReview(f.reviewer2, {
      reviewId: operatorReissued.reviewId!,
      expectedRevision: operatorReissued.workflow.revision,
      verdict: 'pass',
      notes: 'Replacement independently verified the same evidence.',
      requestId: 'accept',
    });
    assert.equal(done.workflow.state, 'done');
    assert.throws(
      () =>
        f.tasks.reissueReview(f.producer, {
          taskId: task.id,
          expectedRevision: done.workflow.revision,
          reason: 'Too late.',
          requestId: 'after-done',
        }),
      code('invalid_transition'),
    );
  } finally {
    f.cleanup();
  }
});

test('review reissue rollback restores original claim and target revision', () => {
  const f = fixture();
  try {
    const task = f.create();
    const pending = f.tasks.submitDelivery(f.producer, {
      taskId: task.id,
      artifactIds: [f.delivery().id],
      expectedRevision: 0,
      requestId: 'delivery',
    });
    const original = f.reviews.start(f.reviewer, pending.reviewId!);
    const before = f.state.events(f.producer.projectId);
    const append = f.state.appendEvent.bind(f.state);
    f.state.appendEvent = (tx, event) => {
      const result = append(tx, event);
      if (event.type === 'task.review_reissued') throw new Error('Injected reissue failure');
      return result;
    };
    const input = {
      taskId: task.id,
      expectedRevision: pending.workflow.revision,
      reason: 'Reviewer unavailable.',
      requestId: 'reissue',
    };
    assert.throws(() => f.tasks.reissueReview(f.producer, input), /Injected reissue failure/);
    assert.deepEqual(f.tasks.get(f.producer, task.id), pending);
    assert.deepEqual(f.reviews.get(f.producer, original.id), original);
    assert.equal(f.reviews.list(f.producer).length, 1);
    assert.deepEqual(f.state.events(f.producer.projectId), before);
    f.state.appendEvent = append;
    assert.notEqual(f.tasks.reissueReview(f.producer, input).reviewId, original.id);
  } finally {
    f.cleanup();
  }
});
