/**
 * The pieces of the project's column that Merv.app and runmerv.com share, so the list beside the chat has one look:
 * one row shape (mark, title, state, the time under the pointer), a fold ("Earlier · 38 ›"), the spinner,
 * a job's quiet diamond, and the column's own clock. Their rules are in column.css.
 */
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/** How often the column's clock moves while it is fresh. */
export const CLOCK_EVERY = 30_000;
/** The column's clock: now, moving on its beat, and held where it was while the read is stale. */
export function useClock(stale = false, every = CLOCK_EVERY): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (stale) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [stale, every]);
  return now;
}

/** A fold's words: "Earlier · 38". */
const foldWords = (word: string, count: number) => `${word} · ${count}`;

export const Chevron = () => (
  <svg className="col-fold-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path
      d="M3 1.5 6.5 5 3 8.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
export const Spinner = () => (
  <svg
    className="col-spin"
    width="14"
    height="14"
    viewBox="0 0 14 14"
    role="img"
    aria-label="Working"
  >
    <path
      className="spin"
      d="M7 1.5A5.5 5.5 0 1 1 1.5 7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

/** A job's mark in the project's list: a small quiet diamond, beside agents' provider icons. */
export function JobGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="job-glyph"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      role="img"
      aria-label="Job"
    >
      <path
        d="M7 2.2 11.8 7 7 11.8 2.2 7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One row: mark, title, state, and the time under the pointer. Controls, when a row has any, stand over its state
 *  cell under the pointer, beside the row's own button rather than inside it. */
export function ColumnRow({
  mark,
  title,
  extra,
  state,
  time,
  controls,
  className,
  agent,
  ...button
}: {
  mark: ReactNode;
  title: string;
  extra?: ReactNode;
  state?: ReactNode;
  time?: string;
  controls?: ReactNode;
  className?: string;
  agent?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & {
    [data: `data-${string}`]: string | undefined;
  }) {
  return (
    <li className="col-item">
      <button
        type="button"
        {...button}
        className={`col-row${className ? ` ${className}` : ''}`}
        data-agent={agent}
      >
        <span className="col-mark" aria-hidden="true">
          {mark}
        </span>
        <span className="col-title">
          <span className="col-text">{title}</span>
          {extra}
        </span>
        <span className="col-state">
          <span className="col-words">{state}</span>
          {time && <span className="col-time">{time}</span>}
        </span>
      </button>
      {controls && <span className="col-controls">{controls}</span>}
    </li>
  );
}

/** A fold: its word, how many wait behind it, and the chevron that turns as it opens. `edge`: it starts where the rows'
 *  marks start, the project's edge, as "Earlier jobs · N" does. */
export const Fold = ({
  word,
  count,
  open,
  controls,
  edge,
  onToggle,
}: {
  word: string;
  count: number;
  open: boolean;
  controls?: string;
  edge?: boolean;
  onToggle(): void;
}) => (
  <button
    type="button"
    className={`col-fold${edge ? ' is-edge' : ''}`}
    aria-expanded={open}
    aria-controls={controls}
    onClick={onToggle}
  >
    {foldWords(word, count)}
    <Chevron />
  </button>
);

/** Jobs at work, scheduled, recently finished, and earlier. Workers never become column rows. */
export type Flow = 'working' | 'later' | 'finished';
type Kinded = { kind: string; at: string };
type JobItem<T> = Extract<T, { kind: 'job' | 'later' }>;
const jobLike = <T extends Kinded>(item: T): item is JobItem<T> =>
  item.kind === 'job' || item.kind === 'later';
export function columnParts<T extends Kinded>(list: {
  needs: T[];
  working: T[];
  later: T[];
  finished: T[];
  earlier: T[];
}) {
  const ended = list.finished.filter(jobLike).sort((a, b) => b.at.localeCompare(a.at));
  const as =
    (where: Flow) =>
    (item: JobItem<T>): [JobItem<T>, Flow] => [item, where];
  return {
    needs: list.needs.filter(jobLike),
    jobs: [
      ...list.working.filter(jobLike).map(as('working')),
      ...list.later.filter(jobLike).map(as('later')),
      ...ended.map(as('finished')),
    ],
    jobsEarlier: list.earlier.filter(jobLike),
  };
}

/** Both lists remember the person's Other chats disclosure across navigation and reloads. */
export function useOtherChatsOpen() {
  const key = 'merv:other-chats-open';
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === 'yes';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(key, next ? 'yes' : 'no');
    } catch {
      /* Still usable without storage. */
    }
  };
  return [open, toggle] as const;
}
/** A job at work in words, as the desk says it ("reviewing · round 3"), else from its step and round. */
export function jobWords(words: string | undefined, step: string | undefined, round = 1): string {
  const said = words?.trim() || step || 'working';
  return round > 1 && !/\bround\b/.test(said) ? `${said} · round ${round}` : said;
}

/** The project's name with the way back to every project left of it. */
export function FolderLead({
  name,
  path,
  onBack,
}: {
  name: string;
  path?: string;
  onBack?(): void;
}) {
  return (
    <span className="folder-lead">
      <button
        type="button"
        className="folder-back"
        aria-label="All projects"
        title="All projects"
        onClick={onBack}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M8.5 2.5 4 7l4.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <span className="folder-name" title={path}>
        {name}
      </span>
    </span>
  );
}
