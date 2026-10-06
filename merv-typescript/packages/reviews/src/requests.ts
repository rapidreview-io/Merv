import {
  canonical,
  check,
  digest,
  idPattern,
  inTransaction,
  newId,
  now,
  plain,
  recorded,
  visible,
  type Caller,
  type ReviewInput,
  type ReviewProvenance,
  type ReviewRequest,
  type Transaction,
} from '@merv/contracts';
import { ownField } from './findings.js';
import type { ReviewService } from './index.js';
import { hydrate, type ReviewRow } from './rows.js';

// Requesting a review, reissuing it at a new revision and superseding it: the producer's and the
// administrator's side of a review. ReviewService (index.ts) runs these as its own methods.
/**
 * A bounded list field read without invoking accessors and copied as plain JSON: a proxy,
 * getter or sparse array is refused with `code`, and so is any item `valid` refuses.
 */
function listField<T>(
  input: ReviewInput,
  name: 'excludedActorIds' | 'requiredCriteria',
  code: string,
  what: string,
  valid: (item: unknown) => item is T,
): T[] | undefined {
  const value = ownField(input, name, code, 'Review input');
  if (value === undefined) return undefined;
  const items = plain(value, code, { nodes: 201 });
  check(
    Array.isArray(items) && items.length <= 200 && items.every(valid),
    code,
    `${what} must be a bounded list`,
  );
  return items as T[];
}

/** Contributor identity is set-like; normalize before hashing, without invoking accessors. */
function contributorExclusions(input: ReviewInput): string[] | undefined {
  const ids = listField(
    input,
    'excludedActorIds',
    'invalid_review_exclusions',
    'Contributor exclusions',
    (item): item is string => typeof item === 'string' && idPattern.test(item),
  );
  return ids && [...new Set(ids)].sort();
}

/**
 * The criteria a pass can never waive, read without invoking accessors and sorted so that
 * [4,2] and [2,4] pin the same review. Whether each number names one of this review's
 * criteria is checked where the criteria themselves are.
 */
function requiredCriteria(input: ReviewInput): number[] | undefined {
  const numbers = listField(
    input,
    'requiredCriteria',
    'invalid_required_criteria',
    'Required criteria',
    (item): item is number => Number.isSafeInteger(item) && (item as number) >= 1,
  );
  if (numbers === undefined) return undefined;
  check(
    numbers.length >= 1 && new Set(numbers).size === numbers.length,
    'invalid_required_criteria',
    'Required criteria must be distinct and at least one',
  );
  return numbers.sort((a, b) => a - b);
}

export async function request(
  this: ReviewService,
  caller: Caller,
  input: ReviewInput,
  transaction?: Transaction,
): Promise<ReviewRequest> {
  caller = structuredClone(caller);
  // Check descriptor-sensitive exclusions before copying; later awaits must use
  // the same evidence and ownership input that command hashing will retain.
  contributorExclusions(input);
  requiredCriteria(input);
  input = plain<ReviewInput>(input);
  return await inTransaction(this.state, transaction, async (tx) => {
    await this.scope.require(caller, 'write', tx);
    const authority = await this.scope.authorityActor(caller, tx);
    check(
      input.producerId === caller.actorId || authority.role === 'operator',
      'forbidden',
      'Only the producer or an operator can request review',
      403,
    );
    const owner = input.administrativeActorId ?? input.producerId;
    check(
      owner === authority.id || owner === caller.actorId || authority.role === 'operator',
      'forbidden',
      'Review administrative ownership must follow its authenticated source',
      403,
    );
    return await this.saveRequest(caller, input, tx, authority.id);
  });
}

