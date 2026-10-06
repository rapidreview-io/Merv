import { reviewActions } from '@merv/reviews/rules';
import { types as nodeTypes } from 'node:util';
import {
  check,
  requireHuman,
  type Caller,
  type Data,
  type ReviewRequest,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowPolicy,
  type WorkflowSnapshot,
} from '@merv/contracts';
import { taskExecutionPolicy } from './execution-policy.js';
import type { TaskDeliveryCode, TaskReview } from './types.js';
import type { TasksContext } from './index.js';
import {
  GIT_CLAIM,
  producing,
  roundsFrom,
  serviceOwned,
  taskContract,
  taskWorkspace,
} from './workflow.js';
import { checkDelivery, checkFailure, checkReissue } from './commands.js';
import {
  workflowAssignment,
  workflowAssignmentFacts,
  workflowExecutionReferences,
} from './context.js';
import { currentLease, leaseHooks, leasedClaim, prepareTasks, unleased } from './lease.js';

// The task workflow's policy and the checks its review actions run. Each runs on TaskService
// (index.ts) as its TasksContext.

/** Tasks have fixed routes; inspect only an ordinary optional data property. */
export function rejectReviewReturn(input: object): void {
  const message = 'Task reviews have fixed return routes and do not accept returnTo';
  check(
    input && typeof input === 'object' && !nodeTypes.isProxy(input),
    'invalid_review_return',
    message,
  );
  const prototype = Object.getPrototypeOf(input);
  check(prototype === Object.prototype || prototype === null, 'invalid_review_return', message);
  const descriptor = Object.getOwnPropertyDescriptor(input, 'returnTo');
  check(
    !descriptor || ('value' in descriptor && descriptor.value === undefined),
    'invalid_review_return',
    message,
  );
}

