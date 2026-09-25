import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { WorkflowDecision, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import { refreshTools, type Loaded } from '../api';
import { useCommand } from '../mutations';
import { useSession } from '../session';
import type { Row, ShellData } from '../shell';
import {
  Ago,
  EmptyState,
  Failure,
  KindLabel,
  LoadState,
  StatusPill,
  Summary,
  kindOf,
} from '../components';
import { ArrowRightIcon } from '../icons';
import type { RecordNames } from '../markdown';
import { firstPersonMove } from './code-blockers';
import { namesOf } from './people';
// The record shapes the home pages read are declared once, beside the graph they feed.
import { newest, useHome, type Flow, type HomeData } from './map-data';

/**
 * The standing line: what needs me, what is with an agent, what is waiting. One
 * column of record cards ordered by whose move each is (see `whose`), and each
 * says its move in one sentence a person reads, made from facts the gate carries —
 * the ready action, the blocker's code, the prerequisite's name, who holds it. The
 * server's own instruction is written for the agent holding the tool, so it is
 * never the headline: it stays on the card, folded, for whoever operates the
 * agents. A blocker another plugin published whose next move is a person's speaks
 * in the same voice, through the one vocabulary `code-blockers.ts` holds, and is
 * the one thing that puts ended work on this page at all — a publication nobody
 * has merged is a wait on a human and not a record that is running.
 * Every block is gated on its owning ui.shell row, so it goes quiet with
 * its plugin, and every fact on the page comes from the one read the rail and the
 * map share. An absent value is never rendered as zero and an error is never
 * rendered as empty.
 */

/** An open record, the sentence it stands on, and the way to act on it. */
interface Line {
  id: string;
  kind: string;
  name: ReactNode;
  to: string;
  at: string;
  mine: boolean;
  /** The move in plain words: the ask, or whose hands the record is in. */
  sentence: string;
  /** Whose work it is, where the sentence does not already name them. */
  who?: string;
  /** The server's own words to whoever holds the tool. */
  says: string[];
  /** The review this page may claim where it stands, because the gate says it is ready. */
  claim?: string;
  /** The desk where the move is made, where a page of this app holds one. */
  desk?: { label: string; to: string };
}
/** Whose move a record is; one that is simply running is nobody's and is not listed. */
type Whose = 'yours' | 'agent' | 'nobody' | 'unknown';
export type Lines = Record<Whose, Line[]>;
type Named = (id: string | null | undefined) => string | undefined;

/** Codes meaning another role must act, as scope.require and the policies throw them. */
const ROLE = ['forbidden', 'membership_required', 'stale_lease'];
const ENDED = ['complete', 'abandoned', 'failed'];

const rowOf = (rows: Row[], kind: string) => rows.find((row) => row.view.kind === kind);

/**
 * The whole ordering policy: four codes, and no promotion of what it cannot read. A
 * gate with no blocker is simply running — unless it holds the reader's own move
 * (`asked`): work sent back for changes, or never begun, reports only `begin` as
 * ready, which no page here sends, while its delivery already waits on the reader.
 */
const whose = (decision: WorkflowDecision, mine: boolean, asked: boolean): Whose | null => {
  const codes = decision.blockers.map((blocker) => blocker.code);
  if (!codes.length) return mine && asked ? 'yours' : null;
  if (mine && codes.includes('input_required')) return 'yours';
  // A prerequisite that ended without succeeding is the owner's decision, nobody's wait.
  if (codes.includes('dependency_failed')) return mine ? 'yours' : 'unknown';
  if (codes.some((code) => ROLE.includes(code))) return 'agent';
  if (codes.includes('dependencies_pending')) return 'nobody';
  return 'unknown';
};

/** What each ready action asks of the person whose record it is, by the action's own name. */
const ASKS: Record<string, string> = {
  submit_delivery: 'Deliver the work for review',
  submit_design: 'Submit the design for review',
  submit_results: 'Submit the results for review',
};
/** The owner's move the gate holds open: the same edge the record's own page hangs its desk on. */
const askOf = (decision: WorkflowDecision) =>
  decision.actions.find((action) => action.action in ASKS && action.status !== 'blocked');
/**
 * The asks a page of this app can carry out, by the tool the gate names: the control's
 * words, and the place on the record's own page where the desk for it stands. An ask
 * with no desk here is made through an agent, so its card offers no control at all.
 */
export const DELIVER = 'deliver';
const DESKS: Record<string, { label: string; at: string }> = {
  'task.submit_delivery': { label: 'Submit delivery', at: DELIVER },
};
/** What a reviewer is asked to read, by the state its subject waits in. */
const READS: Record<string, string> = {
  in_review: 'Review this delivery',
  design_review: 'Review this design',
  experiment_review: 'Review these results',
};
/** A gate that is a review's, not its owner's: the work is out of the owner's hands. */
const REVIEWING: Record<string, string> = {
  review_required: 'Waiting for a reviewer',
  review_recovery_pending: 'Waiting for a reviewer',
  independent_review: 'In review',
};
const listed = (names: string[]) =>
  names.length > 2
    ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
    : names.join(' and ');

/**
 * One record's move as a sentence. Every word comes from a fact of the gate: the
 * action that is ready, the gate's own name, a prerequisite's name and whether it
 * failed, the name of whoever holds the work, whether a review sent it back. A gate
 * this page cannot read carries the server's own reason — under a heading that
 * already says Waiting, the bare word would say nothing — and only waits without one.
 */
export function recordSentence(
  bucket: Whose,
  gate: {
    currentGate?: string;
    nextAction: { action: string } | null;
    dependencies: Pick<WorkflowDependency, 'name' | 'settled' | 'failed'>[];
    blockers?: { message: string }[];
  },
  holder?: string,
  returned = false,
): string {
  const failed = gate.dependencies.find((item) => item.failed)?.name;
  const pending = gate.dependencies.filter((item) => !item.settled && !item.failed);
  if (bucket === 'yours') {
    if (failed) return `Decide what happens next: ${failed} failed`;
    const ask = ASKS[gate.nextAction?.action ?? ''];
    if (!ask) return 'Needs your input';
    return returned ? `Changes requested: ${ask[0].toLowerCase()}${ask.slice(1)}` : ask;
  }
  // Work out for review is out of its owner's hands whichever code its gate refuses with.
  const reviewing = REVIEWING[gate.currentGate ?? ''];
  if (reviewing) return reviewing;
  if (bucket === 'agent') return holder ? `With ${holder}` : 'With its owner';
  if (bucket === 'nobody')
    return pending.length
      ? `Waiting on ${listed(pending.map((item) => item.name))}`
      : 'Waiting on earlier work';
  if (failed) return `Stopped: ${failed} failed`;
  return gate.blockers?.find((item) => item.message)?.message ?? 'Waiting';
}

/** One open review's move: to be claimed, to be finished, or in someone else's hands. */
export function reviewSentence(
  standing: 'open' | 'yours' | 'unclaimed' | 'theirs',
  subjectState?: string,
  reviewer?: string,
): string {
  if (standing === 'open') return READS[subjectState ?? ''] ?? 'Review this work';
  if (standing === 'yours') return 'Finish your review';
  if (standing === 'unclaimed') return 'Waiting for a reviewer';
  return reviewer ? `In review with ${reviewer}` : 'In review';
}

/** What the server told whoever holds the tool: its instruction, then each refusal, once. */
const said = ({ instruction, blockers }: WorkflowDecision) =>
  [instruction, ...blockers.map((item) => item.message)].filter(
    (text, index, all) => !!text && all.indexOf(text) === index,
  );

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
  /** Who is reading, and whether they are a person: the publication verbs answer only one. */
  viewer: { id: string; role: string; signedIn?: boolean },
  named: Named,
): Lines {
  const me = viewer.id;
  const gate = new Map((home?.workflows?.workflows ?? []).map((item) => [item.instanceId, item]));
  const work = openWork(home);
  // A blocker that names another record names it the way this app names it, here as on the
  // record's own page; the server's label is the fallback and an id names nobody.
  const recordNames: RecordNames = new Map(
    work.flatMap(([, items]) => items.map((item) => [item.id, { name: item.name }] as const)),
  );
  const lines: Lines = { yours: [], agent: [], nobody: [], unknown: [] };
  const subjects = new Map<string, Open>();
  const reviewsRow = rowOf(rows, 'reviews');
  const reviews = reviewsRow ? (home?.reviews ?? []) : [];
  const openReviews = reviews.filter((item) => ['requested', 'started'].includes(item.status));
  // A record out for review is listed once, as its review: that card names it and leads to it.
  const underReview = new Set(openReviews.map((item) => item.subjectId));
  // The newest verdict on a record, to tell work that was sent back from work never delivered.
  const lastVerdict = new Map<string, string | null>();
  for (const review of newest(
    reviews.filter((item) => item.status === 'submitted'),
    (item) => item.createdAt,
  ))
    if (!lastVerdict.has(review.subjectId)) lastVerdict.set(review.subjectId, review.verdict);
  for (const [kind, items] of work) {
    const row = rowOf(rows, kind);
    for (const item of items) {
      subjects.set(item.id, item);
      if (!row || underReview.has(item.id)) continue;
      const decision = gate.get(item.id);
      // A blocker another plugin published whose next move is a person's outranks the
      // record's own gate and stands here whatever that gate says — including on work
      // that has ended and waits on somebody to carry its accepted code to main.
      const held = decision && firstPersonMove(decision.providerBlockers ?? [], recordNames);
      if (held) {
        // Whose move it is and whether this app can make it are two questions: a move no
        // page here carries out is still the reader's, and belongs under Needs you with no
        // control at all. Only a wait on the server is nobody's.
        const yours =
          held.move.whose !== 'nobody' && viewer.role === 'operator' && !!viewer.signedIn;
        lines[yours ? 'yours' : 'unknown'].push({
          id: item.id,
          kind,
          name: item.name,
          to: `${row.path}/${item.id}`,
          at: held.blocker.since ?? item.workflow.updatedAt,
          mine: item.owner === me,
          sentence: held.move.sentence,
          who: held.move.who,
          says: [...said(decision), held.blocker.next].filter(
            (text, index, all) =>
              !!text && all.indexOf(text) === index && text !== held.move.sentence,
          ) as string[],
          ...(yours && held.move.control
            ? { desk: { label: held.move.control.label, to: held.move.control.to } }
            : {}),
        });
        continue;
      }
      if (decision ? decision.terminal : ENDED.includes(item.workflow.state)) continue;
      const mine = item.owner === me;
      // Whoever began the step holds it; before anyone has, it is its owner's.
      const began = decision?.workStart?.actorId;
      const ask = decision && (!began || began === me) ? askOf(decision) : undefined;
      const bucket = decision && whose(decision, mine, !!ask);
      if (!bucket || !decision) continue;
      const next = (bucket === 'yours' && ask) || decision.nextAction;
      const desk = bucket === 'yours' && next?.status !== 'blocked' && DESKS[next?.tool ?? ''];
      const verdict = lastVerdict.get(item.id);
      const sentence = recordSentence(
        bucket,
        { ...decision, nextAction: next },
        (began !== me && named(began)) || named(item.owner),
        !!verdict && verdict !== 'pass',
      );
      lines[bucket].push({
        id: item.id,
        kind,
        name: item.name,
        to: `${row.path}/${item.id}`,
        at: item.workflow.updatedAt,
        mine,
        sentence,
        // Where the server's reason is the headline, the fold does not say it again.
        says: said(decision).filter((text) => text !== sentence),
        desk: desk ? { label: desk.label, to: `${row.path}/${item.id}#${desk.at}` } : undefined,
      });
    }
  }
  if (reviewsRow)
    for (const review of openReviews) {
      // A review names its subject through the lists the other blocks already read.
      const subject = subjects.get(review.subjectId);
      const held = review.reviewerId;
      // Claiming is offered here only where the subject's own gate says this caller may.
      const start = gate
        .get(review.subjectId)
        ?.actions.find((action) => action.tool === 'review.start');
      // Whether an unclaimed review is this viewer's move is the server's answer, not ours:
      // the list holds the contributor exclusions, which this page never sees, and the gate
      // the rest, such as a Git task's review, which only a leased reviewer may claim.
      const mine =
        review.status === 'requested'
          ? !!review.claimable && start?.status !== 'blocked'
          : held === me;
      const standing = !held ? (mine ? 'open' : 'unclaimed') : held === me ? 'yours' : 'theirs';
      lines[mine ? 'yours' : 'agent'].push({
        id: review.id,
        kind: 'reviews',
        name: subject?.name,
        to: `${reviewsRow.path}/${review.id}`,
        at: review.createdAt,
        mine,
        sentence: reviewSentence(standing, subject?.workflow.state, named(held)),
        who: mine ? named(subject?.owner) : undefined,
        says: [],
        claim: standing === 'open' && start?.status === 'ready' ? review.id : undefined,
      });
    }
  for (const bucket of Object.keys(lines) as Whose[])
    lines[bucket] = newest(lines[bucket], (line) => line.at);
  return lines;
}

