import {
  check,
  inTransaction,
  newId,
  plain,
  recorded,
  visible,
  type Caller,
  type ReviewRequest,
  type ReviewSubmit,
  type Role,
  type StoredEvent,
  type Transaction,
} from '@merv/contracts';
import { permits } from '@merv/scope/rules';
import { evidenceFrom, ownField, validateAssessment } from './findings.js';
import type { ReviewService } from './index.js';
import { REVIEW_VERDICTS } from './rules.js';
import { freeze, hydrate, type ReviewRow } from './rows.js';

// Claiming a review, submitting its verdict and releasing a claim: the reviewer's side of a
// review. ReviewService (index.ts) runs these as its own methods.
/** Route shape is generic; allowed destinations and verdict rules belong to the owner. */
export function validateReturnTo(input: { returnTo?: unknown }): string | undefined {
  const value = ownField(input, 'returnTo', 'invalid_return_to', 'Review return input');
  if (value === undefined) return undefined;
  check(
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value),
    'invalid_return_to',
    'returnTo must be an identifier of 1–128 characters, starting with a letter',
  );
  return value;
}

export async function checkStart(
  this: ReviewService,
  caller: Caller,
  reviewId: string,
  transaction?: Transaction,
  override = false,
): Promise<ReviewRequest> {
  caller = structuredClone(caller);
  return await inTransaction(this.state, transaction, async (tx) => {
    const actor = await this.scope.require(caller, 'review', tx);
    const row = await this.row(tx, caller, reviewId);
    const current = hydrate(row);
    // The override is taken with the claim; a retried claim keeps the one it has.
    if (override && row.status === 'requested') current.override = true;
    check(
      await this.independent(caller, actor, current, tx),
      'review_independence',
      override
        ? 'Only the project owner, acting as themself, may decide a review as owner'
        : 'A producer, contributor or directing authority cannot review their own work',
      403,
    );
    check(
      row.status === 'requested' ||
        (row.status === 'started' && row.reviewer_id === caller.actorId),
      'review_unavailable',
      'Review is already claimed or closed',
      409,
    );
    if (row.status === 'started') await this.requireLiveClaim(row, tx);
    return current;
  });
}

export async function start(
  this: ReviewService,
  caller: Caller,
  reviewId: string,
  transaction?: Transaction,
  override = false,
): Promise<ReviewRequest> {
  caller = structuredClone(caller);
  return await inTransaction(this.state, transaction, async (tx) => {
    const current = await this.checkStart(caller, reviewId, tx, override);
    if (current.status === 'started') return current;
    // Only a review one domain can apply a verdict to is claimed, and that domain may refuse
    // a claim its rules could never let finish.
    const { owner, current: unchanged } = await this.ownerOf(freeze(current), tx);
    await owner.claim?.(caller, current, tx);
    unchanged();
    const claimId = newId('claim');
    const changed = await tx.run(
      // Only an override names the column, so an ordinary claim writes what it always has.
      `UPDATE reviews SET status = 'started', reviewer_id = ?, claim_id=?, claim_generation=claim_generation+1${current.override ? ', owner_override=true' : ''} WHERE id = ? AND status = 'requested'`,
      caller.actorId,
      claimId,
      reviewId,
    );
    check(
      changed.changes === 1,
      'review_unavailable',
      'Another reviewer already claimed this review',
      409,
    );
    const event = await recorded(this.state, tx, caller, 'review.started', reviewId, {
      claimId,
      claimGeneration: current.claimGeneration + 1,
      ...(current.override && { override: true }),
    });
    await tx.run(
      `UPDATE reviews SET claim_event_id=?, claimed_at=?, claimed_by_agent=${!!caller.session} WHERE id=?`,
      event.id,
      event.createdAt,
      reviewId,
    );
    return hydrate(await this.row(tx, caller, reviewId));
  });
}

export async function checkSubmit(
  this: ReviewService,
  caller: Caller,
  reviewId: string,
  input?: Omit<ReviewSubmit, 'requestId'>,
  transaction?: Transaction,
): Promise<ReviewRequest> {
  caller = structuredClone(caller);
  if (input) {
    validateReturnTo(input);
    evidenceFrom(input);
    input = plain(input);
  }
  return await inTransaction(this.state, transaction, async (tx) => {
    const actor = await this.scope.require(caller, 'review', tx);
    const row = await this.row(tx, caller, reviewId);
    check(
      row.status === 'started',
      'review_closed',
      'Review must be claimed and open before a verdict can be submitted',
      409,
    );
    const current = hydrate(row);
    check(
      row.reviewer_id === caller.actorId && (await this.independent(caller, actor, current, tx)),
      'review_independence',
      'Only the independent reviewer who claimed this review may submit',
      403,
    );
    await this.requireLiveClaim(row, tx);
    if (input) {
      check(
        typeof input.claimId === 'string' && input.claimId === row.claim_id,
        'stale_claim',
        'Submission must identify the current review claim',
        409,
      );
      check(
        REVIEW_VERDICTS.includes(input.verdict),
        'invalid_verdict',
        'Verdict must be pass, needs_changes, or fail',
      );
      check(
        typeof input.notes === 'string' && visible(input.notes),
        'invalid_notes',
        'A verdict must include assessment notes',
      );
      validateAssessment(hydrate(row), input);
    }
    return hydrate(row);
  });
}

