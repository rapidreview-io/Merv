import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool, type ApiError, type Loaded, type Project } from '../api';
import { useSession } from '../session';
import type { Row, ShellData } from '../shell';
import { ObjId, StatusPill, relativeTime } from '../components';
import { useActorNames } from './people';

/**
 * The morning page: what needs me, what is running, what has been recorded.
 * One column of plain rows under three headings. Every source is gated on its
 * owning ui.shell row, so it goes quiet with its plugin while the Hooks below
 * keep their order. An absent value is never rendered as zero and an error is
 * never rendered as empty.
 */

interface TaskLite {
  id: string;
  title: string;
  workflow: { state: string; updatedAt: string };
}
interface ExperimentLite {
  id: string;
  name: string;
  attempt: { index: number };
  workflow: { state: string; updatedAt: string };
}
interface ReviewLite {
  id: string;
  subjectId: string;
  status: string;
  reviewerId: string | null;
  createdAt: string;
}
interface ClaimLite {
  id: string;
  statement: string;
  status: string;
  confidence: string;
  updatedAt: string;
}
interface PostLite {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}
interface AgentLite {
  id: string;
  name: string;
  status: string;
  currentExecutionId: string | null;
  currentAssignment: { label: string } | null;
}
interface SessionsLite {
  agents?: AgentLite[];
  runners: { live: boolean }[];
  queueTotal: number;
}
/** The two lists the work blocks share, read once for the whole page. */
interface Work {
  experiments: { row?: Row; load: Loaded<ExperimentLite[]> };
  tasks: { row?: Row; load: Loaded<TaskLite[]> };
}
type Named = (id: string | null | undefined) => string | undefined;

const rowOf = (rows: Row[], kind: string) => rows.find((row) => row.view.kind === kind);
const newest = <T,>(items: T[], at: (item: T) => string) =>
  [...items].sort((a, b) => at(b).localeCompare(at(a)));
const when = (iso: string) => (
  <time dateTime={iso} title={iso}>
    {relativeTime(iso)}
  </time>
);
const busy = (loads: { loading: boolean; error?: ApiError }[]) =>
  loads.some((load) => load.loading || !!load.error);

/** One line: a title link, a quiet meta, a pill only where the state adds something. */
function Item({
  to,
  title,
  meta,
  state,
  say,
}: {
  to: string;
  title: ReactNode;
  meta?: ReactNode;
  state?: string;
  say?: string;
}) {
  return (
    <li className="ov-row">
      <Link className="ov-name" to={to}>
        {title}
      </Link>
      <span className="ov-meta">
        {state && <StatusPill value={state} />}
        {meta}
      </span>
      {say && <p className="ov-say">{say}</p>}
    </li>
  );
}

/** A source still arriving, or one that failed, says so in the same row grammar. */
function Trouble({ what, load }: { what: string; load: { loading: boolean; error?: ApiError } }) {
  if (!load.error) return load.loading ? <li className="ov-row ov-note">Loading {what}…</li> : null;
  return (
    <li className="ov-row ov-note" role="alert">
      Could not load {what} <span className="mono">({load.error.code})</span>
    </li>
  );
}

function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="ov-block">
      <h2 className="ov-h">
        {title}
        {!!count && <span className="ov-count">{count}</span>}
      </h2>
      <ul className="ov-list">{children}</ul>
    </section>
  );
}

/**
 * Block 1. Open reviews and unwell rows. Open work whose next action is a
 * person's would belong here too, but WorkflowDecision carries no field naming
 * who must act, so this page does not guess at one.
 */
function NeedsYou({ rows, work, named }: { rows: Row[]; work: Work; named: Named }) {
  const reviewsRow = rowOf(rows, 'reviews');
  const list = useTool<ReviewLite[]>(reviewsRow ? 'review.list' : null);
  const open = newest(
    (list.data ?? []).filter(
      (review) => review.status === 'requested' || review.status === 'started',
    ),
    (review) => review.createdAt,
  );
  const unwell = rows.filter(
    (row) => row.status.state === 'degraded' || row.status.state === 'unavailable',
  );
  /** Reviews name their subject through the lists the other blocks already read. */
  const subject = (id: string) => {
    const experiment = work.experiments.load.data?.find((item) => item.id === id);
    return {
      name: experiment?.name ?? work.tasks.load.data?.find((task) => task.id === id)?.title,
      stage: experiment?.workflow.state,
    };
  };
  return (
    <Block title="Needs you" count={open.length + unwell.length}>
      {reviewsRow && <Trouble what="reviews" load={list} />}
      {reviewsRow &&
        open.map((review) => {
          const { name, stage } = subject(review.subjectId);
          return (
            <Item
              key={review.id}
              to={`${reviewsRow.path}/${review.id}`}
              title={
                <>
                  {stage === 'design_review'
                    ? 'Design review'
                    : stage === 'experiment_review'
                      ? 'Results review'
                      : 'Review'}{' '}
                  · {name ?? <ObjId id={review.subjectId} />}
                </>
              }
              meta={
                <>
                  {review.reviewerId ? (
                    <>claimed by {named(review.reviewerId) ?? <ObjId id={review.reviewerId} />}</>
                  ) : (
                    'unclaimed'
                  )}{' '}
                  · {when(review.createdAt)}
                </>
              }
            />
          );
        })}
      {unwell.map((row) => (
        <Item
          key={row.id}
          to={row.path}
          title={`${row.label} ${row.status.state}`}
          meta={row.status.detail}
        />
      ))}
      {!open.length && !unwell.length && !busy([list]) && (
        <li className="ov-none">Nothing needs you right now.</li>
      )}
    </Block>
  );
}

