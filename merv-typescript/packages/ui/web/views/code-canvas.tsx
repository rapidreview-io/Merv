import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KindLabel, StatusPill, cx, kindOf, kindStyle, toneOf, words } from '../components';
import { ArrowRightIcon } from '../icons';
import { MAIN, relationsOf, type GitEdge, type GitLane, type GitModel } from './code-model';

/**
 * The Git canvas: main as a trunk across the top, one lane per unit of work beneath
 * it, a square where accepted commits were merged into a base, and a ring for every
 * publication. Plain SVG placed from one measured width and one pure layout, so
 * there is no canvas library, no minimap and nothing draggable — and the manners are
 * the map's own, so the app gains no second grammar for a second drawing.
 *
 * Columns are a topological rank rather than a clock: a merge this server made is
 * stamped with a fixed author date so that a repeat is byte-identical, and a base
 * keeps only when it was last touched, so no honest merge timeline exists in the
 * data and none is drawn. Below 900px `canvas()` answers null and the same model is
 * stacked as a list, where each node says in words what the lines would have said.
 */

/** Under this there is no room for a lane and its label, so nothing is placed. */
const NARROW = 900;
/** The label column, held at its width so the drawing takes every pixel past it. */
const LABEL = 320;
const TRUNK_Y = 56;
const ROW = 76;
/** The room a lane leaves after the point it was cut from, and its elbow's radius. */
const CUT = 32;
const ELBOW = 20;
/** A diffstat is printed only where the next one is far enough away to read it. */
const STAT_GAP = 56;

interface Point {
  x: number;
  y: number;
}
export type CanvasLayout = NonNullable<ReturnType<typeof canvas>>;

/**
 * Where everything goes, from the model and one width. Pure: two runs of the same
 * model place the same drawing, whatever the clock says.
 */
export function canvas(model: GitModel, width: number) {
  if (width < NARROW || !model.lanes.length) return null;
  const x0 = LABEL + 40;
  const deepest = Math.max(1, ...model.ranks.values());
  // The column is the width divided by the depth, so the deepest rank lands against the
  // right edge at every screen; the floor is what keeps a deep graph legible on a narrow one.
  const column = Math.max(110, (width - x0 - 48) / deepest);
  const at = new Map<string, Point>();
  for (const node of model.nodes)
    at.set(node.id, {
      x: x0 + (model.ranks.get(node.id) ?? 0) * column,
      y: TRUNK_Y + node.row * ROW,
    });

  const lanes = model.lanes.map((lane) => {
    const here = at.get(lane.id)!;
    const from = at.get(lane.from) ?? { x: x0, y: TRUNK_Y };
    const start = Math.min(from.x + CUT, here.x);
    const run = Math.max(here.x - start, 0);
    let printed = -Infinity;
    const dots = lane.stops.map((stop, index) => {
      const x = lane.stops.length > 1 ? start + (run * index) / (lane.stops.length - 1) : here.x;
      const stat = !!stop.stat && x - printed >= STAT_GAP;
      if (stat) printed = x;
      return { x, add: stop.stat?.add ?? 0, del: stop.stat?.del ?? 0, stat, title: stop.title };
    });
    // A lane always runs to its own node, so that a lane with nothing committed on it yet
    // still reaches the point every edge that names it is drawn to.
    const end = dots[dots.length - 1]?.x ?? here.x;
    const held = lane.mirrored < dots.length ? (dots[lane.mirrored - 1]?.x ?? start) : null;
    return {
      id: lane.id,
      y: here.y,
      // A lane drops from the point it was cut from; one cut from something on its own
      // row or below simply runs from there, rather than drawing a riser upwards.
      path:
        from.y <= here.y - ELBOW
          ? `M ${from.x},${from.y} V ${here.y - ELBOW} q 0,${ELBOW} ${ELBOW},${ELBOW} H ${end}`
          : `M ${from.x},${here.y} H ${end}`,
      hollow: held === null ? null : `M ${held},${here.y} H ${end}`,
      dots,
      tip: { x: end, kind: lane.tip },
    };
  });

  const edges = model.edges.flatMap((edge) => {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (!a || !b) return [];
    // A publication merged into the trunk rises to it where the ring itself stands,
    // so the mark it leaves on main is the commit it merged at.
    const to = edge.to === MAIN ? { x: a.x, y: TRUNK_Y } : b;
    const middle = (a.x + to.x) / 2;
    const d =
      edge.to === MAIN
        ? `M ${a.x},${a.y} V ${to.y}`
        : `M ${a.x},${a.y} C ${middle},${a.y} ${middle},${to.y} ${to.x},${to.y}`;
    return [{ edge, d, x: middle, y: (a.y + to.y) / 2 - 7 }];
  });

  const reached = edges.flatMap((line) => (line.edge.to === MAIN ? [line.x] : []));
  // Merv can name main at the commit every lane was cut from it, so the trunk is solid
  // that far even where nothing has been merged back into it yet.
  const named = model.lanes.some((lane) => lane.from === MAIN) ? x0 + CUT : x0;
  return {
    width,
    height: Math.max(...model.nodes.map((node) => TRUNK_Y + node.row * ROW)) + 48,
    trunk: { y: TRUNK_Y, x0, solid: Math.max(named, ...reached), end: width - 2 },
    at,
    lanes,
    edges,
  };
}

