import { check, clip, digest, now } from '@merv/contracts';
import type {
  Artifacts,
  Data,
  EventConsumer,
  ReviewRequest,
  Reviews,
  SqlValue,
  Transaction,
  WorkflowAssignmentRule,
  WorkflowCheckContext,
  WorkflowLease,
} from '@merv/contracts';

// Every leased step's lease is one wf_leases row, whichever program owns the step. A program's
// lease hooks write and read it here, in the caller's transaction; the row's provenance is
// immutable, only its release is ever written, and it is never deleted.

/** One lease as stored: the columns every leased step shares, and its program's own facts. */
export interface LeaseRow<D = Data> {
  /** The id of the worker session that holds it. */
  id: string;
  project_id: string;
  instance_id: string;
  revision: number;
  workflow: string;
  state: string;
  actor_id: string;
  /** Who offered the worker the step, where its receipt recorded one. */
  source_actor_id: string | null;
  review_id: string | null;
  claim_id: string | null;
  /** The ownership receipt as JSON text: a lease is held only by presenting it exactly. */
  receipt: string;
  /** What the owning program pinned with the lease, as it wrote it. */
  details: D;
  released_at: string | null;
}

/** Writes a step's lease at its acquisition: the step it holds, its review claim and receipt. */
export async function insertLease(
  tx: Transaction,
  lease: {
    id: string;
    projectId: string;
    snapshot: { id: string; revision: number; workflow: string; state: string };
    actorId: string;
    sourceActorId: string;
    reviewId: string | null;
    claimId: string | null;
    receipt: Data;
    /** Plain JSON: it is read back as written. */
    details: object;
  },
): Promise<void> {
  await tx.run(
    'INSERT INTO wf_leases(id,project_id,instance_id,revision,workflow,state,actor_id,source_actor_id,review_id,claim_id,receipt,details) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    lease.id,
    lease.projectId,
    lease.snapshot.id,
    lease.snapshot.revision,
    lease.snapshot.workflow,
    lease.snapshot.state,
    lease.actorId,
    lease.sourceActorId,
    lease.reviewId,
    lease.claimId,
    JSON.stringify(lease.receipt),
    JSON.stringify(lease.details),
  );
}

/**
 * A project's leases, newest last, narrowed by whichever of these are given. `active` keeps
 * only those not yet released; an empty `instanceIds` matches none.
 */
export async function leaseRows<D = Data>(
  tx: Transaction,
  where: {
    projectId: string;
    id?: string;
    instanceIds?: readonly string[];
    revision?: number;
    actorId?: string;
    workflows?: readonly string[];
    active?: boolean;
  },
): Promise<LeaseRow<D>[]> {
  if (where.instanceIds?.length === 0 || where.workflows?.length === 0) return [];
  const clauses = ['project_id=?'];
  const values: SqlValue[] = [where.projectId];
  const equal = (column: string, value: SqlValue | undefined) => {
    if (value === undefined) return;
    clauses.push(`${column}=?`);
    values.push(value);
  };
  const among = (column: string, list: readonly string[] | undefined) => {
    if (!list) return;
    clauses.push(`${column} IN (${list.map(() => '?').join(',')})`);
    values.push(...list);
  };
  equal('id', where.id);
  among('instance_id', where.instanceIds);
  equal('revision', where.revision);
  equal('actor_id', where.actorId);
  among('workflow', where.workflows);
  if (where.active) clauses.push('released_at IS NULL');
  const rows = await tx.all<Omit<LeaseRow<D>, 'details'> & { details: string }>(
    `SELECT * FROM wf_leases WHERE ${clauses.join(' AND ')} ORDER BY _merv_rowid`,
    ...values,
  );
  return rows.map((row) => ({ ...row, details: JSON.parse(row.details) as D }));
}

/** A lease's stored ownership receipt must be exactly the one presented, or the lease is stale. */
export function checkReceipt<T extends { receipt: string }>(
  lease: T | undefined,
  receipt: unknown,
  message: string,
): asserts lease is T {
  check(
    !!lease && digest(JSON.parse(lease.receipt)) === digest(receipt),
    'stale_lease',
    message,
    409,
  );
}

/**
 * Release the lease a worker holds by its exact ownership receipt. A missing row, another
 * step or another receipt is a stale lease.
 */
export async function releasedLease(
  tx: Transaction,
  reviews: Pick<Reviews, 'releaseClaim'>,
  lease: WorkflowLease,
  reason: string,
): Promise<void> {
  const row = (
    await leaseRows(tx, {
      projectId: lease.projectId,
      id: lease.leaseId,
      instanceIds: [lease.instanceId],
      revision: lease.expectedRevision,
      actorId: lease.actorId,
    })
  ).find((row) => row.state === lease.state);
  checkReceipt(row, lease.receipt, 'Release must name the exact ownership receipt');
  await releaseLeaseRow(tx, reviews, row, reason);
}

