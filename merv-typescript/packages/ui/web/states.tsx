import type { ReactNode } from 'react';
import { StatusPill, cx, words } from './components';

/**
 * One clause of a record's standing. A clause passed as `null` reads as absent —
 * a fact that could exist and does not is itself information — while a clause
 * left out is one this kind of record cannot have (a session lease is never
 * reviewed). No clause is ever filled in from another.
 */
export interface Clause {
  /** The word that carries the fact. */
  word?: string | null;
  /** True for a verdict or finding: the one word on a row that takes colour. */
  verdict?: boolean;
  /** True when the word states that the fact is missing; it stays faint. */
  absent?: boolean;
  /** The quieter rest of the clause: a name, a revision, a recorded sentence. */
  detail?: ReactNode;
}

function Say({ clause }: { clause: Clause | null }) {
  if (!clause || (!clause.word && !clause.detail))
    return <span className="states-clause states-absent">—</span>;
  return (
    <span className={cx('states-clause', clause.absent && 'states-absent')}>
      {clause.word && (
        <span
          className={cx(
            clause.verdict ? 'crit-word' : 'states-word',
            clause.verdict && `crit-word--${clause.word}`,
            clause.absent && 'states-absent',
          )}
        >
          {words(clause.word)}
        </span>
      )}
      {clause.detail && <span className="states-detail">{clause.detail}</span>}
    </span>
  );
}

/**
 * Execution, review and outcome in one cell, in that fixed order and never
 * collapsed into a single word: work can be finished and unreviewed, reviewed
 * and inconclusive, or running under a plan that already passed. Colour reaches
 * the verdict word alone; the rest of the row stays ink.
 */
export function ThreeStates({
  execution,
  review,
  outcome,
}: {
  execution?: string | null;
  review?: Clause | null;
  outcome?: Clause | null;
}) {
  return (
    <div className="states">
      {execution !== undefined && (
        <span className="states-clause">
          {execution ? <StatusPill value={execution} /> : <span className="states-absent">—</span>}
        </span>
      )}
      {review !== undefined && <Say clause={review} />}
      {outcome !== undefined && <Say clause={outcome} />}
    </div>
  );
}

/** What a row needs of a review: the shape `review.list` already returns. */
export interface ReviewFacts {
  subjectId: string;
  subjectRevision: number;
  status: string;
  reviewerId?: string | null;
  verdict?: string | null;
  returnTo?: string;
  findings?: { status: string }[];
  createdAt: string;
}

/**
 * The review that speaks for a record: the newest at the highest revision it
 * pinned, so an open re-review outranks the verdict it will replace.
 */
export function newestReview<T extends ReviewFacts>(
  reviews: T[] | undefined,
  subjectId: string,
): T | undefined {
  const mine = (reviews ?? []).filter((review) => review.subjectId === subjectId);
  return mine.sort(
    (a, b) => a.subjectRevision - b.subjectRevision || a.createdAt.localeCompare(b.createdAt),
  )[mine.length - 1];
}

/**
 * The review clause: the verdict recorded against this record, or that nobody
 * has taken it up yet. A pass built on waivers carries the qualification, since
 * dropping it would let two exceptions read as an unqualified pass.
 */
export function reviewClause(review: ReviewFacts | undefined, reviewer?: ReactNode): Clause | null {
  if (!review) return null;
  if (review.status === 'requested') return { word: 'unclaimed' };
  if (review.status === 'started') return { word: 'in review', detail: reviewer };
  if (review.status === 'superseded')
    return { word: 'superseded', detail: `pinned revision ${review.subjectRevision}` };
  if (!review.verdict) return null;
  const findings = review.findings ?? [];
  const count = (status: string) => findings.filter((item) => item.status === status).length;
  const detail = [
    count('waived') && `${count('waived')} of ${findings.length} waived`,
    count('not_verified') && `${count('not_verified')} not verified`,
    review.returnTo && `returned to ${words(review.returnTo)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return { word: review.verdict, verdict: true, detail };
}

/** The first clause of a recorded sentence, in the record's own words. */
export function firstSentence(text: string | null | undefined, limit = 140): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const stop = trimmed.search(/[.!?](\s|$)|\n/);
  const first = (stop >= 0 ? trimmed.slice(0, stop + 1) : trimmed).trim();
  return first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
}

/**
 * What the number beside a row label counts, mirrored from the row adapters
 * (packages/tasks/src/ui.ts, packages/reviews/src/ui.ts) so that arriving from
 * the count lands on exactly the work it counted. `All states` is one click away.
 */
export const OPEN = 'open';
export const isOpenTask = (state: string) => !['done', 'failed'].includes(state);
export const isOpenReview = (status: string) => status === 'requested' || status === 'started';
