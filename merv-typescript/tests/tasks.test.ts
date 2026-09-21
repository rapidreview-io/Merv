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
import { TASK_TYPES } from '../packages/tasks/src/definitions.js';
import type { Caller, ReviewHistory, Workflows } from '@merv/contracts';

async function fixture(limits?: { reviewRounds: number }) {
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
    new TaskService(state, scope, artifacts, workflows, reviews, builder, limits),
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
    builder,
    tasks,
    brief,
    create,
    delivery,
    cleanup,
  };
}
const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test('task reads, context and failure keep their original caller and inputs', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const task = await f.create();
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const foreign = { projectId: other.project.id, actorId: other.actor.id };
  for (const method of ['get', 'record', 'records', 'list', 'process'] as const) {
    await t.test(method, async () => {
      const caller = { ...(method === 'process' ? f.producer : foreign) };
      const reading =
        method === 'list' || method === 'records'
          ? f.tasks[method](caller)
          : f.tasks[method](caller, task.id);
      Object.assign(caller, method === 'process' ? foreign : f.producer);
      if (method === 'list' || method === 'records') assert.deepEqual(await reading, []);
      else if (method === 'process') await reading;
      else await assert.rejects(reading, code('not_found'));
    });
  }
  await t.test('context', async () => {
    const caller = { ...f.producer };
    const input = {
      taskId: task.id,
      purpose: 'work' as const,
      expectedRevision: 0,
      requestId: 'context',
    };
    const original = { ...input };
    const building = f.tasks.context(caller, input);
    Object.assign(caller, f.reader);
    input.requestId = 'replacement';
    const context = await building;
    assert.deepEqual(await f.tasks.context(f.producer, original), context);
  });
  await t.test('failure', async () => {
    const caller = { ...f.producer };
    const input = {
      taskId: task.id,
      expectedRevision: 0,
      reason: 'Original reason',
      requestId: 'failure',
    };
    const failing = f.tasks.markFailed(caller, input);
    Object.assign(caller, f.operator);
    input.reason = 'Replacement reason';
    const failed = await failing;
    assert.equal(failed.failure!.actorId, f.producer.actorId);
    assert.equal(failed.failure!.reason, 'Original reason');
  });
});