export async function reissue(
  this: ReviewService,
  caller: Caller,
  input: { reviewId: string; subjectRevision: number; requestId: string },
  transaction?: Transaction,
): Promise<ReviewRequest> {
  ({ caller, input } = structuredClone({ caller, input }));
  return await inTransaction(this.state, transaction, async (tx) => {
    await this.scope.require(caller, 'write', tx);
    const row = await this.row(tx, caller, input.reviewId);
    const directing = await this.requireAdministration(caller, row, tx);
    check(
      row.status !== 'submitted',
      'review_closed',
      'Submitted review evidence cannot be reissued',
      409,
    );
    return await this.saveRequest(
      caller,
      {
        ...(row.provenance_json
          ? { provenanceOwner: (JSON.parse(row.provenance_json) as ReviewProvenance).provider }
          : {}),
        subjectId: row.subject_id,
        subjectRevision: input.subjectRevision,
        producerId: row.producer_id,
        administrativeActorId: row.administrative_actor_id,
        artifactIds: JSON.parse(row.artifact_ids),
        pinnedInputIds: JSON.parse(row.pinned_input_ids),
        ...(row.excluded_actor_ids == null
          ? {}
          : { excludedActorIds: JSON.parse(row.excluded_actor_ids) }),
        ...(row.required_criteria == null
          ? {}
          : { requiredCriteria: JSON.parse(row.required_criteria) }),
        criteria: JSON.parse(row.criteria),
        formatVersion: row.format_version,
        requestId: input.requestId,
      },
      tx,
      directing,
      row.excluded_actor_ids == null ? [] : (JSON.parse(row.excluded_actor_ids) as string[]),
    );
  });
}

/** Refuses all but the review's owner or an operator; returns the caller's directing authority. */
export async function requireAdministration(
  this: ReviewService,
  caller: Caller,
  row: ReviewRow,
  tx: Transaction,
): Promise<string> {
  const authority = await this.scope.authorityActor(caller, tx);
  check(
    row.producer_id === caller.actorId ||
      row.administrative_actor_id === authority.id ||
      authority.role === 'operator',
    'forbidden',
    'Only the review owner or an operator may administer this request',
    403,
  );
  return authority.id;
}

