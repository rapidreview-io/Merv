import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { reviewStanding } from '@merv/reviews/rules';
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
  /** The quieter rest of the clause: a name, a recorded sentence. */
  detail?: ReactNode;
  /** Where the fact itself is a record: the clause is then the way to it. */
  to?: string;
}

function Say({ clause }: { clause: Clause | null }) {
  if (!clause || (!clause.word && !clause.detail))
    return <span className="states-clause states-absent">—</span>;
  const className = 'states-clause';
  const said = (
    <>
      {clause.word && (
        <span
          className={cx(
            clause.verdict ? 'crit-word' : 'states-word',
            clause.verdict && `crit-word--${clause.word}`,
          )}
        >
          {words(clause.word)}
        </span>
      )}
      {clause.detail && <span className="states-detail">{clause.detail}</span>}
    </>
  );
  return clause.to ? (
    <Link className={className} to={clause.to}>
      {said}
    </Link>
  ) : (
    <span className={className}>{said}</span>
  );
}

/**
 * Execution, review and outcome on one line, in that fixed order and never
 * collapsed into a single word: work can be finished and unreviewed, reviewed
 * and inconclusive, or running under a plan that already passed. Colour reaches
 * the verdict word alone; the rest of the line stays ink. A kind with none of the
 * three still stands somehow, and says so in the same place through `meta`, which
 * carries whose it is and when it last moved and is never a summary of it.
 */
export function ThreeStates({
  execution,
  stage,
  review,
  outcome,
  meta,
}: {
  execution?: string | null;
  /** Execution as its stage mark, where the record has a workflow: the mark and the word. */
  stage?: ReactNode;
  review?: Clause | null;
  outcome?: Clause | null;
  meta?: ReactNode;
}) {
  return (
    <div className="states">
      {stage && <span className="states-clause">{stage}</span>}
      {execution !== undefined && (
        <span className="states-clause">
          {execution ? <StatusPill value={execution} /> : <span className="states-absent">—</span>}
        </span>
      )}
      {review !== undefined && <Say clause={review} />}
      {outcome !== undefined && <Say clause={outcome} />}
      {meta && <span className="states-clause states-detail">{meta}</span>}
    </div>
  );
}

/** What a row needs of a review: the shape `review.list` already returns. */
interface ReviewFacts {
  status: string;
  reviewerId?: string | null;
  verdict?: string | null;
  returnTo?: string;
  findings?: { criterionNumber: number; status: string }[];
}

/**
 * The review clause: how Reviews says the review stands (`reviewStanding`). The state pill
 * beside it already says the record is in review, so an open review adds only what the pill
 * cannot: whose hands it is in, or that it is in nobody's. A verdict carries every check it did
 * not take as met, since dropping one would let two exceptions read as an unqualified pass.
 */
export function reviewClause(review: ReviewFacts | undefined, reviewer?: ReactNode): Clause | null {
  const said = review && reviewStanding(review);
  if (!said) return null;
  if (said.word === 'claimed')
    return reviewer ? { detail: <>with {reviewer}</> } : { word: 'claimed' };
  if (!('exceptions' in said)) return { word: said.word };
  const detail = [
    ...said.exceptions.map(({ status, criteria }) =>
      status === 'not_verified'
        ? `${criteria.length} ${words(status)}`
        : `${criteria.length} of ${said.of} ${words(status)}`,
    ),
    review.returnTo && `returned to ${words(review.returnTo)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return { word: said.word, verdict: true, detail };
}

/** What the count beside a row label means, so arriving from it lands on that work. */
export const OPEN = 'open';
