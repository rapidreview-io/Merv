import { directsIndependently, excludedFromReview, NOT_INDEPENDENT } from '@merv/reviews/rules';
import {
  heldLease,
  insertLease,
  leaseRows,
  liveLease,
  reviewedLeaseHooks,
  type LeaseRow as WorkflowLeaseRow,
} from '@merv/workflows/lease-rows';
import {
  check,
  type Artifact,
  type Caller,
  type Data,
  type ReviewRequest,
  type Transaction,
  type WorkflowAssignmentRule,
  type WorkflowCheckContext,
} from '@merv/contracts';
import type { Experiment, ExperimentEvidence } from './types.js';
import type { ExperimentsContext } from './index.js';
import { reviewing, producing, captureEpochs } from './program.js';
import { type FrozenInputs, eligibleRecovery, inputsOf, inputIds } from './context.js';
import { facts, assertProducer, reviewOf, reviewCapture, requireBase } from './policy.js';

// Experiment leases: who holds the current step, and what its lease froze.

/** An experiment's lease: the attempt it serves and the inputs, artifacts and recovery it froze. */
type LeaseRow = WorkflowLeaseRow<{
  attemptIndex: number;
  artifacts: Artifact[];
  recovery: ExperimentEvidence[];
  inputs: FrozenInputs;
}>;

/** What names an experiment's lease. */
type LeaseTarget = Pick<Experiment, 'id' | 'projectId'> & {
  workflow: Pick<Experiment['workflow'], 'revision' | 'state'>;
  attempt?: Pick<Experiment['attempt'], 'index'>;
};

const step = ({ projectId, id, workflow }: LeaseTarget) => ({
  projectId,
  instanceId: id,
  revision: workflow.revision,
});

/** The live lease on this revision, whoever holds it. */
export async function activeLease(
  ctx: ExperimentsContext,
  experiment: LeaseTarget,
  tx: Transaction,
): Promise<LeaseRow | undefined> {
  return await liveLease<LeaseRow['details']>(ctx.state, tx, step(experiment));
}

/** The caller's live lease on this revision; without `attempt`, at whichever attempt it holds. */
export async function leaseOf(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: LeaseTarget,
  tx: Transaction,
): Promise<LeaseRow> {
  const lease = await heldLease<LeaseRow['details']>(ctx.state, tx, step(experiment), caller);
  check(
    (!experiment.attempt || lease.details.attemptIndex === experiment.attempt.index) &&
      lease.state === experiment.workflow.state,
    'stale_lease',
    'The worker no longer owns this exact experiment assignment',
    409,
  );
  return lease;
}