export function workflowPolicy(ctx: TasksContext, version: number): WorkflowPolicy {
  const taskArguments = ({ snapshot }: WorkflowCheckContext): Data => ({
    taskId: snapshot.id,
    expectedRevision: snapshot.revision,
  });
  return {
    successStates: ['done'],
    dependencyFailureAction: 'mark_failed',
    limits: [
      {
        name: 'review_rounds',
        from: roundsFrom(version),
        actions: serviceOwned(version) ? ['submit_delivery', 'mark_failed'] : ['revise'],
        max: ctx.limits.reviewRounds,
      },
    ],
    ...(serviceOwned(version)
      ? {
          limitExtended: async (context: WorkflowCheckContext) => {
            if (context.snapshot.state !== 'suspended') return;
            await ctx.registration(version).transition(
              context.caller,
              {
                instanceId: context.snapshot.id,
                expectedRevision: context.snapshot.revision,
                action: 'resume',
                requestId: `task:resume:${context.input!.requestId}`,
                input: context.input,
                // The task runs again; the reason it stopped stays its feedback, not a failure.
                data: { failure: null },
              },
              context.tx,
            );
          },
        }
      : {}),
    assignments: [
      {
        state: 'in_progress',
        requiresDependencies: true,
        check: async (context) => {
          await workflowAssignmentFacts(ctx, context);
          const { caller, snapshot, tx } = context;
          await unleased(ctx, caller, snapshot.id, snapshot.revision, tx);
        },
        build: async (context) => await workflowAssignment(ctx, context),
        execution: taskExecutionPolicy(
          'work',
          taskWorkspace(version),
          taskContract(version).largeUploads,
        ),
        references: async (context) => await workflowExecutionReferences(ctx, context),
        lease: leaseHooks(ctx),
      },
      {
        state: 'in_review',
        check: async (context) => {
          await workflowAssignmentFacts(ctx, context);
        },
        build: async (context) => await workflowAssignment(ctx, context),
        execution: taskExecutionPolicy(
          'review',
          taskWorkspace(version),
          taskContract(version).largeUploads,
        ),
        references: async (context) => await workflowExecutionReferences(ctx, context),
        lease: leaseHooks(ctx),
      },
    ],
    prepare: async (context) => await prepareTasks(ctx, context),
    describe: async ({ caller, snapshot, tx, dependencies }) => {
      const row = await ctx.row(tx, caller, snapshot.id);
      const review = row.review_id ? await ctx.reviews.get(caller, row.review_id, tx) : null;
      const recovering =
        review?.status === 'started' &&
        review.reviewerId &&
        !(await ctx.scope.eligible(caller.projectId, review.reviewerId, 'review', tx));
      const [gate, waiting] =
        snapshot.state === 'suspended'
          ? [
              'suspended',
              'This service task is suspended. A signed-in human operator can resume this same task with workflow.extend_limit (review_rounds), or cancel/replan its waiters.',
            ]
          : snapshot.state === 'in_progress'
            ? ['delivery_required', 'The task producer must complete and submit the delivery.']
            : recovering
              ? [
                  'review_recovery_pending',
                  'The reviewer no longer has access. Recovery must reopen the claim before another reviewer can begin.',
                ]
              : review?.waiting
                ? ['review_provenance_blocked', review.waiting]
                : review?.status === 'requested'
                  ? [
                      'review_required',
                      'Wait for an independent reviewer to claim this review. The producer cannot review its own work.',
                    ]
                  : [
                      'independent_review',
                      'An independent review is in progress. Wait for its verdict; no producer transition is needed.',
                    ];
      return {
        label: row.title,
        gate,
        waiting,
        // A delivery names its worker's own commit, so only a leased worker ever makes one.
        owner: { actorId: row.producer_id, leased: ['submit_delivery'] },
        references: [
          ...(dependencies ?? []).map((dependency) => ({
            kind: 'workflow',
            id: dependency.id,
            label: `Prerequisite: ${dependency.name || dependency.id}`,
          })),
          { kind: 'artifact', id: row.brief_id, label: 'Pinned brief' },
          ...(JSON.parse(row.delivery_ids) as string[]).map((id) => ({
            kind: 'artifact',
            id,
            label:
              id === snapshot.data.deliveryCodeArtifactId
                ? 'Delivered commit'
                : 'Submitted delivery',
          })),
          ...(row.review_id
            ? [{ kind: 'review', id: row.review_id, label: 'Current independent review' }]
            : []),
        ],
      };
    },
    actions: [
      ...(serviceOwned(version)
        ? [
            {
              name: 'resume',
              states: ['suspended'],
              transitions: ['resume'],
              tool: 'workflow.extend_limit',
              suggested: false,
              instruction:
                'A signed-in human operator extends review_rounds to resume this same task.',
              check: async ({ caller, tx, snapshot }: WorkflowCheckContext) => {
                requireHuman(
                  caller,
                  'forbidden',
                  'Only a signed-in human operator resumes service work',
                );
                await ctx.scope.require(caller, 'admin', tx);
                const limit = (
                  await ctx.workflows.limitStatusOf(caller, [snapshot.id], 'review_rounds', tx)
                ).get(snapshot.id)!;
                check(
                  !limit.exhausted,
                  'workflow_limit_exhausted',
                  'Extend review_rounds before resuming',
                  409,
                );
              },
            },
          ]
        : []),
      {
        name: 'submit_delivery',
        states: ['in_progress'],
        transitions: ['submit_delivery'],
        requiresDependencies: true,
        tool: 'task.submit_delivery',
        instruction:
          'Read the task context and inspect any completed prerequisites through their referenced records. Complete the pinned brief and retain evidence for every check. When returning for changes, read the previous review with review.get and address its findings. Submit confirmations with each checkNumber, met/not_met status, evidenceIds from the submitted artifacts, and notes explaining your verification or what remains unmet. Submit for independent review, then stop producer work while the review is pending.',
        // A Git task also needs the commandId of this worker's own successful code.commit,
        // and only a leased worker can obtain one; guidance says so before the refusal does.
        requiredInput: ['artifactIds', 'commandId', 'confirmations'],
        arguments: taskArguments,
        check: async (context) => {
          if (!ctx.checked.found(context)) await checkDelivery(ctx, context);
        },
      },
      ...reviewActions<WorkflowCheckContext>({
        names: { submit: 'submit_review', start: 'start_review' },
        states: ['in_review'],
        transitions: [
          'accept',
          'revise',
          'fail_review',
          ...(serviceOwned(version) ? ['revise_suspended'] : []),
        ],
        instructions: {
          submit:
            'Read the review context and independently inspect the pinned evidence. Submit a verdict with verification notes. Include a short plain synopsis and one finding per numbered criterion: met, not_met, not_verified or waived, cited pinned evidenceIds and verification, correction or explicit waiver reasons. Pass requires every criterion met or explicitly waived, and a criterion the review names in requiredCriteria met, never waived; also judge whether the overall goal was achieved. Stop after the verdict; its task transition is automatic.',
          start:
            'Claim this independent review, then refresh its guidance and read the context for your new assignment.' +
            ` ${GIT_CLAIM}`,
        },
        reviews: ctx.reviews,
        // Refuses a named reviewId that is not the current submission's.
        current: async (context) => await currentReview(ctx, context),
        submit: async (context) => await checkTaskReview(ctx, context),
        start: async ({ caller, snapshot, tx }) => await leasedClaim(ctx, caller, snapshot, tx),
      }),
      {
        name: 'reissue_review',
        states: ['in_review'],
        transitions: ['reissue_review'],
        tool: 'task.reissue_review',
        suggested: false,
        requiredInput: ['reason'],
        arguments: taskArguments,
        instruction:
          'Only if the current review needs replacement: give a reason to supersede it while preserving the evidence. Normal progress waits for the reviewer.',
        check: async (context) => {
          await checkReissue(ctx, context);
        },
      },
      {
        name: 'mark_failed',
        states: ['in_progress', 'in_review'],
        transitions: ['mark_failed'],
        tool: 'task.mark_failed',
        suggested: false,
        requiredInput: ['reason'],
        arguments: taskArguments,
        instruction: serviceOwned(version)
          ? 'Suspend this service task with a specific reason. Its evidence and waiters are retained; a human operator can extend review_rounds to resume the same task.'
          : 'Only when this task cannot or should not continue: record a specific reason to end it as failed. Any unfinished review is closed and its evidence is retained. This is a terminal decision.',
        check: async (context) => {
          if (!ctx.checked.found(context)) await checkFailure(ctx, context);
        },
      },
    ],
  };
}