/** Block 2. The cycle in hand, then the work and the agents carrying it. */
function InMotion({ rows, work }: { rows: Row[]; work: Work }) {
  const researchRow = rowOf(rows, 'research');
  const sessionsRow = rowOf(rows, 'sessions');
  const { row: experimentsRow, load: experiments } = work.experiments;
  const { row: tasksRow, load: tasks } = work.tasks;
  const cycles = useTool<{ id: string; name: string; workflow: { state: string } }[]>(
    researchRow ? 'research.list' : null,
  );
  const cycle = (cycles.data ?? []).filter((item) => item.workflow.state !== 'complete').at(-1);
  const guidance = useTool<WorkflowDecision>(
    cycle ? 'workflow.status_and_next' : null,
    { instanceId: cycle?.id ?? '' },
    { every: 10000 },
  );
  const live = useTool<SessionsLite>(
    sessionsRow?.readable ? 'ui.read' : null,
    { rowId: sessionsRow?.id ?? '' },
    { every: 10000 },
  );
  const running = newest(
    (experiments.data ?? []).filter((item) =>
      ['running', 'executing'].includes(item.workflow.state),
    ),
    (item) => item.workflow.updatedAt,
  );
  const open = newest(
    (tasks.data ?? []).filter((task) => !['done', 'failed'].includes(task.workflow.state)),
    (task) => task.workflow.updatedAt,
  );
  const agents = (live.data?.agents ?? []).filter((agent) => agent.status !== 'retired');
  const sayings = (guidance.data?.blockers ?? [])
    .map((blocker) => blocker.message)
    .filter((message) => message !== guidance.data?.instruction);
  if (!researchRow && !experimentsRow && !tasksRow && !sessionsRow) return null;
  return (
    <Block title="In motion">
      {researchRow && <Trouble what="cycles" load={cycles} />}
      {researchRow && cycle && (
        <Item
          to={researchRow.path}
          title={cycle.name}
          state={cycle.workflow.state}
          say={
            guidance.error
              ? `Guidance is unavailable (${guidance.error.code}).`
              : guidance.data && [guidance.data.instruction, ...sayings].join(' · ')
          }
        />
      )}
      {experimentsRow && <Trouble what="experiments" load={experiments} />}
      {experimentsRow &&
        running.map((experiment) => (
          <Item
            key={experiment.id}
            to={`${experimentsRow.path}/${experiment.id}`}
            title={experiment.name}
            state={experiment.workflow.state}
            meta={
              <>
                attempt {experiment.attempt.index} · {when(experiment.workflow.updatedAt)}
              </>
            }
          />
        ))}
      {tasksRow && <Trouble what="tasks" load={tasks} />}
      {tasksRow &&
        open.map((task) => (
          <Item
            key={task.id}
            to={`${tasksRow.path}/${task.id}`}
            title={task.title}
            state={task.workflow.state}
            meta={when(task.workflow.updatedAt)}
          />
        ))}
      {sessionsRow && <Trouble what="agents" load={live} />}
      {sessionsRow &&
        agents.map((agent) => (
          <Item
            key={agent.id}
            to={sessionsRow.path}
            title={agent.name}
            state={agent.currentExecutionId ? 'assigned' : 'unassigned'}
            meta={agent.currentAssignment?.label}
          />
        ))}
      {live.data && (
        <li className="ov-row ov-note">
          {live.data.runners.filter((runner) => runner.live).length} of {live.data.runners.length}{' '}
          runners connected · {live.data.queueTotal} waiting
        </li>
      )}
      {!cycle &&
        !running.length &&
        !open.length &&
        !agents.length &&
        !busy([cycles, experiments, tasks, live]) && (
          <li className="ov-none">Nothing is running.</li>
        )}
    </Block>
  );
}

