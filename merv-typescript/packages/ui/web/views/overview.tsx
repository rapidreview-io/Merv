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
  words,
} from '../components';
import { ArrowRightIcon } from '../icons';
import type { RecordNames } from '../markdown';
import { firstPersonMove } from './code-blockers';
import { namesOf } from './people';
// The record shapes the home pages read are declared once, beside the graph they feed.
import { newest, useHome, type Flow, type HomeData } from './map-data';

/**
 * Now: what needs the reader. One column of record cards, each saying its move in one
 * sentence a person reads, made from facts the gate carries — the ready action, a
 * prerequisite that failed, whether a review sent it back. The server's own instruction is
 * written for the agent holding the tool, so it is never the headline: it stays on the
 * card, folded, for whoever operates the agents. A blocker another plugin published whose
 * next move is this reader's speaks in the same voice, through the one vocabulary
 * `code-blockers.ts` holds, and is the one thing that puts ended work on this page at all —
 * a publication nobody has merged is a wait on a human and not a record that is running.
 * Whose hands everything else is in, and what it waits on, is the Work page's map. Every
 * card is gated on its owning ui.shell row, so it goes quiet with its plugin, and every
 * fact on the page comes from the one read the rail shares. An absent value is
 * never rendered as zero and an error is never rendered as empty.
 */

