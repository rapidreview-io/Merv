import { useState, type CSSProperties } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { Experiment } from '@merv/experiments/models';
import type { ResearchRecord } from '@merv/research/models';
import { refreshTools, useTool } from '../api';
import { useCommand } from '../mutations';
import { Ago, Failure, Field, PageHeader, StatusPill, Submit, cx, words } from '../components';
import { Chips, ListPage, Tabs, useListFilter, useWide } from '../list-filters';
import { RecordPicker, useWorkPicks } from '../record-picker';
import { useSession } from '../session';
import { ThreeStates, firstSentence, newestReview, reviewClause } from '../states';
import type { ShellData } from '../shell-types';
import { Dependency, RowDiagram } from '../process';
import { ArrowRightIcon } from '../icons';
import { newest, useHome, type Flow } from './map-data';
import { ResearchCommand } from './paper';
import { useActorNames } from './people';
import type { Review } from './reviews';
import type { Task } from './tasks';

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
/** Open work, in the union of the two kinds' own words for having stopped. */
const isOpen = (state: string) => !['done', 'failed', 'complete', 'abandoned'].includes(state);

/** One row of the wave, whichever kind of record it is. */
interface Item {
  id: string;
  kind: 'tasks' | 'experiments';
  name: string;
  to: string;
  state: string;
  flow: Flow;
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
    workflow?: { state: string };
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
      if (task.title && task.workflow && task.workflow.state !== 'done')
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
    out.push({ ...known.get(id)!, depth: at, waits: waits.get(id) ?? [] });
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
      out.push({ ...item, depth: 0, waits: waits.get(item.id) ?? [] });
    }
  return out;
}

/** The cycle the project is on: the newest one still running, else the newest. */
export const currentCycle = (cycles: ResearchRecord[] | undefined) => {
  const all = newest(cycles ?? [], (cycle) => cycle.workflow.updatedAt);
  return all.find((cycle) => isOpen(cycle.workflow.state)) ?? all[0];
};