export async function submit(
  this: ReviewService,
  caller: Caller,
  input: ReviewSubmit,
  transaction?: Transaction,
): Promise<ReviewRequest> {
  caller = structuredClone(caller);
  const returnTo = validateReturnTo(input);
  evidenceFrom(input);
  input = plain<ReviewSubmit>(input);
  return await inTransaction(this.state, transaction, async (tx) => {
    await this.scope.require(caller, 'review', tx);
    return await this.command(tx, caller, input.requestId, 'submit', input, async () => {
      const current = await this.checkSubmit(caller, input.reviewId, input, tx);
      const assessment = validateAssessment(current, input);
      await tx.run(
        "UPDATE reviews SET status = 'submitted', verdict = ?, return_to = ?, notes = ?, synopsis = ?, findings_json = ?, evidence_json = ? WHERE id = ?",
        input.verdict,
        returnTo ?? null,
        input.notes,
        assessment.synopsis,
        JSON.stringify(assessment.findings),
        JSON.stringify(assessment.evidence),
        input.reviewId,
      );
      await recorded(this.state, tx, caller, 'review.submitted', input.reviewId, {
        verdict: input.verdict,
        ...(returnTo === undefined ? {} : { returnTo }),
        subjectId: current.subjectId,
        subjectRevision: current.subjectRevision,
        ...(current.override && { override: true }),
      });
      return hydrate(await this.row(tx, caller, input.reviewId));
    });
  });
}

/** Trusted event reactions; neither restored access nor an inactive initiator cancels cleanup. */
export async function releaseClaim(
  this: ReviewService,
  input: {
    projectId: string;
    reviewId: string;
    claimId: string;
    actorId: string;
    reason: string;
  },
  tx: Transaction,
): Promise<void> {
  this.state.assertTransaction(tx);
  const row = await tx.get<ReviewRow>(
    "SELECT * FROM reviews WHERE project_id=? AND id=? AND reviewer_id=? AND claim_id=? AND status='started'",
    input.projectId,
    input.reviewId,
    input.actorId,
    input.claimId,
  );
  if (!row) return;
  const event = await this.state.appendEvent(tx, {
    projectId: input.projectId,
    actorId: input.actorId,
    type: 'review.claim_released',
    subjectId: row.id,
    data: {
      previousActorId: input.actorId,
      previousClaimId: input.claimId,
      reason: input.reason,
      performedBy: 'system:reviews',
      subjectId: row.subject_id,
      subjectRevision: row.subject_revision,
    },
  });
  await tx.run(
    `UPDATE reviews SET status='requested',reviewer_id=NULL,claim_id=NULL,claim_event_id=NULL,claimed_at=NULL,claimed_by_agent=false${row.owner_override ? ',owner_override=false' : ''},recovery_json=? WHERE id=? AND claim_id=?`,
    JSON.stringify({
      eventId: event.id,
      previousActorId: input.actorId,
      previousClaimId: input.claimId,
      reason: input.reason,
    }),
    row.id,
    input.claimId,
  );
}

export async function actorRevoked(
  this: ReviewService,
  event: StoredEvent,
  tx: Transaction,
): Promise<void> {
  this.state.assertTransaction(tx);
  if (event.type !== 'actor.revoked') return;
  await this.releaseClaims(event, 'reviewer_revoked', tx);
}

export async function actorPermissionsChanged(
  this: ReviewService,
  event: StoredEvent,
  tx: Transaction,
): Promise<void> {
  this.state.assertTransaction(tx);
  if (event.type !== 'actor.permissions_changed') return;
  const review = (role: unknown) => permits(role as Role, 'review');
  if (!review(event.data.beforeRole) || review(event.data.role)) return;
  await this.releaseClaims(event, 'review_permission_lost', tx);
}

export async function requireLiveClaim(
  this: ReviewService,
  row: ReviewRow,
  tx: Transaction,
): Promise<void> {
  // A restored membership authorizes new work, but cannot revive a claim whose
  // permission was lost. Check the committed log before eventual recovery runs.
  check(
    !(await this.scope.permissionLost(
      row.project_id,
      row.reviewer_id!,
      'review',
      row.claim_event_id ?? 0,
      tx,
    )),
    'stale_claim',
    'Review permission was lost after this claim; claim again after recovery releases it',
    409,
  );
}

export async function releaseClaims(
  this: ReviewService,
  event: StoredEvent,
  reason: string,
  tx: Transaction,
): Promise<void> {
  const rows = await tx.all<ReviewRow>(
    "SELECT * FROM reviews WHERE project_id=? AND reviewer_id=? AND status='started'",
    event.projectId,
    event.subjectId,
  );
  for (const row of rows) {
    // Recovery may lag behind rejoining a project. Its historical event can invalidate
    // an older claim, but must never release a fresh claim acquired after that event.
    if ((row.claim_event_id ?? 0) >= event.id) continue;
    const recovery = {
      eventId: event.id,
      previousActorId: event.subjectId,
      previousClaimId: row.claim_id,
      reason,
    };
    await tx.run(
      `UPDATE reviews SET status='requested',reviewer_id=NULL,claim_id=NULL,claim_event_id=NULL,claimed_at=NULL,claimed_by_agent=false${row.owner_override ? ',owner_override=false' : ''},recovery_json=? WHERE id=?`,
      JSON.stringify(recovery),
      row.id,
    );
    await this.state.appendEvent(tx, {
      projectId: event.projectId,
      actorId: event.actorId,
      type: 'review.claim_released',
      subjectId: row.id,
      data: {
        ...recovery,
        performedBy: 'system:reviews',
        subjectId: row.subject_id,
        subjectRevision: row.subject_revision,
      },
    });
  }
}