/** An open record that is the reader's move, the sentence it stands on, and the way to act. */
export interface Line {
  id: string;
  kind: string;
  name: ReactNode;
  to: string;
  at: string;
  /** The move in plain words. */
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
type Named = (id: string | null | undefined) => string | undefined;

/** The cycle's refusals on a child of its own ending unapproved: its wave, its consolidation. */
const STOPS = ['dependency_failed', 'integration_failed'];

const rowOf = (rows: Row[], kind: string) => rows.find((row) => row.view.kind === kind);

/**
 * Whether a record is its owner's move. A gate with no blocker is simply running — unless
 * it holds the owner's own move (`asked`): work sent back for changes, or never begun,
 * reports only `begin` as ready, which no page here sends, while its submission already waits
 * on them. Refused, it is theirs where it asks for their input, or where a prerequisite
 * ended without succeeding and what happens next is theirs to decide.
 */
const yours = (decision: WorkflowDecision, mine: boolean, asked: boolean) => {
  const codes = decision.blockers.map((blocker) => blocker.code);
  return (
    mine &&
    (codes.length ? codes.includes('input_required') || codes.includes('dependency_failed') : asked)
  );
};

/** What each ready action asks of the person whose record it is, by the action's own name. */
const ASKS: Record<string, string> = {
  submit_design: 'Submit the design for review',
  submit_results: 'Submit the results for review',
};
/** The owner's move the gate holds open. */
const askOf = (decision: WorkflowDecision) =>
  decision.actions.find((action) => action.action in ASKS && action.status !== 'blocked');
/** What a reviewer is asked to read, by the state its subject waits in. */
const READS: Record<string, string> = {
  in_review: 'Review this delivery',
  design_review: 'Review this design',
  experiment_review: 'Review these results',
};
/**
 * The owner's move as a sentence. Every word comes from a fact of the gate: a prerequisite
 * that failed and its state, the action that is ready, whether a review sent the work back.
 */
export function recordSentence(
  gate: {
    nextAction: { action: string } | null;
    dependencies: Pick<WorkflowDependency, 'name' | 'state' | 'failed'>[];
  },
  returned = false,
): string {
  const ended = gate.dependencies.find((item) => item.failed);
  if (ended) return `Decide what happens next: ${ended.name} ${words(ended.state)}`;
  const ask = ASKS[gate.nextAction?.action ?? ''];
  if (!ask) return 'Needs your input';
  return returned ? `Changes requested: ${ask[0].toLowerCase()}${ask.slice(1)}` : ask;
}

/** A review that is the reader's move: one to claim, or one of theirs to finish. */
export const reviewSentence = (claimed: boolean, subjectState?: string) =>
  claimed ? 'Finish your review' : (READS[subjectState ?? ''] ?? 'Review this work');

/** What the server told whoever holds the tool: its instruction, then each refusal, once. */
const said = ({ instruction, blockers }: WorkflowDecision) =>
  [instruction, ...blockers.map((item) => item.message)].filter(
    (text, index, all) => !!text && all.indexOf(text) === index,
  );

/** What every open record carries before its gate is read. */
type Open = { id: string; name: string; owner: string; workflow: Flow };
const opened = ({ id, workflow }: Pick<Open, 'id' | 'workflow'>, name: string, owner: string) =>
  ({ id, name, owner, workflow }) satisfies Open;
const openWork = (home: HomeData | undefined): [string, Open[]][] => [
  ['tasks', (home?.tasks ?? []).map((item) => opened(item, item.title, item.producerId))],
  ['experiments', (home?.experiments ?? []).map((item) => opened(item, item.name, item.ownerId))],
  ['research', (home?.cycles ?? []).map((item) => opened(item, item.name, item.ownerId))],
];

/**
 * Every open record, and every open review, that is the reader's move, newest first. The
 * gate of each one comes from the same read the page draws, so the list is one answer's and
 * never a race between twenty.
 */
export function needsYou(
  rows: Row[],
  home: HomeData | undefined,
  /** Who is reading, and whether they are a person: the publication verbs answer only one. */
  viewer: { id: string; role: string; signedIn?: boolean },
  named: Named,
): Line[] {
  const me = viewer.id;
  const gate = new Map((home?.workflows?.workflows ?? []).map((item) => [item.instanceId, item]));
  const work = openWork(home);
  // A blocker that names another record names it the way this app names it, here as on the
  // record's own page; the server's label is the fallback and an id names nobody.
  const recordNames: RecordNames = new Map(
    work.flatMap(([, items]) => items.map((item) => [item.id, { name: item.name }] as const)),
  );
  const lines: Line[] = [];
  // A wave's review is named by the wave, and asked for as work: a wave is no delivery.
  const subjects = new Map<string, Omit<Open, 'workflow'> & { workflow?: Flow }>(
    (home?.reflections ?? []).map((r) => [r.id, { id: r.id, name: r.title, owner: r.ownerId }]),
  );
  const reviewsRow = rowOf(rows, 'reviews');
  const reviews = reviewsRow ? (home?.reviews ?? []) : [];
  const openReviews = reviews.filter((item) => ['requested', 'started'].includes(item.status));
  // A record out for review is its reviewer's move, never its owner's.
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
      const decision = gate.get(item.id);
      if (!row || !decision || underReview.has(item.id)) continue;
      // A blocker another plugin published whose next move is a person's outranks the
      // record's own gate and stands here whatever that gate says — including on work
      // that has ended and waits on somebody to carry its accepted code to main. Whose move
      // it is and whether this app can make it are two questions: a move no page here
      // carries out is still the reader's, with no control at all.
      const held = firstPersonMove(decision.providerBlockers ?? [], recordNames);
      if (held) {
        if (held.move.whose !== 'nobody' && viewer.role === 'operator' && viewer.signedIn)
          lines.push({
            id: item.id,
            kind,
            name: item.name,
            to: `${row.path}/${item.id}`,
            at: held.blocker.since ?? item.workflow.updatedAt,
            sentence: held.move.sentence,
            who: held.move.who,
            says: [...said(decision), held.blocker.next].filter(
              (text, index, all) =>
                !!text && all.indexOf(text) === index && text !== held.move.sentence,
            ) as string[],
            ...(held.move.control
              ? { desk: { label: held.move.control.label, to: held.move.control.to } }
              : {}),
          });
        continue;
      }
      if (decision.terminal) continue;
      // Whoever began the step holds it; before anyone has, it is its owner's.
      const began = decision.workStart?.actorId;
      const ask = !began || began === me ? askOf(decision) : undefined;
      const next = ask || decision.nextAction;
      // A task's delivery names its worker's own commit, which only a leased worker can make.
      if (next?.tool === 'task.submit_delivery' || !yours(decision, item.owner === me, !!ask))
        continue;
      const verdict = lastVerdict.get(item.id);
      // A cycle is stopped only when its gate refuses on its own wave or consolidation task,
      // declared after the work it reflects on, which may fail and stop nothing.
      const stop =
        decision.blockers.some((item) => STOPS.includes(item.code)) &&
        decision.dependencies.filter((item) => item.failed).at(-1);
      const dependencies = decision.dependencies.filter(
        (item) => kind !== 'research' || !item.failed || item === stop,
      );
      const sentence = recordSentence(
        { nextAction: next, dependencies },
        !!verdict && verdict !== 'pass',
      );
      lines.push({
        id: item.id,
        kind,
        name: item.name,
        to: `${row.path}/${item.id}`,
        at: item.workflow.updatedAt,
        sentence,
        // Where the server's reason is the headline, the fold does not say it again.
        says: said(decision).filter((text) => text !== sentence),
      });
    }
  }
  if (reviewsRow)
    for (const review of openReviews) {
      // A review names its subject through the lists the other blocks already read.
      const subject = subjects.get(review.subjectId);
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
          : review.reviewerId === me;
      if (!mine) continue;
      lines.push({
        id: review.id,
        kind: 'reviews',
        name: subject?.name,
        to: `${reviewsRow.path}/${review.id}`,
        at: review.createdAt,
        sentence: reviewSentence(!!review.reviewerId, subject?.workflow?.state),
        who: named(subject?.owner),
        says: [],
        claim: !review.reviewerId && start?.status === 'ready' ? review.id : undefined,
      });
    }
  return newest(lines, (line) => line.at);
}

