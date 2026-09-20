import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ProcessGraph, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import { KindLabel, StatusPill, cx, kindStyle, words } from './components';
import type { WorkflowShape } from './shell-types';

/**
 * A workflow drawn as the machine it is: its working states left to right in the order
 * the program's own edges reach them, then one end. The end is where the record stops,
 * whichever way it stops: it reads as the program's own finish until the record has
 * ended, and as the state it ended in after that. The track between states is the way
 * forward; every way back is an arc over the track, landing on the state it returns to.
 * Where the record stands is the filled node, what is behind it is tinted, a state it
 * has left and may reach again is ringed, what it never reached is an outline. Nothing
 * here is authored: the states and edges are the deployed definition, and the marks
 * are the record's own.
 */

/** One node of the drawing, and what the record says about it. */
export interface Step {
  state: string;
  end: boolean;
  /** The record ended some other way than the program's own finish. */
  stopped: boolean;
  current: boolean;
  entered: boolean;
}
/** One line of the drawing, between two nodes by position; `taken` once the record has. */
export interface Way {
  from: number;
  to: number;
  taken: boolean;
}
export interface Diagram {
  steps: Step[];
  ways: Way[];
}
type Mark = { state: string; terminal: boolean; current: boolean; entered: boolean };
type Edge = { from: string; to: string; traversals?: unknown[] };

/**
 * Every end of a program is one node. Its finish is the end the fewest states lead
 * to; an end every working state can fall into (abandoned, failed) is a way out, and a
 * way out is drawn only once the record has taken it, as the name the end then carries.
 * Staying in a state is not a move, so an edge from a state to itself is not drawn.
 */
function diagram(marks: Mark[], edges: Edge[]): Diagram {
  const working = marks.filter((mark) => !mark.terminal);
  const ends = marks.filter((mark) => mark.terminal);
  const ways = (end: string) =>
    new Set(edges.filter((edge) => edge.to === end).map((edge) => edge.from)).size;
  const finish = [...ends].sort((a, b) => ways(a.state) - ways(b.state))[0];
  const reached = ends.find((mark) => mark.current) ?? ends.find((mark) => mark.entered);
  const at = new Map(working.map((mark, index) => [mark.state, index]));
  if (finish) at.set(finish.state, working.length);
  const pairs = new Map<string, Way>();
  for (const edge of edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const way = pairs.get(`${from}>${to}`) ?? { from, to, taken: false };
    way.taken ||= !!edge.traversals?.length;
    pairs.set(`${from}>${to}`, way);
  }
  return {
    steps: [
      ...working.map(({ state, current, entered }) => ({
        state,
        end: false,
        stopped: false,
        current,
        entered,
      })),
      ...(finish
        ? [
            {
              state: (reached ?? finish).state,
              end: true,
              stopped: !!reached && reached !== finish,
              current: !!reached?.current,
              entered: !!reached,
            },
          ]
        : []),
    ],
    ways: [...pairs.values()],
  };
}

/** The reading order a process graph already carries, with the record's own marks. */
export const diagramOfGraph = (graph: ProcessGraph): Diagram =>
  diagram(
    graph.nodes.map((node) => ({
      state: node.state,
      terminal: node.terminal,
      current: node.current,
      entered: !!node.firstEnteredAt,
    })),
    graph.edges,
  );

/**
 * The same walk for a record read from a list, which carries its state but no history:
 * forward from the initial state through the definition's own edges. Everything before
 * where it stands counts as behind it, and a record at its finish has everything behind
 * it; one that ended another way says nothing about how far it got.
 */
export function diagramOfShape(shape: WorkflowShape, state: string): Diagram {
  const walk = [shape.initial];
  for (let index = 0; index < walk.length; index++)
    for (const edge of shape.edges)
      if (edge.from === walk[index] && !walk.includes(edge.to)) walk.push(edge.to);
  const states = [...walk, ...shape.states.filter((item) => !walk.includes(item))];
  const drawn = diagram(
    states.map((item) => ({
      state: item,
      terminal: shape.terminal.includes(item),
      current: item === state,
      entered: item === state,
    })),
    shape.edges,
  );
  const here = drawn.steps.findIndex((step) => step.current);
  const behind = here >= 0 && !drawn.steps[here]!.stopped;
  return {
    ...drawn,
    steps: drawn.steps.map((step, index) => ({
      ...step,
      entered: step.entered || (behind && index < here),
    })),
  };
}

