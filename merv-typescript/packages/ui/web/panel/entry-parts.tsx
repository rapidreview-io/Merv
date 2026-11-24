/**
 * The pieces every finished entry is made of, wherever it is read: in a project's main thread and in Merv's one thread.
 * An entry's name line, which folds it; its words, as the prose any answer is; the one quiet line for the files it
 * changed; a file's changes as lines. Nothing here reads anything: what to show is handed in.
 */
import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { foldAt, toggleWords, type Reveals } from './agents';
import { Prose } from './prose';
import { ago } from './rows';

/** Why a changed file has no lines to show. */
export const UNSHOWN = {
  binary: 'A binary file: nothing to read as lines.',
  too_large: 'Too large to show here. Open the session to see it.',
  unavailable: "This file's changes cannot be read right now.",
};
/** What an entry paused on its background work says in place of how it ended. */
export const PAUSED_WORDS = 'still working in the background';

/** Where an entry's fold is kept: one key per entry, on this Mac, across reloads and restarts. Only a fold that differs
 *  from the entry's default is kept: an agent's entry begins open, a finished job's begins folded to its one line. */
export const FOLD_KEY = 'merv.thread.folded:';
/** Whether an entry of the main thread is folded, and the press that changes it. Display only: the entry is untouched. */
export function useFolded(id: string, byDefault = false): [boolean, () => void] {
  const key = FOLD_KEY + id;
  const [folded, setFolded] = useState(() => {
    try {
      const kept = localStorage.getItem(key);
      return kept === 'yes' ? true : kept === 'no' ? false : byDefault;
    } catch {
      return byDefault;
    }
  });
  const toggle = useCallback(
    () =>
      setFolded((was) => {
        const next = !was;
        try {
          if (next === byDefault) localStorage.removeItem(key);
          else localStorage.setItem(key, next ? 'yes' : 'no');
        } catch {
          /* Folded for this look only. */
        }
        return next;
      }),
    [key, byDefault],
  );
  return [folded, toggle];
}
/** Enter and Space fold or open an entry's line, once each, as a press would. */
const pressKeys = (toggle: () => void) => (event: KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  if (!event.repeat) toggle();
};
const filesWords = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/** An entry's line: who and what, which folds the entry or opens it again. Folded, it says how it ended and how many files
 *  it changed. When it was written, whether a press hides or shows, and the way into its session wait for the pointer or the keyboard. */
export function EntryLine({
  folded,
  toggle,
  mark,
  name,
  end,
  files,
  at,
  what,
  session,
  job,
}: {
  folded: boolean;
  toggle(): void;
  mark: ReactNode;
  name: string;
  end?: ReactNode;
  files?: number;
  at?: string;
  /** What opening it again shows, said as every other line that opens in place says it. */
  what: Reveals;
  session?: { words: string; open(): void };
  /** A job's entry: the way to its own page. */
  job?: () => void;
}) {
  const when = at ? ago(at) : '';
  return (
    <div className="agent-line">
      <button
        type="button"
        className="agent-by"
        aria-expanded={!folded}
        onClick={toggle}
        onKeyDown={pressKeys(toggle)}
      >
        {mark}
        <span className="agent-name">{name}</span>
        {end}
        {folded && !!files && <span className="agent-count">{filesWords(files)}</span>}
        {when && (
          <span className="row-age agent-age" title={new Date(at!).toLocaleString()}>
            {when === 'now' ? 'now' : `${when} ago`}
          </span>
        )}
        <span className="agent-fold-word" aria-hidden="true">
          {toggleWords(!folded, what)}
        </span>
      </button>
      {session && (
        <button type="button" className="agent-session" onClick={session.open}>
          {session.words}
        </button>
      )}
      {job && (
        <button type="button" className="agent-session job-open" onClick={job}>
          open job ›
        </button>
      )}
    </div>
  );
}

const lineClass = (line: string) =>
  line.startsWith('+')
    ? 'is-add'
    : line.startsWith('-')
      ? 'is-del'
      : line.startsWith('@@')
        ? 'is-hunk'
        : undefined;

/** Lines added and removed; a side with nothing to say is left out when the other has something. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      {(added > 0 || !removed) && <span className="agent-add">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="agent-del">−{removed}</span>}
    </>
  );
}

/** A file's changes as lines, in place. */
export function Hunks({ hunks }: { hunks: { id: string; diff: string }[] }) {
  return hunks.length ? (
    <>
      {hunks.map((hunk) => (
        <pre key={hunk.id} className="diff">
          {hunk.diff
            .replace(/\n$/, '')
            .split('\n')
            .map((line, row) => (
              <span key={row} className={lineClass(line)}>
                {line || ' '}
                {'\n'}
              </span>
            ))}
        </pre>
      ))}
    </>
  ) : (
    <p className="soft">Nothing in it changed but how it is kept.</p>
  );
}

/** What an agent changed, in one quiet line that opens to the files themselves: an agent is read by what it says and does,
 *  and its changes are there for whoever asks for them. */
export function ChangesLine({
  count,
  soFar,
  open,
  toggle,
  id,
}: {
  count: number;
  soFar?: boolean;
  open: boolean;
  toggle(): void;
  id: string;
}) {
  return (
    <button
      type="button"
      className="agent-changes"
      aria-expanded={open}
      aria-controls={id}
      onClick={toggle}
    >
      {filesWords(count)}
      {soFar ? ' so far' : ''}
      <span className="agent-changes-word"> · {open ? 'hide changes' : 'show changes'}</span>
    </button>
  );
}

/** An agent's closing words, as the prose any answer is. A long message shows its first part and one word at the cut. */
export function Words({
  text,
  cut,
  id,
  unfolded,
}: {
  text: string;
  cut?: boolean;
  id: string;
  /** Already behind a fold of its own, as a job's are: shown whole, with no second word to open it. */
  unfolded?: boolean;
}) {
  const [whole, setWhole] = useState(false);
  const head = useMemo(() => (unfolded ? undefined : foldAt(text)), [text, unfolded]);
  return (
    <>
      <div className="said assistant agent-said" id={id}>
        <Prose text={head && !whole ? head : text} />
      </div>
      {head && (
        <button
          type="button"
          className="agent-rest"
          aria-expanded={whole}
          aria-controls={id}
          onClick={() => setWhole(!whole)}
        >
          {whole ? 'show less' : 'show the rest'}
        </button>
      )}
      {cut && (whole || !head) && (
        <p className="soft agent-cut">Cut here. Its session has it whole.</p>
      )}
    </>
  );
}