/**
 * The one control a needs-you card carries, and only where it does the move. A
 * review the gate says is ready to claim is claimed where it stands — the same one
 * command the verdict page sends — and the page then opens the desk it unlocked; a
 * delivery is made at the desk on the task's own page, so the control goes there. A
 * move no page of this app can make has no control: the record's name is already
 * the way to it, and an accent that only repeated that link would promise an act.
 */
function Move({ line }: { line: Line }) {
  const navigate = useNavigate();
  const claim = useCommand<{ id: string; status: string }>({
    tool: 'review.start',
    idempotent: true,
    validate: (value) => !!value && value.id === line.claim && value.status === 'started',
    onSuccess: () => {
      refreshTools('ui.home', 'review.list', 'task.list', 'experiment.list');
      navigate(line.to);
    },
  });
  if (!line.claim)
    return line.desk ? (
      <div className="ov-move">
        <Link className="btn btn--primary" to={line.desk.to}>
          {line.desk.label} <ArrowRightIcon size={14} />
        </Link>
      </div>
    ) : null;
  return (
    <div className="ov-move">
      <button
        className="btn btn--primary"
        disabled={claim.busy}
        onClick={() => void claim.submit({ reviewId: line.claim })}
      >
        {claim.retry ? 'Retry same request' : claim.busy ? 'Claiming…' : 'Claim review'}
      </button>
      <Failure message={claim.error} />
    </div>
  );
}

