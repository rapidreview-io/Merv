import { useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ResearchAnswer, ResearchRecord } from '@merv/research/models';
import type { WorkflowDecision } from '@merv/workflows/models';
import type { Task } from '@merv/tasks/models';
import { runningKey, keyId, type RunningNode } from '@merv/contracts/running';
import { ApiError, refreshTools, useTool } from '../api';
import { useCommand } from '../mutations';
import { Ago, Failure, Field, SearchField, Submit, ResearchCommand } from '../components';
import { ListPage, useListFilter } from '../list-filters';
import { RecordPicker, type Pickable } from '../record-picker';
import { useSession, writes } from '../session';
import { OPEN } from '../states';
import type { ShellData, WorkflowShape } from '../shell-types';
import { Dependency, StageMark, ended } from '../process';
import { Icon } from '../icons';
import { calling } from '../navigation';
import { newest, useHome, type Flow, type MapCycle } from './map-data';
import { useActorNames } from './people';
import { LiveNotes, WorkDispatch, WorkPlane, needs, useBoard } from './work-live';
import { Reading, steadyText } from './running-phrase';

/** A compact catalog; the inspector holds each record’s detail and permitted moves. */
const GROUPS = {
  attention: 'Needs attention',
  running: 'In progress',
  review: 'In review',
  waiting: 'Waiting',
  planned: 'Planned',
  other_open: 'Other open work',
  ended: 'Ended',
} as const;
type WorkGroup = keyof typeof GROUPS;
type WorkKind = 'tasks' | 'experiments' | 'reflections' | 'other';
interface Item {
  id: string;
  key: string;
  kind: WorkKind;
  name: string;
  purpose?: string;
  to?: string;
  flow?: Flow;
  end?: { settled: boolean; failed: boolean };
  at?: string;
  owner?: string;
  waits: string[];
  cycles: MapCycle[];
  node?: RunningNode;
  group: WorkGroup;
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
  const tasks = useTool<(Listed & { title: string })[]>('task.read:list');
  const experiments = useTool<(Listed & { name: string })[]>('experiment.read:list');
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
    tool: 'research.write:create',
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

/** The project catalog and its live work share one row per record, at every screen size. */
function WaveList({ shell }: { shell: ShellData }) {
  const { actor } = useSession();
  const nameOf = useActorNames();
  const live = useBoard();
  const reading = useContext(Reading);
  const [kind, setKind] = useState('');
  const [cycleFilter, setCycleFilter] = useState('');
  const home = useHome(8000);
  const { tasks, experiments, research: cycles, reflections } = home.data ?? {};
  const rowOf = (view: string) => shell.rows.find((row) => row.view.kind === view);
  const cycle = currentCycle(cycles ?? undefined, shell.workflows);
  const allCycles = newest(cycles ?? [], (item) => item.workflow.updatedAt);
  const nodes = live?.board?.lanes.work.nodes ?? [];
  const nodeOf = (key: string) =>
    nodes.find((node) => node.key === key || node.aliases?.includes(key));
  const unit = (kind: WorkKind, id: string, flow: Flow, owner: string) => ({
    id,
    key: runningKey('work', id),
    kind,
    flow,
    owner,
    at: flow.updatedAt,
    to: `${rowOf(kind)?.path ?? `/${kind}`}/${id}`,
    cycles: allCycles.filter(
      (item) => item.researchDependencies.includes(id) || item.reflectionId === id,
    ),
    node: nodeOf(runningKey('work', id)),
    group: 'other_open' as WorkGroup,
  });
  const records: Item[] = chained(
    [
      ...(tasks ?? []).map((task) => ({
        ...unit('tasks', task.id, task.workflow, task.producerId),
        name: task.title,
        purpose: task.goal,
        end: task,
      })),
      ...(experiments ?? []).map((item) => ({
        ...unit('experiments', item.id, item.workflow, item.ownerId),
        name: item.name,
        purpose: item.intent,
        end: item,
      })),
      ...(reflections ?? []).map((item) => ({
        ...unit('reflections', item.id, item.workflow, item.ownerId),
        name: item.title,
        purpose: `${item.lenses.filter((lens) => lens.written).length} of ${item.lenses.length} reflection lenses written`,
      })),
    ],
    tasks ?? [],
  );
  // A contribution can name work absent from home (including a failed home part). Keep it
  // visible, but do not duplicate a record already represented by an absorbed node.
  const known = new Set(records.map((item) => item.key));
  for (const node of nodes) {
    if (known.has(node.key) || node.aliases?.some((key) => known.has(key))) continue;
    known.add(node.key);
    const kind: WorkKind =
      node.kind === 'Task'
        ? 'tasks'
        : node.kind === 'Experiment'
          ? 'experiments'
          : node.kind === 'Reflection'
            ? 'reflections'
            : 'other';
    records.push({
      id: keyId(node.key),
      key: node.key,
      name: node.title,
      kind,
      node,
      waits: [],
      cycles: allCycles.filter(
        (item) =>
          item.researchDependencies.includes(keyId(node.key)) ||
          item.reflectionId === keyId(node.key),
      ),
      group: 'other_open',
    });
  }
  const attentionOf = (item: Item) =>
    item.node && needs(item.node) ? item.node : live?.liveOn(item.key).find(needs);
  const standing = (item: Item): WorkGroup => {
    const { flow, node } = item;
    if (attentionOf(item)) return 'attention';
    if (flow ? ended(shell.workflows, flow, item.end) : node?.look === 'quiet') return 'ended';
    const shape =
      flow &&
      shell.workflows?.find(
        (shape) =>
          shape.name === flow.workflow && (!flow.version || shape.version === flow.version),
      );
    if (
      shape?.edges.some(
        (edge) =>
          edge.from === flow!.state && ['review.write', 'review.submit'].includes(edge.tool ?? ''),
      )
    )
      return 'review';
    if (item.waits.length || node?.look === 'dashed') return 'waiting';
    if (node?.dot && !live?.now.stale) return 'running';
    if (flow && rowOf(item.kind)?.states?.[flow.state]?.idle) return 'planned';
    // A deployed nonterminal, non-idle stage says work is under way; it does not claim an agent is live.
    if (shape?.states.includes(flow!.state)) return 'running';
    return 'other_open';
  };
  const items = records.map((item) => ({ ...item, group: standing(item) }));
  const filter = useListFilter(items, {
    stateOf: (item) => item.group,
    isOpen: (group) => group !== 'ended',
    history: true,
    mine: (item) => item.owner === actor.id,
    labels: (item) => [item.name, item.purpose, item.owner && nameOf(item.owner)],
    ids: (item) => [item.id, item.owner],
    also: (item) =>
      (!kind || item.kind === kind) &&
      (!cycleFilter ||
        (cycleFilter === 'none'
          ? !item.cycles.length
          : item.cycles.some((cycle) => cycle.id === cycleFilter))),
  });
  // All counters describe the same catalog after search/type/owner/cycle, before status.
  const count = (group: string) => filter.states.find((state) => state.value === group)?.count ?? 0;
  const total = Object.keys(GROUPS).reduce((sum, group) => sum + count(group), 0);
  const clear = () => {
    setKind('');
    setCycleFilter('');
    filter.reset();
  };
  const unread = ['tasks', 'experiments', 'research', 'reflections'].filter(
    (kind) => rowOf(kind) && home.data?.[kind as keyof typeof home.data] === null,
  );
  const load = {
    loading: !home.data && home.loading && !items.length,
    error:
      home.error ??
      (unread.length
        ? new ApiError(
            'unavailable',
            `Could not read ${unread.join(', ')}. Available work is shown.`,
            503,
          )
        : undefined),
    data: items.length || home.data ? items : undefined,
    loadedAt: home.loadedAt,
  };
  const kindName = (item: Item) =>
    ({
      tasks: 'Task',
      experiments: 'Experiment',
      reflections: 'Reflection',
      other: item.node?.kind ?? 'Work',
    })[item.kind];
  const groups = (Object.keys(GROUPS) as WorkGroup[]).map((group) => ({
    group,
    rows: filter.rows
      .filter((item) => item.group === group)
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
  }));
  const narrowed =
    !!kind ||
    !!cycleFilter ||
    !!filter.query ||
    filter.scope !== 'everyone' ||
    filter.state !== OPEN;
  const detailFiltered =
    !!kind ||
    !!cycleFilter ||
    filter.scope !== 'everyone' ||
    ![OPEN, '', 'ended'].includes(filter.state);
  return (
    <div className="work-page">
      <ListPage
        load={load}
        bare
        listed={false}
        noun="work"
        kind="work"
        emptyTitle="No work yet"
        emptyHint="Start a research cycle to organize the project's work."
        filter={{ ...filter, filtering: narrowed, clear }}
        create={
          rowOf('research')
            ? {
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
            : undefined
        }
        lede={(ends) => (
          <>
            <header className="work-heading">
              <div className="work-heading-main">
                <h1>Work</h1>
                {cycle && rowOf('research') && (
                  <Link
                    className="work-cycle-link"
                    to={`${rowOf('research')!.path}/${cycle.id}`}
                    title={`${ended(shell.workflows, cycle.workflow) ? 'Latest' : 'Current'} cycle · ${cycle.progress.settled} of ${cycle.progress.total} selected work accepted`}
                  >
                    <span>{cycle.name}</span>
                    <span className="work-cycle-count">
                      {cycle.progress.settled}/{cycle.progress.total}
                    </span>
                  </Link>
                )}
              </div>
              <div className="work-heading-actions">
                <WorkDispatch />
                {ends}
              </div>
            </header>
            <div className="work-toolbar">
              <nav className="work-views" aria-label="Work view">
                {[
                  [OPEN, 'Active', count(OPEN)],
                  ['', 'All work', total],
                  ['ended', 'History', count('ended')],
                ].map(([value, label, number]) => (
                  <button
                    key={String(value)}
                    aria-pressed={filter.state === value}
                    onClick={() => filter.setState(String(value))}
                  >
                    {label} <span>{number}</span>
                  </button>
                ))}
              </nav>
              <SearchField
                label="Search work"
                title="Search name, purpose or person"
                value={filter.query}
                onChange={filter.setQuery}
              />
              <details
                className="work-filter-menu"
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || !event.currentTarget.open) return;
                  event.preventDefault();
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                }}
              >
                <summary className={detailFiltered ? 'work-filter-active' : undefined}>
                  <Icon name="settings" size={14} /> Filter
                  {detailFiltered && <span className="work-filter-dot" />}
                </summary>
                <div className="work-filters">
                  <label>
                    <span>Type</span>
                    <select
                      aria-label="Work type"
                      value={kind}
                      onChange={(event) => setKind(event.target.value)}
                    >
                      <option value="">All types</option>
                      <option value="tasks">Tasks</option>
                      <option value="experiments">Experiments</option>
                      <option value="reflections">Reflections</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label>
                    <span>Owner</span>
                    <select
                      aria-label="Owner"
                      value={filter.scope}
                      onChange={(event) =>
                        filter.setScope(event.target.value as 'mine' | 'everyone')
                      }
                    >
                      <option value="everyone">Everyone</option>
                      <option value="mine">Mine</option>
                    </select>
                  </label>
                  {allCycles.length > 0 && (
                    <label>
                      <span>Cycle</span>
                      <select
                        aria-label="Cycle"
                        value={cycleFilter}
                        onChange={(event) => setCycleFilter(event.target.value)}
                      >
                        <option value="">All cycles</option>
                        {allCycles.map((cycle) => (
                          <option key={cycle.id} value={cycle.id}>
                            {cycle.name}
                          </option>
                        ))}
                        <option value="none">No cycle</option>
                      </select>
                    </label>
                  )}
                  <label>
                    <span>Status</span>
                    <select
                      aria-label="Work status"
                      value={filter.state}
                      onChange={(event) => filter.setState(event.target.value)}
                    >
                      <option value={OPEN}>Active</option>
                      <option value="">All work</option>
                      {(Object.keys(GROUPS) as WorkGroup[]).map((group) => (
                        <option key={group} value={group}>
                          {GROUPS[group]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {narrowed && (
                    <button className="work-reset" onClick={clear}>
                      Reset filters
                    </button>
                  )}
                </div>
              </details>
            </div>
          </>
        )}
        drawn={
          <div className="work-groups">
            {groups
              .filter(({ rows }) => rows.length)
              .map(({ group, rows }) => (
                <section className="work-group" key={group} aria-label={GROUPS[group]}>
                  <h2>
                    <span
                      className={`work-group-dot work-group-dot--${group}`}
                      aria-hidden="true"
                    />
                    {GROUPS[group]} <span>{rows.length}</span>
                  </h2>
                  <ul>
                    {rows.map((item) => {
                      const attention = attentionOf(item);
                      const reason =
                        attention?.attention?.says && steadyText(attention.attention.says, reading);
                      return (
                        <li className="work-row" key={item.key}>
                          <span
                            className="work-kind"
                            role="img"
                            aria-label={kindName(item)}
                            title={kindName(item)}
                          >
                            <Icon
                              name={
                                item.kind === 'tasks'
                                  ? 'work'
                                  : item.kind === 'experiments'
                                    ? 'file-data'
                                    : item.kind === 'reflections'
                                      ? 'reflections'
                                      : 'fallback'
                              }
                              size={16}
                            />
                          </span>
                          <button
                            className="work-row-title"
                            data-key={item.key}
                            aria-controls="running-panel"
                            title={item.name}
                            onClick={() => reading.open(item.key, item.to)}
                          >
                            {item.name}
                          </button>
                          {attention && (
                            <button
                              className="work-row-attention"
                              data-key={attention.key}
                              aria-controls="running-panel"
                              aria-label={reason || 'Needs attention'}
                              title={reason || 'Needs attention'}
                              onClick={() => reading.open(attention.key, item.to)}
                            >
                              <Icon name="alert" size={15} />
                            </button>
                          )}
                          <div className="work-row-stage">
                            {item.flow && (
                              <StageMark shapes={shell.workflows} workflow={item.flow} />
                            )}
                          </div>
                          <span className="work-row-owner" title={item.owner && nameOf(item.owner)}>
                            {item.owner ? (nameOf(item.owner) ?? 'Owner') : ''}
                          </span>
                          <span className="work-row-updated">
                            {item.at && <Ago at={item.at} />}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
          </div>
        }
        after={<LiveNotes />}
      />
    </div>
  );
}

/** How often a cycle move the gate refuses is checked again while nothing on the page moves. */
const REFUSED_RECHECK_MS = 30_000;
/** The move a cycle's gate offers its owner, as a person is shown it. */
const ADVANCE = 'research.write:advance';

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
  pulse,
  onSaved,
}: {
  cycle: MapCycle;
  shell: ShellData;
  listed?: boolean;
  /** Where the work the cycle names stands, as the page's own check-free read says it. */
  pulse?: string;
  onSaved(): void;
}) {
  const open = !ended(shell.workflows, cycle.workflow);
  // The gate runs every action's check, so it is read as the move opens and again only when the
  // page's check-free read shows the cycle moved (`pulse`: the work it names), or after a move.
  // A move it refuses may wait on what that read does not show (a consolidation's code reaching
  // main), so while it refuses it is checked again now and then, never left refused for good.
  const checked = useTool<WorkflowDecision>(
    open ? 'workflow.read:status' : null,
    { instanceId: cycle.id },
    {
      every: (decision) =>
        calling(decision?.actions, ADVANCE)?.status === 'blocked' ? REFUSED_RECHECK_MS : undefined,
    },
  );
  const read = checked.data;
  const moved = JSON.stringify([
    cycle.workflow.revision,
    cycle.progress,
    cycle.automation?.blocker?.code ?? null,
    pulse ?? null,
  ]);
  const seen = useRef(moved);
  const { reload } = checked;
  useEffect(() => {
    if (seen.current === moved) return;
    seen.current = moved;
    reload();
  }, [moved, reload]);
  // A gate read at another revision is not this cycle's, and leaves the plain move.
  const gate = read?.revision === cycle.workflow.revision ? read : undefined;
  const advance = calling(gate?.actions, ADVANCE);
  const refused = (code: string) => !!advance?.blockers.some((item) => item.code === code);
  const row = (kind: string) => shell.rows.find((item) => item.view.kind === kind);
  const offered = (address: string) =>
    (calling(gate?.actions, address)?.status ?? 'blocked') !== 'blocked';
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
    tool = ADVANCE,
  ) => (
    <ResearchCommand
      key={label}
      disabled={disabled}
      tool={tool}
      input={{ researchId: cycle.id, expectedRevision: cycle.workflow.revision, ...choice }}
      label={label}
      onSaved={() => {
        onSaved();
        refreshTools('ui.home', 'workflow.read:status');
      }}
    />
  );
  const moves = answer?.moves.map((item) =>
    item.row ? (
      <Link key={item.label} className="btn" to={row(item.row)!.path}>
        {item.label} <Icon name="arrow-right" size={14} />
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
          'research.write:end',
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

/** The same live inspector serves a conventional work list and its connected agents. */
export const WorkView = ({ shell }: { shell: ShellData }) => (
  <WorkPlane nameOf={useActorNames()}>
    <WaveList shell={shell} />
  </WorkPlane>
);
