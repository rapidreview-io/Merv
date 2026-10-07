import { requireDependencies } from '@merv/workflows/rules';
import { reviewActions, REVIEW_VERDICTS } from '@merv/reviews/rules';
import { postgresMigrations } from './program.postgres.js';
import {
  check,
  digest,
  type Caller,
  type Data,
  type ReviewRequest,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowPolicy,
  type WorkflowTransition,
} from '@merv/contracts';
import type { CodeCapture } from '@merv/code-work/types';
import type { Experiment, ExperimentReview } from './types.js';
import type { ExperimentsContext } from './index.js';
import {
  activeStates,
  type ActiveState,
  reviewing,
  producing,
  programVersions,
  programContract,
  runningNode,
  reviewedSubmission,
  epochAfter,
  EXPERIMENT_WORKFLOW,
} from './program.js';
import {
  recipeNames,
  handoffs,
  handoff,
  EXPERIMENT_RECIPES,
  feasibilityCriterion,
} from './definitions.js';
import { execution } from './execution-policy.js';
import { approvedPlan, references, build } from './context.js';
import { activeLease, leaseOf, leaseHooks } from './lease.js';
import { checkAction } from './commands.js';

// The experiment program: the workflow, context and lease rules of every current contract. It
// never launches or authenticates a session. Each runs on ExperimentService (index.ts) as its
// ExperimentsContext: the records and evidence these rules read, with one set of dependencies
// and one lifecycle.

/** Migrates the lease table, then registers every recipe and current workflow version. */
export async function register(ctx: ExperimentsContext): Promise<void> {
  await ctx.state.migrate('experiment_program', postgresMigrations);
  try {
    for (const recipe of EXPERIMENT_RECIPES)
      ctx.contexts.set(
        activeStates.find((state) => recipeNames[state] === recipe.name)!,
        await ctx.contextBuilder.register(recipe),
      );
    for (const version of programVersions)
      ctx.handles.set(
        version,
        await ctx.workflows.register({ ...EXPERIMENT_WORKFLOW, version }, policy(ctx, version)),
      );
  } catch (error) {
    unregister(ctx);
    throw error;
  }
}

export function unregister(ctx: ExperimentsContext): void {
  for (const handle of ctx.handles.values()) handle.dispose();
  ctx.handles.clear();
  for (const context of ctx.contexts.values()) context.dispose();
  ctx.contexts.clear();
}

export function handleFor(ctx: ExperimentsContext, version: number) {
  programContract(version);
  const handle = ctx.handles.get(version);
  check(
    handle,
    'experiment_version_unavailable',
    'The experiment program version is unavailable',
    503,
  );
  return handle;
}

/**
 * Takes an owner edge whose exit checks the calling command has just run in this transaction,
 * so the edge's guard does not run them again. Every other path to the edge is still guarded.
 */
export async function move(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  transition: Omit<WorkflowTransition, 'instanceId'>,
  tx: Transaction,
) {
  const { id, revision, version } = experiment.workflow;
  const data = {
    ...transition.data,
    ...epochAfter(experiment, transition.action, experiment.attempt.index),
  };
  return await ctx.checked.take(tx, { instanceId: id, revision, action: transition.action }, () =>
    handleFor(ctx, version).transition(
      caller,
      { instanceId: experiment.id, ...transition, data },
      tx,
    ),
  );
}

export function revision(ctx: ExperimentsContext, experiment: Experiment, expected: number): void {
  check(
    Number.isSafeInteger(expected) && experiment.workflow.revision === expected,
    'revision_conflict',
    'The experiment changed; read its current revision',
    409,
  );
}

/** The review edge a verdict takes from the stage it assessed. */
export function route(
  ctx: ExperimentsContext,
  stage: 'design' | 'results',
  input: ExperimentReview,
): string {
  check(
    REVIEW_VERDICTS.includes(input.verdict),
    'invalid_verdict',
    'A supported review verdict is required',
  );
  if (input.verdict === 'pass') {
    check(
      input.returnTo === undefined,
      'invalid_review_return',
      'Passing reviews do not accept returnTo',
    );
    return stage === 'design' ? 'approve_design' : 'accept_results';
  }
  if (stage === 'design') {
    check(
      input.returnTo === undefined || input.returnTo === 'planned',
      'invalid_review_return',
      'A rejected design returns only to planned',
    );
    return 'revise_design';
  }
  check(
    input.returnTo === 'planned' || input.returnTo === 'running',
    'invalid_review_return',
    'Both negative attempt verdicts require returnTo planned or running',
  );
  return input.returnTo === 'planned' ? 'revise_plan' : 'revise_execution';
}

