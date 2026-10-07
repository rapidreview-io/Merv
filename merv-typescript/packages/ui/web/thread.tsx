import { useState } from 'react';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { Link } from 'react-router-dom';
import { Ago, Evidence, StatusPill, cx, useArtifacts, words } from './components';
import { ArrowRightIcon, Icon } from './icons';
import { pathOf, useRows, type StateWords } from './navigation';
import { initials } from './views/people';
import { notMet, type Review } from './views/reviews';

/** The disc a post or a line stands on in place of initials: its thread's role, which opens it. */
export interface Mark {
  /** P for a producer, R for a reviewer. */
  letter: string;
  /** What pressing it opens, as a person names it: 'Producer thread'. */
  label: string;
  /** Opens the thread; without it the mark is only drawn. */
  onOpen?(): void;
}
/** A document an entry handed in, opened in the reading area beside the thread. */
export interface Handed {
  id: string;
  title: string;
}
/** A verdict as one line: its word and how many checks it found met; its sentence on a press. */
export interface Judged {
  word: string;
  met: number;
  of: number;
  text?: string;
  review?: string;
}

/** One entry of a thread: a post in somebody's voice, or a quiet line in its gutter. */
export type Entry =
  | {
      kind: 'post';
      key: string;
      role: 'Producer' | 'Reviewer';
      mark?: Mark;
      document?: Handed;
      verdict?: Judged;
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
      mark?: Mark;
      /** What a person has to do. */
      attention?: boolean;
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
  states,
}: {
  graph?: ProcessGraph;
  reviews: Review[];
  subject: string;
  /** A task's brief: every review of it pins the brief, and a delivery's post shows the rest. */
  briefId?: string;
  nameOf(id: string | null | undefined): string | undefined;
  /** The gates a review answers, and what crossing into each says its producer did. */
  states: Pick<StateWords, 'gates' | 'said'>;
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
    const into = states.gates.has(step.to);
    const out = states.gates.has(step.from);
    const decided = out && !into && open?.verdict ? open : undefined;
    open = into ? rounds.find((review) => review.subjectRevision === step.revision) : undefined;
    if (into && !out)
      entries.push({
        kind: 'post',
        key: `${step.revision}`,
        role: 'Producer',
        who: nameOf(step.actorId),
        at: step.at,
        said: states.said.get(step.to)?.submitted,
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
  if (states.gates.has(graph.state) && open && !open.verdict) entries.push(waiting(open));
  return entries;
}

/** The way to a review, where this composition has a page for one. */
function OpenReview({ id }: { id: string }) {
  const reviews = pathOf(useRows(), 'reviews');
  return reviews ? (
    <Link className="cluster hit" to={`${reviews}/${id}`}>
      Open the review <ArrowRightIcon size={14} />
    </Link>
  ) : null;
}

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

/** A thread's role disc: a button to its thread where there is one to open. */
function RoleDisc({ mark }: { mark: Mark }) {
  return mark.onOpen ? (
    <button
      type="button"
      className="role-mark role-mark--disc"
      aria-haspopup="dialog"
      aria-label={mark.label}
      title={mark.label}
      onClick={mark.onOpen}
    >
      {mark.letter}
    </button>
  ) : (
    <span className="role-mark role-mark--disc" title={mark.label}>
      {mark.letter}
    </span>
  );
}

/** Of `of` checks, `met` met: a filled square for each met, a hollow one for each not. */
export function MetSquares({ met, of }: { met: number; of: number }) {
  if (!of) return null;
  return (
    <span className="met-squares" role="img" aria-label={`${met} of ${of} met`}>
      {Array.from({ length: Math.min(of, 12) }, (_, at) => (
        <span key={at} className={cx('met-square', at < met && 'met-square--met')} />
      ))}
    </span>
  );
}

/** A verdict as one line, its word and its squares; a press opens its sentence and its way. */
function VerdictLine({ verdict }: { verdict: Judged }) {
  const [open, setOpen] = useState(false);
  const more = !!verdict.text || !!verdict.review;
  return (
    <>
      <button
        type="button"
        className="verdict-line"
        aria-expanded={more ? open : undefined}
        disabled={!more}
        onClick={() => setOpen(!open)}
      >
        <StatusPill value={verdict.word} />
        <MetSquares met={verdict.met} of={verdict.of} />
      </button>
      {open && verdict.text && <p className="verdict-text">{verdict.text}</p>}
      {open && verdict.review && <OpenReview id={verdict.review} />}
    </>
  );
}

/**
 * The thread drawn. A post is the feed's — an initials disc, who and the part they
 * play, the time at the one right edge, then what they said. A line that only moved
 * the record is a dot in the same gutter, and one hairline joins the gutter from the
 * first entry to the last, so a loop reads as one line of conversation. Where a post's
 * thread is known its role's disc stands for the initials and opens it; a document it
 * handed in is the way to read it (`onDocument`), pressed while it is the one `shown`.
 */
export function Thread({
  entries,
  onDocument,
  shown,
}: {
  entries: Entry[];
  onDocument?(document: Handed): void;
  shown?: string;
}) {
  const artifacts = useArtifacts();
  return (
    <ol className="thread">
      {entries.map((entry) =>
        entry.kind === 'post' ? (
          <li className="feed-entry" key={entry.key}>
            {entry.mark ? (
              <RoleDisc mark={entry.mark} />
            ) : (
              <span className="feed-avatar" aria-hidden="true">
                {initials(entry.who)}
              </span>
            )}
            <div className="feed-text">
              <p className="feed-by">
                {entry.who && <span className="feed-author">{entry.who}</span>}
                {(!entry.mark || !entry.who) && <span className="thread-role">{entry.role}</span>}
                <Ago at={entry.at} className="feed-when" />
              </p>
              <div className="thread-body">
                {entry.said && <p>{entry.said}</p>}
                {entry.document &&
                  (onDocument ? (
                    <button
                      type="button"
                      className="thread-doc"
                      aria-pressed={shown === entry.document.id}
                      onClick={() => onDocument(entry.document!)}
                    >
                      <Icon name="file-text" size={14} />
                      <span>{entry.document.title}</span>
                    </button>
                  ) : (
                    <Evidence
                      artifactId={entry.document.id}
                      artifact={artifacts.get(entry.document.id)}
                      meta
                    />
                  ))}
                {entry.verdict && <VerdictLine verdict={entry.verdict} />}
                {entry.review && <Verdict review={entry.review} />}
                {entry.files?.map((id) => (
                  <Evidence key={id} artifactId={id} artifact={artifacts.get(id)} meta />
                ))}
              </div>
            </div>
          </li>
        ) : (
          <li className="feed-entry feed-line" key={entry.key}>
            {entry.mark ? (
              <RoleDisc mark={entry.mark} />
            ) : (
              <span className="feed-mark">
                <span className="thread-dot" />
              </span>
            )}
            <p className={cx('feed-said', entry.attention && 'running-attn')}>
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
