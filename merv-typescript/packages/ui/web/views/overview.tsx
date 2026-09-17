import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool, type ApiError, type Loaded, type Project } from '../api';
import { useSession } from '../session';
import type { Row, ShellData } from '../shell';
import { KindLabel, ObjId, StatusPill, kindStyle, relativeTime, shortId } from '../components';
import { useActorNames } from './people';
// The record shapes the home pages read are declared once, beside the graph they feed.
import {
  newest,
  type Flow,
  type MapClaim,
  type MapCycle,
  type MapExperiment,
  type MapReview,
  type MapTask,
} from './map-data';

/**
 * The morning page: what needs me, what is running, what has been recorded. One
 * column of record cards carrying the server's own sentences, ordered by whose
 * move each is (see `whose`). Every source is gated on its owning ui.shell row,
 * so it goes quiet with its plugin while the Hooks keep their order. An absent
 * value is never rendered as zero and an error is never rendered as empty.
 */

type PostLite = { id: string; authorId: string; body: string; createdAt: string };
type AgentLite = {
  id: string;
  name: string;
  status: string;
  currentExecutionId: string | null;
  currentAssignment: { label: string } | null;
};
type SessionsLite = { agents?: AgentLite[]; runners: { live: boolean }[]; queueTotal: number };
/** The three lists the work blocks share, read once for the whole page. */
type List<T> = { row?: Row; load: Loaded<T[]> };
export type Work = {
  experiments: List<MapExperiment>;
  tasks: List<MapTask>;
  cycles: List<MapCycle>;
};
/** An open record, and once its guidance is in, the sentences it stands on. */
interface Line {
  id: string;
  kind: string;
  name: ReactNode;
  to: string;
  at: string;
  mine: boolean;
  state?: string;
  meta?: ReactNode;
  says?: string[];
}
/** Whose move a record is. Anything still moving under its own power is `moving`. */
type Whose = 'yours' | 'agent' | 'nobody' | 'unknown' | 'moving';
type Lines = Record<Whose, Line[]>;
export interface Standing {
  lines: Lines;
  /** Open records whose guidance the eight fixed hook slots could not ask for. */
  capped: number;
  reviews?: Loaded<MapReview[]>;
  loads: Loaded<unknown>[];
}
type Named = (id: string | null | undefined) => string | undefined;

/** Guidance is asked for one record at a time, so the page asks for a few. */
const CAP = 8;
/** Codes meaning another role must act, as scope.require and the policies throw them. */
const ROLE = ['forbidden', 'membership_required', 'stale_lease'];
const ENDED = ['complete', 'abandoned', 'failed'];
const KIND: Record<string, string> = {
  design_review: 'Design review',
  experiment_review: 'Results review',
};

const rowOf = (rows: Row[], kind: string) => rows.find((row) => row.view.kind === kind);
const when = (iso: string) => (
  <time dateTime={iso} title={iso}>
    {relativeTime(iso)}
  </time>
);
const busy = (loads: { loading: boolean; error?: ApiError }[]) =>
  loads.some((load) => load.loading || !!load.error);

/** The instruction, blockers that do not repeat it, then what it waits on by name. */
const sentences = ({ instruction, blockers, dependencies }: WorkflowDecision) => {
  // The dependency line only adds names the instruction does not already carry.
  const waits = dependencies.filter((item) => !item.settled && !instruction.includes(item.name));
  const on = waits.map((item) => `${item.name} (${item.state})`).join(', ');
  return [instruction, ...blockers.map((item) => item.message)]
    .concat(waits.length ? `Waiting on ${on}…` : [])
    .filter((text, index, all) => !!text && all.indexOf(text) === index);
};
/** The facts every open record shares before its guidance arrives. */
const alive = (item: { workflow: Flow }) => !ENDED.includes(item.workflow.state);
const open = (
  { id, workflow }: { id: string; workflow: Flow },
  kind: string,
  name: string,
  owner: string,
  me: string,
  to: string,
): Line => ({
  id,
  kind,
  name,
  to,
  at: workflow.updatedAt,
  mine: owner === me,
  state: workflow.state,
});
/** The whole ordering policy: four codes, and no promotion of what it cannot read. */
const whose = (decision: WorkflowDecision, mine: boolean): Whose | null => {
  const codes = decision.blockers.map((blocker) => blocker.code);
  if (!codes.length) return null;
  if (mine && codes.includes('input_required')) return 'yours';
  if (codes.some((code) => ROLE.includes(code))) return 'agent';
  if (codes.includes('dependencies_pending')) return 'nobody';
  return 'unknown';
};
/** One card: its kind, the record's name, the sentences it stands on, its state. */
function Item({
  kind,
  to,
  title,
  meta,
  state,
  say,
}: {
  kind: string;
  to: string;
  title: ReactNode;
  meta?: ReactNode;
  state?: string;
  say?: string[];
}) {
  return (
    <li className="record ov-row" style={kindStyle(kind)}>
      <KindLabel kind={kind} />
      <Link className="ov-name" to={to}>
        {title}
      </Link>
      {say?.map((text) => (
        <p className="ov-say" key={text} title={text}>
          {text}
        </p>
      ))}
      {meta && <span className="ov-meta">{meta}</span>}
      {state && <StatusPill value={state} />}
    </li>
  );
}

