import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  runningKey,
  type RunningBoard,
  type RunningKey,
  type RunningLane,
  type RunningLaneName,
  type RunningNode,
} from '@merv/contracts/running';
import { readOnly, refreshTools, useTool } from '../api';
import { Ago, LoadState, cx, kindOf, useNow, useSidebarEscape, words } from '../components';
import { clock, type Clock } from '../liveness';
import { useCommand } from '../mutations';
import { StageGlyph, ended as endedBy, stepsOf } from '../process';
import { useRoomy } from '../theme';
import type { WorkflowShape } from '../shell-types';
import type { Flow } from './map-data';
import { Act, RunningSidebar } from './running-panel';
import { Phrase, Reading, Target, steadyText, type RunningReading } from './running-phrase';
import { beneath, workMapLayout, type MapEdge, type MapPlace } from './work-map-layout';

/**
 * The map of work and what is live on it. Every unit of work is a mark and a name, a quiet
 * line runs from each prerequisite to what waits on it, and beside the map docks the sidebar
 * of whatever is in hand. What moves — the agents on a unit, the machines they run on, what
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
/** Wide enough for the sidebar to stand beside the page; narrower, it takes the page over. */

export const needs = (node: RunningNode) => !!node.attention && !node.attention.quiet;
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
interface MapUnit {
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
  /** The page narrowed the wave: what it holds is drawn, and nothing beside it. */
  only?: boolean;
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
  const keys = new Set(wave?.only ? [] : nodes.keys());
  const later = [...items].sort(([, a], [, b]) => b.at.localeCompare(a.at));
  for (const [key, item] of later) if (item.held) keys.add(key);
  if (!wave?.only)
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
    edges: direct([
      ...new Map(
        edges
          .filter((edge) => keys.has(edge.from) && keys.has(edge.to))
          .map((edge) => [`${edge.from}>${edge.to}`, edge]),
      ).values(),
    ]),
  };
}

/**
 * The lines worth drawing: a prerequisite the unit already reaches through another of its
 * prerequisites is not drawn to it again, since the line through the nearer one says it. What
 * each unit reaches is worked out once, so the map costs its edges times its units at most.
 */
function direct(edges: MapEdge[]): MapEdge[] {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const reach = new Map<string, Set<string>>();
  // Everything below `key`. A unit met again while its own reach is worked out (a cycle, which
  // no owner should send) adds nothing, so every line of the cycle is kept.
  const below = (key: string): Set<string> => {
    const known = reach.get(key);
    if (known) return known;
    const found = new Set<string>();
    reach.set(key, found);
    for (const to of next.get(key) ?? []) {
      found.add(to);
      for (const deeper of below(to)) found.add(deeper);
    }
    return found;
  };
  return edges.filter(
    (edge) =>
      !(next.get(edge.from) ?? []).some((via) => via !== edge.to && below(via).has(edge.to)),
  );
}

/**
 * The sessions on each thing and the machines serving it or them, as the board relates them:
 * who is working on it, and where. Built once for a board, then asked of each card.
 */
export function liveLookup(board: RunningBoard | undefined): (key: RunningKey) => RunningNode[] {
  if (!board) return () => [];
  const all = new Map(
    [...board.lanes.sessions.nodes, ...board.lanes.hardware.nodes].map((node) => [node.key, node]),
  );
  const serving = new Map<RunningKey, RunningNode[]>();
  for (const edge of board.edges) {
    const node = edge.verb !== 'waits on' && all.get(edge.from);
    if (node) serving.set(edge.to, [...(serving.get(edge.to) ?? []), node]);
  }
  const on = (target: RunningKey) => serving.get(target) ?? [];
  return (key) => {
    const sessions = on(key);
    return [...new Set([...sessions, ...sessions.flatMap((node) => on(node.key))])];
  };
}

