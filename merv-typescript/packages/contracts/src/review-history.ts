import type { ReviewRequest } from './index.js';
import { clip } from './text.js';

/** One rejected review round as the next author reads it. */
export interface ReviewRound {
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