/** Every open line reads the same way: the state gives way to a sentence. */
const lineOf = (line: Line) => (
  <Item
    key={line.id}
    kind={line.kind}
    to={line.to}
    title={line.name}
    state={line.says ? undefined : line.state}
    meta={line.meta ?? when(line.at)}
    say={line.says}
  />
);

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

const useDecision = (instanceId: string | undefined) =>
  useTool<WorkflowDecision>(
    instanceId ? 'workflow.status_and_next' : null,
    { instanceId: instanceId ?? '' },
    { every: 10000 },
  );
/** Hooks cannot be called in a loop, so the cap is eight fixed slots. */
function useDecisions(ids: string[]): Loaded<WorkflowDecision>[] {
  return [
    useDecision(ids[0]),
    useDecision(ids[1]),
    useDecision(ids[2]),
    useDecision(ids[3]),
    useDecision(ids[4]),
    useDecision(ids[5]),
    useDecision(ids[6]),
    useDecision(ids[7]),
  ].slice(0, ids.length);
}

/** Sort every open record, and every open review, into whose move it is. */
export function useStanding(rows: Row[], work: Work, me: string, named: Named): Standing {
  const reviewsRow = rowOf(rows, 'reviews');
  const reviews = useTool<MapReview[]>(reviewsRow ? 'review.list' : null);
  const { row: experimentsRow, load: experiments } = work.experiments;
  const { row: tasksRow, load: tasks } = work.tasks;
  const { row: cyclesRow, load: cycles } = work.cycles;
  // Experiments and cycles carry no inline guidance; the newest few are asked for theirs.
  const asked = newest(
    [
      ...(experimentsRow ? (experiments.data ?? []).filter(alive) : []).map((item) => ({
        ...open(
          item,
          'experiments',
          item.name,
          item.ownerId,
          me,
          `${experimentsRow!.path}/${item.id}`,
        ),
        meta: (
          <>
            attempt {item.attempt.index} · {when(item.workflow.updatedAt)}
          </>
        ),
      })),
      ...(cyclesRow ? (cycles.data ?? []).filter(alive) : []).map((item) =>
        open(item, 'research', item.name, item.ownerId, me, cyclesRow!.path),
      ),
    ],
    (item) => item.at,
  );
  const decisions = useDecisions(asked.slice(0, CAP).map((item) => item.id));
  const capped = Math.max(0, asked.length - CAP);
  const lines: Lines = { yours: [], agent: [], nobody: [], unknown: [], moving: [] };
  const add = (bucket: Whose, line: Line) => lines[bucket].push(line);
  /** Without a readable blocker a record is simply moving, never promoted. */
  const place = (item: Line, decision?: WorkflowDecision, failed?: ApiError) => {
    const bucket = decision && whose(decision, item.mine);
    if (failed) add('unknown', { ...item, says: [`Guidance is unavailable (${failed.code}).`] });
    else if (bucket && decision) add(bucket, { ...item, says: sentences(decision) });
    else add('moving', item);
  };
  if (tasksRow)
    for (const task of (tasks.data ?? []).filter((item) => !item.guidance.terminal))
      place(
        open(task, 'tasks', task.title, task.producerId, me, `${tasksRow.path}/${task.id}`),
        task.guidance,
      );
  asked.forEach((item, index) => place(item, decisions[index]?.data, decisions[index]?.error));
  if (reviewsRow)
    for (const review of (reviews.data ?? []).filter((item) =>
      ['requested', 'started'].includes(item.status),
    )) {
      // A review names its subject through the lists the other blocks already read.
      const subject = experiments.data?.find((item) => item.id === review.subjectId);
      const name = subject?.name ?? tasks.data?.find((item) => item.id === review.subjectId)?.title;
      const kind = KIND[subject?.workflow.state ?? ''] ?? 'Review';
      const held = review.reviewerId;
      const mine = review.status === 'requested' || held === me;
      const how = !held
        ? 'waiting for a reviewer to claim it'
        : held === me
          ? 'claimed by you and still open'
          : `with ${named(held) ?? shortId(held)}`;
      add(mine ? 'yours' : 'agent', {
        id: review.id,
        kind: 'reviews',
        name: name ?? <ObjId id={review.subjectId} />,
        to: `${reviewsRow.path}/${review.id}`,
        at: review.createdAt,
        mine,
        says: [`${kind}, ${how}.`],
      });
    }
  for (const bucket of Object.keys(lines) as Whose[])
    lines[bucket] = newest(lines[bucket], (line) => line.at);
  return { lines, capped, reviews: reviewsRow && reviews, loads: [reviews, ...decisions] };
}

