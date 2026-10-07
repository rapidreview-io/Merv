import { directsIndependently, excludedFromReview, NOT_INDEPENDENT } from '@merv/reviews/rules';
import { heldLease, insertLease, leaseRows, reviewedLeaseHooks } from '@merv/workflows/lease-rows';
import {
  check,
  newId,
  now,
  plain,
  recorded,
  visible,
  type Caller,
  type Data,
  type Role,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowPolicy,
} from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import type { TaskCheckpoint, TaskCheckpointInput } from './types.js';
import type { TaskLeaseRow, TaskRow, TasksContext } from './index.js';
import { purposeOf, serviceOwned } from './workflow.js';
import { assignment, contextType } from './context.js';
import { reviewCommit } from './policy.js';

// A task's lease hooks and checkpoints: who may hold the lease, what it pins and the checkpoints
// it freezes, and the checkpoints its worker saves. Each runs on TaskService
// (index.ts) as its TasksContext.

export function leaseHooks(
  ctx: TasksContext,
): NonNullable<NonNullable<WorkflowPolicy['assignments']>[number]['lease']> {
  return reviewedLeaseHooks({
    reviews: ctx.reviews,
    artifacts: ctx.artifacts,
    excluded: excludedFromReview,
    label: async ({ caller, snapshot, tx }) => (await ctx.row(tx, caller, snapshot.id)).title,
    role: async (context): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> =>
      await leaseRole(ctx, context),
    acquire: async (context) => await acquireLease(ctx, context),
    review: async ({ caller, snapshot, tx }) =>
      snapshot.state === 'in_review' ? (await ctx.row(tx, caller, snapshot.id)).review_id : null,
    lease: async ({ caller, snapshot, tx }) =>
      await currentLease(ctx, caller, snapshot.id, snapshot.revision, tx),
    captures: async ({ caller, snapshot, tx }) =>
      await ctx.captureArtifactIds(caller.projectId, snapshot.id, tx),
  });
}

/**
 * A claim made without a lease can never pass a Git task and shuts every leased reviewer out,
 * so it is admitted only once review_rounds is used up: no runner is offered the review then,
 * and the person the limit waits for may still end the task.
 */
export async function leasedClaim(
  ctx: TasksContext,
  caller: Caller,
  snapshot: WorkflowSnapshot,
  tx: Transaction,
) {
  ctx.registration(snapshot.version);
  if (caller.session) return;
  check(
    !!(await ctx.workflows.exhaustedLimit(caller, snapshot.id, tx)),
    'leased_review_required',
    'Only a leased review worker, in a checkout of the delivered commit, can pass a Git task',
    403,
  );
}

export async function leaseRole(
  ctx: TasksContext,
  { caller, snapshot, tx }: WorkflowCheckContext,
): Promise<Role> {
  check(!caller.session, 'forbidden', 'A leased worker cannot delegate another assignment', 403);
  const row = await ctx.row(tx, caller, snapshot.id);
  if (snapshot.state === 'in_progress') {
    await ctx.scope.require(caller, 'write', tx);
    // Version 6 is created only by the service binding; its runner remains a producer.
    if (row.producer_id !== caller.actorId && !serviceOwned(snapshot.version))
      await ctx.scope.require(caller, 'admin', tx);
    await ctx.code.requireLeasable(caller, { unitId: snapshot.id, writer: true }, tx);
    contextType(ctx, { type: row.type_name, typeVersion: row.type_version }, 'work');
    return 'producer';
  }
  check(
    snapshot.state === 'in_review' && row.review_id,
    'lease_unavailable',
    'Task has no review to lease',
    409,
  );
  await ctx.scope.require(caller, 'review', tx);
  const review = await ctx.reviews.get(caller, row.review_id, tx);
  check(
    review.status === 'requested' && review.subjectRevision === snapshot.revision,
    'review_unavailable',
    'Review is already claimed or no longer current',
    409,
  );
  check(directsIndependently(review, caller.actorId), ...NOT_INDEPENDENT);
  await reviewCommit(ctx, caller, snapshot, review, tx);
  contextType(ctx, { type: row.type_name, typeVersion: row.type_version }, 'review');
  return 'reviewer';
}

export async function currentLease(
  ctx: TasksContext,
  caller: Caller,
  taskId: string,
  revision: number,
  tx: Transaction,
): Promise<TaskLeaseRow> {
  return await heldLease<TaskLeaseRow['details']>(
    ctx.state,
    tx,
    { projectId: caller.projectId, instanceId: taskId, revision },
    caller,
  );
}