/**
 * Release a lease row the caller already trusts: the worker's review claim goes back with it,
 * and a row already released is left alone. It checks no receipt, so it never fails as stale.
 */
async function releaseLeaseRow(
  tx: Transaction,
  reviews: Pick<Reviews, 'releaseClaim'>,
  row: Pick<LeaseRow, 'id' | 'project_id' | 'actor_id' | 'review_id' | 'claim_id' | 'released_at'>,
  reason: string,
): Promise<void> {
  if (row.released_at) return;
  if (row.review_id && row.claim_id)
    await reviews.releaseClaim(
      {
        projectId: row.project_id,
        reviewId: row.review_id,
        claimId: row.claim_id,
        actorId: row.actor_id,
        reason,
      },
      tx,
    );
  await tx.run(
    'UPDATE wf_leases SET released_at=? WHERE id=? AND released_at IS NULL',
    now(),
    row.id,
  );
}

/**
 * The durable release of every lease: when a worker session closes, release the lease it names.
 * A session's id is its lease's id, so the row is found without the step's program or a
 * receipt. A close logged while this consumer was unloaded, or before it existed, is released
 * when it next runs; a row already released, or gone with a retired instance, is left.
 */
export const leaseReleaseConsumer = (
  id: string,
  reviews: Pick<Reviews, 'releaseClaim'>,
): EventConsumer => ({
  id,
  types: ['session.closed'],
  from: 'beginning',
  handle: async (event, tx) => {
    const row = await tx.get<LeaseRow<string>>(
      'SELECT * FROM wf_leases WHERE id=? AND released_at IS NULL',
      event.subjectId,
    );
    if (row)
      await releaseLeaseRow(tx, reviews, row, clip(String(event.data.reason ?? 'closed'), 500));
  },
});

type LeaseHooks = NonNullable<WorkflowAssignmentRule['lease']>;

/**
 * The lease hooks of a step that is either work or the independent review of it. The owner
 * says who may hold the lease (`role`), what the lease pins (`acquire`), its queue label, which
 * review a lease of the step would claim (`review`), the caller's own live lease (`lease`,
 * refused as stale otherwise) and Reviews' rule of who a review excludes (`excluded`). The rest
 * is the same for every owner: a worker the review excludes is never offered it; the lease is
 * held only by its exact receipt and, for a review, by the claim it took at the revision it
 * pinned; the worker's outputs are what it made, with any `captures` the owner keeps; and a
 * release returns the claim with the lease.
 */
export function reviewedLeaseHooks<D>(owner: {
  reviews: Pick<Reviews, 'get' | 'checkSubmit' | 'releaseClaim'>;
  artifacts: Pick<Artifacts, 'executionOutputs'>;
  excluded(review: ReviewRequest, actorId: string): boolean;
  label?: LeaseHooks['label'];
  role: LeaseHooks['role'];
  acquire: LeaseHooks['acquire'];
  review(context: WorkflowCheckContext): Promise<string | null | undefined>;
  lease(context: WorkflowCheckContext): Promise<LeaseRow<D>>;
  captures?(context: WorkflowCheckContext, lease: LeaseRow<D>): Promise<readonly string[]>;
}): LeaseHooks {
  const { reviews } = owner;
  return {
    ...(owner.label ? { label: owner.label } : {}),
    role: owner.role,
    acquire: owner.acquire,
    excludes: async (context, actorId) => {
      const reviewId = await owner.review(context);
      return (
        !!reviewId &&
        owner.excluded(await reviews.get(context.caller, reviewId, context.tx), actorId)
      );
    },
    check: async (context, receipt) => {
      const lease = await owner.lease(context);
      checkReceipt(lease, receipt, 'The lease ownership receipt no longer matches');
      if (!lease.review_id) return;
      // checkSubmit refuses a reviewer who is not independent of the reviewed work.
      const review = await reviews.checkSubmit(
        context.caller,
        lease.review_id,
        undefined,
        context.tx,
      );
      check(
        review.claimId === lease.claim_id && review.subjectRevision === context.snapshot.revision,
        'stale_claim',
        'The lease no longer owns its review claim',
        409,
      );
    },
    outputs: async (context) => {
      const lease = await owner.lease(context);
      return {
        artifacts: [
          ...new Set([
            ...(await owner.artifacts.executionOutputs(context.caller, context.tx)).map(
              (artifact) => artifact.id,
            ),
            ...((await owner.captures?.(context, lease)) ?? []),
          ]),
        ],
      };
    },
    release: async ({ lease, reason, tx }) => await releasedLease(tx, reviews, lease, reason),
  };
}