/** Block 1. What is yours to move, then any row that cannot speak for itself. */
function NeedsYou({ rows, standing }: { rows: Row[]; standing: Standing }) {
  const yours = standing.lines.yours;
  const unwell = rows.filter(
    (row) => row.status.state === 'degraded' || row.status.state === 'unavailable',
  );
  return (
    <Block title="Needs you" count={yours.length + unwell.length}>
      {standing.reviews && <Trouble what="reviews" load={standing.reviews} />}
      {yours.map(lineOf)}
      {unwell.map((row) => (
        <Item
          key={row.id}
          kind={row.view.kind}
          to={row.path}
          title={row.label}
          state={row.status.state}
          meta={row.status.detail}
        />
      ))}
      {!yours.length && !unwell.length && !busy(standing.loads) && (
        <li className="ov-none">Nothing needs you right now.</li>
      )}
      {/* The one number on this page that is partial says so: guidance is asked for
          one record at a time, so only the newest few were asked. */}
      {standing.capped > 0 && (
        <li className="ov-row ov-note">
          Estimated: the {CAP} most recently updated records were asked what they are waiting on;{' '}
          {standing.capped} more are listed under In motion.
        </li>
      )}
    </Block>
  );
}

/** Block 2. What waits on an agent, then on nobody, then on an unreadable code,
 * and last the work and the agents that are actually moving. */
function InMotion({ rows, work, standing }: { rows: Row[]; work: Work; standing: Standing }) {
  const sessionsRow = rowOf(rows, 'sessions');
  const { row: experimentsRow, load: experiments } = work.experiments;
  const { row: tasksRow, load: tasks } = work.tasks;
  const { row: cyclesRow, load: cycles } = work.cycles;
  const { agent, nobody, unknown, moving } = standing.lines;
  const live = useTool<SessionsLite>(
    sessionsRow?.readable ? 'ui.read' : null,
    { rowId: sessionsRow?.id ?? '' },
    { every: 10000 },
  );
  const agents = (live.data?.agents ?? []).filter((item) => item.status !== 'retired');
  if (!cyclesRow && !experimentsRow && !tasksRow && !sessionsRow) return null;
  return (
    <Block title="In motion">
      {cyclesRow && <Trouble what="cycles" load={cycles} />}
      {experimentsRow && <Trouble what="experiments" load={experiments} />}
      {tasksRow && <Trouble what="tasks" load={tasks} />}
      {sessionsRow && <Trouble what="agents" load={live} />}
      {agent.map(lineOf)}
      {nobody.map(lineOf)}
      {unknown.map(lineOf)}
      {moving.map(lineOf)}
      {sessionsRow &&
        agents.map((item) => (
          <Item
            key={item.id}
            kind="sessions"
            to={sessionsRow.path}
            title={item.name}
            state={item.currentExecutionId ? 'assigned' : 'unassigned'}
            meta={item.currentAssignment?.label}
          />
        ))}
      {live.data && (
        <li className="ov-row ov-note">
          {live.data.runners.filter((runner) => runner.live).length} of {live.data.runners.length}{' '}
          runners connected · {live.data.queueTotal} waiting
        </li>
      )}
      {![agent, nobody, unknown, moving, agents].some((group) => group.length > 0) &&
        !busy([...standing.loads, cycles, experiments, tasks, live]) && (
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
  const claims = useTool<MapClaim[]>(claimsRow ? 'claim.list' : null);
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
            kind="claims"
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
            kind="feed"
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
            kind="experiments"
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
  const cyclesRow = rowOf(rows, 'research');
  const settings = rows.find((row) => row.group === 'settings');
  const read = useTool<Project>('project.get', {}, { every: 10000 });
  const experiments = useTool<MapExperiment[]>(experimentsRow ? 'experiment.list' : null);
  const tasks = useTool<MapTask[]>(tasksRow ? 'task.list' : null);
  const cycles = useTool<MapCycle[]>(cyclesRow ? 'research.list' : null);
  const named = useActorNames();
  const project = read.data ?? session.project;
  const intro = project.summary?.trim().split(/\n\s*\n/)[0];
  const work: Work = {
    experiments: { row: experimentsRow, load: experiments },
    tasks: { row: tasksRow, load: tasks },
    cycles: { row: cyclesRow, load: cycles },
  };
  const standing = useStanding(rows, work, session.actor.id, named);
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
          <NeedsYou rows={rows} standing={standing} />
          <InMotion rows={rows} work={work} standing={standing} />
          <Recorded rows={rows} work={work} named={named} />
        </>
      )}
    </div>
  );
}