export async function acquireLease(
  ctx: TasksContext,
  context: WorkflowCheckContext & { source: Caller; leaseId: string },
): Promise<Data> {
  const { caller, source, snapshot, tx, leaseId } = context;
  // workflows.offerLease ran lease.role(source) in this transaction just before this hook,
  // matched the worker's role to it and checked worker.session.id === leaseId.
  const row = await ctx.row(tx, caller, snapshot.id);
  const purpose = purposeOf(snapshot);
  // The base is fixed with the lease it serves: Workflows reads references() right after
  // this hook in the same transaction, and a refused offer takes the pin back with it.
  if (purpose === 'work') {
    await ctx.code.pinBase(source, { unitId: snapshot.id, leaseId, writer: true }, tx);
  }
  const review =
    purpose === 'review' ? await ctx.reviews.start(caller, row.review_id!, tx) : undefined;
  const type = contextType(ctx, { type: row.type_name, typeVersion: row.type_version }, purpose);
  const checkpoints = await checkpointRows(
    ctx,
    caller,
    snapshot.id,
    purpose,
    row.review_id,
    snapshot.revision,
    tx,
  );
  const ids = [
    ...new Set([
      row.brief_id,
      ...(JSON.parse(row.delivery_ids) as string[]),
      ...Object.values(JSON.parse(row.context_inputs) as Record<string, string[]>).flat(),
      ...(review?.artifactIds ?? []),
      ...checkpoints.flatMap((checkpoint) => checkpoint.artifactIds),
    ]),
  ];
  // The authenticated source approves existing task continuity evidence exactly once.
  const pinnedArtifacts = await ctx.artifacts.getAll(source, ids, tx);
  const receipt: Data = {
    leaseId,
    taskId: snapshot.id,
    revision: snapshot.revision,
    actorId: caller.actorId,
    purpose,
    reviewId: review?.id ?? null,
    claimId: review?.claimId ?? null,
    project: { ...(await ctx.scope.project(source, tx)) },
    paper: (await ctx.paper.contextInput(
      source,
      type.definition.recipe.maxChars,
      tx,
    )) as unknown as Data,
  };
  await insertLease(tx, {
    id: leaseId,
    projectId: caller.projectId,
    snapshot,
    actorId: caller.actorId,
    sourceActorId: source.actorId,
    reviewId: review?.id ?? null,
    claimId: review?.claimId ?? null,
    receipt,
    details: { purpose, pinnedArtifacts, checkpoints },
  });
  return receipt;
}

export async function leaseArtifactIds(
  ctx: TasksContext,
  caller: Caller,
  lease: TaskLeaseRow,
  tx: Transaction,
): Promise<string[]> {
  return [
    ...new Set([
      ...lease.details.pinnedArtifacts.map((artifact) => artifact.id),
      ...((await ctx.captureArtifactIds(caller.projectId, lease.instance_id, tx)) ?? []),
      ...(await ctx.artifacts.executionOutputs(caller, tx)).map((artifact) => artifact.id),
    ]),
  ].sort();
}

/**
 * Guidance of many tasks at once reads each one's row, and whether a worker holds its revision,
 * in two reads for all of them, where `row` and `unleased` look for them.
 */
export async function prepareTasks(
  ctx: TasksContext,
  {
    caller,
    tx,
    snapshots,
  }: { caller: Caller; tx: Transaction; snapshots: readonly WorkflowSnapshot[] },
): Promise<void> {
  const ids = snapshots.map((snapshot) => snapshot.id);
  for (const row of await tx.all<TaskRow>(
    `SELECT * FROM tasks WHERE project_id=? AND id IN (${ids.map(() => '?').join(',')})`,
    caller.projectId,
    ...ids,
  ))
    await ctx.state.remember(`tasks:row:${caller.projectId}:${row.id}`, async () => row);
  if (caller.session) return;
  const held = new Set(
    (await leaseRows(tx, { projectId: caller.projectId, instanceIds: ids, active: true }))
      .filter((lease) => purposeOf(lease) === 'work')
      .map((lease) => `${lease.instance_id}:${lease.revision}`),
  );
  for (const { id, revision } of snapshots)
    await ctx.state.remember(`tasks:leased:${caller.projectId}:${id}:${revision}`, async () =>
      held.has(`${id}:${revision}`),
    );
}

/** An interactive delivery yields to a worker that holds the revision, as every domain's submission does. */
export async function unleased(
  ctx: TasksContext,
  caller: Caller,
  taskId: string,
  revision: number,
  tx: Transaction,
) {
  if (caller.session) return;
  const key = `tasks:leased:${caller.projectId}:${taskId}:${revision}`;
  check(
    !(await ctx.state.remember(key, async () =>
      (
        await leaseRows(tx, {
          projectId: caller.projectId,
          instanceIds: [taskId],
          revision,
          active: true,
        })
      ).some((lease) => purposeOf(lease) === 'work'),
    )),
    'task_leased',
    'A worker session holds this revision; the operator who offered it can halt it, or wait for its handoff',
    409,
  );
}

export async function isProducer(
  ctx: TasksContext,
  caller: Caller,
  row: TaskRow,
  snapshot: WorkflowSnapshot,
  tx: Transaction,
): Promise<boolean> {
  if (!caller.session) return row.producer_id === caller.actorId;
  return purposeOf(await currentLease(ctx, caller, row.id, snapshot.revision, tx)) === 'work';
}

