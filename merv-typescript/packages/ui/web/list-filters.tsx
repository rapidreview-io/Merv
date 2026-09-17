import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { ApiError } from './api';
import { KindLabel, LoadState, cx, words } from './components';
import { OPEN } from './states';
import type { Row } from './shell-types';

/** Identity-based narrowing, the only axis beside the search box. */
export type Scope = 'mine' | 'everyone';
const SCOPES = ['mine', 'everyone'] as const;
/** One state a list holds, and how much of the list is in it. */
export interface StateCount {
  value: string;
  count: number;
}

/** A person types a name, or pastes an id — whole, or the head of it, with or without its kind prefix. */
export function matches(
  search: string,
  labels: (string | null | undefined)[],
  ids: (string | null | undefined)[] = [],
): boolean {
  if (!search) return true;
  if (labels.some((label) => label?.toLowerCase().includes(search))) return true;
  return ids.some((id) => {
    const value = id?.toLowerCase();
    return (
      !!value &&
      (value.startsWith(search) || value.slice(value.indexOf('_') + 1).startsWith(search))
    );
  });
}

/** The list's own composition, counted from the list a page already holds. */
export function stateCounts<T>(
  items: T[] | undefined,
  stateOf: (item: T) => string,
  isOpen?: (state: string) => boolean,
): StateCount[] {
  const rows = items ?? [];
  const counts = new Map<string, number>();
  for (const item of rows) counts.set(stateOf(item), (counts.get(stateOf(item)) ?? 0) + 1);
  const held = [...counts].sort().map(([value, count]) => ({ value, count }));
  if (!isOpen) return held;
  return [{ value: OPEN, count: rows.filter((item) => isOpen(stateOf(item))).length }, ...held];
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable]');

/**
 * What a collection is made of, and so what its one control row can read: the
 * state a row is in, whose row it is where the record has an owner at all, and
 * the words and ids a person searches it by. A fact a kind does not have is left
 * out, and its control is not drawn.
 */
export interface ListShape<T> {
  stateOf?(item: T): string;
  isOpen?(state: string): boolean;
  /** Present only where the record has an owner: what draws Mine / Everyone. */
  mine?(item: T): boolean;
  /** What a person types: the names first, then the ids they may paste. */
  labels?(item: T): (string | null | undefined)[];
  ids?(item: T): (string | null | undefined)[];
}

/** Everything a filtered list holds between renders, and how a control changes it. */
export interface Filter<T> {
  query: string;
  setQuery(value: string): void;
  scope: Scope;
  setScope(value: Scope): void;
  state: string;
  setState(value: string): void;
  states: StateCount[];
  /** True where this kind has an owner, so whose work it is can be asked. */
  owned: boolean;
  /** Everything the read holds, and the part of it the controls keep. */
  items: T[];
  rows: T[];
  filtering: boolean;
  clear(): void;
  /** The record open beside the list, which stays a row whatever the filters say. */
  openId?: string;
}

/**
 * That state, in one place, and the rows it keeps. The count in the title line is
 * the filter: a list that knows which of its states are open opens on the work it
 * counted, and every state stays one click away on the same line as the search.
 */
export function useListFilter<T extends { id: string }>(
  items: T[] | undefined,
  shape: ListShape<T> = {},
): Filter<T> {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('everyone');
  const [chosen, setChosen] = useState<string>();
  const { id: openId } = useParams();
  const held = items ?? [];
  const states = shape.stateOf ? stateCounts(held, shape.stateOf, shape.isOpen) : [];
  const open = states.find((item) => item.value === OPEN)?.count ?? 0;
  const state = chosen ?? (open ? OPEN : '');
  const search = query.trim().toLowerCase();
  const stateOf = shape.stateOf;
  const holds = (item: T) =>
    !state || !stateOf
      ? true
      : state === OPEN
        ? !!shape.isOpen?.(stateOf(item))
        : stateOf(item) === state;
  return {
    query,
    setQuery,
    scope,
    setScope,
    state,
    setState: setChosen,
    states,
    owned: !!shape.mine,
    items: held,
    // The record open beside the list is always one of its rows, whatever the filters say.
    rows: held.filter(
      (item) =>
        item.id === openId ||
        (holds(item) &&
          (scope === 'everyone' || !shape.mine || shape.mine(item)) &&
          matches(search, shape.labels?.(item) ?? [], shape.ids?.(item) ?? [])),
    ),
    filtering: !!(query || state || scope === 'mine'),
    clear() {
      setQuery('');
      setChosen('');
      setScope('everyone');
    },
    openId,
  };
}