/** A person's or an agent's name, where the reader of the page may see one. */
type Named = Pick<RunningReading, 'nameOf'>;
/** The board as this page last read it, and the clock every fact on it is read by. */
interface Live {
  board?: RunningBoard;
  now: Clock;
  liveOn: ReturnType<typeof liveLookup>;
}
const LiveContext = createContext<Live | null>(null);
/** The key in hand and how one is taken up, where a plane stands to dock its sidebar. */
const Plane = createContext<{ selected: RunningKey | null; onSelect(key: RunningKey): void }>({
  selected: null,
  onSelect: () => undefined,
});
/** The board as the plane last read it, for what stands above the map. */
export const useBoard = () => useContext(LiveContext);
/** Reads the board at the pace of what moves on it; every clock is the payload's own. */
export function useLive() {
  const board = useTool<RunningBoard>('ui.running', {}, { every: cadenceOf });
  const cadence = cadenceOf(board.data);
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
  const shown = nodes ?? (id && live ? live.liveOn(runningKey('work', id)) : []);
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

/** A unit is live while an agent holds it; read from the board's dot. */
const isLive = (node?: RunningNode) => node?.dot === 'live' || node?.dot === 'moving';
/** The unit has ended: its program's end state, or the board drawing it quiet. */
const hasEnded = (shapes: WorkflowShape[] | undefined, unit: MapUnit) =>
  unit.flow ? endedBy(shapes, unit.flow) : unit.node?.look === 'quiet';

/**
 * A mark: a circle for an experiment, a square for a task, filled as far as the unit is along
 * its program; its name beside it, and what a person must do after that. Red is only the ring
 * of what needs a person, green only the dot of what is live. Folded, it is the mark alone.
 */
function Mark({
  unit,
  place,
  shapes,
  red,
  selected,
  dim,
  relations,
  onSelect,
  onHover,
}: {
  unit: MapUnit;
  place: MapPlace;
  shapes: WorkflowShape[] | undefined;
  red: boolean;
  selected: boolean;
  dim: boolean;
  relations: string[];
  onSelect(key: RunningKey): void;
  onHover(key: RunningKey | null): void;
}) {
  const reading = useContext(Reading);
  const { node, flow } = unit;
  const own = !!node && needs(node);
  const live = isLive(node) && !reading.now.stale;
  const done = hasEnded(shapes, unit);
  const steps = flow ? stepsOf(shapes, flow) : [];
  const at = steps.findIndex((step) => step.current);
  // What a person has to do stands after the name; with nobody needed, nothing does.
  const line = own ? node.attention?.says : undefined;
  const said = [unit.kind, unit.name, flow && words(flow.state), steadyText(line, reading)]
    .filter(Boolean)
    .join(', ');
  return (
    <button
      type="button"
      className={cx(
        'wmap-mark',
        done && 'wmap-mark--done',
        node?.look === 'dashed' && 'wmap-mark--waiting',
        red && 'wmap-mark--attn',
        place.folded && 'wmap-mark--folded',
        selected && 'on',
        // A mark that needs a person never steps back.
        dim && !red && 'dim',
      )}
      data-key={unit.key}
      aria-pressed={selected}
      aria-controls="running-panel"
      aria-label={[said, ...relations.filter((relation) => !said.includes(relation))].join(', ')}
      style={{ left: place.x - 15, top: place.y - 15, maxWidth: place.w }}
      onClick={() => onSelect(unit.key)}
      onMouseEnter={() => onHover(unit.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(unit.key)}
      onBlur={() => onHover(null)}
    >
      <span className="wmap-glyph">
        {at >= 0 ? (
          <StageGlyph steps={steps} at={at} shape={unit.kind === 'Task' ? 'square' : 'circle'} />
        ) : (
          <span className="status-dot" aria-hidden="true" />
        )}
        {live && <span className="live-dot live-dot--live" aria-hidden="true" />}
      </span>
      {!place.folded && (
        <span className="wmap-name">
          {unit.name}
          {!!line?.length && (
            <span className="wmap-say running-attn">
              {' · '}
              <Phrase value={line} />
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** Everything a unit reaches along its lines, up to what it waits on and down to what came of it. */
function lineage(key: RunningKey, edges: MapEdge[]): Set<string> {
  const found = new Set<string>([key]);
  const walk = (from: string, way: 'from' | 'to') => {
    const other = way === 'from' ? 'to' : 'from';
    for (const edge of edges)
      if (edge[way] === from && !found.has(edge[other])) {
        found.add(edge[other]);
        walk(edge[other], way);
      }
  };
  walk(key, 'from');
  walk(key, 'to');
  return found;
}

/**
 * The drawing. One width, measured, is all it is laid out from: the sidebar opening narrows
 * it and the map lays itself out again rather than being covered. Narrower than the layout
 * can draw, nothing is drawn, and the list under it says each relation in words.
 */
export function WorkMap({
  shapes,
  wave,
  onDrawn,
}: {
  shapes: WorkflowShape[] | undefined;
  wave: Wave;
  /** Told whether the map is drawn, once its room is known: where it is, the page lists nothing. */
  onDrawn?(drawn: boolean): void;
}) {
  const live = useContext(LiveContext);
  const { selected, onSelect } = useContext(Plane);
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<RunningKey | null>(null);
  const [unfold, setUnfold] = useState(false);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return setWidth(-1);
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const board = live?.board;
  // The clock ticks every second while anything moves; the map is laid out again only when
  // the board, the wave or the room changes.
  const { units, edges } = useMemo(() => mapOf(board, wave), [board, wave]);
  const layout = useMemo(
    () =>
      workMapLayout(
        units.map((unit) => unit.key),
        edges,
        width,
        {
          ended: new Set(units.filter((unit) => hasEnded(shapes, unit)).map((unit) => unit.key)),
          held: new Set(
            units
              .filter(({ node }) => isLive(node) || (!!node && needs(node)))
              .map((unit) => unit.key),
          ),
          unfold,
        },
      ),
    [units, edges, width, shapes, unfold],
  );
  const drawn = !!layout;
  // Unmeasured, nobody knows yet: saying so would flash the rows the drawing replaces.
  useEffect(() => void (width && onDrawn?.(drawn)), [drawn, width, onDrawn]);
  const names = new Map(units.map((unit) => [unit.key, unit.name]));
  // The unit in hand: itself, or the one a session or a machine in hand serves. Its whole line
  // of work stays lit, up and down the page; the one under the pointer lights its neighbours.
  const held = selected && board ? absorberOf(board, selected) : undefined;
  const served = held && board!.edges.find((edge) => edge.from === held.key && names.has(edge.to));
  const inHand = [selected, held?.key, served?.to].find((key) => key && names.has(key)) ?? null;
  const lit = inHand
    ? lineage(inHand, edges)
    : hover
      ? new Set([
          hover,
          ...edges
            .filter((edge) => edge.from === hover || edge.to === hover)
            .flatMap((edge) => [edge.from, edge.to]),
        ])
      : null;
  const red = (unit: MapUnit) =>
    (!!unit.node && needs(unit.node)) || (live?.liveOn(unit.key) ?? []).some(needs);
  // The keys walk the marks, from a mark or from the drawing itself: never with a modifier,
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
            const on = !!lit && lit.has(wire.from) && lit.has(wire.to);
            return (
              <path
                key={`${wire.from}>${wire.to}`}
                className={cx(
                  'wmap-wire',
                  wire.waiting && 'wmap-wire--waiting',
                  on && 'on',
                  !!lit && !on && 'dim',
                )}
                d={wire.d}
              />
            );
          })}
        </svg>
      )}
      {layout?.folds.map((fold) => (
        <button
          type="button"
          key={fold.y}
          className="wmap-fold"
          style={{ left: fold.x - 8, top: fold.y + 9 }}
          onClick={() => setUnfold(true)}
        >
          {fold.count} done
        </button>
      ))}
      {layout &&
        units.map((unit) => (
          <Mark
            key={unit.key}
            unit={unit}
            place={layout.at.get(unit.key)!}
            shapes={shapes}
            red={red(unit)}
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

/** How many of each kind are live, and how many need a person, for the page's one line. */
export interface WorkCounts {
  experiments: { live: number; attention: number };
  tasks: { live: number; attention: number };
}
export function countsOf(units: MapUnit[], stale: boolean): WorkCounts {
  const counts: WorkCounts = {
    experiments: { live: 0, attention: 0 },
    tasks: { live: 0, attention: 0 },
  };
  for (const unit of units) {
    const of = unit.kind === 'Task' ? counts.tasks : counts.experiments;
    if (isLive(unit.node) && !stale) of.live++;
    if (unit.node && needs(unit.node)) of.attention++;
  }
  return counts;
}
/** The one line's filters: what is live or needs a person, of each kind; and which kinds. */
export type WorkShow =
  'experiments-live' | 'experiments-attention' | 'tasks-live' | 'tasks-attention';
export interface WorkFilter {
  /** Show only these, where any is pressed. */
  only: Set<WorkShow>;
  /** Which kinds are drawn, and whether ended work is. */
  kinds: { experiments: boolean; tasks: boolean; ended: boolean };
}
/** Whether a unit passes the page's one line, given what the board says of it. */
export function shown(
  unit: { kind: string; node?: RunningNode; done: boolean },
  filter: WorkFilter,
  stale: boolean,
): boolean {
  const kind = unit.kind === 'Task' ? 'tasks' : 'experiments';
  if (!filter.kinds[kind] || (unit.done && !filter.kinds.ended)) return false;
  if (!filter.only.size) return true;
  const live = isLive(unit.node) && !stale;
  const attention = !!unit.node && needs(unit.node);
  return (
    (filter.only.has(`${kind}-live`) && live) || (filter.only.has(`${kind}-attention`) && attention)
  );
}

const Glyph = ({ kind, tone }: { kind: 'experiments' | 'tasks'; tone?: 'live' | 'attention' }) => (
  <svg
    className={cx('wbar-glyph', tone && `wbar-glyph--${tone}`)}
    viewBox="0 0 14 14"
    aria-hidden="true"
  >
    {kind === 'tasks' ? (
      <rect className="stage-ring" x="1.25" y="1.25" width="11.5" height="11.5" rx="2.5" />
    ) : (
      <circle className="stage-ring" cx="7" cy="7" r="5.75" />
    )}
    {tone === 'live' && <circle className="wbar-live" cx="12" cy="2" r="3" />}
  </svg>
);

/** Dispatch, as the sessions lane offers it: its mark and its word, one press to turn it. */
function Dispatch() {
  const live = useContext(LiveContext);
  const summary = live?.board?.lanes.sessions.summaries.find((item) =>
    item.actions.some((action) => /dispatch/i.test(action.label)),
  );
  const action = summary?.actions.find((item) => /dispatch/i.test(item.label));
  const command = useCommand<unknown>({
    tool: action?.tool ?? '',
    idempotent: true,
    validate: () => true,
    onSuccess: () => refreshTools('ui.running', 'ui.running_panel', 'ui.home'),
  });
  if (!action) return null;
  // A dispatch whose owner asks a question or a confirmation keeps its own control.
  if (action.guard || action.ask) return <Act action={action} />;
  const paused = /start|resume/i.test(action.label);
  const label = paused ? 'dispatch paused' : 'dispatch on';
  return (
    <button
      type="button"
      className="wbar-b"
      title={action.label}
      aria-label={`${label}, ${action.label}`}
      disabled={readOnly() || command.busy}
      onClick={() => void command.submit(action.input)}
    >
      <svg className="wbar-glyph" viewBox="0 0 14 14" aria-hidden="true">
        {paused ? (
          <path d="M4.5 3.5h2v7h-2zM7.5 3.5h2v7h-2z" className="wbar-fill" />
        ) : (
          <path d="M4 2.5 11 7 4 11.5Z" className="wbar-fill" />
        )}
      </svg>
      <span className="wbar-word">{label}</span>
    </button>
  );
}

/** The marks the line does not teach, named once, under it, while Key is pressed. */
function KeyLine() {
  const ring = (inner: ReactNode) => (
    <svg className="wbar-glyph" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="stage-ring" cx="7" cy="7" r="5.75" />
      {inner}
    </svg>
  );
  return (
    <ul className="wkey" aria-label="Key">
      <li>{ring(<path className="stage-fill" d="M7 7V3.5A3.5 3.5 0 1 1 3.5 7Z" />)}in progress</li>
      <li>
        <svg className="wbar-glyph" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="wbar-fill" cx="7" cy="7" r="6.5" />
          <path className="stage-sign" d="M4.2 7.3 6.2 9.2 9.9 5.1" />
        </svg>
        done
      </li>
      <li>
        <svg className="wbar-glyph" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="wbar-fill" cx="7" cy="7" r="6.5" />
          <path className="stage-sign" d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2" />
        </svg>
        stopped
      </li>
      <li>
        <Glyph kind="experiments" tone="attention" />
        needs you
      </li>
      <li>
        <Glyph kind="experiments" tone="live" />
        live
      </li>
      <li>
        <svg className="wbar-line" viewBox="0 0 22 14" aria-hidden="true">
          <path d="M1 7H21" />
        </svg>
        waits on
      </li>
      <li>
        <svg className="wbar-line wbar-line--waiting" viewBox="0 0 22 14" aria-hidden="true">
          <path d="M1 7H21" />
        </svg>
        not yet settled
      </li>
    </ul>
  );
}

/**
 * The page's one line: what is live and what needs a person, of each kind, each count the
 * filter for it; dispatch; the shapes as the remaining filters; Key; and what the page can
 * start (`ends`), with the way to every agent and machine there has been (`agents`).
 */
export function WorkBar({
  counts,
  filter,
  onFilter,
  ends,
  agents,
}: {
  counts: WorkCounts;
  filter: WorkFilter;
  onFilter(next: WorkFilter): void;
  ends?: ReactNode;
  agents?: string;
}) {
  const [key, setKey] = useState(false);
  const count = (kind: 'experiments' | 'tasks', tone: 'live' | 'attention') => {
    const name: WorkShow = `${kind}-${tone}`;
    const on = filter.only.has(name);
    return (
      <button
        type="button"
        className={cx('wbar-b', on && 'on')}
        aria-pressed={on}
        title={
          on
            ? 'Show everything'
            : `Show only ${kind} that ${tone === 'live' ? 'are live' : 'need you'}`
        }
        onClick={() => {
          const only = new Set(filter.only);
          if (on) only.delete(name);
          else only.add(name);
          onFilter({ ...filter, only });
        }}
      >
        <Glyph kind={kind} tone={tone} />
        <span className="wbar-n tabular">{counts[kind][tone]}</span>
        <span className="wbar-word">{tone}</span>
      </button>
    );
  };
  const kind = (name: 'experiments' | 'tasks' | 'ended', glyph: ReactNode, title: string) => (
    <button
      type="button"
      className={cx('wbar-b', filter.kinds[name] && 'on')}
      aria-pressed={filter.kinds[name]}
      title={title}
      aria-label={title}
      onClick={() =>
        onFilter({ ...filter, kinds: { ...filter.kinds, [name]: !filter.kinds[name] } })
      }
    >
      {glyph}
    </button>
  );
  return (
    <>
      <div className="wbar" role="group" aria-label="Work">
        <span className="wbar-g">
          <span className="wbar-word wbar-kind">experiments</span>
          {count('experiments', 'live')}
          {count('experiments', 'attention')}
        </span>
        <span className="wbar-sep" />
        <span className="wbar-g">
          <span className="wbar-word wbar-kind">tasks</span>
          {count('tasks', 'live')}
          {count('tasks', 'attention')}
        </span>
        <span className="wbar-sep" />
        <Dispatch />
        <span className="wbar-gap" />
        {kind('experiments', <Glyph kind="experiments" />, 'Show experiments')}
        {kind('tasks', <Glyph kind="tasks" />, 'Show tasks')}
        {kind(
          'ended',
          <svg className="wbar-glyph" viewBox="0 0 14 14" aria-hidden="true">
            <circle className="wbar-fill" cx="7" cy="7" r="5.75" />
          </svg>,
          'Show ended',
        )}
        <button
          type="button"
          className={cx('wbar-b', 'wbar-key', key && 'on')}
          aria-pressed={key}
          onClick={() => setKey(!key)}
        >
          Key
        </button>
        {agents && (
          <Link className="wbar-word wbar-link" to={agents}>
            Agents
          </Link>
        )}
        {ends}
      </div>
      {key && <KeyLine />}
    </>
  );
}

/**
 * Under the map, what the board has to say beside its counts: a lane that needs a person, a
 * lane that failed to load or went stale, and whatever is live and on no unit of work — a
 * machine nobody is using, an agent between two.
 */
export function LiveNotes() {
  const live = useContext(LiveContext);
  if (!live?.board) return null;
  const { board, now } = live;
  const lanes = LANES.map((name) => board.lanes[name]);
  const on = new Set(
    board.edges.filter((edge) => edge.verb !== 'waits on').map((edge) => edge.from),
  );
  const loose = [...board.lanes.sessions.nodes, ...board.lanes.hardware.nodes].filter(
    (node) => !on.has(node.key),
  );
  const notes = lanes.flatMap((lane) => lane.summaries.filter((summary) => summary.attention));
  const failed = lanes.some((lane) => lane.failed.length > 0);
  const stale = lanes.filter((lane) => staleLane(lane, now)).slice(0, 1);
  if (!notes.length && !failed && !stale.length && !loose.length) return null;
  return (
    <section className="live-notes" aria-label="Live">
      {notes.map(({ attention, owner, lane }, index) => (
        <p className="running-note running-lane-attn" key={`${lane}${owner ?? ''}${index}`}>
          <span className={cx(!attention!.quiet && 'running-attn')}>
            <Phrase value={attention!.says} />
          </span>
          {attention!.who && <span className="muted">{attention!.who}</span>}
          {attention!.to && <Target to={attention!.to}>{attention!.to.text}</Target>}
        </p>
      ))}
      {failed && (
        <p className="error-message running-note" role="status">
          Could not load everything.
        </p>
      )}
      {stale.map((lane) => (
        <p className="muted running-note" role="status" key="stale">
          Could not refresh. Showing the state that loaded <Phrase value={[{ ago: lane.asOf! }]} />.
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
  const liveOn = useMemo(() => liveLookup(data), [data]);
  const roomy = useRoomy();
  const main = useRef<HTMLDivElement>(null);

  // The history keeps one entry for an open sidebar: opening it from the page adds one,
  // which Back and Close both take away; swapping what it shows replaces it.
  const pushed = useRef(false);
  const refocus = useRef<RunningKey | null>(null);
  // Maximized, the sidebar has the page's place beside the rail until it is restored or shut.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (asked) return;
    pushed.current = false;
    setFull(false);
  }, [asked]);
  const select = (key: RunningKey | null, how: 'push' | 'replace', route?: string) => {
    const next = new URLSearchParams(params);
    if (key) next.set('key', key);
    else next.delete('key');
    // The thread an address opened the card on is that card's: another key, or none, drops it.
    if (key !== absorber?.key) next.delete('thread');
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
  // Escape restores a maximized sidebar and closes one beside the page.
  useSidebarEscape(!!asked, full ? () => setFull(false) : close);
  const onSelect = (key: RunningKey) => {
    if (key === target) close();
    else select(key, asked ? 'replace' : 'push');
  };
  return (
    <LiveContext.Provider value={{ board: data, now, liveOn }}>
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
            <div
              className="running-plane"
              data-open={target ? '' : undefined}
              data-full={target && full ? '' : undefined}
            >
              <div
                className="work-main"
                ref={main}
                tabIndex={-1}
                hidden={!!target && (!roomy || full)}
              >
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
                    full={full}
                    onFull={roomy ? () => setFull(!full) : undefined}
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