test('a task can be created inside a caller\u2019s transaction and rolls back with it', async () => {
  const f = await fixture();
  try {
    // A wave materialized from one approved decision creates its records together or not at
    // all, so task creation has to compose into the caller's transaction like every other.
    await assert.rejects(
      async () =>
        await f.state.transaction(async (tx) => {
          const task = await f.tasks.create(
            f.producer,
            {
              title: 'Composed',
              goal: 'Build an adder.',
              checks: ['Adds two numbers.'],
              requestId: 'composed',
            },
            tx,
          );
          assert.ok(task.id);
          throw new Error('Abandon the wave');
        }),
      /Abandon the wave/,
    );
    assert.equal((await f.tasks.list(f.producer)).length, 0);
  } finally {
    await f.cleanup();
  }
});

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
    const caller = { ...f.producer },
      deliveryInput = confirmedDelivery(structuredClone(input), 2);
    const delivering = f.tasks.submitDelivery(caller, deliveryInput);
    Object.assign(caller, f.operator);
    deliveryInput.artifactIds.length = 0;
    const pending = await delivering;
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
    await assert.rejects(
      f.tasks.submitReview(f.reviewer, { ...revise, paperChanges: { documents: [] } }),
      code('paper_edits_unavailable'),
    );
    const decision = structuredClone(revise);
    Object.assign(caller, f.reviewer);
    const revising = f.tasks.submitReview(caller, decision);
    Object.assign(caller, f.reviewer2);
    decision.notes = 'Replacement verdict notes';
    const revised = await revising;
    assert.equal(revised.workflow.state, 'in_progress');
    assert.equal(revised.workflow.data.revisionContext, revise.notes);
    assert.deepEqual(await f.tasks.submitReview(f.reviewer, revise), revised);
    await assert.rejects(
      async () => await f.tasks.submitReview(f.reviewer, { ...revise, verdict: 'pass' }),
      code('request_conflict'),
    );
    // The confirmation sheet Merv rendered for the first delivery is not new evidence.
    await assert.rejects(
      async () =>
        await f.tasks.submitDelivery(
          f.producer,
          confirmedDelivery(
            {
              taskId: initial.id,
              artifactIds: [pending.deliveryAssessmentId!],
              expectedRevision: revised.workflow.revision,
              requestId: 'deliver-sheet',
            },
            2,
          ),
        ),
      code('invalid_delivery'),
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

test('a task rejected more than once carries every earlier round into the next work context', async () => {
  const f = await fixture();
  try {
    const context = async (taskId: string, expectedRevision: number) =>
      await f.tasks.context(f.producer, {
        taskId,
        purpose: 'work',
        expectedRevision,
        requestId: `context-${taskId}-${expectedRevision}`,
      });
    /** One delivery sent back with a finding against the first check. */
    const reject = async (taskId: string, revision: number, round: number) => {
      const pending = await f.tasks.submitDelivery(
        f.producer,
        confirmedDelivery(
          {
            taskId,
            artifactIds: [(await f.delivery(`Delivery ${taskId} ${round}`)).id],
            expectedRevision: revision,
            requestId: `deliver-${taskId}-${round}`,
          },
          2,
        ),
      );
      const review = await f.reviews.start(f.reviewer, pending.reviewId!);
      const returned = await f.tasks.submitReview(f.reviewer, {
        ...reviewedFindings(review),
        findings: review.criteria.map((_, index) => ({
          criterionNumber: index + 1,
          status: index ? ('met' as const) : ('not_met' as const),
          evidenceIds: review.artifactIds.slice(1, -1),
          notes: `ROUND_${round}_FINDING_${index + 1}`,
        })),
        reviewId: review.id,
        claimId: review.claimId!,
        verdict: 'needs_changes',
        notes: `ROUND_${round}_NOTES`,
        expectedRevision: pending.workflow.revision,
        requestId: `reject-${taskId}-${round}`,
      });
      return { review, returned };
    };
    const task = await f.create();
    const first = await reject(task.id, task.workflow.revision, 1);
    assert.deepEqual(first.returned.workflow.data.rejectedReviewIds, [first.review.id]);
    // One rejection reads exactly as it did before rounds were carried: nothing is earlier yet.
    const once = await context(task.id, first.returned.workflow.revision);
    assert.match(once.prompt, /ROUND_1_NOTES/);
    assert.doesNotMatch(once.prompt, /Earlier review rounds/);

    const second = await reject(task.id, first.returned.workflow.revision, 2);
    assert.deepEqual(second.returned.workflow.data.rejectedReviewIds, [
      first.review.id,
      second.review.id,
    ]);
    assert.equal(second.returned.workflow.data.revisionContext, 'ROUND_2_NOTES');
    const twice = await context(task.id, second.returned.workflow.revision);
    assert.ok(!twice.omitted.includes('feedback'));
    assert.match(twice.prompt, /Pinned review assessment[^]*ROUND_2_FINDING_1/);
    const history = JSON.parse(
      twice.prompt.slice(twice.prompt.indexOf('{"rounds":')).split('\n')[0]!,
    ) as ReviewHistory;
    assert.equal(history.omittedRounds, 0);
    assert.deepEqual(
      history.rounds.map(({ round, reviewId, notes, unmet }) => ({
        round,
        reviewId,
        notes,
        unmet: unmet.map((finding) => finding.notes),
      })),
      [
        {
          round: 1,
          reviewId: first.review.id,
          notes: 'ROUND_1_NOTES',
          unmet: ['ROUND_1_FINDING_1'],
        },
      ],
    );
    assert.ok(!JSON.stringify(history).includes(f.reviewer.actorId));

    // A pass closes the loop without touching the list of rejected rounds.
    const third = await f.tasks.submitDelivery(
      f.producer,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [(await f.delivery('Final delivery')).id],
          expectedRevision: second.returned.workflow.revision,
          requestId: 'deliver-final',
        },
        2,
      ),
    );
    const last = await f.reviews.start(f.reviewer, third.reviewId!);
    const done = await f.tasks.submitReview(f.reviewer, {
      ...reviewedFindings(last),
      reviewId: last.id,
      claimId: last.claimId!,
      verdict: 'pass',
      notes: 'Verified.',
      expectedRevision: third.workflow.revision,
      requestId: 'accept-final',
    });
    assert.deepEqual(done.workflow.data.rejectedReviewIds, [first.review.id, second.review.id]);
  } finally {
    await f.cleanup();
  }
});

