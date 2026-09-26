import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  RunningBoard,
  RunningKey,
  RunningLane,
  RunningLaneName,
  RunningNode,
} from '@merv/contracts/running';
import { useTool } from '../api';
import { Ago, EmptyState, LoadState, cx, useNow } from '../components';
import { clock, type Clock } from '../liveness';
import type { ViewProps } from './index';
import { useActorNames } from './people';
import {
  HEAD,
  LANES,
  absorberOf,
  kindsMix,
  related,
  runningLayout,
  type RunningBox,
  type RunningLayout,
} from './running-layout';
import { Act, RunningSidebar } from './running-panel';
import { Phrase, Reading, phraseText, type RunningReading } from './running-phrase';

/**
 * Running: everything in flight, in three bands — the work, the agent sessions on it, and
 * the machines they use — and beside them the sidebar of whatever is in hand. Every node
 * and every word of a sidebar is its owner's; this page lays them out, lights what one
 * relates to, and reads them again while anything moves. It is black and white: kind words
 * and the workflow are ink, green is only a dot on what is live, and red is only ever
 * something a person has to do.
 *
 * The sidebar docks beside the board and never covers it. Opening it narrows the board's
 * column, and the drawing lays itself out again from its measured width; where the page is
 * too narrow for both the sidebar follows the board, and on a phone it replaces it. The
 * thing in hand lives in the address (`?key=`), so a reload, a link or the Back button
 * lands on the same sidebar.
 */

const TITLE: Record<RunningLaneName, string> = {
  work: 'Work',
  sessions: 'Sessions',
  hardware: 'Hardware',
};
/** A total not yet known is the em dash, never a zero. */
const EM = '—';
/** One line under a band's heading — a part that did not load, a read gone stale. */
const NOTE = 22;
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

/** A lane whose cached source is older than its owner says it stays current. */
const staleLane = (lane: RunningLane, now: Clock) =>
  !!lane.asOf && lane.freshForMs !== undefined && now.at - Date.parse(lane.asOf) > lane.freshForMs;

/**
 * What a card is called, made of what it draws: its kind, its title, its name where that
 * is not the title, what needs a person where something does (otherwise its first line),
 * and its second line.
 */
export function nodeName(node: RunningNode, reading: Omit<RunningReading, 'open'>): string {
  const first = node.attention ? node.attention.says : node.lines[0];
  return [
    node.kind,
    node.title,
    node.name !== node.title && node.name,
    phraseText(first, reading),
    phraseText(node.lines[1], reading),
  ]
    .filter(Boolean)
    .join(', ');
}

/** The count beside a band's name, and what needs a person in it. */
function BandTitle({ lane, name }: { lane: RunningLane; name: RunningLaneName }) {
  const count = lane.pending ? EM : lane.nodes.length;
  return (
    <h2 className="running-band-title" id={`running-${name}`}>
      {TITLE[name]} <span className="section-n">{count}</span>
      {!!lane.more && <span className="section-n"> · +{lane.more} more</span>}
      {lane.needsYou > 0 && (
        <span className="running-needs">
          {' '}
          · {lane.needsYou} {lane.needsYou === 1 ? 'needs you' : 'need you'}
        </span>
      )}
    </h2>
  );
}

/**
 * A band's heading line: its name and count, the lane's own line — for Sessions, how
 * dispatch stands, with its one control — and, under it, one line where a part of the lane
 * did not load or its source has gone stale.
 */
function BandHead({ lane, name, now }: { lane: RunningLane; name: RunningLaneName; now: Clock }) {
  return (
    <>
      <div className="running-band-line">
        <BandTitle lane={lane} name={name} />
        {lane.summaries.map((summary, index) => (
          <span className="running-summary" key={`${summary.owner ?? ''}${index}`}>
            <span className="muted">
              <Phrase value={summary.says} />
            </span>
            {summary.attention && (
              <span className={cx(!summary.attention.quiet && 'running-attn')}>
                <Phrase value={summary.attention.says} />
              </span>
            )}
            {summary.actions.map((action) => (
              <Act key={`${action.tool}:${action.label}`} action={action} />
            ))}
          </span>
        ))}
      </div>
      {lane.failed.length > 0 && (
        <p className="error-message running-note" role="status">
          Could not load everything.
        </p>
      )}
      {staleLane(lane, now) && (
        <p className="muted running-note" role="status">
          Could not refresh. Showing the state that loaded <Phrase value={[{ ago: lane.asOf! }]} />.
        </p>
      )}
    </>
  );
}

