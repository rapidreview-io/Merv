import { excludedFromReview, canonical, visible, recorded, mapAsync } from '@merv/contracts';
import { createService, plain } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import { types as nodeTypes } from 'node:util';
import {
  check,
  digest,
  inTransaction,
  newId,
  now,
  type Artifacts,
  type Caller,
  type ReviewInput,
  type ReviewProvenance,
  type ReviewProvenanceResolver,
  type ReviewRequest,
  type Reviews,
  type ReviewSubmit,
  type ReviewApplication,
  type ReviewSubmitOwner,
  type Scope,
  type Sql,
  type State,
  type Transaction,
  type StoredEvent,
} from '@merv/contracts';
import { validateAssessment, evidenceFrom } from './findings.js';

export type {
  ReviewInput,
  ReviewRequest,
  ReviewSubmit,
  ReviewApplication,
  ReviewSubmitOwner,
  Reviews,
  Verdict,
} from '@merv/contracts';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Route shape is generic; allowed destinations and verdict rules belong to the owner. */
function validateReturnTo(input: { returnTo?: unknown }): string | undefined {
  check(
    input && typeof input === 'object' && !nodeTypes.isProxy(input) && !Array.isArray(input),
    'invalid_return_to',
    'Review return input must be an ordinary object',
  );
  const prototype = Object.getPrototypeOf(input);
  check(
    prototype === Object.prototype || prototype === null,
    'invalid_return_to',
    'Review return input must be an ordinary object',
  );
  const descriptor = Object.getOwnPropertyDescriptor(input, 'returnTo');
  check(
    !('returnTo' in input) || (!!descriptor && 'value' in descriptor),
    'invalid_return_to',
    'returnTo must be an ordinary data property',
  );
  const value = descriptor?.value;
  if (value === undefined) return undefined;
  check(
    descriptor?.enumerable &&
      typeof value === 'string' &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value),
    'invalid_return_to',
    'returnTo must be an identifier of 1–128 characters, starting with a letter',
  );
  return value;
}

/** Contributor identity is set-like; normalize before hashing, without invoking accessors. */
function contributorExclusions(input: ReviewInput): string[] | undefined {
  check(
    input && typeof input === 'object' && !Array.isArray(input) && !nodeTypes.isProxy(input),
    'invalid_review_exclusions',
    'Review input must be an ordinary object',
  );
  const prototype = Object.getPrototypeOf(input);
  check(
    prototype === Object.prototype || prototype === null,
    'invalid_review_exclusions',
    'Review input must be a plain object',
  );
  const field = Object.getOwnPropertyDescriptor(input, 'excludedActorIds');
  check(
    !('excludedActorIds' in input) || (field && Object.hasOwn(field, 'value')),
    'invalid_review_exclusions',
    'Contributor exclusions must be an ordinary data field',
  );
  if (!field || field.value === undefined) return undefined;
  const value: unknown = field.value;
  check(
    field.enumerable &&
      Array.isArray(value) &&
      !nodeTypes.isProxy(value) &&
      Object.getPrototypeOf(value) === Array.prototype,
    'invalid_review_exclusions',
    'Contributor exclusions must be an ordinary array',
  );
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  check(
    length <= 200 && Reflect.ownKeys(value).length === length + 1,
    'invalid_review_exclusions',
    'Contributor exclusions must be a bounded dense array',
  );
  const ids = Array.from({ length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    check(
      item &&
        Object.hasOwn(item, 'value') &&
        item.enumerable &&
        typeof item.value === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(item.value),
      'invalid_review_exclusions',
      'Contributor exclusions must be actor identifiers',
    );
    return item.value as string;
  });
  return [...new Set(ids)].sort();
}

/**
 * The criteria a pass can never waive, read without invoking accessors and sorted so that
 * [4,2] and [2,4] pin the same review. Whether each number names one of this review's
 * criteria is checked where the criteria themselves are.
 */
