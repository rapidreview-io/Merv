import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  runningKey,
  type RunningBoard,
  type RunningKey,
  type RunningLane,
  type RunningLaneName,
  type RunningNode,
} from '@merv/contracts/running';
import { useTool } from '../api';
import { Ago, LoadState, cx, kindOf, useNow, words } from '../components';
import { clock, type Clock } from '../liveness';
import { WORK } from '../navigation';
import { StageMark } from '../process';
import type { WorkflowShape } from '../shell-types';
import type { Flow } from './map-data';
import { Act, RunningSidebar } from './running-panel';
import { Phrase, Reading, Target, steadyText, type RunningReading } from './running-phrase';
import { beneath, workMapLayout, type MapBox, type MapEdge } from './work-map-layout';

/**
 * The map of work and what is live on it. Every unit of work is a card, a line runs from
 * each prerequisite down to what waits on it, and beside the map docks the sidebar of
 * whatever is in hand. What moves — the agents on a unit, the machines they run on, what
 * needs a person — is the board's (`ui.running`), written by the plugin that owns each
 * thing; what a unit is and where its workflow stands is the wave's own records. This page
 * joins the two by key and lays them out. Green is only a dot on what is live, and red is
 * only ever something a person has to do.
 *
 * The thing in hand lives in the address (`?key=`), so a reload, a link or the Back button
 * lands on the same sidebar. The sidebar never covers the page: opening it narrows the
 * column the map is measured from; where the page is too narrow for both it follows the
 * page, and on a phone it replaces it.
 */

const LANES: readonly RunningLaneName[] = ['work', 'sessions', 'hardware'];
/** Where Escape is already someone else's: a menu or a dialog shuts itself with it. */
const OWN_ESCAPE =
  '[role="menu"], [role="menubar"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog';
/** Where a key is being typed rather than pressed at the page. */
const TYPING = 'input, textarea, select, [contenteditable="true"]';
/** A total not yet known is the em dash, never a zero. */
const EM = '—';
/** Wide enough for the sidebar to stand beside the page; narrower, it takes the page over. */
const ROOM = window.matchMedia('(min-width: 640px)');
const useRoomy = () =>
  useSyncExternalStore(
    (listener) => {
      ROOM.addEventListener('change', listener);
      return () => ROOM.removeEventListener('change', listener);
    },
    () => ROOM.matches,
  );

const needs = (node: RunningNode) => !!node.attention && !node.attention.quiet;
/** Something moves: a dot on the board, or a lane's own line asking for a person. */
const moving = (board: RunningBoard) =>
  LANES.some(
    (lane) =>
      board.lanes[lane].nodes.some((node) => node.dot) ||
      board.lanes[lane].summaries.some((summary) => summary.attention),
  );
/**
 * How often the board is read: every 2 s while a lane's source has never answered, so the
 * em dash does not stand long; every 5 s while anything moves; every 15 s while nothing does.
 */
export const cadenceOf = (board: RunningBoard | undefined) =>
  !board
    ? 15_000
    : LANES.some((lane) => board.lanes[lane].pending)
      ? 2_000
      : moving(board)
        ? 5_000
        : 15_000;

/**
 * A lane whose cached source was older than its owner says it stays current when the board
 * was read. It is judged at that moment, the answer's own, and not against the page's clock
 * counting on since: a board that is late to arrive again is the page's line to say, and a
 * lane read on time is not stale only because the next answer has not come yet.
 */
export const staleLane = (lane: RunningLane, now: Clock) =>
  !!lane.asOf &&
  lane.freshForMs !== undefined &&
  now.at - now.since - Date.parse(lane.asOf) > lane.freshForMs;

/** The node a key names on the board: itself, or the node that absorbed it. */
export function absorberOf(board: RunningBoard, key: RunningKey): RunningNode | undefined {
  for (const lane of LANES)
    for (const node of board.lanes[lane].nodes)
      if (node.key === key || node.aliases?.includes(key)) return node;
  return undefined;
}

/** One unit of work on the map: what the wave's records say of it, and what the board does. */
export interface MapUnit {
  key: RunningKey;
  /** The word for what it is: Task, Experiment, Reflection. */
  kind: string;
  name: string;
  /** Where its workflow stands, where the wave holds the record. */
  flow?: Flow;
  /** The board's card for it, while it is in flight or a person is needed on it. */
  node?: RunningNode;
}
/** The wave's own records, as the page that lists them read them. */
export interface Wave {
  items: {
    id: string;
    kind: string;
    name: string;
    flow: Flow;
    at: string;
    /** Still open, or named by the cycle the page is on. */
    held: boolean;
  }[];
  /** Every prerequisite and what waits on it, by record. */
  edges: MapEdge[];
}