/** A card's face: what it is, its title, two lines, and a dot where something is live. */
function Face({ node, kinds, now }: { node: RunningNode; kinds: boolean; now: Clock }) {
  const first = node.attention?.says ?? node.lines[0];
  // Red is the dot of what needs a person; otherwise green only on what is live, and it
  // stops breathing once the read it came from is stale.
  const dot = needs(node) ? 'attn' : node.dot === 'moving' && now.stale ? 'live' : node.dot;
  const cells = node.units ? Math.max(1, Math.min(8, node.units.count)) : 0;
  return (
    <span className="running-face">
      {cells > 0 && (
        <span
          className={cx('running-units', node.look === 'dashed' && 'running-units--dashed')}
          aria-hidden="true"
        >
          {Array.from({ length: cells }, (_, index) => (
            <i key={index} className={cx(node.units!.busy && 'on')} />
          ))}
        </span>
      )}
      {kinds && node.kind && <span className="running-kind">{node.kind}</span>}
      <span className="running-title">{node.title}</span>
      {first && first.length > 0 && (
        <span className={cx('running-line', needs(node) && 'running-attn')}>
          <Phrase value={first} />
        </span>
      )}
      {node.lines[1] && node.lines[1].length > 0 && (
        <span className="running-line running-line--second">
          <Phrase value={node.lines[1]} />
        </span>
      )}
      {dot && <span className={cx('running-dot', `running-dot--${dot}`)} aria-hidden="true" />}
    </span>
  );
}

/** A card as the one control it is: it opens this thing's sidebar. */
function Card({
  node,
  kinds,
  now,
  selected,
  dim,
  box,
  className,
  reading,
  onSelect,
  onHover,
  children,
}: {
  node: RunningNode;
  kinds: boolean;
  now: Clock;
  selected: boolean;
  dim: boolean;
  box?: RunningBox & { top: number };
  className: string;
  reading: Omit<RunningReading, 'open'>;
  onSelect(key: RunningKey): void;
  onHover(key: RunningKey | null): void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cx(
        className,
        `running-look--${node.look}`,
        needs(node) && 'running-attn',
        selected && 'on',
        dim && 'dim',
      )}
      data-key={node.key}
      aria-pressed={selected}
      aria-controls="running-panel"
      aria-label={nodeName(node, reading)}
      title={node.name && node.name !== node.title ? node.name : undefined}
      style={
        box
          ? ({
              left: box.x,
              top: box.y - box.top,
              width: box.w,
              height: box.h,
            } as CSSProperties)
          : undefined
      }
      onClick={() => onSelect(node.key)}
      onMouseEnter={() => onHover(node.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.key)}
      onBlur={() => onHover(null)}
    >
      <Face node={node} kinds={kinds} now={now} />
      {children}
    </button>
  );
}

/** The drawing's lines: prerequisites always, and a relation between bands only while lit. */
function Links({
  layout,
  board,
  lit,
}: {
  layout: RunningLayout;
  board: RunningBoard;
  lit: Set<RunningKey> | null;
}) {
  const attention = new Set(
    LANES.flatMap((lane) => board.lanes[lane].nodes.filter(needs).map((node) => node.key)),
  );
  const both = (from: RunningKey, to: RunningKey) => !!lit && lit.has(from) && lit.has(to);
  return (
    <svg
      className="running-links"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      aria-hidden="true"
    >
      {layout.paths.map(({ edge, d, head, cross }) => {
        const on = both(edge.from, edge.to);
        if (cross && !on) return null;
        return (
          <g
            key={`${edge.from}|${edge.to}|${edge.verb}`}
            className={cx(
              cross ? 'running-link' : 'running-wait',
              edge.waiting && 'running-link--waiting',
              on && 'on',
              !!lit && !on && 'dim',
              cross && attention.has(edge.from) && attention.has(edge.to) && 'running-attn',
            )}
          >
            <path d={d} />
            {head && <path d={head} />}
          </g>
        );
      })}
      {layout.ports.map((port) => {
        const on = !!lit && lit.has(port.key);
        return (
          <circle
            key={`${port.key}|${port.x}|${port.y}`}
            className={cx('running-port', on && 'on')}
            cx={port.x}
            cy={port.y}
            r={3.5}
          />
        );
      })}
    </svg>
  );
}