const CAP = 3.5;
/** The corner of a bracket. */
const TURN = 8;
/** A label character at the label's size and tracking, measured generously. */
const CHAR = 7;

export function ProcessDiagram({
  steps,
  ways,
  kind,
  compact,
}: Diagram & { kind?: string; compact?: boolean }) {
  const tip = useId().replaceAll(':', '');
  if (steps.length < 2) return null;
  const names = steps.map((step) => words(step.state));
  const r = compact ? 3 : 6;
  const last = steps.length - 1;
  // A label keeps one line where the stride between two nodes holds it, and breaks by word
  // where it does not. The first and last labels sit flush with the drawing's own edges,
  // so the stride also has to keep each of them clear of its neighbour.
  const stride = Math.max(
    96,
    ...names.flatMap((name) => name.split(' ')).map((word) => word.length * CHAR + 28),
  );
  const labels = names.map((name) =>
    name.length * CHAR <= stride - 12 ? [name] : name.split(' '),
  );
  const wide = (index: number) => Math.max(...labels[index]!.map((line) => line.length)) * CHAR;
  const flush =
    last === 1
      ? wide(0) + wide(1)
      : Math.max(wide(0) + wide(1) / 2, wide(last) + wide(last - 1) / 2);
  const gap = compact ? 13 : Math.max(stride, flush + 14 - r);
  const x = (index: number) => r + 1 + index * gap;
  const here = steps.findIndex((step) => step.current);
  // The track is each step to the next; anything longer, forward or back, is a bracket
  // over it: up from its node, across, and straight down onto the node it reaches. The
  // further a way reaches the higher it runs, so a long way back clears a short one,
  // and the ways the record has taken are drawn last, over the ones it has not.
  const arcs = compact
    ? []
    : ways
        .filter((way) => way.to !== way.from + 1)
        .sort((a, b) => Number(a.taken) - Number(b.taken));
  const reach = [...new Set(arcs.map((way) => Math.abs(way.to - way.from)))].sort((a, b) => a - b);
  const lift = (way: Way) => 18 + reach.indexOf(Math.abs(way.to - way.from)) * 10;
  const row = r + Math.max(compact ? 2 : 6, ...arcs.map((way) => lift(way) + 2));
  const edge = (index: number) => r + (steps[index]!.end && !compact ? CAP : 0);
  const width = x(last) + edge(last) + 1;
  const height = compact
    ? row + r + 2
    : row + r + 18 + 11 * Math.max(...labels.map((label) => label.length));
  return (
    <svg
      className={cx('pd', compact && 'pd--compact')}
      style={kindStyle(kind)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={steps
        .map((step) => words(step.state) + (step.current ? ' (here)' : ''))
        .join(' → ')}
    >
      <defs>
        {['', 'taken'].map((tone) => (
          <marker
            key={tone}
            id={tip + tone}
            className={cx('pd-tip', tone && 'pd-tip--taken')}
            markerUnits="userSpaceOnUse"
            markerWidth="8"
            markerHeight="8"
            refX="6.5"
            refY="4"
            orient="auto"
          >
            <path d="M0.5,0.5 L7.5,4 L0.5,7.5 z" />
          </marker>
        ))}
      </defs>
      {ways
        .filter((way) => way.to === way.from + 1)
        .map((way) => (
          <path
            key={way.from}
            className={cx(
              'pd-track',
              steps[way.from]!.entered &&
                steps[way.to]!.entered &&
                way.to <= here &&
                'pd-track--behind',
            )}
            d={`M${x(way.from) + edge(way.from) + 2},${row} L${x(way.to) - edge(way.to) - 2},${row}`}
          />
        ))}
      {arcs.map((way) => {
        const top = row - r - lift(way);
        const turn = way.to < way.from ? -TURN : TURN;
        return (
          <path
            key={`${way.from}>${way.to}`}
            className={cx('pd-arc', way.taken && 'pd-arc--taken')}
            markerEnd={`url(#${tip}${way.taken ? 'taken' : ''})`}
            d={
              `M${x(way.from)},${row - edge(way.from) - 2} V${top + TURN} ` +
              `Q${x(way.from)},${top} ${x(way.from) + turn},${top} H${x(way.to) - turn} ` +
              `Q${x(way.to)},${top} ${x(way.to)},${top + TURN} V${row - edge(way.to) - 3}`
            }
          />
        );
      })}
      {steps.map((step, index) => (
        <g
          key={step.state}
          className={cx(
            'pd-node',
            step.current && (step.stopped ? 'pd-node--stopped' : 'pd-node--here'),
            !step.current && step.entered && (index < here ? 'pd-node--behind' : 'pd-node--left'),
          )}
        >
          {step.current && !step.end && !compact && (
            <circle className="pd-halo" cx={x(index)} cy={row} r={r + 5} />
          )}
          {step.end && !compact && <circle className="pd-cap" cx={x(index)} cy={row} r={r + CAP} />}
          <circle className="pd-dot" cx={x(index)} cy={row} r={step.end && compact ? r + 1 : r} />
          {compact ? (
            <title>{words(step.state)}</title>
          ) : (
            // The first and last labels sit flush with the drawing's own edges, so the
            // diagram holds the page's column on both sides.
            <text y={row + r + 17} textAnchor={index === 0 ? 'start' : step.end ? 'end' : 'middle'}>
              {labels[index]!.map((word, line) => (
                <tspan
                  key={line}
                  x={index === 0 ? 0 : step.end ? width : x(index)}
                  dy={line ? 11 : 0}
                >
                  {word}
                </tspan>
              ))}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** The same machine on a row: dots on a track, no labels, the state word on hover. */
export function RowDiagram({
  shapes,
  workflow,
  kind,
}: {
  shapes: WorkflowShape[] | undefined;
  workflow: { workflow?: string; version?: number; state: string };
  kind?: string;
}) {
  // The shape a record stands in, by the program it names; unknown draws nothing.
  const shape = shapes?.find(
    (item) =>
      item.name === workflow.workflow &&
      (workflow.version === undefined || item.version === workflow.version),
  );
  if (!shape) return null;
  return <ProcessDiagram {...diagramOfShape(shape, workflow.state)} kind={kind} compact />;
}

/** The view kind a workflow's records are read under, which is also the route they open at. */
const PLACE: Record<string, string> = {
  task: 'tasks',
  experiment: 'experiments',
  research: 'research',
  reflection: 'reflections',
  consolidation: 'consolidation',
};

/**
 * A record another one waits on, or holds up, on one line: its kind, its name as the
 * way to it, and the state it stands at. The state is the whole of the outcome — what
 * has succeeded, ended or is still moving says so in its own word and colour.
 */
export function Dependency({ item }: { item: WorkflowDependency }) {
  const place = PLACE[item.workflow];
  return (
    <p className="cluster">
      <KindLabel kind={place ?? item.workflow} />
      {place ? <Link to={`/${place}/${item.id}`}>{item.name}</Link> : item.name}
      <StatusPill value={item.state} />
    </p>
  );
}

/** One side of a record's relations — what it waits on, what it unblocks — or nothing. */
export function Relations({ title, items }: { title: string; items: WorkflowDependency[] }) {
  if (!items.length) return null;
  return (
    <>
      <h3 className="ev-role">{title}</h3>
      {items.map((item) => (
        <Dependency key={item.id} item={item} />
      ))}
    </>
  );
}

/**
 * The gate as the machine it is: the workflow drawn where the record stands in it, the
 * one control that moves it beside the drawing, and each unsettled prerequisite by name.
 * A blocker is an instruction to the agent holding the tool, so none is printed here.
 */
export function Gate({
  graph,
  kind,
  children,
}: {
  graph?: ProcessGraph;
  kind?: string;
  children?: ReactNode;
}) {
  return (
    <div className="stack">
      {graph && <ProcessDiagram {...diagramOfGraph(graph)} kind={kind} />}
      {graph?.dependencies
        .filter((item) => item.direction === 'depends_on' && (!item.settled || item.failed))
        .map((item) => (
          <Dependency key={item.id} item={item} />
        ))}
      {children}
    </div>
  );
}