/**
 * The map's units and the lines between them: everything the board holds in flight, every
 * record of the wave still open or named by its cycle, and what any of those waits on — a
 * finished prerequisite is what gives a line its upper end. The board's cards lead, in the
 * board's order, so what needs a person stands first in its row.
 */
export function mapOf(
  board: RunningBoard | undefined,
  wave: Wave | undefined,
): { units: MapUnit[]; edges: MapEdge[] } {
  const nodes = new Map((board?.lanes.work.nodes ?? []).map((node) => [node.key, node]));
  const items = new Map((wave?.items ?? []).map((item) => [runningKey('work', item.id), item]));
  const edges: MapEdge[] = [
    ...(wave?.edges ?? []).map((edge) => ({
      ...edge,
      from: runningKey('work', edge.from),
      to: runningKey('work', edge.to),
    })),
    // The board says a prerequisite from the side of what waits on it.
    ...(board?.edges ?? [])
      .filter((edge) => edge.verb === 'waits on')
      .map((edge) => ({ from: edge.to, to: edge.from, waiting: edge.waiting })),
  ];
  const keys = new Set(nodes.keys());
  const later = [...items].sort(([, a], [, b]) => b.at.localeCompare(a.at));
  for (const [key, item] of later) if (item.held) keys.add(key);
  for (const edge of edges.filter((edge) => keys.has(edge.to)))
    if (items.has(edge.from) || nodes.has(edge.from)) keys.add(edge.from);
  return {
    units: [...keys].map((key) => {
      const [item, node] = [items.get(key), nodes.get(key)];
      return {
        key,
        kind: node?.kind ?? kindOf(item?.kind).label,
        name: item?.name ?? node!.title,
        flow: item?.flow,
        node,
      };
    }),
    // One line for each relation, however many owners say it.
    edges: [
      ...new Map(
        edges
          .filter((edge) => keys.has(edge.from) && keys.has(edge.to))
          .map((edge) => [`${edge.from}>${edge.to}`, edge]),
      ).values(),
    ],
  };
}

/**
 * The sessions on one thing and the machines serving it or them, as the board relates
 * them: who is working on it, and where.
 */
export function liveOf(board: RunningBoard | undefined, key: RunningKey): RunningNode[] {
  if (!board) return [];
  const all = new Map(
    [...board.lanes.sessions.nodes, ...board.lanes.hardware.nodes].map((node) => [node.key, node]),
  );
  const on = (target: RunningKey) =>
    board.edges
      .filter((edge) => edge.to === target && edge.verb !== 'waits on')
      .flatMap((edge) => all.get(edge.from) ?? []);
  const sessions = on(key);
  return [...new Set([...sessions, ...sessions.flatMap((node) => on(node.key))])];
}

/** A person's or an agent's name, where the reader of the page may see one. */
type Named = Pick<RunningReading, 'nameOf'>;
/** The board as this page last read it, and the clock every fact on it is read by. */
interface Live {
  board?: RunningBoard;
  now: Clock;
}
const LiveContext = createContext<Live | null>(null);
/** The key in hand and how one is taken up, where a plane stands to dock its sidebar. */
const Plane = createContext<{ selected: RunningKey | null; onSelect(key: RunningKey): void }>({
  selected: null,
  onSelect: () => undefined,
});
/** True where the board is already being read above: one reader a page, never two. */
export const useLiveAbove = () => !!useContext(LiveContext);

/** Reads the board at the pace of what moves on it; every clock is the payload's own. */
function useLive() {
  const [cadence, setCadence] = useState(cadenceOf(undefined));
  const board = useTool<RunningBoard>('ui.running', {}, { every: cadence });
  const every = cadenceOf(board.data);
  useEffect(() => setCadence(every), [every]);
  // Past two cadences the clock stops at the moment the board was read, rather than
  // counting on against a fact nobody has refreshed.
  const now = clock(
    board.data?.observedAt,
    board.loadedAt,
    useNow(board.data && moving(board.data) ? 1000 : 0),
    cadence * 2,
  );
  return { board, now };
}

