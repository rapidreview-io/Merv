import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { StatusPill, cx, kindStyle, words } from './components';
import type { WorkflowShape } from './shell-types';

/**
 * A workflow drawn as the machine it is: its states left to right in the order the
 * program's own edges reach them, terminal states last and capped, forward arrows
 * between them and a curved arrow beneath for every edge that goes back. Where the
 * record stands is the filled node, what it has passed is filled muted, what it has
 * not reached is an outline. Nothing here is authored: the states and edges are the
 * deployed definition, and the marks are the record's own.
 */

/** One state of the walk, and what the record says about it. */
export interface Step {
  state: string;
  terminal: boolean;
  current: boolean;
  entered: boolean;
}
type Edge = { from: string; to: string };

/** The reading order a process graph already carries, with its own marks. */
export const stepsOfGraph = (graph: ProcessGraph): Step[] =>
  graph.nodes.map((node) => ({
    state: node.state,
    terminal: node.terminal,
    current: node.current,
    entered: !!node.firstEnteredAt,
  }));

/**
 * The same walk for a record read from a list, which carries its state but no
 * history: forward from the initial state through the definition's own edges, ends
 * last, and everything before where it stands counted as passed.
 */
export function stepsOfShape(shape: WorkflowShape, state: string): Step[] {
  const walk = [shape.initial];
  for (let index = 0; index < walk.length; index++)
    for (const edge of shape.edges)
      if (edge.from === walk[index] && !walk.includes(edge.to)) walk.push(edge.to);
  const ordered = [...walk, ...shape.states.filter((item) => !walk.includes(item))];
  const states = [
    ...ordered.filter((item) => !shape.terminal.includes(item)),
    ...ordered.filter((item) => shape.terminal.includes(item)),
  ];
  const here = states.indexOf(state);
  return states.map((item, index) => ({
    state: item,
    terminal: shape.terminal.includes(item),
    current: item === state,
    entered: here >= 0 && index < here,
  }));
}

/** The shape a record stands in, by the program it names; unknown draws nothing. */
export const shapeOf = (
  shapes: WorkflowShape[] | undefined,
  workflow: string | undefined,
  version: number | undefined,
) =>
  workflow === undefined
    ? undefined
    : (shapes ?? []).find(
        (shape) => shape.name === workflow && (version === undefined || shape.version === version),
      );

const R = 7;
const GAP = 84;
const PAD = 14;
const ROW = 16;

export function ProcessDiagram({
  steps,
  edges,
  kind,
  compact,
}: {
  steps: Step[];
  edges: Edge[];
  kind?: string;
  compact?: boolean;
}) {
  const arrow = useId().replaceAll(':', '');
  if (steps.length < 2) return null;
  const at = new Map(steps.map((step, index) => [step.state, index]));
  const r = compact ? 4 : R;
  const gap = compact ? 16 : GAP;
  const pad = compact ? r + 1 : PAD;
  const row = compact ? r + 1 : ROW;
  // One line per pair, whichever action drew it: a diagram states where a record can
  // go, never how many ways there are of going there.
  const pairs = [
    ...new Map(
      edges
        .filter((edge) => at.has(edge.from) && at.has(edge.to))
        .map((edge) => [`${edge.from}>${edge.to}`, edge]),
    ).values(),
  ];
  const back = pairs.filter((edge) => at.get(edge.to)! <= at.get(edge.from)!);
  const x = (index: number) => pad + index * gap;
  const width = pad * 2 + (steps.length - 1) * gap;
  const height = row + r + (compact ? 1 : 30) + (back.length && !compact ? 14 : 0);
  return (
    <svg
      className={cx('pd', compact && 'pd--compact')}
      style={kindStyle(kind)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={steps.map((step) => words(step.state)).join(' → ')}
    >
      <defs>
        <marker
          id={arrow}
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L6,3 L0,6 z" />
        </marker>
      </defs>
      {pairs.map((edge) => {
        const from = at.get(edge.from)!;
        const to = at.get(edge.to)!;
        const going = to > from;
        // A way back leaves and returns under the row; a way back to the same state
        // still has two ends, so it leaves one side of the node and returns the other.
        const loop = from === to ? r : 0;
        const dip = row + r + (compact ? 8 : 20);
        return (
          <path
            key={`${edge.from}>${edge.to}`}
            className={cx('pd-edge', !going && 'pd-edge--back')}
            markerEnd={`url(#${arrow})`}
            d={
              going
                ? `M${x(from) + r + 2},${row} L${x(to) - r - 4},${row}`
                : `M${x(from) + loop},${row + r} Q${(x(from) + x(to)) / 2},${dip} ${x(to) - loop},${row + r + 1}`
            }
          />
        );
      })}
      {steps.map((step, index) => (
        <g
          key={step.state}
          className={cx(
            'pd-node',
            step.current && 'pd-node--here',
            !step.current && step.entered && 'pd-node--passed',
          )}
        >
          <circle cx={x(index)} cy={row} r={r} />
          {step.terminal && <circle className="pd-cap" cx={x(index)} cy={row} r={r + 3} />}
          {compact ? (
            <title>{words(step.state)}</title>
          ) : (
            <text x={x(index)} y={row + r + 13} textAnchor="middle">
              {words(step.state)
                .split(' ')
                .map((word, line) => (
                  <tspan key={word} x={x(index)} dy={line ? 11 : 0}>
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

/** The diagram a record page draws: its own graph, marked where it stands. */
export const RecordDiagram = ({ graph, kind }: { graph: ProcessGraph; kind?: string }) => (
  <ProcessDiagram steps={stepsOfGraph(graph)} edges={graph.edges} kind={kind} />
);

/** The same machine on a row: dots on a line, no labels, the state word on hover. */
export function RowDiagram({
  shapes,
  workflow,
  kind,
}: {
  shapes: WorkflowShape[] | undefined;
  workflow: { workflow?: string; version?: number; state: string };
  kind?: string;
}) {
  const shape = shapeOf(shapes, workflow.workflow, workflow.version);
  if (!shape) return null;
  return (
    <ProcessDiagram
      steps={stepsOfShape(shape, workflow.state)}
      edges={shape.edges}
      kind={kind}
      compact
    />
  );
}

/**
 * The gate as the machine it is: the workflow drawn where the record stands in it,
 * the one control that moves it beside the drawing, one blocker line only where the
 * person can answer it, and an unsettled prerequisite named in the server's own words.
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
  const asks = graph?.nodes
    .find((node) => node.current)
    ?.blockers.find((blocker) => blocker.code === 'input_required');
  return (
    <div className="stack">
      {graph && <RecordDiagram graph={graph} kind={kind} />}
      {asks && <p className="muted">{asks.message}</p>}
      {graph?.dependencies
        .filter((item) => item.direction === 'depends_on' && (!item.settled || item.failed))
        .map((item) => (
          <p className="muted" key={item.id}>
            {['task', 'experiment'].includes(item.workflow) ? (
              <Link to={`/${item.workflow === 'task' ? 'tasks' : 'experiments'}/${item.id}`}>
                {item.name}
              </Link>
            ) : (
              item.name
            )}{' '}
            <StatusPill value={item.state} />
          </p>
        ))}
      {children}
    </div>
  );
}