test('feedback that no longer fits a nearly full recipe is reported omitted, never cut', async () => {
  const f = await fixture();
  const disposers: (() => void)[] = [];
  try {
    const work = async (taskId: string, expectedRevision: number) =>
      await f.tasks.context(f.producer, {
        taskId,
        purpose: 'work',
        expectedRevision,
        requestId: `context-${taskId}-${expectedRevision}`,
      });
    const typed = async (name: string, maxChars: number) => {
      const definition = structuredClone(TASK_TYPES[0]);
      disposers.push(
        await f.tasks.registerType({
          ...definition,
          name,
          recipe: { ...definition.recipe, maxChars },
        }),
      );
      let task = await f.tasks.create(f.producer, {
        title: 'Adder',
        goal: 'Build an adder.',
        checks: ['Adds two numbers.', 'Handles negative inputs.'],
        briefId: f.brief.id,
        requestId: `create-${name}`,
        type: name,
        typeVersion: definition.version,
      });
      for (const round of [1, 2]) {
        const pending = await f.tasks.submitDelivery(
          f.producer,
          confirmedDelivery(
            {
              taskId: task.id,
              artifactIds: [(await f.delivery(`Delivery ${round}`)).id],
              expectedRevision: task.workflow.revision,
              requestId: `deliver-${name}-${round}`,
            },
            2,
          ),
        );
        const review = await f.reviews.start(f.reviewer, pending.reviewId!);
        task = await f.tasks.submitReview(f.reviewer, {
          ...reviewedFindings(review),
          reviewId: review.id,
          claimId: review.claimId!,
          verdict: 'needs_changes',
          notes: `Round ${round} was not reproducible.`,
          expectedRevision: pending.workflow.revision,
          requestId: `reject-${name}-${round}`,
        });
      }
      return await work(task.id, task.workflow.revision);
    };
    // Twice rejected under a roomy copy of the default recipe, everything fits.
    const roomy = await typed('task.roomy', 48_000);
    assert.ok(!roomy.omitted.includes('feedback'));
    assert.match(roomy.prompt, /Pinned review assessment[^]*Earlier review rounds/);
    // The same task under a budget 200 characters short of that: Context Builder drops an optional
    // section whole. The worker is told feedback is missing and can still read every round with
    // review.get; a half-cut assessment would mislead instead.
    const budget = roomy.prompt.length - 200;
    const tight = await typed('task.tight', budget);
    assert.ok(tight.omitted.includes('feedback'));
    assert.doesNotMatch(tight.prompt, /Pinned review assessment|Earlier review rounds/);
    assert.ok(tight.prompt.length <= budget);
  } finally {
    for (const dispose of disposers) dispose();
    await f.cleanup();
  }
});

test('a task sent back before rounds were recorded keeps that round at its next rejection', async () => {
  const f = await fixture();
  try {
    const task = await f.create();
    const deliver = async (revision: number, round: number) =>
      await f.tasks.submitDelivery(
        f.producer,
        confirmedDelivery(
          {
            taskId: task.id,
            artifactIds: [(await f.delivery(`Delivery ${round}`)).id],
            expectedRevision: revision,
            requestId: `deliver-${round}`,
          },
          2,
        ),
      );
    const reject = async (pending: Awaited<ReturnType<typeof deliver>>, round: number) => {
      const review = await f.reviews.start(f.reviewer, pending.reviewId!);
      const returned = await f.tasks.submitReview(f.reviewer, {
        ...reviewedFindings(review),
        reviewId: review.id,
        claimId: review.claimId!,
        verdict: 'needs_changes',
        notes: `LEGACY_ROUND_${round}`,
        expectedRevision: pending.workflow.revision,
        requestId: `reject-${round}`,
      });
      return { review, returned };
    };
    const first = await reject(await deliver(task.workflow.revision, 1), 1);
    // The record as an older server left it: one round in revisionContext and reviewId, no list.
    await f.state.transaction(async (tx) => {
      const row = (await tx.get<{ data_json: string }>(
        'SELECT data_json FROM wf_instances WHERE id=?',
        task.id,
      ))!;
      const { rejectedReviewIds: _dropped, ...legacy } = JSON.parse(row.data_json) as Record<
        string,
        unknown
      >;
      await tx.run(
        'UPDATE wf_instances SET data_json=? WHERE id=?',
        JSON.stringify(legacy),
        task.id,
      );
    });
    const legacy = await f.tasks.get(f.producer, task.id);
    assert.equal(legacy.workflow.data.rejectedReviewIds, undefined);
    const context = await f.tasks.context(f.producer, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: legacy.workflow.revision,
      requestId: 'legacy-context',
    });
    assert.match(context.prompt, /LEGACY_ROUND_1/);
    assert.doesNotMatch(context.prompt, /Earlier review rounds/);
    const second = await reject(await deliver(legacy.workflow.revision, 2), 2);
    assert.deepEqual(second.returned.workflow.data.rejectedReviewIds, [
      first.review.id,
      second.review.id,
    ]);
  } finally {
    await f.cleanup();
  }
});

