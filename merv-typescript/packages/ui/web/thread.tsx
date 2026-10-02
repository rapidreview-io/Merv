import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { Link } from 'react-router-dom';
import { Ago, Evidence, StatusPill, useArtifacts, words } from './components';
import { ArrowRightIcon } from './icons';
import { initials } from './views/people';
import { notMet, type Review } from './views/reviews';

/** The gates a review answers, and what crossing into each says its producer did. */
const SUBMITTED = new Map([
  ['design_review', 'Submitted the design'],
  ['experiment_review', 'Submitted the results'],
  ['in_review', 'Delivered'],
]);

/** One entry of a thread: a post in somebody's voice, or a quiet line in its gutter. */
export type Entry =
  | {
      kind: 'post';
      key: string;
      role: 'Producer' | 'Reviewer';
      /** Absent where the reader cannot name them: the role word then stands alone. */
      who?: string;
      at: string;
      /** What the producer did. */
      said?: string;
      /** What a delivery pinned, each file opening in place. */
      files?: string[];
      /** The verdict a reviewer posted. */
      review?: Review;
    }
  | {
      kind: 'line';
      key: string;
      said: string;
      who?: string;
      at?: string;
      /** The open review the line is the way to. */
      review?: string;
    };

const sentence = (state: string) => words(state).replace(/^./, (first) => first.toUpperCase());

/**
 * What happened to a unit of work, oldest first, as a forum reads it. Every recorded
 * crossing of the record's own process graph is one entry: a crossing into a review
 * gate is its producer's post, and the verdict that carried it out again the
 * reviewer's. A submission is answered by the review it requested, which is pinned at
 * the revision the crossing made, so the k-th submission meets the k-th review and a
 * review reissued at its gate replaces the one before it. A verdict that lands
 * earlier in the program than the gate it left is followed by the return it was;
 * anything else only moved the record and is one quiet line. A record standing at a
 * gate ends on the review still open there. Without a graph the reviews alone are the
 * thread.
 */
export function threadOf({
  graph,
  reviews,
  subject,
  briefId,
  nameOf,
}: {
  graph?: ProcessGraph;
  reviews: Review[];
  subject: string;
  /** A task's brief: every review of it pins the brief, and a delivery's post shows the rest. */
  briefId?: string;
  nameOf(id: string | null | undefined): string | undefined;
}): Entry[] {
  const rounds = reviews
    .filter((review) => review.subjectId === subject)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const verdict = (review: Review, at: string): Entry => ({
    kind: 'post',
    key: review.id,
    role: 'Reviewer',
    who: nameOf(review.reviewerId),
    at,
    review,
  });
  const waiting = (review: Review): Entry => {
    const reviewer = nameOf(review.reviewerId);
    return {
      kind: 'line',
      key: `${review.id}-open`,
      said:
        review.status === 'requested'
          ? 'Review unclaimed'
          : reviewer
            ? `In review with ${reviewer}`
            : 'Review claimed',
      review: review.id,
    };
  };
  if (!graph)
    return rounds.map((review) =>
      review.verdict ? verdict(review, review.createdAt) : waiting(review),
    );
  const order = graph.nodes.map((node) => node.state);
  const crossings = graph.edges
    .flatMap((edge) => edge.traversals.map((step) => ({ ...step, from: edge.from, to: edge.to })))
    .sort((a, b) => a.at.localeCompare(b.at) || a.revision - b.revision);
  const entries: Entry[] = [];
  let open: Review | undefined;
  for (const step of crossings) {
    const into = SUBMITTED.has(step.to);
    const out = SUBMITTED.has(step.from);
    const decided = out && !into && open?.verdict ? open : undefined;
    open = into ? rounds.find((review) => review.subjectRevision === step.revision) : undefined;
    if (into && !out)
      entries.push({
        kind: 'post',
        key: `${step.revision}`,
        role: 'Producer',
        who: nameOf(step.actorId),
        at: step.at,
        said: SUBMITTED.get(step.to),
        files: briefId === undefined ? undefined : open?.artifactIds.filter((id) => id !== briefId),
      });
    else if (decided) {
      entries.push(verdict(decided, step.at));
      if (order.indexOf(step.to) < order.indexOf(step.from))
        entries.push({
          kind: 'line',
          key: `${step.revision}-back`,
          said: `Returned to ${words(step.to)}`,
        });
    } else
      entries.push({
        kind: 'line',
        key: `${step.revision}`,
        said: sentence(step.to),
        who: nameOf(step.actorId),
        at: step.at,
      });
  }
  if (SUBMITTED.has(graph.state) && open && !open.verdict) entries.push(waiting(open));
  return entries;
}

const OpenReview = ({ id }: { id: string }) => (
  <Link className="cluster hit" to={`/reviews/${id}`}>
    Open the review <ArrowRightIcon size={14} />
  </Link>
);

/** A verdict posted: its word, how many checks it found short, its sentence, the way to it. */
function Verdict({ review }: { review: Review }) {
  const short = notMet(review);
  const said = review.synopsis ?? review.notes;
  return (
    <>
      <p className="cluster">
        <StatusPill value={review.verdict} />
        {short && <span className="muted">{short}</span>}
      </p>
      {said && <p>{said}</p>}
      <p>
        <OpenReview id={review.id} />
      </p>
    </>
  );
}

/**
 * The thread drawn. A post is the feed's — an initials disc, who and the part they
 * play, the time at the one right edge, then what they said. A line that only moved
 * the record is a dot in the same gutter, and one hairline joins the gutter from the
 * first entry to the last, so a loop reads as one line of conversation.
 */
export function Thread({ entries }: { entries: Entry[] }) {
  const artifacts = useArtifacts();
  return (
    <ol className="thread">
      {entries.map((entry) =>
        entry.kind === 'post' ? (
          <li className="feed-entry" key={entry.key}>
            <span className="feed-avatar" aria-hidden="true">
              {initials(entry.who)}
            </span>
            <div className="feed-text">
              <p className="feed-by">
                {entry.who && <span className="feed-author">{entry.who}</span>}
                <span className="thread-role">{entry.role}</span>
                <Ago at={entry.at} className="feed-when" />
              </p>
              <div className="thread-body">
                {entry.said && <p>{entry.said}</p>}
                {entry.review && <Verdict review={entry.review} />}
                {entry.files?.map((id) => (
                  <Evidence key={id} artifactId={id} artifact={artifacts.get(id)} meta />
                ))}
              </div>
            </div>
          </li>
        ) : (
          <li className="feed-entry feed-line" key={entry.key}>
            <span className="feed-mark">
              <span className="thread-dot" />
            </span>
            <p className="feed-said">
              {entry.said}
              {entry.who && <span className="faint"> · {entry.who}</span>}
            </p>
            {/* The right edge says when, or, for a review still open, where it is. */}
            {entry.at && <Ago at={entry.at} className="feed-when" />}
            {entry.review && <OpenReview id={entry.review} />}
          </li>
        ),
      )}
    </ol>
  );
}