export function CreateResearch({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [automatic, setAutomatic] = useState(false);
  const [maxCycles, setMaxCycles] = useState('10');
  // What a cycle may wait on is the work this page lists, chosen by name.
  const work = useWorkPicks({ includeFailed: true });
  const command = useCommand<ResearchRecord>({
    tool: 'research.create',
    validate: (value) =>
      !!value && typeof value.id === 'string' && value.workflow?.workflow === 'research',
    onSuccess: () => {
      setName('');
      setDependencies([]);
      // The new cycle's gate rides the shared home read, which its header's move reads.
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
          ...(automatic ? { automatic: true, maxCycles: Number(maxCycles) } : {}),
        });
      }}
    >
      <h2>New cycle</h2>
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
 * stay on screen beside it.
 */
export function WorkList({ shell }: { shell: ShellData }) {
  const [chosen, setChosen] = useState<string>();
  const { actor } = useSession();
  const nameOf = useActorNames();
  const [kind, setKind] = useState<string>(ALL);
  const rowOf = (view: string) => shell.rows.find((row) => row.view.kind === view);
  const tasksRow = rowOf('tasks');
  const experimentsRow = rowOf('experiments');
  const cyclesRow = rowOf('research');
  const reviewsPath = rowOf('reviews')?.path;
  const tasks = useTool<Task[]>(tasksRow ? 'task.list' : null, {}, { every: 8000 });
  const experiments = useTool<Experiment[]>(
    experimentsRow ? 'experiment.list' : null,
    {},
    { every: 8000 },
  );
  // Review clauses move with the record beside the list: a claim or a verdict must show.
  const reviews = useTool<Review[]>(rowOf('reviews') ? 'review.list' : null, {}, { every: 8000 });
  const cycles = useTool<ResearchRecord[]>(cyclesRow ? 'research.list' : null);
  // The cycle the head shows is the one the narrowing means.
  const cycle = cycles.data?.find((item) => item.id === chosen) ?? currentCycle(cycles.data);
  // The work the cycle itself names: its own prerequisites, and nothing inferred.
  const inCycle = new Set(cycle?.researchDependencies);
  const items: Item[] = chained(
    [
      ...(tasks.data ?? []).map((task): Item => ({
        id: task.id,
        kind: 'tasks',
        name: task.title,
        to: `${tasksRow!.path}/${task.id}`,
        state: task.workflow.state,
        flow: task.workflow,
        at: task.workflow.updatedAt,
        mine: task.producerId === actor.id,
        outcome: task.failure?.reason ?? null,
        named: inCycle.has(task.id),
        labels: [task.title, task.goal, nameOf(task.producerId)],
        owner: task.producerId,
        depth: 0,
        waits: [],
      })),
      ...(experiments.data ?? []).map((item): Item => ({
        id: item.id,
        kind: 'experiments',
        name: item.name,
        to: `${experimentsRow!.path}/${item.id}`,
        state: item.workflow.state,
        flow: item.workflow,
        at: item.workflow.updatedAt,
        mine: item.ownerId === actor.id,
        outcome: item.conclusion,
        named: inCycle.has(item.id),
        labels: [item.name, item.intent, nameOf(item.ownerId)],
        owner: item.ownerId,
        depth: 0,
        waits: [],
      })),
    ],
    tasks.data ?? [],
  );
  const under = (of: string) => (item: Item) =>
    of === ALL || (of === 'cycle' ? item.named : item.kind === of);
  const filter = useListFilter(items, {
    stateOf: (item) => item.state,
    isOpen,
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
      ['cycle', 'In this cycle'],
    ] as const
  ).filter(([value]) => items.some(under(value)) || kind === value);
  // Two reads make one list: it is still loading while neither has arrived, and a
  // failure that leaves rows on screen degrades to a line rather than blanking them.
  const load = {
    loading: !items.length && (tasks.loading || experiments.loading),
    error: tasks.error ?? experiments.error,
    data: items.length ? items : undefined,
    loadedAt: tasks.loadedAt ?? experiments.loadedAt,
  };
  // One step in for each thing the row waits behind, on the name and on the line under it.
  const step = (item: Item) => ({ '--depth': item.depth }) as CSSProperties;
  return (
    <>
      {/* The cycle stands where every other page's title line stands, and above the list
          beside an open record, so its one move is never a page away. */}
      <div className="page-lede">
        <CycleHead shell={shell} chosen={chosen} onChoose={setChosen} />
      </div>
      <ListPage
        load={load}
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
          narrowings.length > 1 && (
            <Tabs
              label="Kind of work"
              options={[[ALL, 'All'] as const, ...narrowings].map(([value, label]) => ({
                value,
                label,
                count: filter.tabbed.filter(under(value)).length,
              }))}
              value={kind}
              onChange={setKind}
            />
          )
        }
        emptyTitle="No work yet"
        create={
          cyclesRow && {
            label: 'New cycle',
            shown: actor.role === 'operator' || actor.role === 'producer',
            form: (close) => (
              <CreateResearch
                onSaved={() => {
                  close();
                  cycles.reload();
                }}
              />
            ),
          }
        }
        line={(item) => {
          const review = newestReview(reviews.data, item.id);
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
                  execution={item.state}
                  diagram={
                    <RowDiagram shapes={shell.workflows} workflow={item.flow} kind={item.kind} />
                  }
                  // A review is a record of its own, so the clause is the way to its verdict.
                  review={
                    said && review && reviewsPath
                      ? { ...said, to: `${reviewsPath}/${review.id}` }
                      : (said ?? undefined)
                  }
                  outcome={
                    firstSentence(item.outcome)
                      ? { detail: firstSentence(item.outcome) }
                      : undefined
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
              </div>
            ),
          };
        }}
      />
    </>
  );
}

/** The gate's own code for a cycle whose problem, scope, goals and constraints are unwritten. */
const UNDEFINED = 'research_definition_required';

/**
 * A cycle's one move, here and on its own page, as the project's one read of every gate
 * has it. A move the gate refuses is not offered as a button that can only fail: for want
 * of the definition it is the way to the paper, where that is written, and otherwise it
 * stands disabled over the records it waits on — unless the page already `listed` them.
 * An answer the gate asks for, the approved plan's next wave or a fresh consolidation
 * task, is a move of its own.
 */
