import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { type ApiError, type Loaded } from '../api';
import { useSession } from '../session';
import type { Row, ShellData } from '../shell';
import { KindLabel, StatusPill, relativeTime } from '../components';
import { namesOf } from './people';
// The record shapes the home pages read are declared once, beside the graph they feed.
import { newest, useHome, type Flow, type HomeData } from './map-data';

/**
 * The morning page: what needs me, what is running, what has been recorded. One
 * column of record cards carrying the server's own sentences, ordered by whose
 * move each is (see `whose`). Every block is gated on its owning ui.shell row, so
 * it goes quiet with its plugin, and every fact on the page comes from the one
 * read the rail and the map share. An absent value is never rendered as zero and
 * an error is never rendered as empty.
 */

/** An open record, and the sentences its gate stands on. */
interface Line {
  id: string;
  kind: string;
  name: ReactNode;
  to: string;
  at: string;
  mine: boolean;
  says: string[];
}
/** Whose move a record is; one that is simply running is nobody's and is not listed. */
type Whose = 'yours' | 'agent' | 'nobody' | 'unknown';
export type Lines = Record<Whose, Line[]>;
type Named = (id: string | null | undefined) => string | undefined;

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

/**
 * The instruction, blockers that do not repeat it, then what it waits on by name. A record
 * in an agent's hands says whose: the refusals the viewer would meet are not its story.
 */
const sentences = (
  { instruction, blockers, dependencies }: WorkflowDecision,
  withWhom?: string | undefined,
) => {
  // The dependency line only adds names the instruction does not already carry.
  const waits = dependencies.filter((item) => !item.settled && !instruction.includes(item.name));
  const on = waits.map((item) => `${item.name} (${item.state})`).join(', ');
  return (withWhom ? [`With ${withWhom}.`] : [instruction, ...blockers.map((item) => item.message)])
    .concat(waits.length ? `Waiting on ${on}…` : [])
    .filter((text, index, all) => !!text && all.indexOf(text) === index);
};
/** The whole ordering policy: four codes, and no promotion of what it cannot read. */
const whose = (decision: WorkflowDecision, mine: boolean): Whose | null => {
  const codes = decision.blockers.map((blocker) => blocker.code);
  if (!codes.length) return null;
  if (mine && codes.includes('input_required')) return 'yours';
  // A prerequisite that ended without succeeding is the owner's decision, nobody's wait.
  if (codes.includes('dependency_failed')) return mine ? 'yours' : 'unknown';
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
    <li className="record ov-row">
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

/** Every open line reads the same way: the record, the sentence it stands on, when. */
const lineOf = (line: Line) => (
  <Item
    key={line.id}
    kind={line.kind}
    to={line.to}
    title={line.name}
    meta={when(line.at)}
    say={line.says}
  />
);

/** The one read still arriving, or one that failed, in the same row grammar. */
function Trouble({ load }: { load: { loading: boolean; error?: ApiError } }) {
  if (!load.error) return load.loading ? <li className="ov-row ov-note">Loading…</li> : null;
  return (
    <li className="ov-row ov-note" role="alert">
      Could not load <span className="mono">({load.error.code})</span>
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

/** What every open record carries before its gate is read. */
type Open = { id: string; name: string; owner: string; workflow: Flow };
const openWork = (home: HomeData | undefined): [string, Open[]][] => [
  [
    'tasks',
    (home?.tasks ?? []).map((item) => ({
      id: item.id,
      name: item.title,
      owner: item.producerId,
      workflow: item.workflow,
    })),
  ],
  [
    'experiments',
    (home?.experiments ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      owner: item.ownerId,
      workflow: item.workflow,
    })),
  ],
  [
    'research',
    (home?.cycles ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      owner: item.ownerId,
      workflow: item.workflow,
    })),
  ],
];

/**
 * Sort every open record, and every open review, into whose move it is. The gate of
 * each one comes from the same read the page draws, so the order is one answer's
 * and never a race between twenty.
 */
export function standingOf(
  rows: Row[],
  home: HomeData | undefined,
  me: string,
  named: Named,
): Lines {
  const gate = new Map((home?.workflows?.workflows ?? []).map((item) => [item.instanceId, item]));
  const lines: Lines = { yours: [], agent: [], nobody: [], unknown: [] };
  for (const [kind, items] of openWork(home)) {
    const row = rowOf(rows, kind);
    if (!row) continue;
    for (const item of items) {
      const decision = gate.get(item.id);
      if (decision ? decision.terminal : ENDED.includes(item.workflow.state)) continue;
      const mine = item.owner === me;
      const bucket = decision && whose(decision, mine);
      if (bucket && decision)
        lines[bucket].push({
          id: item.id,
          kind,
          name: item.name,
          to: `${row.path}/${item.id}`,
          at: item.workflow.updatedAt,
          mine,
          says: sentences(
            decision,
            bucket === 'agent' ? (named(item.owner) ?? 'its producer') : undefined,
          ),
        });
    }
  }
  const reviewsRow = rowOf(rows, 'reviews');
  if (reviewsRow)
    for (const review of (home?.reviews ?? []).filter((item) =>
      ['requested', 'started'].includes(item.status),
    )) {
      // A review names its subject through the lists the other blocks already read.
      const subject = home?.experiments?.find((item) => item.id === review.subjectId);
      const name =
        subject?.name ?? home?.tasks?.find((item) => item.id === review.subjectId)?.title;
      const kind = KIND[subject?.workflow.state ?? ''] ?? 'Review';
      const held = review.reviewerId;
      const mine = review.status === 'requested' || held === me;
      const how = !held
        ? 'waiting for a reviewer to claim it'
        : held === me
          ? 'claimed by you and still open'
          : named(held)
            ? `with ${named(held)}`
            : 'claimed and still open';
      lines[mine ? 'yours' : 'agent'].push({
        id: review.id,
        kind: 'reviews',
        name,
        to: `${reviewsRow.path}/${review.id}`,
        at: review.createdAt,
        mine,
        says: [`${kind}, ${how}.`],
      });
    }
  for (const bucket of Object.keys(lines) as Whose[])
    lines[bucket] = newest(lines[bucket], (line) => line.at);
  return lines;
}

/** What is yours to move, then any row that cannot speak for itself. */
function NeedsYou({ rows, lines, load }: { rows: Row[]; lines: Lines; load: Loaded<HomeData> }) {
  const yours = lines.yours;
  const unwell = rows.filter(
    (row) => row.status.state === 'degraded' || row.status.state === 'unavailable',
  );
  return (
    <Block title="Needs you" count={yours.length + unwell.length}>
      <Trouble load={load} />
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
      {!yours.length && !unwell.length && load.data && (
        <li className="ov-none">Nothing needs you right now.</li>
      )}
    </Block>
  );
}

/** The other two lists: whose move it is when it is not yours. */
const Waiting = ({ title, lines }: { title: string; lines: Line[] }) =>
  lines.length ? (
    <Block title={title} count={lines.length}>
      {lines.map(lineOf)}
    </Block>
  ) : null;

export function OverviewView({ shell }: { shell: ShellData }) {
  const session = useSession();
  const rows = shell.rows;
  const home = useHome();
  const lines = standingOf(rows, home.data, session.actor.id, namesOf(home.data?.actors));
  return (
    <div className="page-stage overview">
      <h1 className="page-title">Now</h1>
      <NeedsYou rows={rows} lines={lines} load={home} />
      <Waiting title="With an agent" lines={lines.agent} />
      <Waiting title="Waiting" lines={[...lines.nobody, ...lines.unknown]} />
    </div>
  );
}
