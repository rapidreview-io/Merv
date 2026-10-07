/** Reviews' contract: the review inputs, owners and the service other units call. */
import type { Sql, Transaction } from './index.js';
import type { Caller } from './scope-models.js';
import type { Data } from './data.js';
import type { Verdict } from './types.js';
export type { Verdict } from './types.js';
import type {
  ReviewClaim,
  ReviewFinding,
  ReviewGuide,
  ReviewProvenance,
  ReviewRequest,
  ReviewReturn,
} from './review-models.js';
export type {
  ReviewClaim,
  ReviewFinding,
  ReviewGuide,
  ReviewProvenance,
  ReviewRequest,
  ReviewReturn,
} from './review-models.js';
export type ReviewProvenanceResolver = (
  projectId: string,
  subjectId: string,
  tx: Transaction,
) => Promise<ReviewProvenance>;
export interface ReviewInput {
  /** Trusted owner capability; callers never provide a certificate or its identities. */
  provenanceOwner?: string;
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  administrativeActorId?: string;
  artifactIds: string[];
  /** Explicit input provenance; all remaining evidence must be authored by producerId. */
  pinnedInputIds?: string[];
  /** Authors of pinned manifest evidence who must not claim or judge this review. */
  excludedActorIds?: string[];
  criteria: string[];
  /**
   * Numbers of the criteria a pass can never waive: each must be met with retained evidence.
   * The requesting domain sets it, so a reviewer cannot wave through the check the domain
   * depends on.
   */
  requiredCriteria?: number[];
  /** The only verdict format: a synopsis and one finding per criterion. */
  formatVersion?: 2;
  requestId: string;
}
export interface ReviewSubmit {
  reviewId: string;
  claimId: string;
  verdict: Verdict;
  /** Optional bounded identifier; the owning domain decides valid/required return routes. */
  returnTo?: string;
  notes: string;
  synopsis?: string;
  findings?: ReviewFinding[];
  /** Structured observations/metrics; evidence.outcome may name the resulting outcome. */
  evidence?: Data;
  requestId: string;
}
/** A held claim handed back, with why; review.release replays by requestId. */
export interface ReviewRelease {
  reviewId: string;
  reason: string;
  requestId: string;
}
/**
 * A verdict as the owning domain applies it. Fields the owner names in `fields` pass through
 * Reviews unread, and the owner validates them.
 */
