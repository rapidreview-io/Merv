import { workRoute } from '@merv/contracts/running';
import type { ProcessGraph, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { KindLabel, StatusPill, cx, kindStyle, toneOf, useNow, words } from './components';
import { elapsed } from './liveness';
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

/**
 * How long the record stood in each state, in milliseconds, from its recorded crossings:
 * the start opens the initial state, each crossing closes one state and opens the next,
 * and the state it stands in is still open at `now`. Staying in a state is no crossing,
 * and a state left within a second of entering it has no time to say.
 */
export function stageTimes(graph: ProcessGraph, now: number): Map<string, number> {
  const first = graph.nodes.find((node) => node.initial);
  const crossings = graph.edges
    .filter((edge) => edge.from !== edge.to)
    .flatMap((edge) =>
      edge.traversals.map(({ at, revision }) => ({ at: Date.parse(at), revision, to: edge.to })),
    )
    .sort((a, b) => a.revision - b.revision);
  const spent = new Map<string, number>();
  let state = first?.state;
  let since = Date.parse(first?.firstEnteredAt ?? '');
  const leave = (at: number) => {
    if (state !== undefined && at > since) spent.set(state, (spent.get(state) ?? 0) + at - since);
  };
  for (const crossing of crossings) {
    leave(crossing.at);
    [state, since] = [crossing.to, crossing.at];
  }
  leave(now);
  return new Map([...spent].filter(([, ms]) => ms >= 1000));
}

/**
 * How a stage is coloured, the way Linear colours a status: by what kind of standing it is,
 * never by which program it belongs to. Not begun is grey, work is yellow, a review is
 * orange, what is running is green, the finish is indigo; an end the record took another
 * way is grey, or the refusal's red where it failed.
 */
type Hue = 'idle' | 'work' | 'review' | 'live' | 'done' | 'bad' | 'off';
const IDLE = ['planned', 'queued', 'requested', 'pending', 'draft'];
const hueOf = (step: Step): Hue =>
  step.end
    ? !step.stopped
      ? 'done'
      : toneOf(step.state) === 'bad'
        ? 'bad'
        : 'off'
    : IDLE.includes(step.state)
      ? 'idle'
      : step.state.includes('review')
        ? 'review'
        : toneOf(step.state) === 'ok'
          ? 'live'
          : 'work';

/**
 * A stage's mark: a ring, with a pie inside it filled as far round as the stage is along
 * the work its program does — empty before any of it has begun, a filled disc with a check
 * at the finish, one with a cross where the record ended another way. A stage the record
 * has not reached (`ahead`) is the empty grey ring whatever it will be.
 */
function StageGlyph({
  steps,
  at,
  size = 14,
  ahead,
}: {
  steps: Step[];
  at: number;
  size?: number;
  ahead?: boolean;
}) {
  const step = steps[at]!;
  const hue = ahead ? 'idle' : hueOf(step);
  const begun = steps.filter((item) => !item.end && hueOf(item) !== 'idle');
  const turn = ((begun.indexOf(step) + 1) / (begun.length + 1)) * 2 * Math.PI;
  return (
    <svg
      className={`stage-glyph stage-glyph--${hue}`}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      {step.end && !ahead ? (
        <>
          <circle className="stage-fill" cx="7" cy="7" r="6.5" />
          <path
            className="stage-sign"
            d={step.stopped ? 'M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2' : 'M4.2 7.3 6.2 9.2 9.9 5.1'}
          />
        </>
      ) : (
        <>
          <circle className="stage-ring" cx="7" cy="7" r="5.75" />
          {hue !== 'idle' && (
            <path
              className="stage-fill"
              d={`M7 7V3.5A3.5 3.5 0 ${turn > Math.PI ? 1 : 0} 1 ${7 + 3.5 * Math.sin(turn)} ${7 - 3.5 * Math.cos(turn)}Z`}
            />
          )}
        </>
      )}
    </svg>
  );
}

/** Where a record read from a list stands: the program it names, and its state. */
type Standing = { workflow?: string; version?: number; state: string };
/** That program's steps with the record's place marked; none for a program with no shape here. */
function stepsOf(shapes: WorkflowShape[] | undefined, workflow: Standing): Step[] {
  const shape = shapes?.find(
    (item) =>
      item.name === workflow.workflow &&
      (workflow.version === undefined || item.version === workflow.version),
  );
  return shape ? diagramOfShape(shape, workflow.state).steps : [];
}
/**
 * A state said beside a name, the one way everywhere: its mark in the stage's colour, then
 * its word in plain ink. The stages come from the record's own graph where the page holds
 * it, and otherwise from the deployed shape of its program; a program this build has no
 * shape for keeps a dot in the tone the state's pill wears.
 */
export function StageMark({
  shapes,
  graph,
  workflow,
}: {
  shapes?: WorkflowShape[];
  graph?: ProcessGraph;
  workflow: Standing;
}) {
  const steps = graph ? diagramOfGraph(graph).steps : stepsOf(shapes, workflow);
  const at = steps.findIndex((step) => step.current);
  return (
    <span className="stage-mark">
      {at < 0 ? (
        <span
          className={cx('status-dot', `status--${toneOf(workflow.state)}`)}
          aria-hidden="true"
        />
      ) : (
        <StageGlyph steps={steps} at={at} />
      )}
      <span className="stage-word">{words(workflow.state)}</span>
    </span>
  );
}

/**
 * Time in status: every state of the program, top to bottom, as the record met it — the
 * mark, the word, and how long it stood there. The one it stands in is in ink; what it has
 * been through is quieter; what it never reached is a grey ring.
 */
export function StageList({ graph }: { graph: ProcessGraph }) {
  const { steps } = diagramOfGraph(graph);
  const spent = stageTimes(graph, useNow(graph.terminal ? 0 : 30_000));
  return (
    <ol className="stages">
      {steps.map((step, at) => (
        <li
          key={step.state}
          className={cx('stage', step.current && 'stage--here', !step.entered && 'stage--ahead')}
          aria-current={step.current ? 'step' : undefined}
        >
          <StageGlyph steps={steps} at={at} size={18} ahead={!step.entered} />
          <span className="stage-word">{words(step.state)}</span>
          {spent.has(step.state) && (
            <span className="stage-time tabular">{elapsed(spent.get(step.state)!)}</span>
          )}
        </li>
      ))}
    </ol>
  );
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
  times,
}: Diagram & {
  kind?: string;
  /** How long the record stood in each state, by state; said under the state's name. */
  times?: Map<string, number>;
}) {
  const tip = useId().replaceAll(':', '');
  if (steps.length < 2) return null;
  const names = steps.map((step) => words(step.state));
  const r = 6;
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
  const gap = Math.max(stride, flush + 14 - r);
  const x = (index: number) => r + 1 + index * gap;
  const here = steps.findIndex((step) => step.current);
  // The track is each step to the next; anything longer, forward or back, is a bracket
  // over it: up from its node, across, and straight down onto the node it reaches. The
  // further a way reaches the higher it runs, so a long way back clears a short one,
  // and the ways the record has taken are drawn last, over the ones it has not.
  const arcs = ways
    .filter((way) => way.to !== way.from + 1)
    .sort((a, b) => Number(a.taken) - Number(b.taken));
  const reach = [...new Set(arcs.map((way) => Math.abs(way.to - way.from)))].sort((a, b) => a - b);
  const lift = (way: Way) => 18 + reach.indexOf(Math.abs(way.to - way.from)) * 10;
  const row = r + Math.max(6, ...arcs.map((way) => lift(way) + 2));
  const edge = (index: number) => r + (steps[index]!.end ? CAP : 0);
  const width = x(last) + edge(last) + 1;
  const height =
    row + r + 18 + 11 * (Math.max(...labels.map((label) => label.length)) + +!!times?.size);
  return (
    <svg
      className="pd"
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
          {step.current && !step.end && (
            <circle className="pd-halo" cx={x(index)} cy={row} r={r + 5} />
          )}
          {step.end && <circle className="pd-cap" cx={x(index)} cy={row} r={r + CAP} />}
          <circle className="pd-dot" cx={x(index)} cy={row} r={r} />
          {/* The first and last labels sit flush with the drawing's own edges, so the
              diagram holds the page's column on both sides. */}
          <text y={row + r + 17} textAnchor={index === 0 ? 'start' : step.end ? 'end' : 'middle'}>
            {[
              ...labels[index]!,
              ...(times?.has(step.state) ? [elapsed(times.get(step.state)!)] : []),
            ].map((word, line) => (
              <tspan
                key={line}
                className={cx(line >= labels[index]!.length && 'pd-time')}
                x={index === 0 ? 0 : step.end ? width : x(index)}
                dy={line ? 11 : 0}
              >
                {word}
              </tspan>
            ))}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * The view kind a workflow's records are read under. The page each opens at is the shared
 * contract's (`workRoute`), so a relation on a record and one in a Running sidebar go to
 * the same place.
 */
const PLACE: Record<string, string> = {
  task: 'tasks',
  experiment: 'experiments',
  research: 'research',
  reflection: 'reflections',
};

/**
 * A record another one waits on, or holds up, on one line: its kind, its name as the
 * way to it, and the state it stands at. The state is the whole of the outcome — what
 * has succeeded, ended or is still moving says so in its own word and colour.
 */
export function Dependency({ item }: { item: WorkflowDependency }) {
  const route = workRoute(item.workflow, item.id);
  return (
    <p className="cluster">
      <KindLabel kind={PLACE[item.workflow] ?? item.workflow} />
      {route ? <Link to={route}>{item.name}</Link> : item.name}
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
  // The page's own clock, ticking only while the record can still move.
  const now = useNow(graph && !graph.terminal ? 30_000 : 0);
  return (
    <div className="stack">
      {graph && (
        <ProcessDiagram {...diagramOfGraph(graph)} kind={kind} times={stageTimes(graph, now)} />
      )}
      {graph?.dependencies
        .filter((item) => item.direction === 'depends_on' && (!item.settled || item.failed))
        .map((item) => (
          <Dependency key={item.id} item={item} />
        ))}
      {children}
    </div>
  );
}
