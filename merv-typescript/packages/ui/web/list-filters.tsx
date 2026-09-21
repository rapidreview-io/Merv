import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import type { ApiError } from './api';
import { KindLabel, LoadState, SearchField, cx, useOpenedForm, words } from './components';
import { OPEN } from './states';
import type { Row, ShellData } from './shell-types';

/** Identity-based narrowing, the only axis beside the search box. */
export type Scope = 'mine' | 'everyone';
const SCOPES: readonly Choice<Scope>[] = [
  { value: 'mine', label: 'Mine' },
  { value: 'everyone', label: 'Everyone' },
];
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

/**
 * The list's own composition, counted from the list a page already holds. Which
 * states there are is read from the whole list, so the chips stand still while the
 * other controls move; how many rows each holds is read from `counted`, the rows
 * those other controls keep, so the number beside a word is the number of rows
 * pressing it shows.
 */
export function stateCounts<T>(
  items: T[] | undefined,
  stateOf: (item: T) => string,
  isOpen?: (state: string) => boolean,
  counted: T[] = items ?? [],
): StateCount[] {
  const counts = new Map<string, number>((items ?? []).map((item) => [stateOf(item), 0]));
  for (const item of counted) counts.set(stateOf(item), (counts.get(stateOf(item)) ?? 0) + 1);
  const held = [...counts].sort().map(([value, count]) => ({ value, count }));
  if (!isOpen) return held;
  return [{ value: OPEN, count: counted.filter((item) => isOpen(stateOf(item))).length }, ...held];
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
  /** A narrowing the page holds itself — its tabs — which the rows and the chips obey too. */
  also?(item: T): boolean;
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
  /** The rows every control but the page's own narrowing keeps: what its tabs count. */
  tabbed: T[];
  filtering: boolean;
  /** True where Mine is pressed over a list that holds nothing of the reader's at all. */
  unowned: boolean;
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
  const search = query.trim().toLowerCase();
  const stateOf = shape.stateOf;
  // Whose it is and what was typed: the two controls every count on the row answers to.
  const within = held.filter(
    (item) =>
      (scope === 'everyone' || !shape.mine || shape.mine(item)) &&
      matches(search, shape.labels?.(item) ?? [], shape.ids?.(item) ?? []),
  );
  const also = (item: T) => !shape.also || shape.also(item);
  const states = stateOf ? stateCounts(held, stateOf, shape.isOpen, within.filter(also)) : [];
  // A list opens on its open work wherever it holds any, whatever is narrowed later.
  const open = !!stateOf && held.some((item) => shape.isOpen?.(stateOf(item)));
  const state = chosen ?? (open ? OPEN : '');
  const holds = (item: T) =>
    !state || !stateOf
      ? true
      : state === OPEN
        ? !!shape.isOpen?.(stateOf(item))
        : stateOf(item) === state;
  // The record open beside the list is always one of its rows, whatever the filters say.
  const kept = (rows: T[]) => {
    const among = new Set(rows);
    return held.filter((item) => item.id === openId || (among.has(item) && holds(item)));
  };
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
    rows: kept(within.filter(also)),
    tabbed: kept(within),
    filtering: !!(query || state || scope === 'mine'),
    unowned: scope === 'mine' && !!shape.mine && !held.filter(also).some(shape.mine),
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
      const from = at >= 0 ? at : links.findIndex((link) => link.classList.contains('row-open'));
      const next = from < 0 ? (step > 0 ? 0 : links.length - 1) : from + step;
      links[Math.min(links.length - 1, Math.max(0, next))]?.focus();
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [frame]);
}

/**
 * One option of a control that narrows a list: what it selects, the word for it,
 * and how many rows it holds where the list has counted them.
 */
export interface Choice<V extends string = string> {
  value: V;
  label: ReactNode;
  count?: ReactNode;
}
interface Choosing<V extends string> {
  /** What the group is for, said to a screen reader: the buttons say only their own word. */
  label: string;
  options: readonly Choice<V>[];
  /** The option in force; none of them, where nothing is narrowed. */
  value: string;
  /** The option that was clicked, pressed or not: whether a second click lets go is the caller's. */
  onChange(value: V): void;
}
function Choices<V extends string>({
  look,
  label,
  options,
  value,
  onChange,
}: Choosing<V> & { look: 'tabs' | 'segments' | 'chips' }) {
  return (
    <span className={look} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="state-n"> {option.count}</span>}
        </button>
      ))}
    </span>
  );
}
/**
 * The three ways a list is narrowed, told apart by shape rather than by words.
 * Tabs switch which of several lists the page is showing, and the one in force is
 * underlined; segments are a switch between two readings of the same list, one of
 * which always holds; chips are filters, each a soft pill once pressed. All three
 * are pressed buttons in a named group, so what is on is said as well as shown.
 */
