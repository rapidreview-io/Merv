import {
  directsIndependently,
  excludedFromReview,
  NOT_INDEPENDENT,
  REVIEW_VERDICTS,
  standings,
} from './rules.js';
import { canonical, visible, isDirectHuman } from '@merv/contracts';
import { sourceCaller } from '@merv/scope/rules';
import { createService, idPattern, plain, receipted, mapAsync } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { leaseReleaseConsumer } from '@merv/workflows/lease-rows';
import type { Context } from 'cordis';
import {
  check,
  digest,
  inTransaction,
  type Actor,
  type Artifacts,
  type Caller,
  type ReviewProvenance,
  type ReviewProvenanceResolver,
  type ReviewGuide,
  type ReviewRequest,
  type Reviews,
  type ReviewApplication,
  type ReviewSubmitOwner,
  type RunningSection,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { EARLIER, reviewSections } from './running.js';
import { freeze, hydrate, type ReviewRow } from './rows.js';
import { reissue, request, requireAdministration, saveRequest, supersede } from './requests.js';
import {
  actorPermissionsChanged,
  actorRevoked,
  checkStart,
  checkSubmit,
  releaseClaim,
  releaseClaims,
  requireLiveClaim,
  start,
  submit,
  validateReturnTo,
} from './claims.js';

/** The verdict fields Reviews reads; an owner may name more for itself. */
const submitFields: ReadonlySet<string> = new Set([
  'reviewId',
  'claimId',
  'verdict',
  'returnTo',
  'notes',
  'synopsis',
  'findings',
  'evidence',
  'expectedRevision',
  'requestId',
]);

/**
 * The project's owner as the signed-in person: an operator's member actor with human authority.
 * Never a key, which agents and workers hold, a worker, a machine actor or a conversation.
 */
const projectOwner = (caller: Caller, actor: Actor) =>
  actor.role === 'operator' && !!actor.user && isDirectHuman(caller);

/** Generic assessment of immutable evidence. Target state changes belong to the integrating program. */
export class ReviewService implements Reviews {
  // The producer's side (requests.ts) and the reviewer's (claims.ts). Only the Reviews contract
  // is public; the rest are theirs.
  readonly request = request;
  readonly reissue = reissue;
  readonly supersede = supersede;
  readonly requireAdministration = requireAdministration;
  readonly saveRequest = saveRequest;
  readonly checkStart = checkStart;
  readonly start = start;
  readonly checkSubmit = checkSubmit;
  readonly submit = submit;
  readonly releaseClaim = releaseClaim;
  readonly actorRevoked = actorRevoked;
  readonly actorPermissionsChanged = actorPermissionsChanged;
  readonly requireLiveClaim = requireLiveClaim;
  readonly releaseClaims = releaseClaims;
  private readonly owners = new Map<string, Readonly<ReviewSubmitOwner>>();
  private readonly provenanceOwners = new Map<string, ReviewProvenanceResolver>();
  private ownerEpoch = 0;
  private closed = false;
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly artifacts: Artifacts,
  ) {}
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('reviews', postgresMigrations);
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

  async certificate(
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

  async independent(
    caller: Caller,
    actor: Actor,
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
    // The owner's override lifts the exclusions below, and only for that person: an agent's
    // conversation proposes it, and the person's own Run takes it.
    if (review.override) return projectOwner(caller, actor);
    // Existing evidence exclusions and owner-certified contributors share one identity rule.
    return (
      !excludedFromReview(review, caller.actorId) &&
      directsIndependently(review, (await this.scope.authorityActor(caller, tx)).id)
    );
  }

  registerSubmitOwner(owner: ReviewSubmitOwner): () => void {
    check(!this.closed, 'review_owner_unavailable', 'Review routing is unavailable', 503);
    check(
      typeof owner?.id === 'string' && idPattern.test(owner.id),
      'invalid_review_owner',
      'Review owner requires an identifier',
    );
    check(
      !this.owners.has(owner.id),
      'review_owner_conflict',
      'Review owner is already registered',
      409,
    );
    // A copy: the callbacks and fields registered are the ones that stay.
    const registered = Object.freeze({
      ...owner,
      ...(owner.fields ? { fields: Object.freeze([...owner.fields]) } : {}),
    });
    this.owners.set(registered.id, registered);
    this.ownerEpoch++;
    return () => {
      if (this.owners.get(registered.id) !== registered) return;
      this.owners.delete(registered.id);
      this.ownerEpoch++;
    };
  }

  /**
   * The one active domain that owns this review, and a check that ownership has not changed
   * since: a claim or verdict nothing could apply, or two domains could, is refused.
   */
  async ownerOf(
    review: Readonly<ReviewRequest>,
    tx: Transaction,
  ): Promise<{ owner: Readonly<ReviewSubmitOwner>; current: () => void }> {
    check(!this.closed, 'review_owner_unavailable', 'Review routing is unavailable', 503);
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
    check(matches.length > 0, 'review_owner_unavailable', 'No active domain owns this review', 503);
    check(matches.length === 1, 'review_owner_ambiguous', 'Multiple domains own this review', 409);
    return { owner: matches[0], current };
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
      const review = freeze(await this.get(caller, input.reviewId, tx));
      const { owner, current } = await this.ownerOf(review, tx);
      const extra = Object.keys(input).find(
        (key) => !submitFields.has(key) && !owner.fields?.includes(key),
      );
      check(extra === undefined, 'invalid_review_input', `This review does not accept ${extra}`);
      // The domain's own command handles replay before current-claim checks. Checking
      // an open claim here would reject a retry after its first successful verdict.
      const result = await owner.submit(caller, input, tx);
      current();
      await this.scope.require(caller, 'review', tx);
      return result;
    });
  }

  async guide(
    caller: Caller,
    reviewOrId: string | ReviewRequest,
    transaction?: Transaction,
  ): Promise<ReviewGuide> {
    caller = structuredClone(caller);
    const review = freeze(
      typeof reviewOrId === 'string'
        ? await this.get(caller, reviewOrId, transaction)
        : structuredClone(reviewOrId),
    );
    const read = async (tx: Transaction) => {
      const matches: Readonly<ReviewSubmitOwner>[] = [];
      for (const owner of [...this.owners.values()])
        if ((await owner.owns(review, tx)) === true) matches.push(owner);
      if (matches.length !== 1) return {};
      const [{ guidance, returns, verdicts, overrides = [], claims }] = matches;
      const routes = returns ? [...(await returns(review, tx))] : [];
      const open = verdicts && [...(await verdicts(caller, review, tx))];
      const gate = (await this.gatesOf([review.id], tx)).get(review.id);
      const claimed = claims ? [...(await claims(caller, review, tx))] : [];
      return {
        ...(guidance === undefined ? {} : { guidance }),
        ...(routes.length ? { returns: routes.map(({ value, label }) => ({ value, label })) } : {}),
        ...(open ? { verdicts: REVIEW_VERDICTS.filter((verdict) => open.includes(verdict)) } : {}),
        // Deciding as owner lifts Reviews' own independence rule, and what the owner says it lifts.
        ...(review.overridable ? { overrides: [NOT_INDEPENDENT[0], ...overrides] } : {}),
        ...(gate === undefined ? {} : { gate }),
        ...(claimed.length ? { claims: structuredClone(claimed) } : {}),
      };
    };
    // Ownership reads in a transaction; a snapshot's is read-only and takes no writer lock.
    const tx = transaction ?? this.state.ambient;
    if (tx) {
      this.state.assertTransaction(tx);
      return await read(tx);
    }
    return await this.state.snapshotTransaction(read);
  }

  close(): void {
    this.closed = true;
    this.owners.clear();
    this.provenanceOwners.clear();
    this.ownerEpoch++;
  }

  async row(sql: Sql, caller: Caller, reviewId: string): Promise<ReviewRow> {
    const row = await sql.get<ReviewRow>(
      'SELECT * FROM reviews WHERE id = ? AND project_id = ?',
      reviewId,
      caller.projectId,
    );
    check(row, 'not_found', 'Review not found in this project', 404);
    return row;
  }

  async command(
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
    return await receipted(tx, caller, requestId, digest(input), fn, {
      table: 'review_commands',
      operation,
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
    const authorityId = reviewer
      ? (await this.scope.authorityActor(caller, tx)).id
      : caller.actorId;
    return reviews.map((review) => ({
      ...review,
      claimable:
        reviewer &&
        review.status === 'requested' &&
        !excludedFromReview(review, caller.actorId) &&
        directsIndependently(review, authorityId),
    }));
  }

  /**
   * How this caller reads reviews, authorized once: an operator also learns whether they may
   * override a requested one, and whether it waits for an operator to add an independent reviewer.
   */
  private async reader(caller: Caller, transaction?: Transaction) {
    const reader = await this.scope.require(caller, 'read', transaction);
    // The person's own agent reads it as the person, to propose what only the person's Run takes.
    const person = caller.conversation
      ? sourceCaller(await this.scope.delegationSource(caller, transaction))
      : caller;
    return async (review: ReviewRequest): Promise<ReviewRequest> => {
      if (review.status !== 'requested' || reader.role !== 'operator' || reader.sessionId)
        return review;
      if (projectOwner(person, reader)) review.overridable = true;
      const { producerId, excludedActorIds = [], provenance } = review;
      if (
        provenance &&
        !(await this.scope.eligible(
          caller.projectId,
          { except: [producerId, ...excludedActorIds, ...provenance.excludedActorIds] },
          'review',
          transaction,
        ))
      )
        review.waiting =
          'Every eligible reviewer is a retained contributor or directing authority. An operator must provide an independent reviewer.';
      return review;
    };
  }

  async get(caller: Caller, reviewId: string, transaction?: Transaction): Promise<ReviewRequest> {
    caller = structuredClone(caller);
    const view = await this.reader(caller, transaction);
    const read = async (sql: Sql) => await view(hydrate(await this.row(sql, caller, reviewId)));
    if (transaction) {
      this.state.assertTransaction(transaction);
      return await read(transaction);
    }
    return await this.state.read(read);
  }

  async find(caller: Caller, ids: readonly string[], transaction?: Transaction) {
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', transaction);
    const read = async (sql: Sql) => {
      const rows = await sql.all<ReviewRow>(
        'SELECT * FROM reviews WHERE project_id = ? AND id IN (SELECT jsonb_array_elements_text(?::jsonb))',
        caller.projectId,
        JSON.stringify([...new Set(ids)]),
      );
      return new Map(rows.map((row) => [row.id, hydrate(row)]));
    };
    if (!transaction) return await this.state.read(read);
    this.state.assertTransaction(transaction);
    return await read(transaction);
  }

  async list(caller: Caller, { subjectId }: { subjectId?: string } = {}): Promise<ReviewRequest[]> {
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read');
    return await this.state.read(
      async (sql) =>
        await this.claimableBy(
          caller,
          standings(
            (
              await sql.all<ReviewRow>(
                `SELECT * FROM reviews WHERE project_id = ?${subjectId === undefined ? '' : ' AND subject_id = ?'} ORDER BY created_at, id`,
                caller.projectId,
                ...(subjectId === undefined ? [] : [subjectId]),
              )
            ).map(hydrate),
          ),
        ),
    );
  }

  async open(caller: Caller): Promise<number> {
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read');
    return await this.state.read(
      async (sql) =>
        (await sql.get<{ n: number }>(
          "SELECT count(*)::int AS n FROM reviews WHERE project_id = ? AND status IN ('requested', 'started')",
          caller.projectId,
        ))!.n,
    );
  }

  /**
   * The Running sidebar's Review sections for these subjects, read inside the page's snapshot:
   * one query over the project's reviews of them, the review that speaks for each read as get()
   * serves it to this caller, with its waiting, synopsis and findings.
   */
  async running(
    caller: Caller,
    subjectIds: readonly string[],
    transaction?: Transaction,
  ): Promise<RunningSection[]> {
    caller = structuredClone(caller);
    // A sidebar asks about its own key and the few it absorbed, and a machine's about none.
    const subjects = [...new Set(subjectIds)]
      .filter((id) => typeof id === 'string' && visible(id))
      .slice(0, 64);
    if (!subjects.length) return [];
    const view = await this.reader(caller, transaction);
    const read = async (sql: Sql) => {
      // The newest at the highest revision it pinned speaks for its subject, so an open
      // re-review outranks the verdict it will replace. Earlier rounds show only their outcome,
      // so only the newest is read whole, manifest and all.
      const rows = await sql.all<
        Pick<ReviewRow, 'id' | 'subject_id' | 'status' | 'verdict' | 'created_at'>
      >(
        `SELECT id, subject_id, status, verdict, created_at FROM reviews
         WHERE project_id = ? AND subject_id IN (${subjects.map(() => '?').join(',')})
         ORDER BY subject_revision DESC, created_at DESC, id DESC`,
        caller.projectId,
        ...subjects,
      );
      const rounds = subjects
        .map((subjectId) => rows.filter((row) => row.subject_id === subjectId))
        .filter((mine) => mine.length > 0);
      const whole = new Map(
        rounds.length
          ? (
              await sql.all<ReviewRow>(
                `SELECT * FROM reviews WHERE project_id = ? AND id IN (${rounds.map(() => '?').join(',')})`,
                caller.projectId,
                ...rounds.map(([newest]) => newest!.id),
              )
            ).map((row) => [row.id, row])
          : [],
      );
      const gates = await this.gatesOf(
        rounds.flatMap((mine) => mine.slice(0, EARLIER + 1).map((row) => row.id)),
        sql,
      );
      const gated = (id: string) => (gates.has(id) ? { gate: gates.get(id)! } : {});
      const sections = await mapAsync(rounds, async ([newest, ...earlier]) => {
        const row = whole.get(newest!.id)!;
        const current = await view(hydrate(row));
        const claim =
          current.status === 'started' && row.claimed_at !== null
            ? { at: row.claimed_at, agent: row.claimed_by_agent }
            : undefined;
        return reviewSections({
          current,
          ...gated(current.id),
          ...(claim ? { claim } : {}),
          earlier: earlier.map((row) => ({
            id: row.id,
            status: row.status,
            verdict: row.verdict,
            createdAt: row.created_at,
            ...gated(row.id),
          })),
        });
      });
      return sections.flat();
    };
    if (transaction) {
      this.state.assertTransaction(transaction);
      return await read(transaction);
    }
    return await this.state.read(read);
  }

  /**
   * The gate each of these reviews was read at, named by the domain that owns it where its
   * records are reviewed at more than one. The first owner to name a review names it.
   */
  private async gatesOf(reviewIds: readonly string[], sql: Sql): Promise<Map<string, string>> {
    const gates = new Map<string, string>();
    if (!reviewIds.length) return gates;
    for (const owner of [...this.owners.values()]) {
      if (!owner.gates) continue;
      const named: unknown = await owner.gates(Object.freeze([...reviewIds]), sql);
      if (!named || typeof named !== 'object') continue;
      for (const id of reviewIds) {
        const gate: unknown = Object.hasOwn(named, id)
          ? (named as Record<string, unknown>)[id]
          : null;
        if (!gates.has(id) && typeof gate === 'string' && gate.length <= 40 && visible(gate))
          gates.set(id, gate);
      }
    }
    return gates;
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
      // A closed worker session releases its workflow lease, and the review claim it held.
      yield await ctx.domainEvents.subscribe(
        leaseReleaseConsumer('reviews.lease-release.v1', reviews),
      );
      yield ctx.provide('reviews', reviews);
    });
  },
};
export default reviewsPlugin;