/** What a card relates to, in words, where there is no room to draw the line. */
function Relations({
  node,
  board,
  titles,
}: {
  node: RunningNode;
  board: RunningBoard;
  titles: ReadonlyMap<RunningKey, string>;
}) {
  const said = board.edges
    .filter((edge) => edge.from === node.key && titles.has(edge.to))
    .map((edge) => `${edge.verb} ${titles.get(edge.to)}`);
  if (!said.length) return null;
  return (
    <span className="running-relations">
      {said.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

export function RunningPage({ nameOf }: { nameOf(id: string): string | undefined }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const asked = params.get('key');
  const [cadence, setCadence] = useState(cadenceOf(undefined));
  const board = useTool<RunningBoard>('ui.running', {}, { every: cadence });
  const data = board.data;
  const every = cadenceOf(data);
  useEffect(() => setCadence(every), [every]);
  const live = !!data && moving(data);
  // Every clock on the board is the payload's own server time, and past two cadences it
  // stops at the moment the board was read rather than counting on against a stale fact.
  const now = clock(data?.observedAt, board.loadedAt, useNow(live ? 1000 : 0), cadence * 2);
  const roomy = useRoomy();
  const graph = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [heads, setHeads] = useState<Partial<Record<RunningLaneName, number>>>({});
  const [hover, setHover] = useState<RunningKey | null>(null);
  const measure = useRef<ResizeObserver>();
  // One width, measured, is all the drawing is laid out from: the sidebar opening narrows
  // it, and the board lays itself out again rather than being covered.
  useEffect(() => {
    const element = graph.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const heights: Partial<Record<RunningLaneName, number>> = {};
      for (const entry of entries) {
        const target = entry.target as HTMLElement | undefined;
        const lane = target?.dataset?.lane as RunningLaneName | undefined;
        if (lane) heights[lane] = target!.offsetHeight;
        else setWidth(entry.contentRect.width);
      }
      if (Object.keys(heights).length)
        setHeads((old) =>
          Object.entries(heights).some(([lane, h]) => h && old[lane as RunningLaneName] !== h)
            ? { ...old, ...heights }
            : old,
        );
    });
    observer.observe(element);
    measure.current = observer;
    return () => observer.disconnect();
  }, []);
  // A heading grows by the line under it; its measured height moves the band below.
  const headRef = useMemo(
    () =>
      Object.fromEntries(
        LANES.map((lane) => [
          lane,
          (element: HTMLElement | null) => {
            if (element) measure.current?.observe(element);
          },
        ]),
      ) as Record<RunningLaneName, (element: HTMLElement | null) => void>,
    [],
  );

  // The history keeps one entry for an open sidebar: opening it from the board adds one,
  // which Back and Close both take away; swapping what it shows replaces it.
  const pushed = useRef(false);
  const refocus = useRef<RunningKey | null>(null);
  useEffect(() => {
    if (!asked) pushed.current = false;
  }, [asked]);
  const select = (key: RunningKey | null, how: 'push' | 'replace') => {
    const next = new URLSearchParams(params);
    if (key) next.set('key', key);
    else next.delete('key');
    if (how === 'push') pushed.current = true;
    setParams(next, { replace: how === 'replace' });
  };
  // A key another node absorbed opens that node, in place of the address that named it.
  const absorber = data && asked ? absorberOf(data, asked) : undefined;
  const redirect = absorber && absorber.key !== asked ? absorber.key : undefined;
  useEffect(() => {
    if (redirect) select(redirect, 'replace');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirect]);
  // The sidebar waits for the board, which says whether its key is another's alias.
  const target = asked && !redirect && (data || board.error) ? asked : null;
  const selected = target && absorber ? absorber.key : null;
  const close = () => {
    refocus.current = target;
    if (pushed.current) {
      pushed.current = false;
      navigate(-1);
    } else select(null, 'replace');
  };
  // Closing hands the cursor back to the card that was open, or to the board it stood on.
  useEffect(() => {
    const key = refocus.current;
    if (asked || !key) return;
    refocus.current = null;
    const cards = [...(graph.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])];
    (cards.find((card) => card.dataset.key === key) ?? graph.current)?.focus();
  }, [asked]);
  // Escape closes the sidebar wherever the cursor is — except inside a guard, where it
  // means Cancel and has already been taken.
  const closing = useRef(close);
  closing.current = close;
  useEffect(() => {
    if (!asked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const from = event.target as Element | null;
      if (from?.closest?.('.guard, input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      closing.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [asked]);
  const onSelect = (key: RunningKey) => {
    if (key === selected) close();
    else select(key, asked ? 'replace' : 'push');
  };

  const layout = data ? runningLayout(data, width, { heads: headsOf(data, heads, now) }) : null;
  const order =
    layout?.order ?? LANES.flatMap((lane) => data?.lanes[lane].nodes.map((node) => node.key) ?? []);
  const focus = selected ?? hover;
  const lit = data && focus ? related(data, focus) : null;
  const reading = { now, nameOf };
  const kinds = !!data && kindsMix(data);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).closest?.<HTMLElement>('[data-key]')?.dataset.key;
    const index = current ? order.indexOf(current) : -1;
    const step = (delta: number) =>
      order[index < 0 ? (delta > 0 ? 0 : order.length - 1) : index + delta];
    let next: RunningKey | undefined;
    if (event.key === 'ArrowRight' || event.key === 'j') next = step(1);
    else if (event.key === 'ArrowLeft' || event.key === 'k') next = step(-1);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const down = event.key === 'ArrowDown';
      next = layout && current ? beneath(layout, current, down) : step(down ? 1 : -1);
    } else return;
    event.preventDefault();
    if (!next) return;
    [...(graph.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])]
      .find((card) => card.dataset.key === next)
      ?.focus();
  };

  const empty =
    !!data &&
    LANES.every(
      (lane) =>
        !data.lanes[lane].nodes.length &&
        !data.lanes[lane].pending &&
        !data.lanes[lane].failed.length,
    );
  const summaries = data ? LANES.flatMap((lane) => data.lanes[lane].summaries) : [];
  const titles = useMemo(
    () =>
      new Map(
        LANES.flatMap(
          (lane) => data?.lanes[lane].nodes.map((node) => [node.key, node.title]) ?? [],
        ),
      ),
    [data],
  );
  const card = (node: RunningNode, box?: RunningBox & { top: number }) => (
    <Card
      key={node.key}
      node={node}
      kinds={kinds}
      now={now}
      selected={node.key === selected}
      dim={!!lit && !lit.has(node.key) && !needs(node)}
      box={box}
      className={box ? 'running-node' : 'running-row'}
      reading={reading}
      onSelect={onSelect}
      onHover={(key) => setHover((old) => key ?? (old === node.key ? null : old))}
    >
      {!box && data && <Relations node={node} board={data} titles={titles} />}
    </Card>
  );

  return (
    <Reading.Provider value={{ now, nameOf, open: (key) => select(key, 'replace') }}>
      <div className="page-stage running">
        {data && board.error && <LoadState {...board} />}
        {data && !board.error && now.stale && board.loadedAt && (
          <p className="muted agent-help" role="status">
            Showing the state that loaded <Ago at={board.loadedAt} />.
          </p>
        )}
        <div className="running-plane" data-open={target ? '' : undefined}>
          <section className="running-board" hidden={!!target && !roomy}>
            {!data ? (
              <LoadState {...board} columns={3} />
            ) : empty ? (
              <EmptyState
                kind="running"
                title="Nothing is running"
                hint={
                  summaries.length > 0 && (
                    <>
                      {summaries.map((summary, index) => (
                        <span
                          key={index}
                          className={cx(
                            summary.attention && !summary.attention.quiet && 'running-attn',
                          )}
                        >
                          {index > 0 && ' · '}
                          <Phrase value={summary.attention?.says ?? summary.says} />
                        </span>
                      ))}
                    </>
                  )
                }
                action={
                  summaries.some((summary) => summary.actions.length) && (
                    <>
                      {summaries.flatMap((summary) =>
                        summary.actions.map((action) => (
                          <Act key={`${action.tool}:${action.label}`} action={action} />
                        )),
                      )}
                    </>
                  )
                }
              />
            ) : null}
            <div
              className={cx('running-graph', !layout && 'running-graph--stacked')}
              ref={graph}
              tabIndex={0}
              role="group"
              aria-label="Running"
              hidden={!data || empty}
              onKeyDown={onKeyDown}
              style={layout ? { height: layout.height } : undefined}
            >
              {data && !empty && layout
                ? layout.bands.map((band) => (
                    <section
                      className="running-band"
                      key={band.lane}
                      aria-labelledby={`running-${band.lane}`}
                      style={{ top: band.top, height: band.height }}
                    >
                      <div
                        className="running-band-head"
                        data-lane={band.lane}
                        ref={headRef[band.lane]}
                      >
                        <BandHead lane={data.lanes[band.lane]} name={band.lane} now={now} />
                      </div>
                      {data.lanes[band.lane].nodes.map((node) => {
                        const box = layout.at.get(node.key);
                        return box ? card(node, { ...box, top: band.top }) : null;
                      })}
                      {layout.ghosts
                        .filter((ghost) => ghost.lane === band.lane)
                        .map((ghost, index) => (
                          <span
                            className="running-ghost"
                            key={index}
                            aria-hidden="true"
                            style={{
                              left: ghost.x,
                              top: ghost.y - band.top,
                              width: ghost.w,
                              height: ghost.h,
                            }}
                          />
                        ))}
                    </section>
                  ))
                : data &&
                  !empty &&
                  LANES.map((lane) => (
                    <section
                      className="running-lane"
                      key={lane}
                      aria-labelledby={`running-${lane}`}
                    >
                      <div className="running-band-head">
                        <BandHead lane={data.lanes[lane]} name={lane} now={now} />
                      </div>
                      {data.lanes[lane].pending && !data.lanes[lane].nodes.length ? (
                        <LoadState loading />
                      ) : (
                        data.lanes[lane].nodes.length > 0 && (
                          <ul className="running-rows">
                            {data.lanes[lane].nodes.map((node) => (
                              <li key={node.key}>{card(node)}</li>
                            ))}
                          </ul>
                        )
                      )}
                    </section>
                  ))}
              {data && !empty && layout && <Links layout={layout} board={data} lit={lit} />}
            </div>
          </section>
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
                nameOf={nameOf}
                open={(key) => select(key, 'replace')}
              />
            )}
          </aside>
        </div>
      </div>
    </Reading.Provider>
  );
}