export async function producerOrAdmin(
  ctx: TasksContext,
  caller: Caller,
  row: TaskRow,
  snapshot: WorkflowSnapshot,
  tx: Transaction,
): Promise<void> {
  if (!(await isProducer(ctx, caller, row, snapshot, tx)))
    await ctx.scope.require(caller, 'admin', tx);
}

export async function checkpointRows(
  ctx: TasksContext,
  caller: Caller,
  taskId: string,
  purpose: 'work' | 'review',
  reviewId: string | null,
  revision: number,
  tx: Transaction,
  actorId?: string,
): Promise<TaskCheckpoint[]> {
  return (
    await tx.all<{ checkpoint: string }>(
      `SELECT checkpoint FROM task_checkpoints WHERE project_id=? AND task_id=? AND purpose=? AND (?='work' OR (review_id=? AND revision=?)) AND (CAST(? AS TEXT) IS NULL OR (checkpoint::jsonb #>> '{actorId}')=?) ORDER BY _merv_rowid DESC LIMIT 20`,
      caller.projectId,
      taskId,
      purpose,
      purpose,
      reviewId,
      revision,
      actorId ?? null,
      actorId ?? null,
    )
  )
    .map((row) => JSON.parse(row.checkpoint) as TaskCheckpoint)
    .reverse();
}

/**
 * The checkpoints a caller's context shows. A leased worker sees those its lease froze, then
 * its own, citing only artifacts the lease admits; anyone else sees them all.
 */
export async function visibleCheckpoints(
  ctx: TasksContext,
  caller: Caller,
  taskId: string,
  purpose: 'work' | 'review',
  reviewId: string | null,
  revision: number,
  tx: Transaction,
): Promise<TaskCheckpoint[]> {
  const checkpoints = await checkpointRows(
    ctx,
    caller,
    taskId,
    purpose,
    reviewId,
    revision,
    tx,
    caller.session ? caller.actorId : undefined,
  );
  if (!caller.session) return checkpoints;
  const lease = await currentLease(ctx, caller, taskId, revision, tx);
  const frozen = lease.details.checkpoints;
  const frozenIds = new Set(frozen.map((checkpoint) => checkpoint.id));
  const allowed = new Set(await leaseArtifactIds(ctx, caller, lease, tx));
  return [...frozen, ...checkpoints.filter((checkpoint) => !frozenIds.has(checkpoint.id))].map(
    (checkpoint) => ({
      ...checkpoint,
      artifactIds: checkpoint.artifactIds.filter((id) => allowed.has(id)),
    }),
  );
}

export async function checkpoint(
  ctx: TasksContext,
  caller: Caller,
  input: TaskCheckpointInput,
): Promise<TaskCheckpoint> {
  caller = structuredClone(caller);
  input = plain<TaskCheckpointInput>(input);
  return await ctx.state.transaction(async (tx) => {
    // The committed answer replays even after the task moved on; the assignment is
    // checked only for a checkpoint that has yet to be written.
    return await ctx.command(tx, caller, input.requestId, 'checkpoint', input, async () => {
      const { task, review } = await assignment(ctx, caller, input, tx);
      check(
        typeof input.notes === 'string' && visible(input.notes) && input.notes.length <= 16000,
        'invalid_checkpoint',
        'Checkpoint notes must contain 1–16000 characters',
      );
      const artifactIds = input.artifactIds ?? [];
      check(
        Array.isArray(artifactIds) &&
          artifactIds.length <= 50 &&
          new Set(artifactIds).size === artifactIds.length,
        'invalid_checkpoint',
        'Checkpoint artifact IDs must be distinct, at most 50',
      );
      if (caller.session) {
        const allowed = new Set(
          await leaseArtifactIds(
            ctx,
            caller,
            await currentLease(ctx, caller, task.id, task.workflow.revision, tx),
            tx,
          ),
        );
        check(
          artifactIds.every((id) => allowed.has(id)),
          'execution_arguments_forbidden',
          'Checkpoint evidence must be frozen input or this worker’s own output',
          403,
        );
      }
      await ctx.artifacts.getMany(caller, artifactIds, tx);
      const result: TaskCheckpoint = {
        id: newId('checkpoint'),
        taskId: task.id,
        actorId: caller.actorId,
        purpose: input.purpose,
        revision: task.workflow.revision,
        reviewId: review?.id ?? null,
        claimId: review?.claimId ?? null,
        notes: input.notes,
        artifactIds,
        createdAt: now(),
      };
      await tx.run(
        'INSERT INTO task_checkpoints(id,project_id,task_id,purpose,revision,review_id,checkpoint) VALUES(?,?,?,?,?,?,?)',
        result.id,
        caller.projectId,
        task.id,
        input.purpose,
        result.revision,
        result.reviewId,
        JSON.stringify(result),
      );
      await recorded(ctx.state, tx, caller, 'task.checkpoint_saved', task.id, {
        checkpointId: result.id,
        purpose: input.purpose,
        revision: result.revision,
      });
      return result;
    });
  });
}
