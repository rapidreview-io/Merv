import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { Ago, LoadState, cx, useNow, useSidebarEscape } from '../components';
import { clock, type Clock } from '../liveness';
import { useRoomy } from '../theme';
import { Act, RunningSidebar } from './running-panel';
import { Phrase, Reading, Target, type RunningReading } from './running-phrase';

/** Shared live status, dispatch controls and the selected work item's docked sidebar. */

const LANES: readonly RunningLaneName[] = ['work', 'sessions', 'hardware'];
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
/** The item whose sidebar is open. */
const Plane = createContext<RunningKey | null>(null);
/** The live board as the workspace last read it. */
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
  const selected = useContext(Plane);
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

/** The dispatch action offered by Sessions, including its own confirmation when required. */
export function WorkDispatch() {
  const live = useContext(LiveContext);
  const summary = live?.board?.lanes.sessions.summaries.find((item) =>
    item.actions.some((action) => /dispatch/i.test(action.label)),
  );
  const action = summary?.actions.find((item) => /dispatch/i.test(item.label));
  return action ? <Act action={action} /> : null;
}

/**
 * Lane-level attention, stale or failed reads, and live agents or machines not attached to work.
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
 * Read live status once for the workspace, keep the selected item in the address, and dock its sidebar.
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
  return (
    <LiveContext.Provider value={{ board: data, now, liveOn }}>
      <Reading.Provider value={{ now, nameOf, open: follow }}>
        <Plane.Provider value={target}>
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