/** The heights of the band headings: as measured, or one line and its notes until then. */
function headsOf(
  board: RunningBoard,
  measured: Partial<Record<RunningLaneName, number>>,
  now: Clock,
): Partial<Record<RunningLaneName, number>> {
  return Object.fromEntries(
    LANES.map((lane) => {
      const notes =
        Number(board.lanes[lane].failed.length > 0) + Number(staleLane(board.lanes[lane], now));
      return [lane, measured[lane] || HEAD + notes * NOTE];
    }),
  );
}

/** The card straight below (or above) this one: the nearest row that way, nearest across. */
function beneath(layout: RunningLayout, key: RunningKey, down: boolean): RunningKey | undefined {
  const from = layout.at.get(key);
  if (!from) return undefined;
  const centre = (box: RunningBox) => box.x + box.w / 2;
  const candidates = layout.order
    .map((other) => ({ key: other, box: layout.at.get(other)! }))
    .filter(({ box }) => (down ? box.y > from.y : box.y < from.y));
  if (!candidates.length) return undefined;
  const row = down
    ? Math.min(...candidates.map(({ box }) => box.y))
    : Math.max(...candidates.map(({ box }) => box.y));
  return candidates
    .filter(({ box }) => box.y === row)
    .sort(
      (a, b) => Math.abs(centre(a.box) - centre(from)) - Math.abs(centre(b.box) - centre(from)),
    )[0]?.key;
}

/** The row's view: names are read the one way every page reads them, for operators only. */
export const RunningView = (_: ViewProps) => <RunningPage nameOf={useActorNames()} />;