/**
 * The cursor is the row link itself: j and k step down the rows, the arrows do
 * the same once a row holds the cursor and otherwise leave the page to scroll,
 * and the browser opens the row in hand on Enter. The focus ring is the mark,
 * and nothing being typed into is interrupted.
 */
function useRowKeys(frame: { current: HTMLDivElement | null }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const letter = event.key === 'j' ? 1 : event.key === 'k' ? -1 : 0;
      const arrow = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (!(letter || arrow) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target)) return;
      const links = [...(frame.current?.querySelectorAll<HTMLAnchorElement>('a.row-link') ?? [])];
      const at = links.indexOf(document.activeElement as HTMLAnchorElement);
      const step = letter || (at >= 0 ? arrow : 0);
      if (!step || !links.length) return;
      // With no cursor yet, movement carries on from the row already open.
      const from = at >= 0 ? at : links.findIndex((link) => !!link.querySelector('.row-open'));
      const next = from < 0 ? (step > 0 ? 0 : links.length - 1) : from + step;
      links[Math.min(links.length - 1, Math.max(0, next))]?.focus();
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [frame]);
}

/**
 * One row of every list: what the record is above — its kind where the collection
 * mixes kinds, and its name — and how it stands below. Never a third line, and
 * never a paragraph of what it says: that is the record's own page.
 */
export interface Line {
  kind?: string;
  name: ReactNode;
  standing?: ReactNode;
}

/**
 * The page's one creation control and the form behind it. The opener is the last
 * thing in the control row and the only accent outside the form; the form opens
 * directly under the row, in place, and closes itself through the callback its
 * own success path already carries.
 */
export interface Creation {
  label: string;
  /** False where this reader may not create anything: no control is drawn. */
  shown?: boolean;
  /** True where the control opens something other than a new record. */
  plain?: boolean;
  /** Open on arrival, where arriving at the page is itself the request. */
  opened?: boolean;
  form(close: () => void): ReactNode;
}

/**
 * Every collection renders the same page in the same order and differs only in
 * which parts are true: the title line the shell draws, one control row — search,
 * whose work this is, which states it holds, and the one creation control at its
 * right end — then the rows. The state of the read keeps the list's own shape, the
 * filtered-to-nothing screen is distinct from the empty one, and a failed read is
 * the one state that replaces the list rather than sitting beside it.
 */
