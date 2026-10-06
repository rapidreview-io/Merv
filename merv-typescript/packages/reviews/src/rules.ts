import { clip, visible } from '@merv/contracts/text';
import type { ReviewFinding, ReviewRequest, Verdict } from '@merv/contracts/types';

// Reviews' rules that units requesting reviews apply themselves: pure, so any unit may run them,
// and free of server code, so the browser's verdict desk checks a verdict by the same rules.

/** The verdicts a review may reach. */
export const REVIEW_VERDICTS = ['pass', 'needs_changes', 'fail'] as const;
/** What a domain's review.submit step requires of its input. */
export const REVIEW_SUBMIT_INPUT = ['verdict', 'notes', 'synopsis', 'findings'] as const;

/** A review's producer and its excluded contributors cannot be its reviewer. */
export const excludedFromReview = (
  review: Pick<ReviewRequest, 'producerId' | 'excludedActorIds' | 'provenance'>,
  actorId: string,
) =>
  review.producerId === actorId ||
  (review.excludedActorIds ?? []).includes(actorId) ||
  (review.provenance?.excludedActorIds ?? []).includes(actorId);
/**
 * Whether a worker this authority directs may review. The producer never directs its own
 * reviewer, with or without provenance; owner-certified contributors direct none either. Two
 * workers one authority directs are different actors, so either may review the other's work.
 */
export const directsIndependently = (
  review: Pick<ReviewRequest, 'producerId' | 'excludedActorIds' | 'provenance'>,
  authorityId: string,
) =>
  review.provenance ? !excludedFromReview(review, authorityId) : review.producerId !== authorityId;
/**
 * A list of reviews as a reader reads it, in its own order: each open one says so, its subject
 * being in its reviewer's hands, and the newest decided review of each subject (the first of
 * the newest, where several share a moment) says whether its verdict sent the work back.
 */
export function standings<
  T extends Pick<ReviewRequest, 'subjectId' | 'status' | 'verdict' | 'createdAt'>,
>(reviews: T[]): (T & Pick<ReviewRequest, 'open' | 'returned'>)[] {
  const newest = new Map<string, T>();
  for (const review of reviews) {
    const known = newest.get(review.subjectId);
    if (review.status === 'submitted' && (!known || review.createdAt > known.createdAt))
      newest.set(review.subjectId, review);
  }
  return reviews.map((review) => ({
    ...review,
    ...(review.status === 'requested' || review.status === 'started' ? { open: true } : {}),
    ...(newest.get(review.subjectId) === review && review.verdict && review.verdict !== 'pass'
      ? { returned: true }
      : {}),
  }));
}

/**
 * The review that speaks for a subject: the newest at the highest revision it pinned, so an open
 * re-review outranks the verdict it will replace.
 */
export function currentReview<
  T extends Pick<ReviewRequest, 'id' | 'subjectId' | 'subjectRevision' | 'createdAt'>,
