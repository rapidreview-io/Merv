import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ResearchAnswer, ResearchRecord } from '@merv/research/models';
import type { WorkflowDecision } from '@merv/workflows/models';
import { ApiError, refreshTools, useTool } from '../api';
import { useCommand } from '../mutations';
import { Ago, Failure, Field, PageHeader, StatusPill, Submit, cx, words } from '../components';
import { Chips, ListPage, useListFilter } from '../list-filters';
import { RecordPicker, type Pickable } from '../record-picker';
import { useSession, writes } from '../session';
import { firstSentence } from '@merv/contracts/text';
import { currentReview } from '@merv/reviews/rules';
import { OPEN, ThreeStates, reviewClause } from '../states';
import type { ShellData, WorkflowShape } from '../shell-types';
import { Dependency, StageMark, ended } from '../process';
import { ArrowRightIcon } from '../icons';
import { newest, useHome, type Flow, type MapCycle } from './map-data';
import { ResearchCommand } from './paper';
import { useActorNames } from './people';
import { CreateReflection } from './research-programs';
import type { Task } from '@merv/tasks/models';
import { LiveLines, LiveUnder, WorkMap, WorkPlane, type Wave } from './work-map';

/**
 * The wave of work the project is on, in one page: the cycle that frames it in
 * the header with its one move, and under it every task and experiment as one
 * list. Reviews are not rows here — a row's review clause is the way to its
 * verdict — and a row opens its record at that record's own route, beside this
 * list on a wide screen. Nothing on this page is composed by the browser: the
 * cycle names the work it depends on and the rest is each record's own standing.
 */

/** The tab that narrows nothing: every kind of work the wave holds. */
const ALL = 'all';

/** One row of the wave, whichever kind of record it is. */
interface Item {
  id: string;
  kind: 'tasks' | 'experiments' | 'reflections';
  name: string;
  to: string;
  state: string;
  flow: Flow;
  /** Workflows' word for the record's end, where its owner sends one. */
  end?: { settled: boolean; failed: boolean };
  at: string;
  mine: boolean;
  outcome: string | null;
  named: boolean;
  labels: (string | undefined)[];
  owner: string;
  /** How far down its chain the item stands: 0 waits on nothing this list holds. */
  depth: number;
  /** The prerequisites it still waits on, by name. */
  waits: string[];
}

/**
 * The list as the chains it is made of. Every dependency has a task at one end — a task
 * waits on tasks and experiments, an experiment only on tasks — so the task list's own
 * `dependencies` and `dependents` are every edge there is, with no second read. A chain
 * leads with whatever waits on nothing; what follows stands under the last thing it waits
 * on, one step in, and chains are ordered by their most recent movement.
 */