/**
 * The one control a needs-you card carries, and only where it does the move. A
 * review the gate says is ready to claim is claimed where it stands — the same one
 * command the verdict page sends — and the page then opens the desk it unlocked; a move
 * another plugin names a control for goes to that control's page. A
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
 * record's name, the sentence, who and when, and the control at its end.
 */
function Card({ line }: { line: Line }) {
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
      <Move line={line} />
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

/** A row that cannot speak for itself needs someone, and says so in its own state. */
const unwellOf = (rows: Row[]) =>
  rows.filter((row) => row.status.state === 'degraded' || row.status.state === 'unavailable');

/** What Now lists, from the one home the whole page shares; the rail counts exactly this. */
export function useNow(rows: Row[]) {
  const session = useSession();
  const home = useHome();
  // The publication verbs refuse a key and a bearer actor outright, so whether the reader
  // is a person is part of whose move a Code blocker is.
  const lines = needsYou(
    rows,
    home.data,
    { ...session.actor, signedIn: session.account.kind === 'user' },
    namesOf(home.data?.actors),
  );
  return { home, lines, count: lines.length + unwellOf(rows).length };
}

/** What needs the reader: their own moves, then every row that cannot speak for itself. */
export function NeedsYou({
  rows,
  lines,
  load,
}: {
  rows: Row[];
  lines: Line[];
  load: Pick<Loaded<HomeData>, 'loading' | 'error' | 'data' | 'loadedAt'>;
}) {
  const unwell = unwellOf(rows);
  const count = lines.length + unwell.length;
  return (
    <>
      <LoadState {...load} columns={2} />
      {load.data && !count && (
        <div className="ov-clear">
          <EmptyState icon="check" title="Nothing needs you" />
        </div>
      )}
      {count > 0 && (
        <Block title="Needs you" count={count}>
          {lines.map((line) => (
            <Card key={line.id} line={line} />
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
    </>
  );
}

export function OverviewView({ shell }: { shell: ShellData }) {
  const { home, lines } = useNow(shell.rows);
  return (
    <div className="page-stage overview">
      <h1 className="page-title">Now</h1>
      <NeedsYou rows={shell.rows} lines={lines} load={home} />
    </div>
  );
}