/** The tones the stylesheet already carries, reached through a compound state word. */
const tone = (state: string | undefined) => {
  const value = (state ?? '').toLowerCase();
  const direct = toneOf(value);
  return direct !== 'neutral' ? direct : toneOf(value.split(/[ _]/).pop() ?? '');
};
const CHAR = 7.3;
const clip = (text: string) => {
  const most = Math.max(6, Math.floor((LABEL - 16) / CHAR));
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
};

/**
 * The drawing, placed from one measured width. Hovering or selecting a node lights
 * its edges and its neighbours and dims the rest, the keyboard walks the rows, and
 * Enter opens the record a lane belongs to — the map's grammar, on a DAG.
 */
export function BranchCanvas({ model }: { model: GitModel }) {
  const navigate = useNavigate();
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const g = width ? canvas(model, width) : null;
  if (!g) return <div ref={frame}>{width ? <BranchList model={model} /> : null}</div>;

  const focus = hover ?? selected;
  const near = new Set(focus ? [focus] : []);
  for (const edge of model.edges) {
    if (edge.from === focus) near.add(edge.to);
    if (edge.to === focus) near.add(edge.from);
  }
  const rank = (id: string) => model.ranks.get(id) ?? 0;
  const walk = [...model.nodes].sort(
    (a, b) => a.row - b.row || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id),
  );
  const MOVES: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const node = walk.find((item) => item.id === selected);
    const move = MOVES[event.key];
    if (event.key === 'Escape') setSelected(null);
    else if (event.key === 'Enter' && node?.to) navigate(node.to);
    else if (move !== undefined) {
      const index = walk.findIndex((item) => item.id === selected);
      setSelected(walk[Math.min(walk.length - 1, Math.max(0, index + move))]?.id ?? null);
    } else return;
    event.preventDefault();
  };
  /** One node's own group, dimmed unless it is what the reader is looking at. */
  const group = (id: string, colour: string, children: ReactNode) => (
    <g
      key={id}
      className={cx('bg-node', selected === id && 'on', focus && !near.has(id) && 'dim')}
      style={kindStyle(colour)}
      onMouseEnter={() => setHover(id)}
      onMouseLeave={() => setHover((held) => (held === id ? null : held))}
      onClick={() => setSelected((held) => (held === id ? null : id))}
    >
      {children}
    </g>
  );
  const trunk = g.trunk;
  const nodeOf = (id: string) => model.nodes.find((node) => node.id === id)!;
  return (
    <div
      ref={frame}
      tabIndex={0}
      role="group"
      aria-label="Branches"
      className="branch-frame"
      onKeyDown={onKeyDown}
    >
      <svg viewBox={`0 0 ${g.width} ${g.height}`} className="branch-graph">
        <path className="bg-trunk" d={`M ${trunk.x0},${trunk.y} H ${trunk.solid}`} />
        {/* Past the last commit Merv can name the trunk is a dash: the base branch has
            history this process never read, and the drawing says so rather than invent it. */}
        <path
          className="bg-trunk bg-trunk--beyond"
          d={`M ${trunk.solid},${trunk.y} H ${trunk.end}`}
        />
        <text className="bg-ref" x={8} y={trunk.y + 4}>
          {nodeOf(MAIN).name}
        </text>
        {g.edges.map(({ edge, d, x, y }) => {
          const on = !!focus && (edge.from === focus || edge.to === focus);
          return (
            <g
              key={`${edge.from}|${edge.to}|${edge.verb}`}
              className={cx(
                'bg-edge',
                edge.dashed && 'bg-edge--waiting',
                edge.refusal && 'bg-edge--refusal',
                on && 'on',
                focus && !on && 'dim',
              )}
            >
              <path d={d} />
              {/* An edge's verb is written in the gap only while an end of it is held. */}
              {on && (
                <text x={x} y={y} textAnchor="middle">
                  {edge.verb}
                </text>
              )}
            </g>
          );
        })}
        {g.lanes.map((lane) => {
          const node = nodeOf(lane.id);
          const word = model.word.get(lane.id);
          return group(
            lane.id,
            node.colour,
            <>
              <path className="bg-lane" d={lane.path} />
              {lane.hollow && <path className="bg-lane bg-lane--hollow" d={lane.hollow} />}
              <text className="bg-kind" x={8} y={lane.y - 16}>
                {kindOf(node.colour).label.toUpperCase()}
              </text>
              <text className="bg-name" x={8} y={lane.y + 4}>
                {clip(node.name)}
                <title>{node.name}</title>
              </text>
              <text className={cx('bg-meta', `status--${tone(word)}`)} x={8} y={lane.y + 23}>
                ● {words(word ?? '').toUpperCase()}
              </text>
              {lane.dots.map((dot) => (
                <g key={dot.x}>
                  {dot.stat && (
                    <text className="bg-stat" x={dot.x} y={lane.y - 12}>
                      <tspan className="add">+{dot.add}</tspan>{' '}
                      <tspan className="del">−{dot.del}</tspan>
                    </text>
                  )}
                  <circle className="bg-dot" cx={dot.x} cy={lane.y} r={4}>
                    <title>{dot.title}</title>
                  </circle>
                </g>
              ))}
              {lane.tip.kind === 'accepted' && (
                <rect
                  className={cx('bg-accepted', node.hollow && 'bg-hollow')}
                  x={lane.tip.x - 5}
                  y={lane.y - 5}
                  width={10}
                  height={10}
                />
              )}
              {lane.tip.kind === 'head' && (
                <circle
                  className={cx('bg-dot', 'bg-dot--tip', node.hollow && 'bg-hollow')}
                  cx={lane.tip.x}
                  cy={lane.y}
                  r={4.5}
                />
              )}
            </>,
          );
        })}
        {model.nodes
          .filter((node) => node.kind === 'base' || node.kind === 'publication')
          .map((node) => {
            const { x, y } = g.at.get(node.id)!;
            const word = model.word.get(node.id);
            return group(
              node.id,
              node.colour,
              node.kind === 'base' ? (
                <>
                  {/* A base is where lanes meet and never a line that runs, so it is a mark. */}
                  <rect
                    className={cx('bg-merge', node.hollow && 'bg-hollow')}
                    x={x - 7}
                    y={y - 7}
                    width={14}
                    height={14}
                    transform={`rotate(45 ${x} ${y})`}
                  />
                  <text
                    className={cx('bg-mark', `status--${tone(word)}`)}
                    x={x}
                    y={y + 24}
                    textAnchor="middle"
                  >
                    {words(word ?? '').toUpperCase()}
                  </text>
                </>
              ) : (
                <circle
                  className={cx('bg-ring', node.hollow && 'bg-ring--refusal')}
                  cx={x}
                  cy={y}
                  r={7}
                >
                  <title>{node.name}</title>
                </circle>
              ),
            );
          })}
      </svg>
    </div>
  );
}