function requiredCriteria(input: ReviewInput): number[] | undefined {
  const field = Object.getOwnPropertyDescriptor(input, 'requiredCriteria');
  check(
    !('requiredCriteria' in input) || (field && Object.hasOwn(field, 'value')),
    'invalid_required_criteria',
    'Required criteria must be an ordinary data field',
  );
  if (!field || field.value === undefined) return undefined;
  const value: unknown = field.value;
  check(
    field.enumerable &&
      Array.isArray(value) &&
      !nodeTypes.isProxy(value) &&
      Object.getPrototypeOf(value) === Array.prototype,
    'invalid_required_criteria',
    'Required criteria must be an ordinary array',
  );
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  check(
    length >= 1 && length <= 200 && Reflect.ownKeys(value).length === length + 1,
    'invalid_required_criteria',
    'Required criteria must be a nonempty bounded dense array',
  );
  const numbers = Array.from({ length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    check(
      item &&
        Object.hasOwn(item, 'value') &&
        item.enumerable &&
        Number.isSafeInteger(item.value) &&
        item.value >= 1,
      'invalid_required_criteria',
      'Required criteria must be criterion numbers',
    );
    return item.value as number;
  });
  check(
    new Set(numbers).size === length,
    'invalid_required_criteria',
    'Required criteria must be distinct',
  );
  return numbers.sort((a, b) => a - b);
}

interface ReviewRow {
  id: string;
  project_id: string;
  subject_id: string;
  subject_revision: number;
  producer_id: string;
  administrative_actor_id: string | null;
  pinned_input_ids: string;
  excluded_actor_ids: string | null;
  required_criteria: string | null;
  provenance_json: string | null;
  artifact_ids: string;
  criteria: string;
  format_version: 2;
  manifest: string;
  snapshot_hash: string;
  status: ReviewRequest['status'];
  reviewer_id: string | null;
  claim_id: string | null;
  claim_generation: number;
  recovery_json: string | null;
  verdict: ReviewRequest['verdict'];
  return_to: string | null;
  notes: string | null;
  synopsis: string | null;
  findings_json: string;
  evidence_json: string;
  created_at: string;
}
const hydrate = (row: ReviewRow): ReviewRequest => ({
  ...(row.provenance_json == null ? {} : { provenance: JSON.parse(row.provenance_json) }),
  id: row.id,
  projectId: row.project_id,
  subjectId: row.subject_id,
  subjectRevision: row.subject_revision,
  producerId: row.producer_id,
  administrativeActorId: row.administrative_actor_id ?? row.producer_id,
  pinnedInputIds: JSON.parse(row.pinned_input_ids),
  ...(row.excluded_actor_ids == null
    ? {}
    : { excludedActorIds: JSON.parse(row.excluded_actor_ids) }),
  ...(row.required_criteria == null ? {} : { requiredCriteria: JSON.parse(row.required_criteria) }),
  artifactIds: JSON.parse(row.artifact_ids),
  criteria: JSON.parse(row.criteria),
  formatVersion: row.format_version,
  snapshotHash: row.snapshot_hash,
  status: row.status,
  reviewerId: row.reviewer_id,
  claimId: row.claim_id,
  claimGeneration: row.claim_generation,
  recovery: row.recovery_json ? JSON.parse(row.recovery_json) : null,
  verdict: row.verdict,
  ...(row.return_to == null ? {} : { returnTo: row.return_to }),
  notes: row.notes,
  synopsis: row.synopsis,
  findings: JSON.parse(row.findings_json),
  evidence: JSON.parse(row.evidence_json),
  createdAt: row.created_at,
});