/**
 * One card, read top to bottom in the order a person scans it: the kind, the
 * record's name, the sentence, who and when — and, where it is the reader's move,
 * the control at its end.
 */
function Card({ line, acts }: { line: Line; acts?: boolean }) {
  return (
    <li className="record ov-row">
      <div className="ov-body">
        <KindLabel kind={line.kind} />
        <Link className="ov-name" to={line.to}>
          {line.name ?? kindOf(line.kind).label}
        </Link>
        <p className="ov-say">{line.sentence}</p>
        <span className="ov-meta">
          {line.who && <span>{line.who}</span>}
          <Ago at={line.at} />
        </span>
        {line.says.length > 0 && (
          <details className="ov-said">
            <Summary>Agent instructions</Summary>
            {line.says.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </details>
        )}
      </div>
      {acts && <Move line={line} />}
    </li>
  );
}

function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="ov-block">
      <h2 className="ov-h">
        {title}
        {/* A real space, so the name and the number are heard as two words. */}
        {!!count && (
          <>
            {' '}
            <span className="ov-count">{count}</span>
          </>
        )}
      </h2>
      <ul className="ov-list">{children}</ul>
    </section>
  );
}

/** The three lists, from lines already sorted: what is yours, then whose move the rest is. */
export function StandingLine({
  rows,
  lines,
  load,
}: {
  rows: Row[];
  lines: Lines;
  load: Pick<Loaded<HomeData>, 'loading' | 'error' | 'data' | 'loadedAt'>;
}) {
  // A row that cannot speak for itself needs someone, and says so in its own state.
  const unwell = rows.filter(
    (row) => row.status.state === 'degraded' || row.status.state === 'unavailable',
  );
  const waiting = [...lines.nobody, ...lines.unknown];
  const clear = !lines.yours.length && !unwell.length;
  return (
    <>
      <LoadState {...load} columns={2} />
      {load.data && clear && (
        <div className="ov-clear">
          <EmptyState icon="check" title="Nothing needs you" />
        </div>
      )}
      {!clear && (
        <Block title="Needs you" count={lines.yours.length + unwell.length}>
          {lines.yours.map((line) => (
            <Card key={line.id} line={line} acts />
          ))}
          {unwell.map((row) => (
            <li className="record ov-row" key={row.id}>
              <div className="ov-body">
                <KindLabel kind={row.view.kind} />
                <Link className="ov-name" to={row.path}>
                  {row.label}
                </Link>
                {row.status.detail && <p className="ov-say">{row.status.detail}</p>}
                <StatusPill value={row.status.state} />
              </div>
            </li>
          ))}
        </Block>
      )}
      {lines.agent.length > 0 && (
        <Block title="With an agent" count={lines.agent.length}>
          {lines.agent.map((line) => (
            <Card key={line.id} line={line} />
          ))}
        </Block>
      )}
      {waiting.length > 0 && (
        <Block title="Waiting" count={waiting.length}>
          {waiting.map((line) => (
            <Card key={line.id} line={line} />
          ))}
        </Block>
      )}
    </>
  );
}

export function OverviewView({ shell }: { shell: ShellData }) {
  const session = useSession();
  const home = useHome();
  // The publication verbs refuse a key and a bearer actor outright, so whether the reader
  // is a person is part of whose move a Code blocker is.
  const lines = standingOf(
    shell.rows,
    home.data,
    { ...session.actor, signedIn: session.account.kind === 'user' },
    namesOf(home.data?.actors),
  );
  return (
    <div className="page-stage overview">
      <h1 className="page-title">Now</h1>
      <StandingLine rows={shell.rows} lines={lines} load={home} />
    </div>
  );
}
