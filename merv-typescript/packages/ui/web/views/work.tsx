import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Experiment } from '@merv/experiments/models';
import type { ResearchRecord } from '@merv/research/models';
import { useTool } from '../api';
import { useCommand } from '../mutations';
import { Ago, Area, Failure, Field, PageHeader, StatusPill, cx, words } from '../components';
import { ListPage, useListFilter } from '../list-filters';
import { useSession } from '../session';
import { ThreeStates, firstSentence, newestReview, reviewClause } from '../states';
import type { ShellData } from '../shell-types';
import { newest } from './map-data';
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

const ids = (value: string) => value.split(/\s+/).filter(Boolean);
/** Open work, in the union of the two kinds' own words for having stopped. */
const isOpen = (state: string) => !['done', 'failed', 'complete', 'abandoned'].includes(state);

/** One row of the wave, whichever kind of record it is. */
interface Item {
  id: string;
  kind: 'tasks' | 'experiments';
  name: string;
  to: string;
  state: string;
  at: string;
  mine: boolean;
  outcome: string | null;
  named: boolean;
  labels: (string | undefined)[];
  owner: string;
}

/** The cycle the project is on: the newest one still running, else the newest. */
export const currentCycle = (cycles: ResearchRecord[] | undefined) => {
  const all = newest(cycles ?? [], (cycle) => cycle.workflow.updatedAt);
  return all.find((cycle) => cycle.workflow.state !== 'complete') ?? all[0];
};

export function CreateResearch({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [dependencies, setDependencies] = useState('');
  const [consolidationDependencies, setConsolidationDependencies] = useState('');
  const [workspace, setWorkspace] = useState('none');
  const command = useCommand<ResearchRecord>({
    tool: 'research.create',
    validate: (value) =>
      !!value && typeof value.id === 'string' && value.workflow?.workflow === 'research',
    onSuccess: () => {
      setName('');
      setDependencies('');
      setConsolidationDependencies('');
      onSaved();
    },
  });
  return (
    <form
      className="card stack claims-form"
      onSubmit={(event) => {
        event.preventDefault();
        void command.submit({
          name,
          dependsOn: ids(dependencies),
          consolidationDependsOn: workspace === 'git' ? ids(consolidationDependencies) : [],
          consolidationWorkspace: workspace,
        });
      }}
    >
      <h2>New cycle</h2>
      <fieldset disabled={command.locked}>
        <Field label="Name" required maxLength={200} value={name} onChange={setName} />
        <Area
          label="Research prerequisites"
          className="textarea mono"
          rows={2}
          value={dependencies}
          onChange={setDependencies}
          placeholder="Workflow IDs, separated by spaces"
        />
        <label>
          Code changes
          <select
            value={workspace}
            onChange={(event) => {
              setWorkspace(event.target.value);
              if (event.target.value === 'none') setConsolidationDependencies('');
            }}
          >
            <option value="none">No code changes</option>
            <option value="git">Git consolidation</option>
          </select>
        </label>
        {workspace === 'git' && (
          <Area
            label="Additional consolidation prerequisites"
            className="textarea mono"
            rows={2}
            value={consolidationDependencies}
            onChange={setConsolidationDependencies}
          />
        )}
      </fieldset>
      <Failure message={command.error} />
      <div>
        <button className="btn btn--primary" disabled={command.busy || !name.trim()}>
          {command.retry ? 'Retry same request' : 'New cycle'}
        </button>
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
  const { actor } = useSession();
  const nameOf = useActorNames();
  const [kind, setKind] = useState<string>('');
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
  const reviews = useTool<Review[]>(rowOf('reviews') ? 'review.list' : null);
  const cycles = useTool<ResearchRecord[]>(cyclesRow ? 'research.list' : null);
  const cycle = currentCycle(cycles.data);
  // The work the cycle itself names: its own prerequisites, and nothing inferred.
  const inCycle = new Set([
    ...(cycle?.researchDependencies ?? []),
    ...(cycle?.consolidationDependencies ?? []),
  ]);
  const items: Item[] = newest(
    [
      ...(tasks.data ?? []).map((task): Item => ({
        id: task.id,
        kind: 'tasks',
        name: task.title,
        to: `${tasksRow!.path}/${task.id}`,
        state: task.workflow.state,
        at: task.workflow.updatedAt,
        mine: task.producerId === actor.id,
        outcome: task.failure?.reason ?? null,
        named: inCycle.has(task.id),
        labels: [task.title, task.goal, nameOf(task.producerId)],
        owner: task.producerId,
      })),
      ...(experiments.data ?? []).map((item): Item => ({
        id: item.id,
        kind: 'experiments',
        name: item.name,
        to: `${experimentsRow!.path}/${item.id}`,
        state: item.workflow.state,
        at: item.workflow.updatedAt,
        mine: item.ownerId === actor.id,
        outcome: item.conclusion,
        named: inCycle.has(item.id),
        labels: [item.name, item.intent, nameOf(item.ownerId)],
        owner: item.ownerId,
      })),
    ],
    (item) => item.at,
  );
  const filter = useListFilter(items, {
    stateOf: (item) => item.state,
    isOpen,
    mine: (item) => item.mine,
    labels: (item) => item.labels,
    ids: (item) => [item.id, item.owner],
  });
  const counted = (of: string) =>
    of === 'cycle'
      ? items.filter((item) => item.named).length
      : items.filter((item) => item.kind === of).length;
  // The first narrowing: which kind of work, and the work this cycle itself names.
  const narrowings = [
    ['tasks', 'Tasks'],
    ['experiments', 'Experiments'],
    ...(counted('cycle') ? [['cycle', 'In this cycle']] : []),
  ] as [string, string][];
  const shown = filter.rows.filter(
    (item) => !kind || (kind === 'cycle' ? item.named : item.kind === kind),
  );
  // Two reads make one list: it is still loading while neither has arrived, and a
  // failure that leaves rows on screen degrades to a line rather than blanking them.
  const load = {
    loading: !items.length && (tasks.loading || experiments.loading),
    error: tasks.error ?? experiments.error,
    data: items.length ? items : undefined,
    loadedAt: tasks.loadedAt ?? experiments.loadedAt,
  };
  return (
    <ListPage
      load={load}
      noun="work"
      placeholder="Name, question or person"
      filter={filter}
      rows={shown}
      narrow={
        items.length > 0 && (
          <span className="state-line">
            {narrowings.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="btn-text"
                aria-pressed={kind === value}
                onClick={() => setKind(kind === value ? '' : value)}
              >
                {label} <span className="state-n">{counted(value)}</span>
              </button>
            ))}
          </span>
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
            <Link className={cx('row-link', item.id === filter.openId && 'row-open')} to={item.to}>
              <strong>{item.name}</strong>
            </Link>
          ),
          standing: (
            <ThreeStates
              execution={item.state}
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
          ),
        };
      }}
    />
  );
}