/** Generic assessment of immutable evidence. Target state changes belong to the integrating program. */
export class ReviewService implements Reviews {
  private readonly owners = new Map<string, Readonly<ReviewSubmitOwner>>();
  private readonly provenanceOwners = new Map<string, ReviewProvenanceResolver>();
  private ownerEpoch = 0;
  private closed = false;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
  ) {
    this.initialize = async () => {
      await state.migrate('reviews', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
        {
          version: 2,
          sql: postgresMigrations[2],
        },
        {
          version: 3,
          sql: postgresMigrations[3],
        },
        {
          version: 4,
          sql: postgresMigrations[4],
        },
        {
          version: 5,
          sql: postgresMigrations[5],
        },
        {
          version: 6,
          sql: postgresMigrations[6],
        },
        {
          version: 7,
          sql: postgresMigrations[7],
        },
        {
          version: 8,
          sql: postgresMigrations[8],
        },
        {
          version: 9,
          sql: postgresMigrations[9],
        },
        {
          version: 10,
          sql: postgresMigrations[10],
        },
      ]);
    };
  }

  provenance(provider: string): ReturnType<Reviews['provenance']> {
    check(provider.trim().length > 0, 'invalid_provider', 'A provenance owner is required');
    return {
      register: (resolve) => {
        check(
          !this.closed && !this.provenanceOwners.has(provider),
          'review_owner_conflict',
          'Provenance owner is already registered or unavailable',
          409,
        );
        this.provenanceOwners.set(provider, resolve);
        return () => {
          if (this.provenanceOwners.get(provider) === resolve)
            this.provenanceOwners.delete(provider);
        };
      },
    };
  }

  private async certificate(
    provider: string,
    projectId: string,
    subjectId: string,
    tx: Transaction,
  ): Promise<ReviewProvenance> {
    const resolve = this.provenanceOwners.get(provider);
    check(
      !this.closed && resolve,
      'review_owner_unavailable',
      'The review provenance owner is unavailable',
      503,
    );
    const certificate = structuredClone(await resolve(projectId, subjectId, tx));
    const { hash, ...body } = certificate;
    check(
      this.provenanceOwners.get(provider) === resolve,
      'review_owner_unavailable',
      'The review provenance owner changed',
      503,
    );
    check(
      body.formatVersion === 1 &&
        body.provider === provider &&
        hash === digest(body) &&
        canonical(body.excludedActorIds) === canonical([...new Set(body.excludedActorIds)].sort()),
      'invalid_review_owner',
      'The owner supplied an invalid provenance certificate',
      409,
    );
    return certificate;
  }

  private async independent(
    caller: Caller,
    review: ReviewRequest,
    tx: Transaction,
  ): Promise<boolean> {
    if (review.provenance?.revalidate) {
      const current = await this.certificate(
        review.provenance.provider,
        review.projectId,
        review.subjectId,
        tx,
      );
      check(
        canonical(current) === canonical(review.provenance),
        'review_provenance_changed',
        'The exact pinned review result and contributors must still match; request a new review',
        409,
      );
    }
    // Existing evidence exclusions and owner-certified contributors share one identity rule.
    return (
      !excludedFromReview(review, caller.actorId) &&
      (!review.provenance ||
        !excludedFromReview(review, (await this.scope.authorityActor(caller, tx)).id))
    );
  }

  registerSubmitOwner(owner: ReviewSubmitOwner): () => void {
    check(!this.closed, 'review_owner_unavailable', 'Review routing is unavailable', 503);
    check(
      owner &&
        typeof owner === 'object' &&
        !Array.isArray(owner) &&
        (Object.getPrototypeOf(owner) === Object.prototype ||
          Object.getPrototypeOf(owner) === null),
      'invalid_review_owner',
      'Review owner must be a plain object',
    );
    const descriptors = Object.getOwnPropertyDescriptors(owner);
    check(
      Reflect.ownKeys(owner).length === 3 &&
        ['id', 'owns', 'submit'].every(
          (key) => descriptors[key] && 'value' in descriptors[key] && descriptors[key].enumerable,
        ),
      'invalid_review_owner',
      'Review owner requires only id, owns and submit',
    );
    check(
      typeof owner.id === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(owner.id) &&
        typeof owner.owns === 'function' &&
        typeof owner.submit === 'function',
      'invalid_review_owner',
      'Review owner requires an identifier and callbacks',
    );
    check(
      !this.owners.has(owner.id),
      'review_owner_conflict',
      'Review owner is already registered',
      409,
    );
    const registered = Object.freeze({ id: owner.id, owns: owner.owns, submit: owner.submit });
    this.owners.set(registered.id, registered);
    this.ownerEpoch++;
    return () => {
      if (this.owners.get(registered.id) !== registered) return;
      this.owners.delete(registered.id);
      this.ownerEpoch++;
    };
  }

  async apply(
    caller: Caller,
    input: ReviewApplication,
    transaction?: Transaction,
  ): Promise<unknown> {
    caller = structuredClone(caller);
    // Preserve route-specific validation before detaching input from its caller.
    validateReturnTo(input);
    input = plain<ReviewApplication>(input);
    return await inTransaction(this.state, transaction, async (tx) => {
      check(!this.closed, 'review_owner_unavailable', 'Review routing is unavailable', 503);
      await this.scope.require(caller, 'review', tx);
      const review = await freeze(await this.get(caller, input.reviewId, tx));
      const epoch = this.ownerEpoch;
      const matches: Readonly<ReviewSubmitOwner>[] = [];
      for (const owner of [...this.owners.values()]) {
        const owns = await owner.owns(review, tx);
        check(
          typeof owns === 'boolean',
          'invalid_review_owner',
          'Review ownership must return a boolean',
          500,
        );
        if (owns) matches.push(owner);
      }
      const current = () =>
        check(
          !this.closed && epoch === this.ownerEpoch,
          'review_owner_changed',
          'Review ownership changed during application',
          409,
        );
      current();
      check(
        matches.length > 0,
        'review_owner_unavailable',
        'No active domain owns this review',
        503,
      );
      check(
        matches.length === 1,
        'review_owner_ambiguous',
        'Multiple domains own this review',
        409,
      );
      // The domain's own command handles replay before current-claim checks. Checking
      // an open claim here would reject a retry after its first successful verdict.
      const result = await matches[0].submit(caller, input, tx);
      current();
      await this.scope.require(caller, 'review', tx);
      return result;
    });
  }

  close(): void {
    this.closed = true;
    this.owners.clear();
    this.provenanceOwners.clear();
    this.ownerEpoch++;
  }

  private async row(sql: Sql, caller: Caller, reviewId: string): Promise<ReviewRow> {
    const row = await sql.get<ReviewRow>(
      'SELECT * FROM reviews WHERE id = ? AND project_id = ?',
      reviewId,
      caller.projectId,
    );
    check(row, 'not_found', 'Review not found in this project', 404);
    return row;
  }

  private async command(
    tx: Transaction,
    caller: Caller,
    requestId: string,
    operation: string,
    input: unknown,
    fn: () => ReviewRequest | Promise<ReviewRequest>,
  ): Promise<ReviewRequest> {
    check(
      typeof requestId === 'string' && visible(requestId),
      'invalid_request',
      'requestId is required',
    );
    const hash = digest(input);
    const old = await tx.get<{ operation: string; input_hash: string; result: string }>(
      'SELECT operation, input_hash, result FROM review_commands WHERE project_id = ? AND actor_id = ? AND request_id = ?',
      caller.projectId,
      caller.actorId,
      requestId,
    );
    if (old) {
      check(
        old.operation === operation && old.input_hash === hash,
        'request_conflict',
        'requestId was already used with different input',
        409,
      );
      const result = JSON.parse(old.result) as ReviewRequest;
      return {
        ...result,
        administrativeActorId: result.administrativeActorId ?? result.producerId,
        pinnedInputIds: result.pinnedInputIds ?? [],
        synopsis: result.synopsis ?? null,
        findings: result.findings ?? [],
        evidence: result.evidence ?? {},
      };
    }
    const result = await fn();
    await tx.run(
      'INSERT INTO review_commands VALUES (?, ?, ?, ?, ?, ?)',
      caller.projectId,
      caller.actorId,
      requestId,
      operation,
      hash,
      JSON.stringify(result),
    );
    return result;
  }

  async request(
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
      return await this.saveRequest(caller, input, tx);
    });
  }

  async reissue(
    caller: Caller,
    input: { reviewId: string; subjectRevision: number; requestId: string },
    transaction?: Transaction,
  ): Promise<ReviewRequest> {
    ({ caller, input } = structuredClone({ caller, input }));
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const row = await this.row(tx, caller, input.reviewId);
      await this.requireAdministration(caller, row, tx);
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
          administrativeActorId: row.administrative_actor_id ?? row.producer_id,
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
        row.excluded_actor_ids == null ? [] : (JSON.parse(row.excluded_actor_ids) as string[]),
      );
    });
  }

  private async requireAdministration(
    caller: Caller,
    row: ReviewRow,
    tx: Transaction,
  ): Promise<void> {
    const authority = await this.scope.authorityActor(caller, tx);
    check(
      row.producer_id === caller.actorId ||
        (row.administrative_actor_id ?? row.producer_id) === authority.id ||
        authority.role === 'operator',
      'forbidden',
      'Only the review owner or an operator may administer this request',
      403,
    );
  }

  private async saveRequest(
    caller: Caller,
    input: ReviewInput,
    tx: Transaction,
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
      // Format 2 is the only verdict format; an omitted field means it, and null is refused.
      const formatVersion = input.formatVersion === undefined ? 2 : input.formatVersion;
      check(formatVersion === 2, 'invalid_review_format', 'Review formatVersion must be 2');
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
      const manifest = await mapAsync(
        input.artifactIds,
        async (id) => await this.artifacts.get(caller, id, tx),
      );
      // Exclusions name contributors: authors of retained evidence, the record's owner, or
      // the authority that directed the submitting worker.
      const directing = (await this.scope.authorityActor(caller, tx)).id;
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
        formatVersion,
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
        formatVersion,
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

  /**
   * Whose move each unclaimed review is, answered for the reader so that no client has to
   * restate the three clauses checkStart applies: the permission, the producer, and the
   * immutable contributor exclusions. The directing authority is checked once for the list.
   */
  private async claimableBy(
    caller: Caller,
    reviews: ReviewRequest[],
    tx?: Transaction,
  ): Promise<ReviewRequest[]> {
    const reviewer =
      reviews.some((review) => review.status === 'requested') &&
      !!caller.actorId &&
      (await this.scope.eligible(caller.projectId, caller.actorId, 'review', tx));
    const authorityId =
      reviewer && reviews.some((review) => review.provenance && review.status === 'requested')
        ? (await this.scope.authorityActor(caller, tx)).id
        : caller.actorId;
    return reviews.map((review) => ({
      ...review,
      claimable:
        reviewer &&
        review.status === 'requested' &&
        !excludedFromReview(review, caller.actorId) &&
        (!review.provenance || !excludedFromReview(review, authorityId)),
    }));
  }

  async get(caller: Caller, reviewId: string, transaction?: Transaction): Promise<ReviewRequest> {
    caller = structuredClone(caller);
    const reader = await this.scope.require(caller, 'read', transaction);
    const read = async (sql: Sql) => {
      const review = hydrate(await this.row(sql, caller, reviewId));
      if (
        reader.role === 'operator' &&
        !reader.sessionId &&
        review.provenance &&
        review.status === 'requested'
      ) {
        for (const actor of await this.scope.actors(caller))
          if (
            !actor.sessionId &&
            !excludedFromReview(review, actor.id) &&
            (await this.scope.eligible(caller.projectId, actor.id, 'review', transaction))
          )
            return review;
        return {
          ...review,
          waiting:
            'Every eligible reviewer is a retained contributor or directing authority. An operator must provide an independent reviewer.',
        };
      }
      return review;
    };
    if (transaction) {
      this.state.assertTransaction(transaction);
      return await read(transaction);
    }
    return await this.state.read(read);
  }

  async list(caller: Caller): Promise<ReviewRequest[]> {
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read');
    return await this.state.read(
      async (sql) =>
        await this.claimableBy(
          caller,
          (
            await sql.all<ReviewRow>(
              'SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at, id',
              caller.projectId,
            )
          ).map(hydrate),
        ),
    );
  }

  async checkStart(
    caller: Caller,
    reviewId: string,
    transaction?: Transaction,
  ): Promise<ReviewRequest> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'review', tx);
      const row = await this.row(tx, caller, reviewId);
      const current = hydrate(row);
      check(
        await this.independent(caller, current, tx),
        'review_independence',
        'A producer, contributor or directing authority cannot review their own work',
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
      return hydrate(row);
    });
  }

  async start(caller: Caller, reviewId: string, transaction?: Transaction): Promise<ReviewRequest> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const current = await this.checkStart(caller, reviewId, tx);
      if (current.status === 'started') return current;
      const claimId = newId('claim');
      const changed = await tx.run(
        "UPDATE reviews SET status = 'started', reviewer_id = ?, claim_id=?, claim_generation=claim_generation+1 WHERE id = ? AND status = 'requested'",
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
      await recorded(this.state, tx, caller, 'review.started', reviewId, {
        claimId,
        claimGeneration: current.claimGeneration + 1,
      });
      return hydrate(await this.row(tx, caller, reviewId));
    });
  }

  async checkSubmit(
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
      await this.scope.require(caller, 'review', tx);
      const row = await this.row(tx, caller, reviewId);
      check(
        row.status === 'started',
        'review_closed',
        'Review must be claimed and open before a verdict can be submitted',
        409,
      );
      const current = hydrate(row);
      check(
        row.reviewer_id === caller.actorId && (await this.independent(caller, current, tx)),
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
          ['pass', 'needs_changes', 'fail'].includes(input.verdict),
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

  async submit(
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
        });
        return hydrate(await this.row(tx, caller, input.reviewId));
      });
    });
  }

  async supersede(caller: Caller, reviewId: string, transaction?: Transaction): Promise<void> {
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
  /** Trusted event reactions; neither restored access nor an inactive initiator cancels cleanup. */
  async releaseClaim(
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
      "UPDATE reviews SET status='requested',reviewer_id=NULL,claim_id=NULL,recovery_json=? WHERE id=? AND claim_id=?",
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

  async actorRevoked(event: StoredEvent, tx: Transaction): Promise<void> {
    this.state.assertTransaction(tx);
    if (event.type !== 'actor.revoked') return;
    await this.releaseClaims(event, 'reviewer_revoked', tx);
  }

  async actorPermissionsChanged(event: StoredEvent, tx: Transaction): Promise<void> {
    this.state.assertTransaction(tx);
    if (event.type !== 'actor.permissions_changed') return;
    const permitsReview = (role: unknown) => role === 'operator' || role === 'reviewer';
    if (!permitsReview(event.data.beforeRole) || permitsReview(event.data.role)) return;
    await this.releaseClaims(event, 'review_permission_lost', tx);
  }

  private async claimStartedAt(row: ReviewRow, tx: Transaction): Promise<number> {
    return (
      (
        await tx.get<{ id: number | null }>(
          `SELECT MAX(id) AS id FROM events
         WHERE project_id=? AND subject_id=? AND type='review.started'
           AND ((data_json::jsonb #>> '{claimId}')=? OR ?='legacy:' || ?)`,
          row.project_id,
          row.id,
          row.claim_id,
          row.claim_id,
          row.id,
        )
      )?.id ?? 0
    );
  }

  private async requireLiveClaim(row: ReviewRow, tx: Transaction): Promise<void> {
    // A restored membership authorizes new work, but cannot revive a claim whose
    // permission was lost. Check the committed log before eventual recovery runs.
    const loss = await tx.get<{ id: number }>(
      `SELECT id FROM events WHERE project_id=? AND subject_id=? AND id>? AND (
         type='actor.revoked' OR (type='actor.permissions_changed'
           AND (data_json::jsonb #>> '{beforeRole}') IN ('operator','reviewer')
           AND COALESCE((data_json::jsonb #>> '{role}'),'') NOT IN ('operator','reviewer'))
       ) ORDER BY id LIMIT 1`,
      row.project_id,
      row.reviewer_id,
      await this.claimStartedAt(row, tx),
    );
    check(
      !loss,
      'stale_claim',
      'Review permission was lost after this claim; claim again after recovery releases it',
      409,
    );
  }

  private async releaseClaims(event: StoredEvent, reason: string, tx: Transaction): Promise<void> {
    const rows = await tx.all<ReviewRow>(
      "SELECT * FROM reviews WHERE project_id=? AND reviewer_id=? AND status='started'",
      event.projectId,
      event.subjectId,
    );
    for (const row of rows) {
      // Recovery may lag behind rejoining a project. Its historical event can invalidate
      // an older claim, but must never release a fresh claim acquired after that event.
      if ((await this.claimStartedAt(row, tx)) >= event.id) continue;
      const recovery = {
        eventId: event.id,
        previousActorId: event.subjectId,
        previousClaimId: row.claim_id,
        reason,
      };
      await tx.run(
        "UPDATE reviews SET status='requested',reviewer_id=NULL,claim_id=NULL,recovery_json=? WHERE id=?",
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
}

export const reviewsPlugin = {
  name: 'merv-reviews',
  inject: ['state', 'scope', 'artifacts', 'domainEvents'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const reviews = await createService(new ReviewService(ctx.state, ctx.scope, ctx.artifacts));
      yield () => reviews.close();
      yield await ctx.domainEvents.subscribe({
        id: 'reviews.actor-revoked.v1',
        types: ['actor.revoked'],
        from: 'beginning',
        handle: async (event, tx) => await reviews.actorRevoked(event, tx),
      });
      yield await ctx.domainEvents.subscribe({
        id: 'reviews.actor-permissions-changed.v1',
        types: ['actor.permissions_changed'],
        from: 'beginning',
        handle: async (event, tx) => await reviews.actorPermissionsChanged(event, tx),
      });
      yield ctx.provide('reviews', reviews);
    });
  },
};
export default reviewsPlugin;