/** The checked experiment. Guidance's callbacks each ask; one snapshot reads it once. */
export async function current(
  ctx: ExperimentsContext,
  { caller, snapshot, tx }: WorkflowCheckContext,
): Promise<Experiment> {
  const key = `experiments:get:${caller.projectId}:${snapshot.id}`;
  return structuredClone(await ctx.state.remember(key, () => ctx.get(caller, snapshot.id, tx)));
}

export async function facts(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<Experiment> {
  check(!ctx.closed, 'experiment_unavailable', 'The experiment program is unavailable', 503);
  const experiment = await current(ctx, context);
  check(
    experiment.workflow.revision === context.snapshot.revision &&
      experiment.workflow.state === context.snapshot.state,
    'revision_conflict',
    'The experiment assignment changed',
    409,
  );
  return experiment;
}

/** Interactive production is fenced while a lease owns the current node. Terminal administration is separate. */
export async function assertProducer(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<void> {
  await ctx.scope.require(caller, 'write', tx);
  check(
    producing(experiment.workflow.state),
    'experiment_not_writable',
    'Evidence work is available only during planning or execution',
    409,
  );
  if (caller.session) await leaseOf(ctx, caller, experiment, tx);
  else {
    if (caller.actorId !== experiment.ownerId) await ctx.scope.require(caller, 'admin', tx);
    check(
      !(await activeLease(ctx, experiment, tx)),
      'experiment_leased',
      'A worker session holds this revision; the operator who offered it can halt it, or wait for its handoff',
      409,
    );
  }
  if (experiment.workflow.state === 'running') {
    approvedPlan(ctx, experiment);
    requireDependencies(
      (await ctx.workflows.prerequisites(caller, [experiment.id], tx)).get(experiment.id)!,
    );
  }
}

/** Ending work is explicit administration, independent of production readiness or prerequisites. */
export async function assertAdministration(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<void> {
  await ctx.scope.require(caller, 'write', tx);
  if (caller.session) {
    check(
      producing(experiment.workflow.state),
      'forbidden',
      'Review workers cannot end an experiment',
      403,
    );
    await leaseOf(ctx, caller, experiment, tx);
  } else if (caller.actorId !== experiment.ownerId) {
    await ctx.scope.require(caller, 'admin', tx);
  }
}

/** The current review, pinned to this exact submission. Its code capture is read separately. */
export async function reviewOf(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<ReviewRequest> {
  check(
    experiment.reviewId && reviewing(experiment.workflow.state),
    'stale_review',
    'The experiment has no current review assignment',
    409,
  );
  const review = await ctx.reviews.get(caller, experiment.reviewId, tx);
  check(
    review.subjectId === experiment.id &&
      review.subjectRevision === experiment.workflow.revision &&
      reviewedSubmission(experiment, review.id),
    'stale_review',
    'This review must pin the exact current submission and attempt',
    409,
  );
  return review;
}

/**
 * The commit a results review pins: the producing session's final capture, resolved by its
 * immutable reference even after its handoff. A machine that died before handing that capture
 * over leaves its writer for an operator to fence; Code then answers with the last commit it
 * admitted from that session, which is what the fence kept.
 */
export async function reviewCapture(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<CodeCapture | null> {
  if (experiment.workflow.state !== 'experiment_review') return null;
  const submission = experiment.submissions.find((entry) => entry.reviewId === experiment.reviewId);
  check(
    submission?.stage === 'results' &&
      submission.codeCaptureRef?.kind === 'session-final' &&
      submission.codeCaptureRef.sessionId === submission.sessionId,
    'experiment_capture_required',
    'The result submission must pin its producing session capture',
    409,
  );
  const checked = await ctx.code.checkCapture(
    caller,
    submission.codeCaptureRef,
    {
      unitId: experiment.id,
      revision: submission.subjectRevision - 1,
      workflow: runningNode,
      sessionId: submission.sessionId,
      actorId: submission.producerId,
    },
    tx,
  );
  check(
    checked.status !== 'foreign',
    'experiment_capture_provenance',
    'The code capture must belong to the exact producing experiment node',
    409,
  );
  check(
    checked.status === 'ready',
    'experiment_capture_pending',
    'The producing worker must stop and report its final Git capture before review, or an operator fences its writer with code.unit.fence',
    409,
  );
  return checked.capture;
}

/**
 * A verdict's own checks, made after its review is pinned and Reviews has checked the
 * submission: it names that review at the current revision, and it routes to this edge.
 */
export async function checkReview(
  ctx: ExperimentsContext,
  { caller, tx, input: proposed, transition }: WorkflowCheckContext,
  experiment: Experiment,
  pinned: ReviewRequest,
): Promise<void> {
  const input = proposed as unknown as ExperimentReview;
  if (input.expectedRevision !== undefined) revision(ctx, experiment, input.expectedRevision);
  await ctx.scope.require(caller, 'review', tx);
  const review =
    input.reviewId === pinned.id ? pinned : await ctx.reviews.get(caller, input.reviewId, tx);
  check(
    experiment.reviewId === review.id,
    'stale_review',
    'This review no longer belongs to the current submission',
    409,
  );
  revision(ctx, experiment, input.expectedRevision);
  const submission = reviewedSubmission(experiment, review.id)!;
  check(
    submission.subjectRevision === review.subjectRevision &&
      submission.producerId === review.producerId,
    'stale_review',
    'The review must pin this exact attempt and submission',
    409,
  );
  check(
    digest([
      ...new Set([...submission.evidence.map((e) => e.artifactId), ...submission.figureIds]),
    ]) === digest(review.artifactIds),
    'stale_review',
    'Review evidence differs from the sealed submission',
    409,
  );
  const action = route(ctx, submission.stage, input);
  // Reviews holds the criterion to met with some pinned evidence; only Experiments knows
  // which artifact is the statement, and a finding citing the plan alone has not read it.
  const statement = submission.evidence.find((e) => e.role === 'feasibility');
  if (input.verdict === 'pass' && submission.stage === 'design' && statement)
    check(
      input.findings
        ?.find((finding) => finding.criterionNumber === feasibilityCriterion)
        ?.evidenceIds.includes(statement.artifactId),
      'feasibility_not_cited',
      `A passing design review cites the feasibility statement ${statement.artifactId} in the finding for criterion ${feasibilityCriterion}`,
    );
  if (input.paperChanges !== undefined)
    await ctx.paper.checkReview(
      caller,
      {
        ...input.paperChanges,
        source: { kind: 'experiment', id: experiment.id, revision: review.subjectRevision },
        reviewId: review.id,
        verdict: input.verdict,
        evidenceIds: review.artifactIds,
      },
      tx,
    );
  check(
    !transition || action === transition,
    'invalid_review_return',
    'The verdict does not select this transition',
  );
}

export async function admit(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<{ experiment: Experiment; review: ReviewRequest | null }> {
  const experiment = await facts(ctx, context);
  if (producing(context.snapshot.state)) {
    await assertProducer(ctx, context.caller, experiment, context.tx);
    await requireBase(ctx, context);
    return { experiment, review: null };
  }
  await ctx.scope.require(context.caller, 'review', context.tx);
  const review = await reviewOf(ctx, context.caller, experiment, context.tx);
  await reviewCapture(ctx, context.caller, experiment, context.tx);
  if (context.caller.session) {
    const lease = await leaseOf(ctx, context.caller, experiment, context.tx);
    check(
      lease.review_id === review.id && lease.claim_id === review.claimId,
      'stale_claim',
      'The session no longer owns its pinned claim',
      409,
    );
    await ctx.reviews.checkSubmit(context.caller, review.id, undefined, context.tx);
  } else if (review.status === 'requested')
    await ctx.reviews.checkStart(context.caller, review.id, context.tx);
  else await ctx.reviews.checkSubmit(context.caller, review.id, undefined, context.tx);
  return { experiment, review };
}

/**
 * Refuses producing work whose base Code cannot derive, with Code's own blocker code. This
 * only reads: it runs under lease admission, the dispatch candidate scan and every
 * assignment check. The refusal makes the experiment no candidate at all, so it is never
 * launched and never held; Code publishes the reason where status and the stuck report look.
 */
export async function requireBase(
  ctx: ExperimentsContext,
  { caller, snapshot, tx }: WorkflowCheckContext,
): Promise<void> {
  await ctx.code.requireLeasable(
    caller,
    { unitId: snapshot.id, writer: snapshot.state === 'running' },
    tx,
  );
}

export function policy(ctx: ExperimentsContext, version: number): WorkflowPolicy {
  const argumentsFor = (context: WorkflowCheckContext): Data => ({
    experimentId: context.snapshot.id,
    expectedRevision: context.snapshot.revision,
  });
  const action = (
    name: string,
    states: string[],
    instruction: string,
    requiresDependencies = false,
  ) => ({
    name,
    states,
    transitions: [name],
    tool: 'experiment.transition',
    instruction,
    requiresDependencies,
    // Ending or retrying takes a reason under evidence; the guidance says so before the call.
    ...(['retry_running', 'abandon', 'mark_failed'].includes(name)
      ? { requiredInput: ['evidence'] }
      : {}),
    suggested: !['retry_running', 'abandon', 'mark_failed'].includes(name),
    arguments: (context: WorkflowCheckContext): Data => ({
      ...argumentsFor(context),
      transition: name,
    }),
    check: async (context: WorkflowCheckContext) => {
      if (!ctx.checked.found(context)) await checkAction(ctx, { ...context, transition: name });
    },
  });
  const lease = leaseHooks(ctx);
  return {
    successStates: ['complete'],
    dependencyFailureAction: 'mark_failed',
    limits: [
      {
        name: 'design_rounds',
        from: 'design_review',
        actions: ['revise_design'],
        max: ctx.limits.designRounds,
      },
      {
        name: 'result_rounds',
        from: 'experiment_review',
        actions: ['revise_plan', 'revise_execution'],
        max: ctx.limits.resultRounds,
      },
    ],
    assignments: activeStates.map((state) => ({
      state,
      // A plan is written against its inputs, so planning waits for the tasks the
      // experiment depends on, as running does (founder, 2026-09-18: an experiment
      // depends on tasks, never on another experiment).
      ...(['planned', 'running'].includes(state) ? { requiresDependencies: true } : {}),
      check: async (context) => {
        await admit(ctx, context);
      },
      build: async (context) => await build(ctx, context),
      references: async (context) => await references(ctx, context),
      execution: execution(state, version),
      lease,
    })),
    describe: async (context) => {
      const experiment = await facts(ctx, context);
      const review = experiment.reviewId
        ? await ctx.reviews.get(context.caller, experiment.reviewId, context.tx)
        : null;
      const state = context.snapshot.state as ActiveState;
      return {
        label: experiment.name,
        owner: {
          actorId: experiment.ownerId,
          asks: {
            submit_design: 'Submit the design for review',
            submit_results: 'Submit the results for review',
          },
        },
        gate:
          state === 'planned'
            ? 'design_required'
            : state === 'running'
              ? 'execution_evidence_required'
              : review?.status === 'requested'
                ? 'review_required'
                : 'independent_review',
        waiting: producing(state)
          ? handoff(state)
          : 'Wait for an independent reviewer to assess the exact pinned submission. Producer evidence stays immutable while its review is pending.',
        references: [
          ...(context.dependencies ?? []).map((dependency) => ({
            kind: 'workflow',
            id: dependency.id,
            label: `Prerequisite: ${dependency.name || dependency.id}`,
          })),
          ...(experiment.reviewId
            ? [
                {
                  kind: 'review',
                  id: experiment.reviewId,
                  label: 'Current or previous independent review',
                },
              ]
            : []),
          ...(experiment.attempt.approvedSubmissionId
            ? [
                {
                  kind: 'submission',
                  id: experiment.attempt.approvedSubmissionId,
                  label: 'Exact approved design',
                },
              ]
            : []),
        ],
      };
    },
    actions: [
      action('submit_design', ['planned'], handoff('planned'), true),
      action('submit_results', ['running'], handoffs.running, true),
      action(
        'retry_running',
        ['running'],
        'For an infrastructure interruption, retain a specific reason and recover completed work before rerunning. This preserves the attempt and approved plan.',
      ),
      action(
        'abandon',
        [...activeStates],
        'End this experiment as abandoned with a specific reason; unfinished review ownership is closed and evidence remains retained.',
      ),
      action(
        'mark_failed',
        [...activeStates],
        'End this experiment as failed with a specific reason; do not confuse this owner action with a reviewer returning work for correction.',
      ),
      ...(['design_review', 'experiment_review'] as const).flatMap((state) =>
        reviewActions<WorkflowCheckContext>({
          names: { submit: `submit_${state}`, start: `start_${state}` },
          states: [state],
          transitions:
            state === 'design_review'
              ? ['approve_design', 'revise_design']
              : ['accept_results', 'revise_plan', 'revise_execution'],
          instructions: {
            submit: handoff(state),
            start: 'Claim the exact current independent review, then refresh its assignment.',
          },
          reviews: ctx.reviews,
          // The submit check pins the same review and gates its capture, so this only names it.
          current: async (context) =>
            await reviewOf(ctx, context.caller, await facts(ctx, context), context.tx),
          submit: async (context) => {
            const experiment = await facts(ctx, context);
            const review = await reviewOf(ctx, context.caller, experiment, context.tx);
            await reviewCapture(ctx, context.caller, experiment, context.tx);
            await ctx.reviews.checkSubmit(
              context.caller,
              review.id,
              context.input as unknown as ExperimentReview | undefined,
              context.tx,
            );
            if (context.input) await checkReview(ctx, context, experiment, review);
          },
          start: async (context, review) => {
            await reviewCapture(ctx, context.caller, await facts(ctx, context), context.tx);
            check(
              !context.input?.reviewId || context.input.reviewId === review.id,
              'stale_review',
              'The current review is required',
              409,
            );
          },
        }),
      ),
    ],
  };
}