export function ListPage<T extends { id: string }>({
  load,
  noun,
  placeholder,
  filter,
  rows = filter.rows,
  line,
  opens,
  create,
  cards,
  emptyTitle,
  emptyHint,
  columns = 2,
  after,
}: {
  load: { loading: boolean; error?: ApiError; data?: unknown; loadedAt?: string };
  noun: string;
  placeholder: string;
  filter: Filter<T>;
  /** What the page shows, in the order it shows it; the kept rows unless said otherwise. */
  rows?: T[];
  line?(item: T): Line;
  /** True where a row is the way into a record of its own. */
  opens?: boolean;
  create?: Creation;
  /** Where the row is a designed card of its own: the class its stack takes. */
  cards?: { className: string; render(item: T): ReactNode };
  emptyTitle: string;
  emptyHint: string;
  /** How many columns the skeleton draws while the read is in flight; two lines by default. */
  columns?: number;
  /** What a page states after its rows, where it holds a second list of another kind. */
  after?: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(!!create?.opened);
  useRowKeys(frame);
  const total = filter.items.length;
  // Filtered to nothing has a screen per cause, and the scope states its meaning there.
  const nothing =
    filter.scope === 'mine'
      ? [`None of these ${noun} are yours`, 'Everyone shows the whole project.']
      : [`No ${noun} match these filters`, 'Try another search or clear the filters.'];
  return (
    <div className="page-stage stack" ref={frame}>
      <div className="stack">
        <div className="action-row">
          {/* The filters wrap among themselves, so the one control at the end of the
              row keeps the same place however many states a list turns out to hold. */}
          <div className="action-filters">
            {total > 0 && (
              <input
                className="input"
                type="search"
                aria-label={`Search ${noun}`}
                placeholder={placeholder}
                value={filter.query}
                onChange={(event) => filter.setQuery(event.target.value)}
              />
            )}
            {total > 0 && filter.owned && (
              <span className="scope" role="group" aria-label={`Whose ${noun}`}>
                {SCOPES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="btn-text"
                    aria-pressed={filter.scope === value}
                    onClick={() => filter.setScope(value)}
                  >
                    {value === 'mine' ? 'Mine' : 'Everyone'}
                  </button>
                ))}
              </span>
            )}
            {filter.states.length > 1 && (
              <span className="state-line">
                {filter.states.map(({ value, count }) => (
                  <button
                    key={value}
                    type="button"
                    className="btn-text"
                    aria-pressed={filter.state === value}
                    onClick={() => filter.setState(filter.state === value ? '' : value)}
                  >
                    {words(value)} <span className="state-n">{count}</span>
                  </button>
                ))}
              </span>
            )}
          </div>
          {create && create.shown !== false && (
            <button
              type="button"
              className={cx('btn', !create.plain && 'btn--primary', 'action-end')}
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {create.label}
            </button>
          )}
        </div>
        {open && create && create.form(() => setOpen(false))}
      </div>
      <LoadState
        {...load}
        empty={total === 0}
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
        columns={columns}
      />
      {total > 0 && !load.loading && rows.length === 0 && (
        <LoadState
          loading={false}
          empty
          emptyTitle={nothing[0]}
          emptyHint={
            <>
              {nothing[1]}{' '}
              <button type="button" className="btn-text" onClick={filter.clear}>
                Clear filters
              </button>
            </>
          }
        />
      )}
      {rows.length > 0 &&
        !load.error &&
        (cards ? (
          <div className={cards.className}>{rows.map((item) => cards.render(item))}</div>
        ) : (
          <ul className="rows">
            {rows.map((item) => {
              const { kind, name, standing } = line!(item);
              const body = (
                <>
                  <span className="row-name">
                    {kind && <KindLabel kind={kind} />}
                    {name}
                  </span>
                  {standing}
                </>
              );
              return (
                <li className="row" key={item.id}>
                  {opens ? (
                    <Link
                      className={cx('row-link', item.id === filter.openId && 'row-open')}
                      to={item.id}
                    >
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        ))}
      {after}
    </div>
  );
}

/** Above this the record opens beside its list; narrower than this it is the page. */
const WIDE = window.matchMedia('(min-width: 1080px)');
const useWide = () =>
  useSyncExternalStore(
    (listener) => {
      WIDE.addEventListener('change', listener);
      return () => WIDE.removeEventListener('change', listener);
    },
    () => WIDE.matches,
  );

function Split({ list, record, row }: { list: ReactNode; record: ReactNode; row: Row }) {
  const wide = useWide();
  const navigate = useNavigate();
  // Escape leaves the record for the list at either width; j/k move within the list.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || typing(event.target)) return;
      event.preventDefault();
      navigate(row.path);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, row.path]);
  if (!wide) return <>{record}</>;
  return (
    <div className="split">
      <div className="split-list">{list}</div>
      <div className="split-record">{record}</div>
    </div>
  );
}

/**
 * A work row's two routes. On a wide screen the list stays mounted beside the
 * record it sent you to, under that record's own URL and divided by one hairline;
 * narrower than that the record replaces the list, which is today's behaviour.
 */
export function splitRoutes<P extends { row: Row }>(
  Index: ComponentType<P>,
  Detail: ComponentType<P>,
) {
  return function Routed(props: P) {
    return (
      <Routes>
        <Route index element={<Index {...props} />} />
        <Route
          path=":id"
          element={
            <Split list={<Index {...props} />} record={<Detail {...props} />} row={props.row} />
          }
        />
      </Routes>
    );
  };
}
