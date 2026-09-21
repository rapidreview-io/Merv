/**
 * JSON, read as the tree it is. A results file is a few facts a person wants and
 * a great deal they do not, so the first two levels stand open and everything
 * deeper is a count until it is asked for. What is closed is not rendered at all,
 * and a long array is drawn a hundred entries at a time, so a file of two
 * megabytes opens as fast as one of two lines.
 *
 * Nothing here is handed to the browser as HTML. A string is text, with three
 * exceptions that are each the whole of the string and never a part of it: a
 * record id reads as the record's name and link, exactly as in a document
 * (`RecordLink`); an `http` or `https` address opens in another tab; and a commit
 * or a digest is its two ends in the mono, with all of it one click from the
 * clipboard. Nothing else is ever a link.
 */
import { useState, type MouseEvent, type ReactNode } from 'react';
import { CopyButton } from './components';
import { ChevronRightIcon } from './icons';
import { RecordLink, safeHref, splitIds, type RecordNames } from './markdown';

/** How deep the tree stands open before anything is pressed: the root and its entries. */
const OPEN_DEPTH = 2;
/** How many entries of one object or array are drawn at a time. */
const PAGE = 100;
/** Past this a string is cut, with the rest one press away. */
const LONG = 120;
/** A commit (SHA-1) or a digest (SHA-256), whole: for comparing, never for reading. */
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ADDRESS = /^https?:\/\/\S+$/i;

/** What a file holds, or nothing where it does not parse: that one stays the text it was. */
export function readJson(content: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(content) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * An order to everything under one node, given by an Alt-press on its toggle. It
 * is numbered so a node can tell a new order from the one it has already obeyed,
 * and `open` is left out by a plain press, which only ends the order before it:
 * what is then opened stands at its own default again.
 */
interface Sweep {
  at: number;
  open?: boolean;
}
let sweeps = 0;
const later = (a?: Sweep, b?: Sweep) => (!a || (b && b.at > a.at) ? b : a);

type Branch = Record<string, unknown> | unknown[];
const isBranch = (value: unknown): value is Branch => typeof value === 'object' && value !== null;

function Text({ value, names }: { value: string; names?: RecordNames }) {
  const [all, setAll] = useState(false);
  if (HASH.test(value))
    return (
      <>
        <span className="json-hash" title={value}>
          {value.slice(0, 8)}…{value.slice(-6)}
        </span>
        <CopyButton text={value} label="Copy hash" />
      </>
    );
  const pieces = splitIds(value);
  if (pieces.length === 3 && !pieces[0] && !pieces[2])
    return <RecordLink id={pieces[1]!} names={names} />;
  const address = ADDRESS.test(value) ? safeHref(value) : null;
  if (address?.external)
    return (
      <a
        className="json-link"
        href={address.href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
      >
        {value}
      </a>
    );
  const long = value.length > LONG;
  return (
    <>
      <span className="json-string">
        {long && !all ? `${value.slice(0, LONG).trimEnd()}…` : value}
      </span>
      {long && (
        <>
          {' '}
          <button
            type="button"
            className="btn-text"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? 'Show less' : 'Show all'}
          </button>
        </>
      )}
    </>
  );
}

function Leaf({ value, names }: { value: unknown; names?: RecordNames }): ReactNode {
  if (typeof value === 'string') return <Text value={value} names={names} />;
  if (isBranch(value))
    return <span className="json-count">{Array.isArray(value) ? '[ ]' : '{ }'}</span>;
  return (
    <span className={`json-${value === null ? 'null' : typeof value}`}>
      {JSON.stringify(value)}
    </span>
  );
}

function Node({
  name,
  index,
  value,
  depth,
  names,
  sweep,
}: {
  /** The key it stands under; the root has none. */
  name?: string;
  /** A place in an array is a key nobody wrote: drawn fainter, as wide as the last of them. */
  index?: number;
  value: unknown;
  depth: number;
  names?: RecordNames;
  sweep?: Sweep;
}) {
  const [open, setOpen] = useState(sweep?.open ?? depth < OPEN_DEPTH);
  const [obeyed, setObeyed] = useState(sweep?.at);
  const [mine, setMine] = useState<Sweep>();
  const [shown, setShown] = useState(PAGE);
  if (sweep && sweep.at !== obeyed) {
    setObeyed(sweep.at);
    if (sweep.open !== undefined) setOpen(sweep.open);
  }
  const label = name !== undefined && (
    <span
      className={index ? 'json-key json-key--index' : 'json-key'}
      style={index ? { minWidth: `${index}ch` } : undefined}
    >
      {name}
    </span>
  );
  const list = Array.isArray(value);
  // An object's keys are listed once a render and its entries only as far as they
  // are drawn: an array of a hundred thousand numbers is never copied to show ten.
  const keys = isBranch(value) && !list ? Object.keys(value) : undefined;
  const size = list ? value.length : (keys?.length ?? 0);
  if (!size)
    return (
      <li className="json-node">
        <div className="json-row json-row--leaf">
          {label}
          <span className="json-value">
            <Leaf value={value} names={names} />
          </span>
        </div>
      </li>
    );
  const toggle = (event: MouseEvent) => {
    sweeps += 1;
    setMine({ at: sweeps, open: event.altKey ? !open : undefined });
    setOpen(!open);
  };
  const entries = (): [string, unknown][] =>
    list
      ? value.slice(0, shown).map((item, at) => [String(at), item])
      : keys!.slice(0, shown).map((key) => [key, (value as Record<string, unknown>)[key]]);
  const rest = size - shown;
  return (
    <li className="json-node">
      <div className="json-row">
        <button
          type="button"
          className="json-toggle"
          aria-expanded={open}
          aria-label={name === undefined ? (list ? 'Array' : 'Object') : undefined}
          onClick={toggle}
        >
          <ChevronRightIcon size={12} className="json-caret" />
          {label}
        </button>
        {/* The root has no key, so its count is what its toggle stands beside, open or not. */}
        {(!open || name === undefined) && (
          <span className="json-count">{list ? `[ ${size} ]` : `{ ${size} }`}</span>
        )}
      </div>
      {open && (
        <ul className="json-list">
          {entries().map(([key, item]) => (
            <Node
              key={key}
              name={key}
              index={list ? String(size - 1).length : undefined}
              value={item}
              depth={depth + 1}
              names={names}
              sweep={later(sweep, mine)}
            />
          ))}
          {rest > 0 && (
            <li className="json-node">
              <div className="json-row json-row--leaf">
                <button type="button" className="btn-text" onClick={() => setShown(shown + PAGE)}>
                  Show {Math.min(PAGE, rest)} more
                </button>
              </div>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** A parsed JSON value as a tree of folds; `names` are the records its ids may name. */
export function JsonView({ value, names }: { value: unknown; names?: RecordNames }) {
  return (
    <div className="json">
      <ul className="json-list json-list--root">
        <Node value={value} depth={0} names={names} />
      </ul>
    </div>
  );
}