export const Tabs = <V extends string>(props: Choosing<V>) => <Choices look="tabs" {...props} />;
export const Segments = <V extends string>(props: Choosing<V>) => (
  <Choices look="segments" {...props} />
);
export const Chips = <V extends string>(props: Choosing<V>) => <Choices look="chips" {...props} />;

/**
 * One row of every list: what the record is above — its kind where the collection
 * mixes kinds, and its name — and how it stands below. Never a third line, and
 * never a paragraph of what it says: that is the record's own page. A view names
 * the kind of every row; the list prints it only while the rows on screen are of
 * more than one kind, because a word repeated down a whole list says nothing.
 */
export interface Line {
  kind?: string;
  name: ReactNode;
  standing?: ReactNode;
}

/** True where the rows a list is showing are of more than one kind. */
export const mixesKinds = (lines: Line[]): boolean =>
  new Set(lines.map((line) => line.kind).filter(Boolean)).size > 1;

/**
 * The page's one creation control and the form behind it. The opener is the last
 * thing in the control row and the only accent outside the form — or, while the
 * list is empty, the one thing the empty state offers. The form opens directly
 * under the row, in place, and closes itself through the callback its own success
 * path already carries. While it is open the opener reads Cancel: the form's
 * heading already says what is being made, and its button says Create.
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
 * What a control opened, held to a form's width however wide the page is. The
 * command belongs to the form inside, which locks its fields by disabling the
 * fieldset around them while a request is in flight or kept for a retry; the box
 * reads that lock from its own subtree, so Escape and the opener's Cancel both
 * hold still for every form a list opens, and none of them has to say so.
 */
function Opened({
  children,
  onClose,
  onLock,
}: {
  children: ReactNode;
  onClose(): void;
  onLock(locked: boolean): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const read = () => setLocked(!!node.querySelector('fieldset:disabled'));
    const watch = new MutationObserver(read);
    watch.observe(node, { subtree: true, childList: true, attributeFilter: ['disabled'] });
    read();
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    onLock(locked);
    return () => onLock(false);
  }, [onLock, locked]);
  useOpenedForm(box, onClose, locked);
  return (
    <div className="creation" ref={box}>
      {children}
    </div>
  );
}

/**
 * Where a row carries a second destination its name is the link, and the row is
 * still one thing to press: a press anywhere on it that is not on a control of its
 * own, and is not the end of a selection being dragged, is a press on its name.
 */
function openRow(event: MouseEvent<HTMLLIElement>) {
  const pressed = event.target as HTMLElement;
  if (pressed.closest('a, button, input, select, summary') || window.getSelection()?.toString())
    return;
  event.currentTarget.querySelector<HTMLElement>('.row-name > .row-link')?.click();
}

/**
 * Every collection renders the same page in the same order and differs only in
 * which parts are true: the title line the shell draws, one control row — which
 * list this is, search, whose work this is, which states it holds, and the one
 * creation control at its right end — then the rows. The state of the read keeps
 * the list's own shape, the filtered-to-nothing screen is distinct from the empty
 * one, and a failed read is the one state that replaces the list rather than
 * sitting beside it.
 */