export async function saveRequest(
  this: ReviewService,
  caller: Caller,
  input: ReviewInput,
  tx: Transaction,
  /** The authority that directs the caller, read once by the command. */
  directing: string,
  /**
   * Exclusions a stored request already admitted. A reissue replays them exactly as they
   * were pinned, and the authority that directed the worker then is rarely the one asking
   * for the new claim now, so they are not judged again against this caller.
   */
  admitted: string[] = [],
): Promise<ReviewRequest> {
  const excludedActorIds = contributorExclusions(input);
  if (excludedActorIds !== undefined) input = { ...input, excludedActorIds };
  const required = requiredCriteria(input);
  if (required !== undefined) input = { ...input, requiredCriteria: required };
  return await this.command(tx, caller, input.requestId, 'request', input, async () => {
    check(
      typeof input.subjectId === 'string' && visible(input.subjectId),
      'invalid_subject',
      'A subject identifier is required',
    );
    check(
      Number.isSafeInteger(input.subjectRevision) && input.subjectRevision >= 0,
      'invalid_revision',
      'subjectRevision must be a nonnegative integer',
    );
    // Format 2 is the only verdict format. Callers may still name it, since stored request
    // receipts hash it; null is refused.
    check(
      input.formatVersion === undefined || input.formatVersion === 2,
      'invalid_review_format',
      'Review formatVersion must be 2',
    );
    check(
      Array.isArray(input.criteria) &&
        input.criteria.length > 0 &&
        input.criteria.every((item) => typeof item === 'string' && visible(item)),
      'invalid_criteria',
      'At least one nonempty assessment criterion is required',
    );
    check(
      !required || required.every((number) => number <= input.criteria.length),
      'invalid_required_criteria',
      "Required criteria must be numbers of this review's criteria",
    );
    check(
      Array.isArray(input.artifactIds) &&
        input.artifactIds.length > 0 &&
        new Set(input.artifactIds).size === input.artifactIds.length,
      'invalid_artifacts',
      'A review requires a nonempty list of distinct artifacts',
    );
    const pinnedInputIds = input.pinnedInputIds ?? [];
    check(
      Array.isArray(pinnedInputIds) &&
        new Set(pinnedInputIds).size === pinnedInputIds.length &&
        pinnedInputIds.every((id) => typeof id === 'string' && input.artifactIds.includes(id)),
      'invalid_artifacts',
      'Pinned inputs must be distinct entries in the review manifest',
    );
    check(
      pinnedInputIds.length < input.artifactIds.length,
      'invalid_artifacts',
      'Review requires authored output as well as any pinned inputs',
    );
    const manifest = await this.artifacts.getAll(caller, input.artifactIds, tx);
    // Exclusions name contributors: authors of retained evidence, the record's owner, or
    // the authority that directed the submitting worker.
    check(
      !excludedActorIds ||
        excludedActorIds.every(
          (actorId) =>
            actorId === (input.administrativeActorId ?? input.producerId) ||
            actorId === directing ||
            admitted.includes(actorId) ||
            manifest.some((artifact) => artifact.createdBy === actorId),
        ),
      'invalid_review_exclusions',
      'Excluded contributors must be authors of retained evidence, the record owner, or the directing authority',
    );
    check(
      manifest.every(
        (item) => pinnedInputIds.includes(item.id) || item.createdBy === input.producerId,
      ),
      'forbidden',
      'Every output artifact must belong to the producer; other inputs must be explicitly pinned',
      403,
    );
    const provenance = input.provenanceOwner
      ? await this.certificate(input.provenanceOwner, caller.projectId, input.subjectId, tx)
      : undefined;
    const id = newId('review');
    const createdAt = now();
    const snapshotHash = digest({
      ...(provenance ? { provenance } : {}),
      subjectId: input.subjectId,
      subjectRevision: input.subjectRevision,
      producerId: input.producerId,
      criteria: input.criteria,
      manifest,
      ...(pinnedInputIds.length
        ? {
            pinnedInputIds,
            administrativeActorId: input.administrativeActorId ?? input.producerId,
          }
        : {}),
      formatVersion: 2,
      ...(excludedActorIds === undefined ? {} : { excludedActorIds }),
      ...(required === undefined ? {} : { requiredCriteria: required }),
    });
    await tx.run(
      `INSERT INTO reviews (id, project_id, subject_id, subject_revision, producer_id, artifact_ids,
        criteria, manifest, snapshot_hash, status, created_at, format_version, administrative_actor_id, pinned_input_ids${excludedActorIds === undefined ? '' : ', excluded_actor_ids'}${required === undefined ? '' : ', required_criteria'}${provenance ? ', provenance_json' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?${excludedActorIds === undefined ? '' : ', ?'}${required === undefined ? '' : ', ?'}${provenance ? ', ?' : ''})`,
      id,
      caller.projectId,
      input.subjectId,
      input.subjectRevision,
      input.producerId,
      JSON.stringify(input.artifactIds),
      JSON.stringify(input.criteria),
      JSON.stringify(manifest),
      snapshotHash,
      createdAt,
      2,
      input.administrativeActorId ?? input.producerId,
      JSON.stringify(pinnedInputIds),
      ...(excludedActorIds === undefined ? [] : [JSON.stringify(excludedActorIds)]),
      ...(required === undefined ? [] : [JSON.stringify(required)]),
      ...(provenance ? [canonical(provenance)] : []),
    );
    await recorded(this.state, tx, caller, 'review.requested', id, {
      subjectId: input.subjectId,
      subjectRevision: input.subjectRevision,
      snapshotHash,
      ...(excludedActorIds === undefined ? {} : { excludedActorIds }),
      ...(required === undefined ? {} : { requiredCriteria: required }),
    });
    return hydrate(await this.row(tx, caller, id));
  });
}

export async function supersede(
  this: ReviewService,
  caller: Caller,
  reviewId: string,
  transaction?: Transaction,
): Promise<void> {
  caller = structuredClone(caller);
  await inTransaction(this.state, transaction, async (tx) => {
    await this.scope.require(caller, 'write', tx);
    const row = await this.row(tx, caller, reviewId);
    await this.requireAdministration(caller, row, tx);
    if (row.status === 'superseded') return;
    check(row.status !== 'submitted', 'review_closed', 'A submitted verdict is immutable', 409);
    await tx.run("UPDATE reviews SET status = 'superseded' WHERE id = ?", reviewId);
    await recorded(this.state, tx, caller, 'review.superseded', reviewId, {});
  });
}