/**
 * The board for a list that stands with no map over it, beside an open record: its rows
 * still say who is on each unit and where, and a name there goes to the map with that
 * thing's sidebar open.
 */
export function LiveProvider({ nameOf, children }: Named & { children: ReactNode }) {
  const navigate = useNavigate();
  const { board, now } = useLive();
  return (
    <LiveContext.Provider value={{ board: board.data, now }}>
      <Reading.Provider
        value={{
          now,
          nameOf,
          open: (key) => navigate(`${WORK.path}?key=${encodeURIComponent(key)}`),
        }}
      >
        {children}
      </Reading.Provider>
    </LiveContext.Provider>
  );
}

/** One live thing on a line: its dot, what it is, what it is doing and where. */
function LiveLine({ node }: { node: RunningNode }) {
  const { open, now } = useContext(Reading);
  const { selected } = useContext(Plane);
  const dot = needs(node) ? 'attn' : node.dot === 'moving' && now.stale ? 'live' : node.dot;
  const lines = [node.attention?.says ?? node.lines[0], node.lines[1]];
  return (
    <button
      type="button"
      className="live-line"
      data-key={node.key}
      aria-pressed={selected === node.key}
      aria-controls="running-panel"
      // A row is one target; this line is its own, and goes somewhere else.
      onClick={(event) => {
        event.stopPropagation();
        open(node.key);
      }}
    >
      <span className={cx('live-dot', dot && `live-dot--${dot}`)} aria-hidden="true" />
      <span className="live-who">{node.title}</span>
      {lines.map(
        (line, at) =>
          !!line?.length && (
            <span className={cx('live-says', !at && needs(node) && 'running-attn')} key={at}>
              <Phrase value={line} />
            </span>
          ),
      )}
    </button>
  );
}