export function CycleMove({
  cycle,
  shell,
  listed = false,
  onSaved,
}: {
  cycle: ResearchRecord;
  shell: ShellData;
  listed?: boolean;
  onSaved(): void;
}) {
  const home = useHome();
  // A cycle that has ended has no move left.
  if (!isOpen(cycle.workflow.state)) return null;
  const read = home.data?.workflows?.workflows.find((item) => item.instanceId === cycle.id);
  // A gate read at another revision is not this cycle's, and leaves the plain move.
  const gate = read?.revision === cycle.workflow.revision ? read : undefined;
  const advance = gate?.actions.find((action) => action.tool === 'research.advance');
  const refused = (code: string) => !!advance?.blockers.some((item) => item.code === code);
  const paper = shell.rows.find((row) => row.view.kind === 'paper');
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
        refreshTools('ui.home');
      }}
    />
  );
  const end = (label: string, reason: string) =>
    move(label, { outcome: 'abandoned', reason }, false, 'research.end');
  if (refused(UNDEFINED) && paper)
    return (
      <Link className="btn" to={paper.path}>
        Write the definition <ArrowRightIcon size={14} />
      </Link>
    );
  if (cycle.automation && isOpen(cycle.workflow.state))
    return (
      <div className="stack">
        <span>
          Automatic · cycle {cycle.automation.cycle} of {cycle.automation.maxCycles}
        </span>
        {cycle.automation.blocker && <span>{cycle.automation.blocker.message}</span>}
        {cycle.automation.blocker?.code === 'research_definition_changed' &&
          move('Accept changed definition')}
        {end('Stop automatic research', 'The owner stopped automatic research from the Work page.')}
      </div>
    );
  if (advance?.requiredInput.includes('nextWave'))
    return (
      <div className="cluster">
        {move('Create next wave', { nextWave: 'create' })}
        {move('Skip next wave', { nextWave: 'skip' })}
      </div>
    );
  if (refused('integration_failed')) return move('Retry consolidation', { retryIntegration: true });
  // A wave that ended unapproved stops its cycle, though work it reflects on may fail and still be
  // read: the wave where it stands, unless the page lists it, and the end the gate offers instead.
  const ends = gate?.actions.some(
    (item) => item.tool === 'research.end' && item.status !== 'blocked',
  );
  if (refused('dependency_failed') && ends) {
    const waves = gate!.dependencies.filter(
      (item) => item.failed && item.workflow === 'reflection',
    );
    return (
      <div className="stack">
        {!listed && waves.map((item) => <Dependency key={item.id} item={item} />)}
        {end('End cycle', `${waves[0]?.name ?? 'Its reflection'} was abandoned.`)}
      </div>
    );
  }
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
  chosen,
  onChoose,
}: {
  shell: ShellData;
  chosen?: string;
  onChoose: (id: string) => void;
}) {
  const { actor } = useSession();
  const cyclesRow = shell.rows.find((row) => row.view.kind === 'research');
  const cycles = useTool<ResearchRecord[]>(
    cyclesRow ? 'research.list' : null,
    {},
    { every: 10000 },
  );
  const all = newest(cycles.data ?? [], (cycle) => cycle.workflow.updatedAt);
  const cycle = all.find((item) => item.id === chosen) ?? currentCycle(cycles.data);
  // With no cycle the page is its title: the absent switch already says there is none.
  if (!cycle || !cyclesRow) return <PageHeader title="Work" />;
  const writable =
    actor.role === 'operator' || (actor.role === 'producer' && cycle.ownerId === actor.id);
  return (
    <PageHeader
      title={<Link to={`${cyclesRow.path}/${cycle.id}`}>{cycle.name}</Link>}
      actions={
        <div className="cluster">
          <StatusPill value={cycle.workflow.state} />
          {writable && <CycleMove cycle={cycle} shell={shell} onSaved={cycles.reload} />}
        </div>
      }
      summary={
        all.length > 1 && (
          <Chips
            label="Research cycle"
            options={all.map((item) => ({
              value: item.id,
              label: item.name,
              count: words(item.workflow.state),
            }))}
            value={cycle.id}
            onChange={onChoose}
          />
        )
      }
    />
  );
}

export function WorkView({ shell }: { shell: ShellData }) {
  const wide = useWide();
  const experimentsRow = shell.rows.find((row) => row.view.kind === 'experiments');
  const experiments = useTool<Experiment[]>(experimentsRow ? 'experiment.list' : null);
  // Where a record stands beside its list, Work opens on the latest experiment: the list,
  // the cycle and its move are all still on screen, and the page is never an empty pane.
  const latest = newest(experiments.data ?? [], (item) => item.workflow.updatedAt)[0];
  if (wide && experimentsRow && latest)
    return <Navigate to={`${experimentsRow.path}/${latest.id}`} replace />;
  // Until the list has answered there is nothing to choose between the two.
  if (wide && experimentsRow && experiments.loading && !experiments.data) return null;
  return <WorkList shell={shell} />;
}