export function chained<T extends { id: string; at: string }>(
  items: T[],
  tasks: (Pick<Task, 'id' | 'dependencies' | 'dependents'> & {
    title?: string;
    settled?: boolean;
  })[],
): (T & { depth: number; waits: string[] })[] {
  const known = new Map(items.map((item) => [item.id, item]));
  const after = new Map<string, Set<string>>();
  const before = new Map<string, Set<string>>();
  const waits = new Map<string, string[]>();
  const edge = (first: string, then: string) => {
    if (!known.has(first) || !known.has(then) || first === then) return;
    (after.get(first) ?? after.set(first, new Set()).get(first)!).add(then);
    (before.get(then) ?? before.set(then, new Set()).get(then)!).add(first);
  };
  for (const task of tasks) {
    for (const on of task.dependencies ?? []) {
      edge(on.id, task.id);
      if (!on.settled) waits.set(task.id, [...(waits.get(task.id) ?? []), on.name]);
    }
    // What follows a task waits on it until the task is done; the task list says that of
    // the task itself, which is how an experiment's wait is known without reading it.
    for (const next of task.dependents ?? []) {
      edge(task.id, next.id);
      if (task.title && task.settled === false)
        waits.set(next.id, [...(waits.get(next.id) ?? []), task.title]);
    }
  }
  // A chain is as recent as the newest thing in it, so a finished first step does not
  // sink the work still moving behind it.
  const recent = new Map<string, string>();
  const reach = (id: string, seen = new Set<string>()): string => {
    if (recent.has(id)) return recent.get(id)!;
    if (seen.has(id)) return known.get(id)!.at;
    seen.add(id);
    let at = known.get(id)!.at;
    for (const next of after.get(id) ?? []) {
      const theirs = reach(next, seen);
      if (theirs > at) at = theirs;
    }
    recent.set(id, at);
    return at;
  };
  const byRecent = (ids: Iterable<string>) =>
    [...ids].sort((a, b) => reach(b).localeCompare(reach(a)));
  const depth = new Map<string, number>();
  const out: (T & { depth: number; waits: string[] })[] = [];
  const place = (id: string, at: number) => {
    if (depth.has(id)) return;
    // What waits on several things stands under the last of them to be placed.
    if ([...(before.get(id) ?? [])].some((first) => !depth.has(first))) return;
    depth.set(id, at);
    out.push({ ...known.get(id)!, depth: at, waits: [...new Set(waits.get(id))] });
    for (const next of byRecent(after.get(id) ?? []))
      place(
        next,
        Math.max(...[...(before.get(next) ?? [])].map((first) => depth.get(first) ?? 0)) + 1,
      );
  };
  for (const id of byRecent(items.filter((item) => !before.get(item.id)?.size).map((i) => i.id)))
    place(id, 0);
  // A cycle among dependencies cannot be stored, but a list must never lose a row to one.
  for (const item of items)
    if (!depth.has(item.id)) {
      depth.set(item.id, 0);
      out.push({ ...item, depth: 0, waits: [...new Set(waits.get(item.id))] });
    }
  return out;
}

/** The cycle the project is on: the newest one still running, else the newest. */
export const currentCycle = <T extends MapCycle>(
  cycles: T[] | undefined,
  shapes: WorkflowShape[] | undefined,
) => {
  const all = newest(cycles ?? [], (cycle) => cycle.workflow.updatedAt);
  return all.find((cycle) => !ended(shapes, cycle.workflow)) ?? all[0];
};

interface Listed {
  id: string;
  workflow: { state: string };
}
/**
 * The work a new cycle may wait on: every task and experiment of the project, failed ones
 * too. The server takes any workflow of the project as a prerequisite; these two lists are
 * the ones this page is made of, and the same two reads it has already made.
 */
function useWorkPicks(): { options: Pickable[]; loading: boolean } {
  const tasks = useTool<(Listed & { title: string })[]>('task.list');
  const experiments = useTool<(Listed & { name: string })[]>('experiment.list');
  const pick = (kind: string, item: Listed, name: string): Pickable => ({
    id: item.id,
    name,
    kind,
    state: item.workflow.state,
  });
  return {
    options: [
      ...(tasks.data ?? []).map((item) => pick('tasks', item, item.title)),
      ...(experiments.data ?? []).map((item) => pick('experiments', item, item.name)),
    ],
    loading: tasks.loading || experiments.loading,
  };
}

export function CreateResearch({
  onSaved,
  follows,
}: {
  onSaved: () => void;
  /** The ended cycle on screen, which a cycle started beside it follows. */
  follows?: { id: string; name: string };
}) {
  const [name, setName] = useState('');
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [automatic, setAutomatic] = useState(false);
  const [maxCycles, setMaxCycles] = useState('10');
  // What a cycle may wait on is the work this page lists, chosen by name.
  const work = useWorkPicks();
  const command = useCommand<ResearchRecord>({
    tool: 'research.create',
    validate: (value) =>
      !!value && typeof value.id === 'string' && value.workflow?.workflow === 'research',
    onSuccess: () => {
      setName('');
      setDependencies([]);
      // What the new cycle asks of the reader counts on the rail at once.
      refreshTools('ui.home');
      onSaved();
    },
  });
  return (
    <form
      className="card stack entry-form"
      onSubmit={(event) => {
        event.preventDefault();
        void command.submit({
          name,
          dependsOn: dependencies,
          ...(follows ? { previousCycleId: follows.id } : {}),
          ...(automatic ? { automatic: true, maxCycles: Number(maxCycles) } : {}),
        });
      }}
    >
      <h2>New cycle</h2>
      {follows && <p className="muted">Follows {follows.name}</p>}
      <fieldset disabled={command.locked}>
        <Field label="Name" required maxLength={200} value={name} onChange={setName} />
        <RecordPicker
          label="Work in this wave"
          {...work}
          value={dependencies}
          onChange={setDependencies}
        />
        <label>
          <input
            type="checkbox"
            checked={automatic}
            onChange={(event) => setAutomatic(event.target.checked)}
          />
          Continue automatically through reviewed research waves
        </label>
        {automatic && (
          <label>
            Maximum cycles
            <input
              type="number"
              min="1"
              max="100"
              required
              value={maxCycles}
              onChange={(event) => setMaxCycles(event.target.value)}
            />
          </label>
        )}
      </fieldset>
      <Failure message={command.error} />
      <div>
        <Submit busy={command.busy} retry={command.retry} disabled={!name.trim()} />
      </div>
    </form>
  );
}