/** The cycle that frames the wave: what it is called, where it stands, its one move. */
function CycleHead({ shell }: { shell: ShellData }) {
  const { actor } = useSession();
  const [chosen, setChosen] = useState<string>();
  const cyclesRow = shell.rows.find((row) => row.view.kind === 'research');
  const cycles = useTool<ResearchRecord[]>(
    cyclesRow ? 'research.list' : null,
    {},
    { every: 10000 },
  );
  const all = newest(cycles.data ?? [], (cycle) => cycle.workflow.updatedAt);
  const cycle = all.find((item) => item.id === chosen) ?? currentCycle(cycles.data);
  if (!cycle || !cyclesRow)
    return <PageHeader title="Work" summary={cyclesRow ? 'No research cycle yet' : undefined} />;
  const writable =
    actor.role === 'operator' || (actor.role === 'producer' && cycle.ownerId === actor.id);
  return (
    <PageHeader
      title={<Link to={`${cyclesRow.path}/${cycle.id}`}>{cycle.name}</Link>}
      actions={
        <div className="cluster">
          <StatusPill value={cycle.workflow.state} />
          {writable && (
            <ResearchCommand
              disabled={cycle.workflow.state === 'complete'}
              tool="research.advance"
              input={{ researchId: cycle.id, expectedRevision: cycle.workflow.revision }}
              label="Start next step"
              onSaved={cycles.reload}
            />
          )}
        </div>
      }
      summary={
        all.length > 1 && (
          <span className="state-line">
            {all.map((item) => (
              <button
                key={item.id}
                type="button"
                className="btn-text"
                aria-pressed={item.id === cycle.id}
                onClick={() => setChosen(item.id)}
              >
                {item.name} <span className="state-n">{words(item.workflow.state)}</span>
              </button>
            ))}
          </span>
        )
      }
    />
  );
}

export function WorkView({ shell }: { shell: ShellData }) {
  return (
    <>
      {/* The cycle stands where every other page's title line stands. */}
      <div className="page-lede">
        <CycleHead shell={shell} />
      </div>
      <WorkList shell={shell} />
    </>
  );
}