export function ListPage<T extends { id: string }>({
  load,
  noun,
  kind,
  placeholder,
  filter,
  rows = filter.rows,
  line,
  opens,
  narrow,
  create,
  aside,
  cards,
  emptyTitle,
  emptyHint,
  columns = 2,
  after,
}: {
  load: { loading: boolean; error?: ApiError; data?: unknown; loadedAt?: string };
  noun: string;
  /**
   * The view kind the list belongs to, which its empty state draws the glyph and
   * the colour of. A list that does not say is read from the place it stands in:
   * every collection's path opens with its own kind.
   */
  kind?: string;
  /** What the search reads, in a few words. The field says Search; this is its hover title. */
  placeholder?: string;
  filter: Filter<T>;
  /** What the page shows, in the order it shows it; the kept rows unless said otherwise. */
  rows?: T[];
  line?(item: T): Line;
  /** True where a row is the way into a record of its own. */
  opens?: boolean;
  /** Where a page holds more than one list: the tabs that stand over the control row. */
  narrow?: ReactNode;
  create?: Creation;
  /** A second control on the same row that opens something other than a record. */
  aside?: Creation;
  /** Where the row is a designed card of its own: the class its stack takes. */
  cards?: { className: string; render(item: T): ReactNode };
  emptyTitle: string;
  emptyHint?: string;
  /** How many columns the skeleton draws while the read is in flight; two lines by default. */
  columns?: number;
  /** What a page states after its rows, where it holds a second list of another kind. */
  after?: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const place = useLocation().pathname.split('/')[1];
  // One control is open at a time, and its form opens under the row it sits in.
  const [open, setOpen] = useState<string | undefined>(create?.opened ? 'create' : undefined);
  const close = useCallback(() => setOpen(undefined), []);
  const [locked, setLocked] = useState(false);
  // The cursor goes back to the control that opened what just closed, wherever that
  // control is drawn by then: an empty list holds it in the empty state.
  const last = useRef(open);
  const returned = useRef<string>();
  const opener = (key: string) =>
    frame.current?.querySelector<HTMLElement>(`[data-opens="${key}"]`);
  useEffect(() => {
    if (!open && last.current) opener(last.current)?.focus();
    returned.current = open ? undefined : last.current;
    last.current = open;
  }, [open]);
  const control = (key: string, item: Creation) =>
    item.shown === false ? null : (
      <button
        type="button"
        data-opens={key}
        className={cx('btn', !item.plain && open !== key && 'btn--primary')}
        aria-expanded={open === key}
        // Cancel means what Escape means, and neither can take back a request in flight.
        disabled={open === key && locked}
        onClick={() => (open === key ? close() : setOpen(key))}
      >
        {open !== key ? item.label : item.plain ? 'Close' : 'Cancel'}
      </button>
    );
  useRowKeys(frame);
  const total = filter.items.length;
  // An empty list offers its first record itself; the row takes the control back
  // once there are rows, or while the form is open and needs its Cancel. Until the
  // read lands nobody knows which, so the control waits rather than jumping.
  const vacant = total === 0 && !load.loading && !load.error;
  const creating = open === 'create';
  const offered = !!create && vacant && !creating;
  // The first record takes the opener out of the empty state and puts it in the row;
  // the cursor that had gone back to the one follows it to the other.
  useEffect(() => {
    if (offered || !returned.current) return;
    if (document.activeElement === document.body) opener(returned.current)?.focus();
    returned.current = undefined;
  }, [offered]);
  // Filtered to nothing has a screen per cause, and each sentence is said only where it
  // is true: a search or a chip that emptied a list holding the reader's rows did not
  // make them anyone else's. The way out of either is the one control.
  const nothing = filter.unowned ? 'Nothing here is yours' : 'Nothing matches';
  const lines = line ? rows.map((item) => line(item)) : [];
  const mixed = mixesKinds(lines);
  return (
    <div className="page-stage stack" ref={frame}>
      <div className="stack controls">
        {/* Where a page holds more than one list, the strip that chooses between them
            runs the width of the page over the row that narrows the one chosen. */}
        {narrow && <div className="tabs tabs--strip">{narrow}</div>}
        <div className="action-row">
          {/* The filters wrap among themselves, so the one control at the end of the
              row keeps the same place however many states a list turns out to hold. */}
          <div className="action-filters">
            {total > 0 && (
              <SearchField
                label={`Search ${noun}`}
                title={placeholder}
                value={filter.query}
                onChange={filter.setQuery}
              />
            )}
            {total > 0 && filter.owned && (
              <Segments
                label={`Whose ${noun}`}
                options={SCOPES}
                value={filter.scope}
                onChange={filter.setScope}
              />
            )}
            {filter.states.length > 1 && (
              <Chips
                label={`State of ${noun}`}
                options={filter.states.map(({ value, count }) => ({
                  value,
                  label: words(value),
                  count,
                }))}
                value={filter.state}
                onChange={(value) => filter.setState(filter.state === value ? '' : value)}
              />
            )}
          </div>
          {/* What the page can open ends the row, the quiet control before the primary one. */}
          <div className="action-end">
            {/* A quiet control beside nothing at all would be the page's only element. */}
            {aside && (!vacant || open === 'aside') && control('aside', aside)}
            {create && !offered && !load.loading && control('create', create)}
          </div>
        </div>
        {open === 'aside' && aside && (
          <Opened onClose={close} onLock={setLocked}>
            {aside.form(close)}
          </Opened>
        )}
        {creating && create && (
          <Opened onClose={close} onLock={setLocked}>
            {create.form(close)}
          </Opened>
        )}
      </div>
      <LoadState
        {...load}
        empty={total === 0 && !creating}
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
        emptyKind={kind ?? place}
        emptyAction={offered && control('create', create)}
        columns={columns}
      />
      {total > 0 && !load.loading && rows.length === 0 && (
        <LoadState
          loading={false}
          empty
          emptyIcon="search"
          emptyTitle={nothing}
          emptyAction={
            <button type="button" className="btn" onClick={filter.clear}>
              Clear filters
            </button>
          }
        />
      )}
      {/* A failed refresh degrades to the one stale line LoadState renders above; it
          never blanks rows that are still correct. */}
      {rows.length > 0 &&
        (cards ? (
          <div className={cards.className}>{rows.map((item) => cards.render(item))}</div>
        ) : (
          <ul className="rows">
            {rows.map((item, index) => {
              const { kind: of, name, standing } = lines[index]!;
              const body = (
                <>
                  <span className="row-name">
                    {mixed && of && <KindLabel kind={of} />}
                    {name}
                  </span>
                  {standing}
                </>
              );
              return (
                <li className="row" key={item.id} onClick={opens ? undefined : openRow}>
                  {opens ? (
                    <Link
                      className={cx('row-link', item.id === filter.openId && 'row-open')}
                      // Beside an open record the list sits under that record's route.
                      to={filter.openId === undefined ? item.id : `../${item.id}`}
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
export const useWide = () =>
  useSyncExternalStore(
    (listener) => {
      WIDE.addEventListener('change', listener);
      return () => WIDE.removeEventListener('change', listener);
    },
    () => WIDE.matches,
  );

function Split({ list, record, back }: { list: ReactNode; record: ReactNode; back: string }) {
  const wide = useWide();
  const navigate = useNavigate();
  const held = useRef<HTMLDivElement>(null);
  // Escape leaves the record for the list at either width; j/k move within the list.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An Escape a form already took as its Cancel is not also the way out of the record.
      if (event.key !== 'Escape' || event.defaultPrevented || typing(event.target)) return;
      // Nor is it while the record holds something unsent: a desk marks itself `data-draft`.
      if (held.current?.querySelector('[data-draft]')) return;
      event.preventDefault();
      navigate(back);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, back]);
  // The record stands at one place in the tree at either width, so crossing 1080px —
  // a window resized, a tablet turned, a panel docked — draws the list in or out
  // beside it and never remounts it: a delivery or a verdict half written is only
  // held in the record's own state.
  return (
    <div className={wide ? 'split' : undefined}>
      {wide && <div className="split-list">{list}</div>}
      <div className={wide ? 'split-record' : undefined} ref={held}>
        {record}
      </div>
    </div>
  );
}

/**
 * A record's two routes. On a wide screen the list stays mounted beside the record
 * it sent you to, under that record's own URL and divided by one hairline; narrower
 * than that the record replaces the list. A kind that shares one page with others
 * names that page as `elsewhere`: its record route stays exactly where it was, so
 * every link and pasted URL still lands, and its index and its Escape go there.
 */
export function splitRoutes<P extends { row: Row; shell: ShellData }>(
  Index: ComponentType<P>,
  Detail: ComponentType<P>,
  elsewhere?: string,
) {
  return function Routed(props: P) {
    return (
      <Routes>
        <Route
          index
          element={elsewhere ? <Navigate to={elsewhere} replace /> : <Index {...props} />}
        />
        <Route
          path=":id"
          element={
            <Split
              list={<Index {...props} />}
              record={<Detail {...props} />}
              back={elsewhere ?? props.row.path}
            />
          }
        />
      </Routes>
    );
  };
}