/**
 * The list the wave is made of. It is the same list wherever it is mounted: the
 * Work page, and the left pane of every record it opens, so a record's siblings
 * stay on screen beside it. On the Work page the same records are drawn as the map, under
 * the same row that narrows them, and are listed only where there is no room to draw.
 */
function WaveList({ shell }: { shell: ShellData }) {
  const [chosen, setChosen] = useState<string>();
  const { actor } = useSession();
  const nameOf = useActorNames();
  const [kind, setKind] = useState<string>(ALL);
  const rowOf = (view: string) => shell.rows.find((row) => row.view.kind === view);
  const tasksRow = rowOf('tasks');
  const experimentsRow = rowOf('experiments');
  const cyclesRow = rowOf('research');
  const wavesRow = rowOf('reflections');
  const reviewsPath = rowOf('reviews')?.path;
  // Every list the wave is made of is the one home read the rail polls, each part under its
  // row's id; review clauses move with the record beside the list, so it is read as often.
  const home = useHome(8000);
  const { tasks, experiments, reviews, research: cycles, reflections: waves } = home.data ?? {};
  const all = newest(cycles ?? [], (item) => item.workflow.updatedAt);
  const navigate = useNavigate();
  // The cycle the head shows is the one the narrowing means.
  const cycle =
    cycles?.find((item) => item.id === chosen) ??
    currentCycle(cycles ?? undefined, shell.workflows);
  // The work the cycle itself names: its own prerequisites, and nothing inferred.
  const inCycle = new Set(cycle?.researchDependencies);
  const items: Item[] = chained(
    [
      ...(tasks ?? []).map((task): Item => ({
        id: task.id,
        kind: 'tasks',
        name: task.title,
        to: `${tasksRow!.path}/${task.id}`,
        state: task.workflow.state,
        flow: task.workflow,
        end: task,
        at: task.workflow.updatedAt,
        mine: task.producerId === actor.id,
        outcome: task.failure?.reason ?? null,
        named: inCycle.has(task.id),
        labels: [task.title, task.goal, nameOf(task.producerId)],
        owner: task.producerId,
        depth: 0,
        waits: [],
      })),
      ...(experiments ?? []).map((item): Item => ({
        id: item.id,
        kind: 'experiments',
        name: item.name,
        to: `${experimentsRow!.path}/${item.id}`,
        state: item.workflow.state,
        flow: item.workflow,
        end: item,
        at: item.workflow.updatedAt,
        mine: item.ownerId === actor.id,
        outcome: item.conclusion,
        named: inCycle.has(item.id),
        labels: [item.name, item.intent, nameOf(item.ownerId)],
        owner: item.ownerId,
        depth: 0,
        waits: [],
      })),
      // A reflection is a unit of the wave like the work it reflects on.
      ...(waves ?? []).map((wave): Item => ({
        id: wave.id,
        kind: 'reflections',
        name: wave.title,
        to: `${wavesRow!.path}/${wave.id}`,
        state: wave.workflow.state,
        flow: wave.workflow,
        at: wave.workflow.updatedAt,
        mine: wave.ownerId === actor.id,
        outcome: `${wave.lenses.filter((lens) => lens.artifact).length} of ${wave.lenses.length} lenses written`,
        named: cycle?.reflectionId === wave.id,
        labels: [wave.title, nameOf(wave.ownerId)],
        owner: wave.ownerId,
        depth: 0,
        waits: [],
      })),
    ],
    tasks ?? [],
  );
  const under = (of: string) => (item: Item) =>
    of === ALL || (of === 'cycle' ? item.named : item.kind === of);
  const filter = useListFilter(items, {
    stateOf: (item) => item.state,
    // Open work: in no program's end state, as the deployed shapes declare them.
    isOpen: (state) => !shell.workflows?.some((shape) => shape.terminal.includes(state)),
    mine: (item) => item.mine,
    labels: (item) => item.labels,
    ids: (item) => [item.id, item.owner],
    also: under(kind),
  });
  // The first narrowing: which kind of work, and the work this cycle itself names. A tab
  // with nothing under it is not drawn, unless it is the one in force and so the way back;
  // and where only one of them holds anything there is nothing to choose between. Which
  // tabs there are is read from the whole wave, so they stand still; the number on each
  // is what pressing it would show under the search, the scope and the state in force.
  const narrowings = (
    [
      ['tasks', 'Tasks'],
      ['experiments', 'Experiments'],
      ['reflections', 'Reflections'],
      ['cycle', 'In this cycle'],
    ] as const
  ).filter(([value]) => items.some(under(value)) || kind === value);
  // One read makes the list, and a failure that leaves rows on screen degrades to a line
  // rather than blanking them. A list whose row is here but whose part did not answer is a
  // failure too: its records would otherwise vanish without a word.
  const unread = (['tasks', 'experiments', 'research', 'reflections'] as const).filter(
    (kind) => rowOf(kind) && home.data?.[kind] === null,
  );
  const load = {
    loading: !items.length && home.loading,
    error:
      home.error ??
      (unread.length
        ? new ApiError('unavailable', `Could not read ${unread.join(', ')}`, 503)
        : undefined),
    data: items.length ? items : undefined,
    loadedAt: home.loadedAt,
  };
  // Where the map is drawn it is the page's one view of the work, and no row is listed under it.
  const [drawn, setDrawn] = useState(true);
  // One step in for each thing the row waits behind, on the name and on the line under it.
  const step = (item: Item) => ({ '--depth': item.depth }) as CSSProperties;
  // What the map draws, and every line between two of them, each said once by the task at one
  // end of it. As the page opens that is every record still open or named by the cycle, with
  // what the board holds in flight; once the page is narrowed it is the kept rows and no other.
  const only =
    filter.state !== OPEN || !!filter.query || filter.scope !== 'everyone' || kind !== ALL;
  const kept = new Set(filter.rows);
  const read: Wave = {
    only,
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      flow: item.flow,
      at: item.at,
      held: only ? kept.has(item) : !ended(shell.workflows, item.flow, item.end) || item.named,
    })),
    edges: (tasks ?? []).flatMap((task) => [
      ...(task.dependencies ?? []).map((on) => ({
        from: on.id,
        to: task.id,
        waiting: !on.settled,
      })),
      ...(task.dependents ?? []).map((next) => ({
        from: task.id,
        to: next.id,
        waiting: !task.settled,
      })),
    ]),
  };
  // The same wave read again is the same wave, so the map is not worked out again on each poll.
  const same = JSON.stringify(read);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wave = useMemo(() => read, [same]);
  return (
    <ListPage
      load={load}
      // The cycle stands where every other page's title line stands, its one move beside
      // it, and after that the one word that narrows the map and the one that starts work.
      lede={(ends) => <CycleHead shell={shell} cycle={cycle} onSaved={home.reload} ends={ends} />}
      reset={
        only || chosen
          ? () => {
              filter.reset();
              setKind(ALL);
              setChosen(undefined);
            }
          : undefined
      }
      drawn={
        <div className="wmap-stage">
          <WorkMap shapes={shell.workflows} wave={wave} onDrawn={setDrawn} />
          <LiveUnder agents={shell.rows.find((row) => row.view.kind === 'sessions')?.path} />
        </div>
      }
      listed={!drawn}
      noun="work"
      kind="work"
      placeholder="Name, question or person"
      filter={{
        ...filter,
        filtering: filter.filtering || kind !== ALL,
        clear() {
          filter.clear();
          setKind(ALL);
        },
      }}
      narrow={
        <>
          {all.length > 1 && (
            <Chips
              label="Research cycle"
              options={all.map((item) => ({
                value: item.id,
                label: item.name,
                count: words(item.workflow.state),
              }))}
              value={cycle!.id}
              onChange={setChosen}
            />
          )}
          {narrowings.length > 1 && (
            <Chips
              label="Kind of work"
              options={[[ALL, 'All'] as const, ...narrowings].map(([value, label]) => ({
                value,
                label,
                count: filter.tabbed.filter(under(value)).length,
              }))}
              value={kind}
              onChange={setKind}
            />
          )}
        </>
      }
      emptyTitle="No work yet"
      create={
        // Under its own tab the thing to start is a reflection; anywhere else, a cycle.
        kind === 'reflections'
          ? {
              label: 'New reflection',
              shown: writes(actor),
              form: () => (
                <CreateReflection onCreated={(wave) => navigate(`${wavesRow!.path}/${wave.id}`)} />
              ),
            }
          : cyclesRow && {
              label: 'New cycle',
              shown: writes(actor),
              form: (close) => (
                <CreateResearch
                  follows={
                    cycle && !cycle.successorId && ended(shell.workflows, cycle.workflow)
                      ? { id: cycle.id, name: cycle.name }
                      : undefined
                  }
                  onSaved={() => {
                    close();
                    home.reload();
                  }}
                />
              ),
            }
      }
      line={(item) => {
        const review = currentReview(reviews ?? undefined, item.id);
        const said = reviewClause(review, nameOf(review?.reviewerId));
        const who = nameOf(item.owner);
        return {
          kind: item.kind,
          name: (
            <span className="chain" style={step(item)}>
              {item.depth > 0 && <span className="chain-elbow" aria-hidden="true" />}
              <Link
                className={cx('row-link', item.id === filter.openId && 'row-open')}
                to={item.to}
              >
                <strong>{item.name}</strong>
              </Link>
            </span>
          ),
          standing: (
            <div className="chain chain--under" style={step(item)}>
              <ThreeStates
                stage={<StageMark shapes={shell.workflows} workflow={item.flow} />}
                // A review is a record of its own, so the clause is the way to its verdict.
                review={
                  said && review && reviewsPath
                    ? { ...said, to: `${reviewsPath}/${review.id}` }
                    : (said ?? undefined)
                }
                outcome={
                  firstSentence(item.outcome) ? { detail: firstSentence(item.outcome) } : undefined
                }
                meta={
                  <>
                    {who && `${who} · `}
                    <Ago at={item.at} />
                  </>
                }
              />
              {/* A line of its own: in the narrow pane it would crowd the owner and the time. */}
              {item.waits.length > 0 && (
                <p className="chain-waits">Waits on {item.waits.join(', ')}</p>
              )}
              {/* Who is on it and where, each the way to that agent's or machine's sidebar. */}
              <LiveLines id={item.id} />
            </div>
          ),
        };
      }}
    />
  );
}