/** One delivery and the verdict input for its review, claimed by the fixture's reviewer. */
async function round(f: Awaited<ReturnType<typeof fixture>>, taskId: string, label: string) {
  const task = await f.tasks.get(f.producer, taskId);
  const pending = await f.tasks.submitDelivery(
    f.producer,
    confirmedDelivery(
      {
        taskId,
        artifactIds: [(await f.delivery(label)).id],
        expectedRevision: task.workflow.revision,
        requestId: `deliver-${label}`,
      },
      2,
    ),
  );
  const review = await f.reviews.start(f.reviewer, pending.reviewId!);
  return {
    pending,
    verdict: (verdict: 'pass' | 'needs_changes', requestId: string) => ({
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      verdict,
      notes: `Round ${label}.`,
      ...(verdict === 'pass' ? { evidence: { outcome: 'Both checks ran.' } } : {}),
      expectedRevision: pending.workflow.revision,
      requestId,
    }),
  };
}

test('the fourth return of a task is refused whole, the task escalates, and a grant buys one more', async () => {
  const f = await fixture();
  try {
    const task = await f.create();
    for (const label of ['one', 'two', 'three']) {
      const { verdict } = await round(f, task.id, label);
      await f.tasks.submitReview(f.reviewer, verdict('needs_changes', `revise-${label}`));
    }
    const { pending, verdict } = await round(f, task.id, 'four');
    const guidance = await f.workflows.evaluate(f.reviewer, task.id);
    assert.equal(guidance.currentGate, 'loop_limit_reached');
    assert.deepEqual(
      guidance.limits.map((limit) => [limit.name, limit.actions, limit.used, limit.max]),
      [['review_rounds', ['revise'], 3, 3]],
    );
    assert.deepEqual((await f.workflows.overview(f.operator)).escalated, [task.id]);

    const events = (await f.state.events(f.operator.projectId)).length;
    await assert.rejects(
      async () => await f.tasks.submitReview(f.reviewer, verdict('needs_changes', 'revise-four')),
      (error: unknown) =>
        code('loop_limit_reached')(error) &&
        /review_rounds is exhausted on this task \(3\/3\)/.test((error as Error).message),
    );
    assert.equal((await f.state.events(f.operator.projectId)).length, events);
    assert.equal((await f.reviews.get(f.reviewer, pending.reviewId!)).verdict, null);
    assert.deepEqual((await f.tasks.get(f.producer, task.id)).workflow, pending.workflow);

    // A reviewer cannot allow itself another round; a project admin can.
    const grant = {
      instanceId: task.id,
      limit: 'review_rounds',
      additional: 1,
      reason: 'The last finding is small and specific.',
      requestId: 'one-more',
    };
    await assert.rejects(async () => await f.workflows.extendLimit(f.reviewer, grant));
    await f.workflows.extendLimit(f.operator, grant);
    assert.deepEqual((await f.tasks.get(f.producer, task.id)).workflow, pending.workflow);
    assert.deepEqual((await f.workflows.overview(f.operator)).escalated, []);
    const revised = await f.tasks.submitReview(
      f.reviewer,
      verdict('needs_changes', 'revise-four-allowed'),
    );
    assert.equal(revised.workflow.state, 'in_progress');
  } finally {
    await f.cleanup();
  }
});