export async function reviewAction(
  ctx: TasksContext,
  context: WorkflowCheckContext,
  verdict: 'pass' | 'needs_changes' | 'fail',
): Promise<string> {
  if (verdict === 'needs_changes' && serviceOwned(context.snapshot.version)) {
    const { caller, snapshot, tx } = context;
    const limit = (
      await ctx.workflows.limitStatusOf(caller, [snapshot.id], 'review_rounds', tx)
    ).get(snapshot.id)!;
    if (limit.exhausted) return 'revise_suspended';
  }
  return { pass: 'accept', needs_changes: 'revise', fail: 'fail_review' }[verdict];
}

export async function currentReview(
  ctx: TasksContext,
  { caller, snapshot, tx, input }: WorkflowCheckContext,
): Promise<ReviewRequest> {
  const row = await ctx.row(tx, caller, snapshot.id);
  check(
    snapshot.state === 'in_review' &&
      row.review_id &&
      (!input?.reviewId || input.reviewId === row.review_id),
    'stale_review',
    'This review no longer belongs to the current task submission',
    409,
  );
  const review = await ctx.reviews.get(caller, row.review_id, tx);
  check(
    review.subjectRevision === snapshot.revision,
    'revision_conflict',
    'Task changed since the review snapshot was pinned',
    409,
  );
  return review;
}