>(reviews: readonly T[] | undefined, subjectId: string): T | undefined {
  return (reviews ?? [])
    .filter((review) => review.subjectId === subjectId)
    .sort(
      (a, b) =>
        a.subjectRevision - b.subjectRevision ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .at(-1);
}

/** A check a verdict did not take as met, in the order a reader is told of them. */
export const REVIEW_EXCEPTIONS = ['not_met', 'waived', 'not_verified'] as const;
export type ReviewException = (typeof REVIEW_EXCEPTIONS)[number];
/**
 * The checks each exception covers, by number: what a verdict held back or let through, which a
 * pass built on waivers must still say. Drafted findings count as recorded ones do.
 */
export function reviewExceptions(
  findings: readonly { criterionNumber: number; status: string }[],
): { status: ReviewException; criteria: number[] }[] {
  return REVIEW_EXCEPTIONS.flatMap((status) => {
    const criteria = findings
      .filter((finding) => finding.status === status)
      .map((finding) => finding.criterionNumber)
      .sort((left, right) => left - right);
    return criteria.length ? [{ status, criteria }] : [];
  });
}
/**
 * How one review stands, as every reader says it: nobody has it, somebody has it, it was
 * superseded, or the verdict it came back with and the checks that verdict did not take as met,
 * of how many. A review handed in without a verdict says nothing.
 */
export type ReviewStanding =
  | { word: 'unclaimed' | 'superseded' }
  | { word: 'claimed'; reviewerId: string | null }
  | { word: Verdict; exceptions: ReturnType<typeof reviewExceptions>; of: number };
export function reviewStanding(review: {
  status: string;
  reviewerId?: string | null;
  verdict?: Verdict | string | null;
  findings?: readonly { criterionNumber: number; status: string }[];
}): ReviewStanding | null {
  if (review.status === 'requested') return { word: 'unclaimed' };
  if (review.status === 'started')
    return { word: 'claimed', reviewerId: review.reviewerId ?? null };
  if (review.status === 'superseded') return { word: 'superseded' };
  if (!review.verdict) return null;
  const findings = review.findings ?? [];
  return {
    word: review.verdict as Verdict,
    exceptions: reviewExceptions(findings),
    of: findings.length,
  };
}

/** The refusal of a lease source that may not direct a reviewer: `check(directsIndependently(…), ...)`. */
export const NOT_INDEPENDENT = [
  'review_independence',
  'A producer or contributor cannot direct the reviewer of its own work',
  403,
] as const;

/** A generated identifier: a short lowercase prefix, then a token carrying digits (exp_3f9a1c…). */
const entityId = /\b[a-z]{2,16}_(?=[A-Za-z]*\d)[A-Za-z0-9]{6,}/u;
/** The trimmed length of a synopsis review.submit takes. */
export const SYNOPSIS_LENGTH = { min: 40, max: 420 } as const;
/**
 * Why review.submit refuses a synopsis, or undefined where it takes it: its trimmed length, a
 * form that is not one plain paragraph (a line break, Markdown, a list or heading marker), or
 * an entity identifier where words should name the thing.
 */
export function synopsisProblem(synopsis: unknown): 'length' | 'format' | 'identifier' | undefined {
  if (typeof synopsis !== 'string') return 'length';
  const { length } = synopsis.trim();
  if (length < SYNOPSIS_LENGTH.min || length > SYNOPSIS_LENGTH.max) return 'length';
  if (
    !visible(synopsis) ||
    /[\r\n\u2028\u2029`]|\*\*|__|\]\(|<\/?[a-z]+>/iu.test(synopsis) ||
    /^\s*(?:#|[-*+]\s|\d+[.)]\s|>)/u.test(synopsis)
  )
    return 'format';
  return entityId.test(synopsis) ? 'identifier' : undefined;
}

/**
 * The first rule of review.submit a verdict's findings break, in the order it checks them, or
 * undefined. `rule` is which: the findings' own shape, a criterion left without a word or notes,
 * notes longer than review.submit keeps, one met without evidence, a pass over a criterion neither met nor waived, or a pass over a
 * required criterion that is not met. The server refuses with `code` and `message`; a desk words
 * the same rule for a person and points at `criterion`.
 */
export function assessmentProblem(
  review: Pick<ReviewRequest, 'criteria' | 'artifactIds' | 'requiredCriteria'>,
  input: { verdict?: Verdict | null; findings?: unknown },
):
  | {
      rule: 'shape' | 'unanswered' | 'long' | 'uncited' | 'unmet' | 'required';
      criterion?: number;
      code: string;
      message: string;
    }
  | undefined {
  const refused = (
    rule: 'shape' | 'unanswered' | 'long' | 'uncited' | 'unmet',
    message: string,
    criterion?: number,
  ) => ({ rule, message, code: 'invalid_findings', ...(criterion ? { criterion } : {}) });
  const value: unknown = input.findings;
  if (!Array.isArray(value))
    return refused('shape', 'Supply one finding for every numbered review criterion');
  const seen = new Set<number>();
  for (const item of value) {
    if (!(
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      Object.keys(item).every((key) =>
        ['criterionNumber', 'status', 'evidenceIds', 'notes'].includes(key),
      )
    ))
      return refused(
        'shape',
        'Findings must contain criterionNumber, status, evidenceIds and notes only',
      );
    if (!(
      Number.isSafeInteger(item.criterionNumber) &&
      item.criterionNumber >= 1 &&
      item.criterionNumber <= review.criteria.length &&
      !seen.has(item.criterionNumber)
    ))
      return refused(
        'shape',
        `Each criterion from 1 through ${review.criteria.length} must appear exactly once`,
      );
    const number = item.criterionNumber as number;
    seen.add(number);
    if (!['met', 'not_met', 'not_verified', 'waived'].includes(item.status))
      return refused(
        'unanswered',
        'Finding status must be met, not_met, not_verified, or waived',
        number,
      );
    if (!(typeof item.notes === 'string' && visible(item.notes) && item.notes.length <= 16000))
      return refused(
        typeof item.notes === 'string' && item.notes.length > 16000 ? 'long' : 'unanswered',
        `Criterion ${number} needs assessment notes (1–16000 characters)`,
        number,
      );
    if (!(
      Array.isArray(item.evidenceIds) &&
      new Set(item.evidenceIds).size === item.evidenceIds.length &&
      item.evidenceIds.every(
        (id: unknown) => typeof id === 'string' && review.artifactIds.includes(id),
      )
    ))
      return refused(
        'shape',
        `Criterion ${number} must refer only to distinct pinned artifact IDs`,
        number,
      );
    if (item.status === 'met' && !item.evidenceIds.length)
      return refused(
        'uncited',
        `Criterion ${number} claims met and requires retained evidence`,
        number,
      );
  }
  const missing = review.criteria.map((_, index) => index + 1).filter((n) => !seen.has(n));
  if (missing.length)
    return refused(
      'unanswered',
      `Missing findings for criteria: ${missing.join(', ')}`,
      missing[0],
    );
  const findings = value as ReviewFinding[];
  const objection = findings.find((item) => item.status !== 'met' && item.status !== 'waived');
  if (input.verdict === 'pass' && objection)
    return refused(
      'unmet',
      'A passing verdict requires every criterion to be met or explicitly waived with a reason',
      objection.criterionNumber,
    );
  // The requesting domain depends on these criteria, so a reviewer's waiver cannot stand in
  // for them; needs_changes is the way out when one cannot be met.
  const unmet = (review.requiredCriteria ?? []).find(
    (number) => findings.find((item) => item.criterionNumber === number)?.status !== 'met',
  );
  if (input.verdict === 'pass' && unmet !== undefined)
    return {
      rule: 'required',
      criterion: unmet,
      code: 'criterion_not_waivable',
      message: `Criterion ${unmet} is required: a passing verdict needs it met with retained evidence, and it cannot be waived. Return needs_changes if it is not met`,
    };
  return undefined;
}

/** One rejected review round as the next author reads it. */
interface ReviewRound {
  /** 1-based position among all rejected rounds, oldest first; stable when older rounds are dropped. */
  round: number;
  reviewId: string;
  subjectRevision: number;
  label?: string;
  verdict: 'needs_changes' | 'fail';
  returnTo?: string;
  synopsis: string | null;
  unmet: {
    criterionNumber: number;
    criterion: string;
    status: 'not_met' | 'not_verified';
    notes: string;
  }[];
  notes: string | null;
}
export interface ReviewHistory {
  rounds: ReviewRound[];
  /** Oldest rounds left out to fit the budget; each is still readable with review.get. */
  omittedRounds: number;
}
export const REVIEW_HISTORY_LIMITS = { notes: 800, findingNotes: 300, criterion: 200 } as const;

/**
 * The rejected rounds among `entries`, which callers pass oldest first, clipped and bounded to
 * `maxChars` of JSON. No actor id is copied: the next author needs what was rejected and why, and
 * naming a reviewer, producer or recovered claimant would leak who judged into a context that a
 * later independent reviewer may also read. When the budget is short the oldest rounds go first,
 * because every later delivery already answered them; the latest round is always kept, even when
 * it alone is over budget, so the section that carries it can report the overflow itself.
 */
export function reviewHistory(
  entries: { review: ReviewRequest; label?: string }[],
  maxChars: number,
): ReviewHistory {
  const rounds = entries.flatMap(({ review, label }): Omit<ReviewRound, 'round'>[] =>
    review.status === 'submitted' &&
    (review.verdict === 'needs_changes' || review.verdict === 'fail')
      ? [
          {
            reviewId: review.id,
            subjectRevision: review.subjectRevision,
            ...(label === undefined ? {} : { label }),
            verdict: review.verdict,
            ...(review.returnTo === undefined ? {} : { returnTo: review.returnTo }),
            synopsis:
              review.synopsis === null ? null : clip(review.synopsis, REVIEW_HISTORY_LIMITS.notes),
            unmet: review.findings.flatMap((finding) =>
              finding.status === 'not_met' || finding.status === 'not_verified'
                ? [
                    {
                      criterionNumber: finding.criterionNumber,
                      criterion: clip(
                        review.criteria[finding.criterionNumber - 1] ?? '',
                        REVIEW_HISTORY_LIMITS.criterion,
                      ),
                      status: finding.status,
                      notes: clip(finding.notes, REVIEW_HISTORY_LIMITS.findingNotes),
                    },
                  ]
                : [],
            ),
            notes: review.notes === null ? null : clip(review.notes, REVIEW_HISTORY_LIMITS.notes),
          },
        ]
      : [],
  );
  const history: ReviewHistory = {
    rounds: rounds.map((round, index) => ({ round: index + 1, ...round })),
    omittedRounds: 0,
  };
  while (JSON.stringify(history).length > maxChars && history.rounds.length > 1) {
    history.rounds.shift();
    history.omittedRounds += 1;
  }
  return history;
}
