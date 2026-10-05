import type { ProcessGraph, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { KindLabel, StatusPill, cx, toneOf, useNow, words } from './components';
import { elapsed } from './liveness';
import { useRows } from './navigation';
import type { WorkflowShape } from './shell-types';

/**
 * A workflow read as its stages: its working states in the order the program's own edges
 * reach them, then one end. The end is where the record stops, whichever way it stops: it
 * reads as the program's own finish until the record has ended, and as the state it ended
 * in after that. Each stage is one mark and one word, the way Linear says a status, and
 * where the record's history is at hand, how long it stood there. Nothing here is authored:
 * the states and edges are the deployed definition, and the marks are the record's own.
 */

/** One stage, and what the record says about it. */
export interface Step {
  state: string;
  end: boolean;
  /** The record ended some other way than the program's own finish. */
  stopped: boolean;
  current: boolean;
  entered: boolean;
}
type Mark = { state: string; terminal: boolean; current: boolean; entered: boolean };

/**
 * Every end of a program is one stage. Its finish is the end the fewest states lead to; an
 * end every working state can fall into (abandoned, failed) is a way out, and a way out is
 * said only once the record has taken it, as the name the end then carries.
 */
function stages(marks: Mark[], edges: { from: string; to: string }[]): Step[] {
  const ends = marks.filter((mark) => mark.terminal);
  const ways = (end: string) =>
    new Set(edges.filter((edge) => edge.to === end).map((edge) => edge.from)).size;
  const finish = [...ends].sort((a, b) => ways(a.state) - ways(b.state))[0];
  const reached = ends.find((mark) => mark.current) ?? ends.find((mark) => mark.entered);
  return [
    ...marks
      .filter((mark) => !mark.terminal)
      .map(({ state, current, entered }) => ({
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
  ];
}

/** The reading order a process graph already carries, with the record's own marks. */
export const stagesOfGraph = (graph: ProcessGraph): Step[] =>
  stages(
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
export function stagesOfShape(shape: WorkflowShape, state: string): Step[] {
  const walk = [shape.initial];
  for (let index = 0; index < walk.length; index++)
    for (const edge of shape.edges)
      if (edge.from === walk[index] && !walk.includes(edge.to)) walk.push(edge.to);
  const steps = stages(
    [...walk, ...shape.states.filter((item) => !walk.includes(item))].map((item) => ({
      state: item,
      terminal: shape.terminal.includes(item),
      current: item === state,
      entered: item === state,
    })),
    shape.edges,
  );
  const here = steps.findIndex((step) => step.current);
  const behind = here >= 0 && !steps[here]!.stopped;
  return steps.map((step, index) => ({
    ...step,
    entered: step.entered || (behind && index < here),
  }));
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
  return shape ? stagesOfShape(shape, workflow.state) : [];
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
  const steps = graph ? stagesOfGraph(graph) : stepsOf(shapes, workflow);
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
 * Time in status: one card, a row for each stage top to bottom — the mark, the word, and
 * how long the record stood there where that is known. The one it stands in is in ink; what
 * it has been through is quieter; what it never reached is a grey ring.
 */
export function TimeInStatus({ steps, spent }: { steps: Step[]; spent?: Map<string, number> }) {
  return (
    <section className="stage-card" aria-label="Time in status">
      <p className="stage-card-title">Time in status</p>
      <ol className="stages">
        {steps.map((step, at) => (
          <li
            key={step.state}
            className={cx('stage', step.current && 'stage--here', !step.entered && 'stage--ahead')}
            aria-current={step.current ? 'step' : undefined}
          >
            <StageGlyph steps={steps} at={at} size={18} ahead={!step.entered} />
            <span className="stage-word">{words(step.state)}</span>
            {spent?.has(step.state) && (
              <span className="stage-time tabular">{elapsed(spent.get(step.state)!)}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A record's own stages as it met them, from its recorded crossings. */
export function StageList({ graph }: { graph: ProcessGraph }) {
  return (
    <TimeInStatus
      steps={stagesOfGraph(graph)}
      spent={stageTimes(graph, useNow(graph.terminal ? 0 : 30_000))}
    />
  );
}

/**
 * A record another one waits on, or holds up, on one line: its kind, its name as the
 * way to it, and the state it stands at. The state is the whole of the outcome — what
 * has succeeded, ended or is still moving says so in its own word and colour.
 */
export function Dependency({ item }: { item: WorkflowDependency }) {
  // Its page, and the kind it is read as, are the row's that lists its workflow, as on the
  // Running page's sidebars.
  const row = useRows().find((entry) => entry.workflow === item.workflow);
  const route = row && `${row.path}/${encodeURIComponent(item.id)}`;
  return (
    <p className="cluster">
      <KindLabel kind={row?.view.kind ?? item.workflow} />
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
 * The gate a record stands at: its stages with where it is among them, each unsettled
 * prerequisite by name, and the one control that moves it. A blocker is an instruction to
 * the agent holding the tool, so none is printed here.
 */
export function Gate({ graph, children }: { graph?: ProcessGraph; children?: ReactNode }) {
  return (
    <div className="stack">
      {graph && <StageList graph={graph} />}
      {graph?.dependencies
        .filter((item) => item.direction === 'depends_on' && (!item.settled || item.failed))
        .map((item) => (
          <Dependency key={item.id} item={item} />
        ))}
      {children}
    </div>
  );
}