/**
 * A cycle's one move, here and on its own page, as the cycle's own gate has it. A move the
 * gate refuses is not offered as a button that can only fail: it stands disabled over the
 * records it waits on — unless the page already `listed` them. Where the gate asks for an
 * answer, refuses for a reason or stops an automatic run, the page draws the moves Research
 * names for it on its Cycles row (`ResearchAnswer`). An ended cycle has only those it still
 * stops on.
 */
export function CycleMove({
  cycle,
  shell,
  listed = false,
  onSaved,
}: {
  cycle: MapCycle;
  shell: ShellData;
  listed?: boolean;
  onSaved(): void;
}) {
  const open = !ended(shell.workflows, cycle.workflow);
  const read = useTool<WorkflowDecision>(
    open ? 'workflow.status_and_next' : null,
    { instanceId: cycle.id },
    { every: 10000 },
  ).data;
  // A gate read at another revision is not this cycle's, and leaves the plain move.
  const gate = read?.revision === cycle.workflow.revision ? read : undefined;
  const advance = gate?.actions.find((action) => action.tool === 'research.advance');
  const refused = (code: string) => !!advance?.blockers.some((item) => item.code === code);
  const row = (kind: string) => shell.rows.find((item) => item.view.kind === kind);
  const offered = (tool: string) =>
    !!gate?.actions.some((item) => item.tool === tool && item.status !== 'blocked');
  const automatic = cycle.automation;
  // An answer applies where the gate says so, and only if the page can make each of its moves.
  // An ended cycle has no gate: only what it still asks, as Research names it, has moves.
  const applies = ({ when, name, moves }: ResearchAnswer) =>
    (when === 'stopped'
      ? automatic?.blocker?.code === name
      : open &&
        (when === 'asks' ? advance?.requiredInput.includes(name) : refused(name)) &&
        (!automatic || moves.every((item) => item.row))) &&
    moves.every((item) => (item.row ? row(item.row) : !item.tool || !open || offered(item.tool)));
  const answer = (row('research')?.view.answers as ResearchAnswer[] | undefined)?.find(applies);
  const move = (
    label: string,
    choice: Record<string, unknown> = {},
    disabled = false,
    tool = 'research.advance',
  ) => (
    <ResearchCommand
      key={label}
      disabled={disabled}
      tool={tool}
      input={{ researchId: cycle.id, expectedRevision: cycle.workflow.revision, ...choice }}
      label={label}
      onSaved={() => {
        onSaved();
        refreshTools('ui.home', 'workflow.status_and_next');
      }}
    />
  );
  const moves = answer?.moves.map((item) =>
    item.row ? (
      <Link key={item.label} className="btn" to={row(item.row)!.path}>
        {item.label} <ArrowRightIcon size={14} />
      </Link>
    ) : (
      move(item.label, item.input, false, item.tool)
    ),
  );
  if (!open)
    return answer ? (
      <div className="stack">
        <span>{automatic!.blocker!.message}</span>
        {moves}
      </div>
    ) : null;
  // A move that answers failed work stands under it.
  const failed = answer?.moves.find((item) => item.failed)?.failed;
  if (answer && answer.when !== 'stopped')
    return (
      <div className={failed ? 'stack' : 'cluster'}>
        {!listed &&
          gate?.dependencies
            .filter((item) => item.failed && item.workflow === failed)
            .map((item) => <Dependency key={item.id} item={item} />)}
        {moves}
      </div>
    );
  if (automatic)
    return (
      <div className="stack">
        <span>
          Automatic · cycle {automatic.cycle} of {automatic.maxCycles}
        </span>
        {automatic.blocker && <span>{automatic.blocker.message}</span>}
        {moves}
        {move(
          'Stop automatic research',
          {
            outcome: 'abandoned',
            reason: 'The owner stopped automatic research from the Work page.',
          },
          false,
          'research.end',
        )}
      </div>
    );
  const blocked = advance?.status === 'blocked';
  return (
    <div className="stack">
      {move('Start next step', {}, blocked)}
      {blocked &&
        !listed &&
        gate!.dependencies
          .filter((item) => !item.settled && !item.failed)
          .map((item) => <Dependency key={item.id} item={item} />)}
    </div>
  );
}

/** The cycle that frames the wave: what it is called, where it stands, its one move. */
function CycleHead({
  shell,
  cycle,
  onSaved,
  ends,
}: {
  shell: ShellData;
  cycle?: MapCycle;
  onSaved(): void;
  /** What the page hangs at the end of its title line: its filter, and what it can start. */
  ends: ReactNode;
}) {
  const cyclesRow = shell.rows.find((row) => row.view.kind === 'research');
  // With no cycle the page is its title.
  if (!cycle || !cyclesRow) return <PageHeader title="Work" actions={ends} />;
  return (
    <PageHeader
      title={<Link to={`${cyclesRow.path}/${cycle.id}`}>{cycle.name}</Link>}
      actions={
        <>
          <StatusPill value={cycle.workflow.state} />
          {cycle.writable && <CycleMove cycle={cycle} shell={shell} onSaved={onSaved} />}
          {ends}
        </>
      }
    />
  );
}

/** The Work page: the row that narrows the wave, its map, and what is live under it. */
export const WorkView = ({ shell }: { shell: ShellData }) => (
  <WorkPlane nameOf={useActorNames()}>
    <WaveList shell={shell} />
  </WorkPlane>
);