/** Only associations selected before this worker's offer can exempt old output authorship. */
export async function pinnedRecovery(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<ExperimentEvidence[]> {
  await ctx.scope.require(caller, 'read', tx);
  if (!caller.session) return [];
  return (await leaseOf(ctx, caller, experiment, tx)).details.recovery;
}

/** Whether this session is the worker holding the experiment's live lease. */
export async function holds(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<boolean> {
  return (await activeLease(ctx, experiment, tx))?.id === caller.session?.id;
}

export async function leaseRole(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> {
  check(!context.caller.session, 'forbidden', 'A leased worker cannot delegate work', 403);
  const experiment = await facts(ctx, context);
  if (producing(context.snapshot.state)) {
    await assertProducer(ctx, context.caller, experiment, context.tx);
    await requireBase(ctx, context);
    return 'producer';
  }
  await ctx.scope.require(context.caller, 'review', context.tx);
  const review = await reviewOf(ctx, context.caller, experiment, context.tx);
  await reviewCapture(ctx, context.caller, experiment, context.tx);
  check(
    review.status === 'requested' && !(await activeLease(ctx, experiment, context.tx)),
    'review_unavailable',
    'This review is already reserved or claimed',
    409,
  );
  // A source may have directed a prior producer session, but never directs the review of
  // work it produced itself. The rest of independence belongs to the new worker.
  check(directsIndependently(review, context.caller.actorId), ...NOT_INDEPENDENT);
  return 'reviewer';
}

/**
 * What earlier visits to this step made: the artifacts each released lease on the experiment at
 * the same revision created in its own session, as its own actor. A visit cut before it attached
 * them hands them to the visit that resumes the step; a move to another revision ends that.
 */
export async function resumedOutputs(
  ctx: Pick<ExperimentsContext, 'artifacts'>,
  caller: Caller,
  step: { id: string; revision: number },
  tx: Transaction,
): Promise<string[]> {
  if (!caller.session) return [];
  const earlier = (
    await leaseRows(tx, {
      projectId: caller.projectId,
      instanceIds: [step.id],
      revision: step.revision,
    })
  ).filter((lease) => lease.released_at && lease.id !== caller.session!.id);
  const found: string[] = [];
  for (const lease of earlier)
    for (const artifact of await ctx.artifacts.list(caller, { sessions: [lease.id] }, tx))
      if (artifact.createdBy === lease.actor_id) found.push(artifact.id);
  return found;
}

export function leaseHooks(ctx: ExperimentsContext): NonNullable<WorkflowAssignmentRule['lease']> {
  return reviewedLeaseHooks({
    reviews: ctx.reviews,
    artifacts: ctx.artifacts,
    excluded: excludedFromReview,
    label: async (context) => (await facts(ctx, context)).name,
    review: async (context) => {
      const experiment = await facts(ctx, context);
      return reviewing(experiment.workflow.state) ? experiment.reviewId : null;
    },
    // The lease of the attempt the facts name: Workflows admitted the step just before.
    lease: async (context) =>
      await leaseOf(ctx, context.caller, await facts(ctx, context), context.tx),
    captures: async (context, lease) => [
      ...((await ctx.sandboxes?.captures(
        context.caller.projectId,
        context.snapshot.id,
        context.tx,
        captureEpochs(
          await attemptRevisions(ctx, context.snapshot.id, lease.details.attemptIndex, context.tx),
          context.snapshot,
        ),
      )) ?? []),
      ...(await resumedOutputs(ctx, context.caller, context.snapshot, context.tx)),
    ],
    role: async (context) => await leaseRole(ctx, context),
    acquire: async (context) => {
      await leaseRole(ctx, { ...context, caller: context.source });
      const experiment = await facts(ctx, context);
      check(
        context.caller.session?.id === context.leaseId &&
          context.source.projectId === context.caller.projectId,
        'invalid_lease',
        'The offered experiment worker must match its source and lease',
        403,
      );
      // The first producing lease fixes the base, and it is normally the planner's; a later
      // one reads the same pin back, so execution inherits what the plan was written against.
      // A refused offer takes the pin back with its transaction.
      if (producing(context.snapshot.state)) {
        // Only execution has a checkout, so only its lease is a writer generation.
        await ctx.code.pinBase(
          context.source,
          {
            unitId: experiment.id,
            leaseId: context.leaseId,
            writer: context.snapshot.state === 'running',
          },
          context.tx,
        );
      }
      let review: ReviewRequest | null = null;
      if (reviewing(context.snapshot.state)) {
        const pinned = await reviewOf(ctx, context.caller, experiment, context.tx);
        await reviewCapture(ctx, context.caller, experiment, context.tx);
        review = await ctx.reviews.start(context.caller, pinned.id, context.tx);
      }
      const inputs = await inputsOf(ctx, context.caller, experiment, context.tx);
      const artifacts = await ctx.artifacts.getAll(
        context.source,
        inputIds(ctx, inputs),
        context.tx,
      );
      const recovery = reviewing(context.snapshot.state) ? [] : eligibleRecovery(ctx, experiment);
      const receipt: Data = {
        leaseId: context.leaseId,
        experimentId: experiment.id,
        revision: context.snapshot.revision,
        attemptIndex: experiment.attempt.index,
        state: context.snapshot.state,
        actorId: context.caller.actorId,
        sourceActorId: context.source.actorId,
        reviewId: review?.id ?? null,
        claimId: review?.claimId ?? null,
      };
      await insertLease(context.tx, {
        id: context.leaseId,
        projectId: context.caller.projectId,
        snapshot: context.snapshot,
        actorId: context.caller.actorId,
        sourceActorId: context.source.actorId,
        reviewId: review?.id ?? null,
        claimId: review?.claimId ?? null,
        receipt,
        details: { attemptIndex: experiment.attempt.index, artifacts, recovery, inputs },
      });
      return receipt;
    },
  });
}

/** The revisions an attempt ran through, as captureEpochs reads them. */
export async function attemptRevisions(
  ctx: ExperimentsContext,
  id: string,
  index: number,
  tx: Transaction,
) {
  const row = (await tx.get<{ started_revision: number; ended_revision: number | null }>(
    'SELECT started_revision,ended_revision FROM experiment_attempts WHERE experiment_id=? AND attempt_index=?',
    id,
    index,
  ))!;
  return {
    index,
    startedRevision: Number(row.started_revision),
    endedRevision: row.ended_revision === null ? null : Number(row.ended_revision),
  };
}