test('an escalated task can still be accepted by a human reviewer', async () => {
  const f = await fixture({ reviewRounds: 1 });
  try {
    const task = await f.create();
    const first = await round(f, task.id, 'one');
    await f.tasks.submitReview(f.reviewer, first.verdict('needs_changes', 'revise-one'));
    const { verdict } = await round(f, task.id, 'two');
    assert.deepEqual((await f.workflows.overview(f.operator)).escalated, [task.id]);
    const done = await f.tasks.submitReview(f.reviewer, verdict('pass', 'accept'));
    assert.equal(done.workflow.state, 'done');
    assert.deepEqual((await f.workflows.overview(f.operator)).escalated, []);
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
      systemPrerequisites: f.workflows.systemPrerequisites.bind(f.workflows),
      dispatchCandidates: f.workflows.dispatchCandidates.bind(f.workflows),
      extendLimit: f.workflows.extendLimit.bind(f.workflows),
      dependencyClosure: f.workflows.dependencyClosure.bind(f.workflows),
      replaceBlockers: f.workflows.replaceBlockers.bind(f.workflows),
      blockers: f.workflows.blockers.bind(f.workflows),
      dependencyRelations: f.workflows.dependencyRelations.bind(f.workflows),
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
    const caller = { ...f.producer },
      request = { ...input };
    const reissuing = f.tasks.reissueReview(caller, request);
    Object.assign(caller, f.reader);
    request.reason = 'Replacement reason';
    const reissued = await reissuing;
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

test('task creation retains the validated input while its pinned brief is read', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const original = {
    title: 'Original task',
    goal: 'Build an adder.',
    checks: ['Adds two numbers.', 'Handles negative inputs.'],
    briefId: f.brief.id,
    requestId: 'input-snapshot',
  };
  const input = structuredClone(original);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = f.artifacts.read.bind(f.artifacts);
  t.mock.method(f.artifacts, 'read', async (...args: Parameters<typeof read>) => {
    const result = await read(...args);
    enter();
    await waiting;
    return result;
  });
  const caller = { ...f.producer };
  const pending = f.tasks.create(caller, input);
  try {
    await entered;
    input.title = '';
    input.checks.splice(0, 2, 'Adds');
    input.requestId = 'mutated-request';
    Object.assign(caller, f.operator);
  } finally {
    release();
  }
  const task = await pending;
  assert.equal(task.producerId, f.producer.actorId);
  assert.equal(task.title, original.title);
  assert.deepEqual(task.checks, original.checks);
  assert.deepEqual(await f.tasks.create(f.producer, original), task);
  assert.equal((await f.tasks.list(f.producer)).length, 1);
});

test('task type registration snapshots the definition before Context Builder yields', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const definition = { ...structuredClone(TASK_TYPES[0]), name: 'task.snapshot' };
  const original = structuredClone(definition);
  const register = f.builder.register.bind(f.builder);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.builder, 'register', async (...args: Parameters<typeof register>) => {
    const handle = await register(...args);
    enter();
    await waiting;
    return handle;
  });
  const pending = f.tasks.registerType(definition);
  try {
    await entered;
    definition.name = 'task.changed';
    definition.version = 999;
    definition.recipe.sections.length = 0;
  } finally {
    release();
  }
  const dispose = await pending;
  try {
    const task = await f.tasks.create(f.producer, {
      title: 'Original type',
      goal: 'Build an adder.',
      checks: ['Adds two numbers.'],
      briefId: f.brief.id,
      requestId: 'registered-type',
      type: original.name,
      typeVersion: original.version,
    });
    const context = await f.tasks.context(f.producer, {
      taskId: task.id,
      purpose: 'work',
      requestId: 'registered-context',
      expectedRevision: task.workflow.revision,
    });
    assert.equal(context.type, original.name);
    assert.equal(context.typeVersion, original.version);
  } finally {
    dispose();
  }
});

for (const pending of [false, true]) {
  test(`task type registration ${pending ? 'pending during' : 'started after'} disposal cannot retain a context recipe`, async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const definition = { ...structuredClone(TASK_TYPES[0]), name: 'task.retired' };
    const register = f.builder.register.bind(f.builder);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (pending)
      t.mock.method(f.builder, 'register', async (...args: Parameters<typeof register>) => {
        const handle = await register(...args);
        enter();
        await waiting;
        return handle;
      });
    else f.tasks.dispose();
    const registration = f.tasks.registerType(definition);
    const rejected = assert.rejects(registration, { code: 'tasks_closed' });
    try {
      if (pending) {
        await entered;
        f.tasks.dispose();
      }
    } finally {
      release();
    }
    await rejected;
    const replacement = await register(definition);
    replacement.dispose();
  });
}

test('task checkpoints retain validated notes and artifact IDs during evidence lookup', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const task = await f.create(),
    evidence = await f.delivery();
  const original = {
    taskId: task.id,
    purpose: 'work' as const,
    expectedRevision: task.workflow.revision,
    requestId: 'stable-checkpoint',
    notes: 'Verified the current result.',
    artifactIds: [evidence.id],
  };
  const input = structuredClone(original);
  const get = f.artifacts.get.bind(f.artifacts);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.artifacts, 'get', async (...args: Parameters<typeof get>) => {
    const result = await get(...args);
    if (args[1] === evidence.id) {
      enter();
      await waiting;
    }
    return result;
  });
  const caller = { ...f.producer };
  const pending = f.tasks.checkpoint(caller, input);
  try {
    await entered;
    input.notes = '';
    input.artifactIds[0] = 'unchecked-artifact';
    Object.assign(caller, f.operator);
  } finally {
    release();
  }
  const checkpoint = await pending;
  assert.equal(checkpoint.actorId, f.producer.actorId);
  assert.equal(checkpoint.notes, original.notes);
  assert.deepEqual(checkpoint.artifactIds, original.artifactIds);
  assert.deepEqual(await f.tasks.checkpoint(f.producer, original), checkpoint);
});