/** Who is on a unit of work and where: a line for each session and each machine. */
export function LiveLines({ id, nodes }: { id?: string; nodes?: RunningNode[] }) {
  const live = useContext(LiveContext);
  const shown = nodes ?? (id ? liveOf(live?.board, runningKey('work', id)) : []);
  if (!shown.length) return null;
  return (
    <ul className="live-lines">
      {shown.map((node) => (
        <li key={node.key}>
          <LiveLine node={node} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A card: its kind, its name, where it stands, and who is on it and where. Each agent and
 * each machine on the unit has a line; with nobody on it, the board's own line says why.
 */
function Card({
  unit,
  box,
  shapes,
  live,
  relations,
  selected,
  dim,
  onSelect,
  onHover,
}: {
  unit: MapUnit;
  box: MapBox;
  shapes: WorkflowShape[] | undefined;
  live: RunningNode[];
  relations: string[];
  selected: boolean;
  dim: boolean;
  onSelect(key: RunningKey): void;
  onHover(key: RunningKey | null): void;
}) {
  const reading = useContext(Reading);
  const { node, flow } = unit;
  const own = !!node && needs(node);
  const red = own || live.some(needs);
  // Red is the dot of what needs a person; otherwise green only on what is live, and it
  // stops breathing once the read it came from is stale.
  const dot = red ? 'attn' : node?.dot === 'moving' && reading.now.stale ? 'live' : node?.dot;
  // Beside the stage and the lines of who is on it, the board's line would say both again.
  const line = own || !flow || !live.length ? (node?.attention?.says ?? node?.lines[0]) : undefined;
  // What the card draws, as its name. Its clocks are left out, so the name of a card in hand
  // holds still while they tick; a prerequisite its line already names is not said twice.
  const said = [
    unit.kind,
    unit.name,
    flow && words(flow.state),
    steadyText(line, reading),
    ...live.map((on) => on.title),
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <button
      type="button"
      className={cx(
        'wmap-node',
        node?.look === 'dashed' && 'wmap-node--waiting',
        (!node || node.look === 'quiet') && 'wmap-node--done',
        red && 'wmap-node--attn',
        selected && 'on',
        // A card that needs a person never steps back.
        dim && !red && 'dim',
      )}
      data-key={unit.key}
      aria-pressed={selected}
      aria-controls="running-panel"
      aria-label={[said, ...relations.filter((relation) => !said.includes(relation))].join(', ')}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onClick={() => onSelect(unit.key)}
      onMouseEnter={() => onHover(unit.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(unit.key)}
      onBlur={() => onHover(null)}
    >
      <span className="wmap-head">
        {/* In the faint small caps and never a kind's colour, which beside what is red
            here would read as an alarm of its own (a reflection's is red). */}
        <span className="running-kind">{unit.kind}</span>
        {dot && <span className={cx('live-dot', `live-dot--${dot}`)} aria-hidden="true" />}
      </span>
      <span className="wmap-name">{unit.name}</span>
      {/* What a person has to do takes the place of where the unit stands: two lines of it. */}
      {flow && !own && <StageMark shapes={shapes} workflow={flow} />}
      {!!line?.length && (
        <span className={cx('wmap-line', own && 'running-attn')}>
          <Phrase value={line} />
        </span>
      )}
      {live.map((on) => {
        // An agent's second line is where it runs; anything else says how it stands.
        const where = !on.attention && on.lane === 'sessions' && on.lines[1];
        return (
          <span className={cx('wmap-line', needs(on) && 'running-attn')} key={on.key}>
            {on.title}
            {where ? ' ' : ' · '}
            <Phrase value={where || (on.attention?.says ?? on.lines[0] ?? [])} />
          </span>
        );
      })}
    </button>
  );
}

/**
 * The drawing. One width, measured, is all it is laid out from: the sidebar opening narrows
 * it and the map lays itself out again rather than being covered. Narrower than the layout
 * can draw, nothing is drawn, and the list under it says each relation in words.
 */
export function WorkMap({ shapes, wave }: { shapes: WorkflowShape[] | undefined; wave: Wave }) {
  const live = useContext(LiveContext);
  const { selected, onSelect } = useContext(Plane);
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<RunningKey | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const board = live?.board;
  const { units, edges } = mapOf(board, wave);
  const layout = workMapLayout(
    units.map((unit) => unit.key),
    edges,
    width,
  );
  const names = new Map(units.map((unit) => [unit.key, unit.name]));
  // The unit in hand: itself, or the one a session or a machine in hand serves. It, or the
  // one under the pointer, stays lit with what it waits on and holds up.
  const held = selected && board ? absorberOf(board, selected) : undefined;
  const served = held && board!.edges.find((edge) => edge.from === held.key && names.has(edge.to));
  const inHand = [selected, held?.key, served?.to].find((key) => key && names.has(key)) ?? null;
  const focus = inHand ?? hover;
  const lit = focus
    ? new Set([
        focus,
        ...edges
          .filter((edge) => edge.from === focus || edge.to === focus)
          .flatMap((edge) => [edge.from, edge.to]),
      ])
    : null;
  const worked = new Set(
    units
      .filter(({ node }) => node?.dot && node.dot !== 'starting' && !live?.now.stale)
      .map((unit) => unit.key),
  );
  // The keys walk the cards, from a card or from the drawing itself: never with a modifier,
  // which is the browser's (Alt+Left is Back).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!layout || event.metaKey || event.ctrlKey || event.altKey) return;
    const from = event.target as HTMLElement;
    if (from !== event.currentTarget && !from.matches?.('[data-key]')) return;
    const current = from.closest?.<HTMLElement>('[data-key]')?.dataset.key;
    const index = current ? layout.order.indexOf(current) : -1;
    const step = (delta: number) =>
      layout.order[index < 0 ? (delta > 0 ? 0 : layout.order.length - 1) : index + delta];
    let next: RunningKey | undefined;
    if (event.key === 'ArrowRight' || event.key === 'j') next = step(1);
    else if (event.key === 'ArrowLeft' || event.key === 'k') next = step(-1);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const down = event.key === 'ArrowDown';
      next = current ? beneath(layout, current, down) : step(down ? 1 : -1);
    } else return;
    event.preventDefault();
    if (!next) return;
    [...(frame.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])]
      .find((card) => card.dataset.key === next)
      ?.focus();
  };
  return (
    <div
      className="wmap"
      ref={frame}
      tabIndex={layout ? 0 : undefined}
      role="group"
      aria-label="Map of work"
      onKeyDown={onKeyDown}
      style={layout ? { height: layout.height } : undefined}
    >
      {layout && (
        <svg
          className="wmap-wires"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
        >
          {layout.wires.map((wire) => {
            const on = !!lit && (wire.from === focus || wire.to === focus);
            return (
              <g
                key={`${wire.from}>${wire.to}`}
                className={cx(
                  'wmap-wire',
                  wire.waiting && 'wmap-wire--waiting',
                  on && 'on',
                  !!lit && !on && 'dim',
                )}
              >
                <path d={wire.d} />
                <path d={wire.head} />
                {worked.has(wire.from) && (
                  <path className="wmap-pulse" d={wire.d} pathLength={100} />
                )}
              </g>
            );
          })}
        </svg>
      )}
      {layout &&
        units.map((unit) => (
          <Card
            key={unit.key}
            unit={unit}
            box={layout.at.get(unit.key)!}
            shapes={shapes}
            live={liveOf(board, unit.key)}
            relations={edges
              .filter((edge) => edge.to === unit.key && edge.waiting)
              .map((edge) => `Waits on ${names.get(edge.from)}`)}
            selected={unit.key === inHand}
            dim={!!lit && !lit.has(unit.key)}
            onSelect={onSelect}
            onHover={(key) => setHover((old) => key ?? (old === unit.key ? null : old))}
          />
        ))}
    </div>
  );
}

/**
 * Under the map: how many agents are working and how many things need a person, each
 * lane's own line with its one control — for sessions, how dispatch stands — and then
 * whatever is live and on no unit of work: a machine nobody is using, an agent between two.
 */
function LiveHead({ board, now }: { board: RunningBoard; now: Clock }) {
  const lanes = LANES.map((name) => board.lanes[name]);
  const needsYou = lanes.reduce((sum, lane) => sum + lane.needsYou, 0);
  const sessions = board.lanes.sessions;
  const on = new Set(
    board.edges.filter((edge) => edge.verb !== 'waits on').map((edge) => edge.from),
  );
  const loose = [...sessions.nodes, ...board.lanes.hardware.nodes].filter(
    (node) => !on.has(node.key),
  );
  // An agent is working while its lease is live; one offered or lapsed is not, nor a machine.
  const working = sessions.nodes.filter((node) => node.dot === 'live' || node.dot === 'moving');
  // With nothing live, no lane's line and nothing that failed to load, there is nothing to say.
  const said = [sessions.nodes, loose, ...lanes.flatMap((lane) => [lane.summaries, lane.failed])];
  if (!sessions.pending && said.every((list) => !list.length)) return null;
  return (
    <section className="live-head" aria-label="Live">
      <div className="live-head-line">
        <span>
          <b className="tabular">{sessions.pending ? EM : working.length}</b> working
        </span>
        {needsYou > 0 && (
          <span className="running-needs">
            {needsYou} {needsYou === 1 ? 'needs you' : 'need you'}
          </span>
        )}
        {lanes.flatMap((lane) =>
          lane.summaries.map((summary, index) => (
            <span className="running-summary" key={`${summary.lane}${summary.owner ?? ''}${index}`}>
              <span className="muted">
                <Phrase value={summary.says} />
              </span>
              {summary.actions.map((action) => (
                <Act key={`${action.tool}:${action.label}`} action={action} />
              ))}
            </span>
          )),
        )}
      </div>
      {lanes.flatMap((lane) =>
        lane.summaries.map(
          ({ attention, owner, lane: name }, index) =>
            attention && (
              <p className="running-note running-lane-attn" key={`${name}${owner ?? ''}${index}`}>
                <span className={cx(!attention.quiet && 'running-attn')}>
                  <Phrase value={attention.says} />
                </span>
                {attention.who && <span className="muted">{attention.who}</span>}
                {attention.to && <Target to={attention.to}>{attention.to.text}</Target>}
              </p>
            ),
        ),
      )}
      {lanes.some((lane) => lane.failed.length > 0) && (
        <p className="error-message running-note" role="status">
          Could not load everything.
        </p>
      )}
      {lanes
        .filter((lane) => staleLane(lane, now))
        .slice(0, 1)
        .map((lane) => (
          <p className="muted running-note" role="status" key="stale">
            Could not refresh. Showing the state that loaded{' '}
            <Phrase value={[{ ago: lane.asOf! }]} />.
          </p>
        ))}
      <LiveLines nodes={loose} />
    </section>
  );
}

/**
 * The page the map stands on: the board read once for everything under it, the key in hand
 * kept in the address, and the sidebar docked beside whatever the page holds.
 */
export function WorkPlane({ nameOf, children }: Named & { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const asked = params.get('key');
  // The page the link that named this key goes to, should no owner answer for it.
  const sent: unknown = (useLocation().state as { route?: unknown } | null)?.route;
  const fallback = typeof sent === 'string' && sent.startsWith('/') ? sent : undefined;
  const { board, now } = useLive();
  const data = board.data;
  const roomy = useRoomy();
  const main = useRef<HTMLDivElement>(null);

  // The history keeps one entry for an open sidebar: opening it from the page adds one,
  // which Back and Close both take away; swapping what it shows replaces it.
  const pushed = useRef(false);
  const refocus = useRef<RunningKey | null>(null);
  useEffect(() => {
    if (!asked) pushed.current = false;
  }, [asked]);
  const select = (key: RunningKey | null, how: 'push' | 'replace', route?: string) => {
    const next = new URLSearchParams(params);
    if (key) next.set('key', key);
    else next.delete('key');
    if (how === 'push') pushed.current = true;
    setParams(next, { replace: how === 'replace', state: route ? { route } : undefined });
  };
  // A link opens its key's sidebar from the page, or swaps it into the one already open.
  const follow = (key: RunningKey, route?: string) =>
    select(key, asked ? 'replace' : 'push', route);
  // A key another node absorbed opens that node, in place of the address that named it.
  const absorber = data && asked ? absorberOf(data, asked) : undefined;
  const redirect = absorber && absorber.key !== asked ? absorber.key : undefined;
  useEffect(() => {
    if (redirect) select(redirect, 'replace');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirect]);
  // The sidebar waits for the board, which says whether its key is another's alias.
  const target = asked && !redirect && (data || board.error) ? asked : null;
  const close = () => {
    refocus.current = target;
    if (pushed.current) {
      pushed.current = false;
      navigate(-1);
    } else select(null, 'replace');
  };
  // Closing hands the cursor back to the card that was open, or to the page it stood on.
  useEffect(() => {
    const key = refocus.current;
    if (asked || !key) return;
    refocus.current = null;
    const cards = [...(main.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])];
    (cards.find((card) => card.dataset.key === key) ?? main.current)?.focus();
  }, [asked]);
  // Escape closes the sidebar wherever the cursor is — except inside a guard, where it
  // means Cancel and has already been taken, and inside a menu or a dialog, such as the
  // rail's account menu, whose own Escape shuts it and must not close this as well.
  const closing = useRef(close);
  closing.current = close;
  useEffect(() => {
    if (!asked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const from = event.target as Element | null;
      if (from?.closest?.(`.guard, ${OWN_ESCAPE}, ${TYPING}`)) return;
      event.preventDefault();
      closing.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [asked]);
  const onSelect = (key: RunningKey) => {
    if (key === target) close();
    else select(key, asked ? 'replace' : 'push');
  };
  return (
    <LiveContext.Provider value={{ board: data, now }}>
      <Reading.Provider value={{ now, nameOf, open: follow }}>
        <Plane.Provider value={{ selected: target, onSelect }}>
          <div className="running work-plane">
            {data && board.error && (
              <div className="shell-stale">
                <LoadState {...board} />
              </div>
            )}
            {data && !board.error && now.stale && board.loadedAt && (
              <p className="muted shell-stale" role="status">
                Showing the state that loaded <Ago at={board.loadedAt} />.
              </p>
            )}
            <div className="running-plane" data-open={target ? '' : undefined}>
              <div className="work-main" ref={main} tabIndex={-1} hidden={!!target && !roomy}>
                {children}
              </div>
              <aside
                id="running-panel"
                className="running-panel"
                aria-labelledby="running-panel-title"
                hidden={!target}
              >
                {target && (
                  <RunningSidebar
                    key={target}
                    target={target}
                    attention={absorber?.attention}
                    moving={!!absorber?.dot}
                    onClose={close}
                    onMissing={fallback ? () => navigate(fallback, { replace: true }) : undefined}
                    nameOf={nameOf}
                    open={follow}
                  />
                )}
              </aside>
            </div>
          </div>
        </Plane.Provider>
      </Reading.Provider>
    </LiveContext.Provider>
  );
}

/** What stands between the map and the list: the board's own lines, once it has answered. */
export function LiveUnder() {
  const live = useContext(LiveContext);
  return live?.board ? <LiveHead board={live.board} now={live.now} /> : null;
}