export async function checkTaskReview(
  ctx: TasksContext,
  context: WorkflowCheckContext,
): Promise<void> {
  // The command making this transition has checked the review and routed the verdict itself.
  const checked = ctx.checked.found<ReviewRequest>(context)?.value;
  let review = checked;
  if (!review) {
    await ctx.scope.require(context.caller, 'review', context.tx);
    if (context.input) rejectReviewReturn(context.input);
    review = await currentReview(ctx, context);
    await ctx.reviews.checkSubmit(
      context.caller,
      review.id,
      context.input as unknown as Omit<TaskReview, 'requestId'> | undefined,
      context.tx,
    );
  }
  // Only a proposed verdict asks Code: the committing transition always carries its input, so
  // this is re-checked there, while guidance read with Code unloaded still answers.
  if (context.input) {
    const headOid = await reviewCommit(ctx, context.caller, context.snapshot, review, context.tx);
    // The owner deciding as owner answers for having read the commit; its receipt still holds.
    if (context.input.verdict === 'pass' && !review.override)
      await checkoutReviewer(ctx, context, review, headOid);
  }
  if (!checked && context.input && context.transition) {
    const action = await reviewAction(
      ctx,
      context,
      context.input.verdict as 'pass' | 'needs_changes' | 'fail',
    );
    check(
      context.transition === action,
      'invalid_verdict',
      'The transition must match the submitted verdict',
    );
  }
}

/**
 * The commit under review is re-derived from Code on every admission and verdict, never trusted
 * from the record alone: the receipt must still be the one the delivery sealed, and the review
 * must pin the rendered record of it. The producing revision is the stored one, because a
 * reissued review advances the task's revision without a new delivery.
 */
export async function reviewCommit(
  ctx: TasksContext,
  caller: Caller,
  snapshot: WorkflowSnapshot,
  review: ReviewRequest,
  tx: Transaction,
): Promise<string> {
  const delivered = snapshot.data.deliveryCode as unknown as TaskDeliveryCode | undefined;
  const recordId = snapshot.data.deliveryCodeArtifactId;
  check(
    delivered?.ref?.kind === 'code-commit' &&
      typeof recordId === 'string' &&
      review.artifactIds.includes(recordId),
    'task_commit_required',
    'This Git task’s review does not pin a delivered commit',
    409,
  );
  const checked = await ctx.code.checkCapture(
    caller,
    delivered.ref,
    {
      unitId: snapshot.id,
      revision: delivered.revision,
      workflow: producing,
      sessionId: delivered.sessionId,
    },
    tx,
  );
  check(
    checked.status === 'ready' && checked.capture.workspace.headOid === delivered.headOid,
    'task_commit_provenance',
    'The delivered commit no longer matches the receipt its delivery sealed',
    409,
  );
  return delivered.headOid;
}

/**
 * A Git task passes only from the leased reviewer of this review, and only once its runner has
 * attached the read-only checkout at the delivered commit. Sessions fixes that attachment and
 * refuses any other base, and a runner without the objects never attaches, so the attachment is
 * the server-side fact that the reviewer could fetch what it accepts. An actor with no checkout
 * at all — an interactive reviewer, admitted only once review_rounds is used up — can only fail it.
 */
export async function checkoutReviewer(
  ctx: TasksContext,
  { caller, snapshot, tx }: WorkflowCheckContext,
  review: ReviewRequest,
  headOid: string,
): Promise<void> {
  check(
    caller.session,
    'task_commit_unfetched',
    'Only a leased reviewer, working in the checkout pinned to the delivered commit, can pass a Git task. Fail it, or have the review replaced with task.reissue_review so a leased worker can claim it',
    409,
  );
  const lease = await currentLease(ctx, caller, snapshot.id, snapshot.revision, tx);
  check(
    lease.details.purpose === 'review' && lease.review_id === review.id,
    'stale_lease',
    'This worker does not hold the lease of the current review',
    409,
  );
  const own = await ctx.code.capture(
    caller,
    { kind: 'session-final', sessionId: caller.session.id },
    tx,
  );
  check(
    own.attachedBaseOid === headOid,
    'task_commit_unfetched',
    'This review’s runner has not attached a checkout of the delivered commit',
    409,
  );
}