/**
 * The same model where there is no room to draw it: one row per node, each saying
 * in words what the lines would have said. It is the map's stacked fallback, so a
 * phone reads the graph rather than being told there is one.
 */
export function BranchList({ model }: { model: GitModel }) {
  const relations = relationsOf(model);
  return (
    <div className="plane map-graph map-graph--stacked" role="group" aria-label="Branches">
      {[...model.nodes]
        .sort((a, b) => a.row - b.row)
        .map((node) => {
          // What is drawn hollow wears the refusal here instead, so the two readings say
          // the same thing about the one fact nothing may be built on again.
          const className = cx('map-node', node.hollow && 'code-refused');
          const body = (
            <>
              <KindLabel kind={node.colour} />
              <span className="map-node-name">{node.name}</span>
              <span className="map-node-foot">
                <StatusPill value={model.word.get(node.id) ?? null} />
              </span>
              {(relations.get(node.id) ?? []).map((said) => (
                <span className="map-rel" key={said}>
                  <ArrowRightIcon size={12} />
                  {said}
                </span>
              ))}
            </>
          );
          return node.to ? (
            <Link className={className} key={node.id} to={node.to} style={kindStyle(node.colour)}>
              {body}
            </Link>
          ) : (
            <div className={className} key={node.id} style={kindStyle(node.colour)}>
              {body}
            </div>
          );
        })}
    </div>
  );
}
