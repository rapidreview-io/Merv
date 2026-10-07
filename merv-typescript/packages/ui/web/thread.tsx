import { useState } from 'react';
import type { RunningUnitEntry } from '@merv/contracts/running';
import { Link } from 'react-router-dom';
import { Ago, Evidence, StatusPill, cx, useArtifacts } from './components';
import { ArrowRightIcon, Icon } from './icons';
import { pathOf, useRows } from './navigation';
import { initials } from './views/people';

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

/**
 * A unit's history as its owner tells it (`unit.history`), drawn as a thread: an entry with a
 * role and a time is that thread's post, anything else a quiet line. `mark` gives an entry the
 * disc of the thread that made it, where the reader has the threads to open; without it, a
 * review still open is the way to its page.
 */
export function historyEntries(
  history: readonly RunningUnitEntry[],
  nameOf: (id: string) => string | undefined,
  mark?: (entry: RunningUnitEntry) => Mark | undefined,
): Entry[] {
  return history.map((item, at): Entry => {
    const who = item.actor ? nameOf(item.actor) : undefined;
    const key = `${at}`;
    if (item.role && item.at)
      return {
        kind: 'post',
        key,
        role: item.role === 'producer' ? 'Producer' : 'Reviewer',
        who,
        at: item.at,
        said: item.said,
        mark: mark?.(item),
        document: item.artifact,
        verdict: item.verdict && { ...item.verdict, review: item.review },
      };
    return {
      kind: 'line',
      key,
      said: item.said ?? '',
      who,
      at: item.at,
      // Beside the threads, the way to a review still open is its Review section's.
      ...(mark ? { mark: mark(item) } : { review: item.review }),
      attention: item.attention,
    };
  });
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