/** The one line that replaced the archive feature box. */
function Earlier({ row }: { row: Row }) {
  const summary = useTool<{ counts: Record<string, number> }>('ui.read', {
    rowId: row.id,
    params: { action: 'summary' },
  });
  if (!summary.data) return <Trouble what="earlier research" load={summary} />;
  const counts = ['experiments', 'tasks', 'reflections', 'papers']
    .map((key) => [key, summary.data!.counts[key] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count.toLocaleString()} ${key}`);
  if (!counts.length) return null;
  return (
    <li className="ov-row ov-note">
      Earlier research: {counts.join(' · ')} · <Link to={row.path}>Explore →</Link>
    </li>
  );
}

/** Block 3. What the project now holds: claims, what was said, finished experiments. */
function Recorded({ rows, work, named }: { rows: Row[]; work: Work; named: Named }) {
  const claimsRow = rowOf(rows, 'claims');
  const feedRow = rowOf(rows, 'feed');
  const archiveRow = rowOf(rows, 'legacy-history');
  const { row: experimentsRow, load: experiments } = work.experiments;
  const claims = useTool<ClaimLite[]>(claimsRow ? 'claim.list' : null);
  const posts = useTool<PostLite[]>(feedRow ? 'feed.list' : null);
  const latestClaims = newest(claims.data ?? [], (claim) => claim.updatedAt).slice(0, 3);
  const latestPosts = newest(posts.data ?? [], (post) => post.createdAt).slice(0, 3);
  const finished = newest(
    (experiments.data ?? []).filter((item) => item.workflow.state === 'complete'),
    (item) => item.workflow.updatedAt,
  );
  const shown = finished.slice(0, 2);
  if (!claimsRow && !feedRow && !experimentsRow && !archiveRow) return null;
  return (
    <Block title="Recorded">
      {claimsRow && <Trouble what="claims" load={claims} />}
      {claimsRow &&
        latestClaims.map((claim) => (
          <Item
            key={claim.id}
            to={claimsRow.path}
            title={claim.statement}
            state={claim.status}
            meta={
              <>
                {claim.confidence} confidence · {when(claim.updatedAt)}
              </>
            }
          />
        ))}
      {claimsRow && (claims.data?.length ?? 0) > latestClaims.length && (
        <li className="ov-row ov-all">
          <Link to={claimsRow.path}>All claims →</Link>
        </li>
      )}
      {feedRow && <Trouble what="posts" load={posts} />}
      {feedRow &&
        latestPosts.map((post) => (
          <Item
            key={post.id}
            to={feedRow.path}
            title={post.body.split('\n')[0]}
            meta={
              <>
                {named(post.authorId) ?? <ObjId id={post.authorId} />} · {when(post.createdAt)}
              </>
            }
          />
        ))}
      {feedRow && (posts.data?.length ?? 0) > latestPosts.length && (
        <li className="ov-row ov-all">
          <Link to={feedRow.path}>All posts →</Link>
        </li>
      )}
      {experimentsRow &&
        shown.map((experiment) => (
          <Item
            key={experiment.id}
            to={`${experimentsRow.path}/${experiment.id}`}
            title={experiment.name}
            meta={when(experiment.workflow.updatedAt)}
          />
        ))}
      {experimentsRow && finished.length > shown.length && (
        <li className="ov-row ov-all">
          <Link to={experimentsRow.path}>All experiments →</Link>
        </li>
      )}
      {archiveRow && !!archiveRow.status.count && <Earlier key={archiveRow.id} row={archiveRow} />}
      {!latestClaims.length &&
        !latestPosts.length &&
        !shown.length &&
        !busy([claims, posts, experiments]) && (
          <li className="ov-none">Nothing has been recorded yet.</li>
        )}
    </Block>
  );
}

export function OverviewView({ shell }: { shell: ShellData }) {
  const session = useSession();
  const rows = shell.rows;
  const experimentsRow = rowOf(rows, 'experiments');
  const tasksRow = rowOf(rows, 'tasks');
  const settings = rows.find((row) => row.group === 'settings');
  const read = useTool<Project>('project.get', {}, { every: 10000 });
  const experiments = useTool<ExperimentLite[]>(experimentsRow ? 'experiment.list' : null);
  const tasks = useTool<TaskLite[]>(tasksRow ? 'task.list' : null);
  const named = useActorNames();
  const project = read.data ?? session.project;
  const intro = project.summary?.trim().split(/\n\s*\n/)[0];
  const work: Work = {
    experiments: { row: experimentsRow, load: experiments },
    tasks: { row: tasksRow, load: tasks },
  };
  return (
    <div className="page-stage overview">
      <h1 className="page-title">{project.name}</h1>
      {intro ? (
        <p className="ov-intro">{intro}</p>
      ) : read.error ? (
        <p className="ov-intro" role="alert">
          The introduction could not load <span className="mono">({read.error.code})</span>.
        </p>
      ) : read.loading || !settings ? null : (
        <p className="ov-intro">
          <Link to={settings.path}>No introduction yet. Write one →</Link>
        </p>
      )}
      {rows.length === 0 ? (
        <p className="ov-none">This workspace is still starting.</p>
      ) : (
        <>
          <NeedsYou rows={rows} work={work} named={named} />
          <InMotion rows={rows} work={work} />
          <Recorded rows={rows} work={work} named={named} />
        </>
      )}
    </div>
  );
}