export interface ReviewApplication extends ReviewSubmit {
  expectedRevision: number;
}
/** Trusted synchronous domain callbacks; ownership checks read metadata only. */
export interface ReviewSubmitOwner {
  id: string;
  owns(review: Readonly<ReviewRequest>, tx: Transaction): boolean | Promise<boolean>;
  submit(caller: Caller, input: ReviewApplication, tx: Transaction): Promise<unknown>;
  /** The owner's verdict rules, shown to a reviewer reading or claiming one of its reviews. */
  guidance?: string;
  /** Extra top-level verdict fields the owner accepts and validates itself; others are refused. */
  fields?: readonly string[];
  /** Refuses a claim of an owned review that the owner's rules could never let finish. */
  claim?(caller: Caller, review: Readonly<ReviewRequest>, tx: Transaction): Promise<void>;
  /** The codes of `claim`'s refusals that the project's owner, deciding as owner, lifts. */
  overrides?: readonly string[];
  /**
   * The verdicts that return the owned work to its producer. Once the limit leaving the work's
   * gate is used up (`Workflows.exhaustedLimit`), Reviews rules them out itself: the reviewer
   * is then told so, and offered no return route if no rejecting verdict is left.
   */
  returning?: readonly Verdict[];
  /** The verdicts this caller may submit on an owned review, where the owner's rules rule some out. */
  verdicts?(
    caller: Caller,
    review: Readonly<ReviewRequest>,
    tx: Transaction,
  ): Promise<readonly Verdict[]>;
  /** The routes a rejecting verdict on this review may choose, where the owner offers a choice. */
  returns?(review: Readonly<ReviewRequest>, tx: Transaction): Promise<readonly ReviewReturn[]>;
  /**
   * The gate each owned review among these was read at, for a domain whose records are
   * reviewed at more than one. Read-only; ids it does not own are left out.
   */
  gates?(reviewIds: readonly string[], sql: Sql): Promise<Readonly<Record<string, string>>>;
  /** What the delivery an owned review judges claimed of each check, where the owner keeps
   *  such claims; read-only, and empty for a review of anything but the newest delivery. */
  claims?(
    caller: Caller,
    review: Readonly<ReviewRequest>,
    tx: Transaction,
  ): Promise<readonly ReviewClaim[]>;
}
export interface Reviews {
  provenance(provider: string): { register(resolve: ReviewProvenanceResolver): () => void };
  registerSubmitOwner(owner: ReviewSubmitOwner): () => void;
  /** Select one current domain owner and apply its verdict/transition in the same writer. */
  apply(caller: Caller, input: ReviewApplication, tx?: Transaction): Promise<unknown>;
  /** What the one domain that owns this review tells its reviewer: its verdict rules, return
   * routes, the verdicts open to this reader, what deciding as owner lifts, the gate it reads
   * and what the delivery claimed, where it states them. A review the caller has just read (get, start) is not read again. */
  guide(caller: Caller, review: string | ReviewRequest, tx?: Transaction): Promise<ReviewGuide>;
  request(caller: Caller, input: ReviewInput, tx?: Transaction): Promise<ReviewRequest>;
  /** Trusted cleanup of exactly one worker claim, without reviving expired caller authority. */
  releaseClaim(
    input: {
      projectId: string;
      reviewId: string;
      claimId: string;
      actorId: string;
      reason: string;
      releasedBy?: string;
    },
    tx: Transaction,
  ): Promise<void>;
  /** Hands a claim back, by the reviewer who holds it or a project admin, never a leased worker. */
  release(caller: Caller, input: ReviewRelease, tx?: Transaction): Promise<ReviewRequest>;
  get(caller: Caller, reviewId: string, tx?: Transaction): Promise<ReviewRequest>;
  /**
   * Several reviews in one read, without what get() adds for an operator; an id the project
   * does not hold is left out.
   */
  find(
    caller: Caller,
    ids: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, ReviewRequest>>;
  /** With `subjectId`, only the reviews of that record. */
  list(caller: Caller, filter?: { subjectId?: string }): Promise<ReviewRequest[]>;
  /**
   * What Home and the rail poll: every open review, each subject's current review and newest
   * verdict, and the newest verdicts, oldest first; `list` holds every review.
   */
  home(caller: Caller): Promise<ReviewRequest[]>;
  /** How many of the project's reviews are requested or started. */
  open(caller: Caller): Promise<number>;
  /** `override` claims it as the project's owner: only that person, signed in, may. */
  start(
    caller: Caller,
    reviewId: string,
    tx?: Transaction,
    override?: boolean,
  ): Promise<ReviewRequest>;
  checkStart(caller: Caller, reviewId: string, tx?: Transaction): Promise<ReviewRequest>;
  checkSubmit(
    caller: Caller,
    reviewId: string,
    input?: Omit<ReviewSubmit, 'requestId'>,
    tx?: Transaction,
  ): Promise<ReviewRequest>;
  submit(caller: Caller, input: ReviewSubmit, tx?: Transaction): Promise<ReviewRequest>;
  supersede(caller: Caller, reviewId: string, tx?: Transaction): Promise<void>;
  /**
   * The Running sidebar's Review sections for each subject that has a review: how the current
   * review stands, and its earlier rounds. Waiting stays operator-only, as get() keeps it.
   */
  running(
    caller: Caller,
    subjectIds: readonly string[],
    tx?: Transaction,
  ): Promise<import('./running.js').RunningSection[]>;
}
