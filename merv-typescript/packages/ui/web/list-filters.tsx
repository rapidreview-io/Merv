import { useEffect, useRef, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import type { Loaded } from './api';
import { LoadState, kindStyle, words } from './components';
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

interface ListFiltersProps {
  noun: string;
  placeholder: string;
  query: string;
  onQueryChange(value: string): void;
  scope: Scope;
  onScopeChange(value: Scope): void;
  state: string;
  onStateChange(value: string): void;
  states: StateCount[];
  shown: number;
  total: number;
}

/**
 * Two controls and never a third: the search box, and whose work this is. What
 * state a record is in is not a control but the line under them — the list's own
 * composition, each segment narrowing to the states it counted.
 */
export function ListFilters({ noun, states, shown, total, ...filter }: ListFiltersProps) {
  const filtering = !!(filter.query || filter.state || filter.scope === 'mine');
  return (
    <>
      <div className="action-row">
        <input
          className="input"
          type="search"
          aria-label={`Search ${noun}`}
          placeholder={filter.placeholder}
          value={filter.query}
          onChange={(event) => filter.onQueryChange(event.target.value)}
        />
        <span className="scope" role="group" aria-label={`Whose ${noun}`}>
          {SCOPES.map((value) => (
            <button
              key={value}
              type="button"
              className="btn-text"
              aria-pressed={filter.scope === value}
              onClick={() => filter.onScopeChange(value)}
            >
              {value === 'mine' ? 'Mine' : 'Everyone'}
            </button>
          ))}
        </span>
        {filtering && (
          <span className="muted" role="status">
            {shown} of {total} {noun}
          </span>
        )}
        {filtering && (
          <button
            type="button"
            className="btn-text"
            onClick={() => {
              filter.onQueryChange('');
              filter.onStateChange('');
              filter.onScopeChange('everyone');
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {states.length > 1 && (
        <p className="state-line">
          {states.map(({ value, count }) => (
            <button
              key={value}
              type="button"
              className="btn-text"
              aria-pressed={filter.state === value}
              onClick={() => filter.onStateChange(filter.state === value ? '' : value)}
            >
              {words(value)} <span className="state-n">{count}</span>
            </button>
          ))}
        </p>
      )}
    </>
  );
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
 * Every filtered list renders the same skeleton in the same order and differs only in
 * which parts are true: the filter row while there is something to filter, the state of
 * the read, the distinct screen for filtered-to-nothing, and the table itself. A failed
 * read is the one state that replaces the list rather than sitting beside it.
 */
export function ListPage<T>({
  list,
  visible,
  emptyTitle,
  emptyHint,
  columns,
  children,
  ...filters
}: Omit<ListFiltersProps, 'shown' | 'total'> & {
  list: Loaded<T[]>;
  visible: number;
  emptyTitle: string;
  emptyHint: string;
  /** How many columns the table below has, so the loading rows match it. */
  columns?: number;
  children: ReactNode;
}) {
  const listed = !!list.data?.length && !list.error;
  const frame = useRef<HTMLDivElement>(null);
  useRowKeys(frame);
  // Filtered to nothing has a screen per cause, and the scope states its meaning there.
  const nothing =
    filters.scope === 'mine'
      ? [`None of these ${filters.noun} are yours`, 'Everyone shows the whole project.']
      : [`No ${filters.noun} match these filters`, 'Try another search or clear the filters.'];
  return (
    <div className="page-stage stack" ref={frame}>
      {listed && <ListFilters {...filters} shown={visible} total={list.data!.length} />}
      <LoadState
        loading={list.loading}
        error={list.error}
        empty={list.data?.length === 0}
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
        columns={columns}
      />
      {listed && !list.loading && visible === 0 && (
        <LoadState loading={false} empty emptyTitle={nothing[0]} emptyHint={nothing[1]} />
      )}
      {visible > 0 && !list.error && children}
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
    <div className="split" style={kindStyle(row.view.kind)}>
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
