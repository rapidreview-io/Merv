import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { WorkflowDecision, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import { refreshTools, type Loaded } from '../api';
import { useCommand } from '../mutations';
import { useSession } from '../session';
import type { Row, ShellData } from '../shell';
import type { RowNeeds } from '../shell-types';
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
import { firstPersonMove } from '@merv/code-work/blockers';
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
 * `@merv/code-work/blockers` holds, and is the one thing that puts ended work on this page at all —
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

/** The owner's own words for a key of one of its maps, and nothing a map merely inherits. */
const word = (words: Record<string, string> | undefined, key = '') =>
  words && Object.hasOwn(words, key) ? words[key] : undefined;
/** The owner's move the gate holds open, by the sentences its row declares. */
const askOf = (decision: WorkflowDecision, asks?: Record<string, string>) =>
  decision.actions.find((action) => word(asks, action.action) && action.status !== 'blocked');
/**
 * The owner's move as a sentence. Every word comes from a fact of the gate — a prerequisite
 * that failed and its state, the action that is ready, whether a review sent the work back —
 * or from the sentence the record's row declares for that action.
 */
export function recordSentence(
  gate: {
    nextAction: { action: string } | null;
    dependencies: Pick<WorkflowDependency, 'name' | 'state' | 'failed'>[];
  },
  returned = false,
  asks?: Record<string, string>,
): string {
  const ended = gate.dependencies.find((item) => item.failed);
  if (ended) return `Decide what happens next: ${ended.name} ${words(ended.state)}`;
  const ask = word(asks, gate.nextAction?.action);
  if (!ask) return 'Needs your input';
  return returned ? `Changes requested: ${ask[0].toLowerCase()}${ask.slice(1)}` : ask;
}

/** A review that is the reader's move: one to claim, or one of theirs to finish. */
export const reviewSentence = (
  claimed: boolean,
  subjectState?: string,
  reads?: Record<string, string>,
) => (claimed ? 'Finish your review' : (word(reads, subjectState) ?? 'Review this work'));

/** What the server told whoever holds the tool: its instruction, then each refusal, once. */
const said = ({ instruction, blockers }: WorkflowDecision) =>
  [instruction, ...blockers.map((item) => item.message)].filter(
    (text, index, all) => !!text && all.indexOf(text) === index,
  );

/** An open record of a row that says how Now reads it, before its gate is read. */
interface Open {
  id: string;
  name: string;
  owner: string;
  workflow: Flow;
  row: Row;
  needs: RowNeeds;
}
/** The records of every row that declares how Now reads them, from the row's own home part. */
const openWork = (rows: Row[], home: HomeData | undefined): Open[] =>
  rows.flatMap(({ needs, ...row }) => {
    const items = (home as Record<string, unknown> | undefined)?.[row.id];
    if (!needs || !Array.isArray(items)) return [];
    return (items as Record<string, unknown>[]).map((item) => ({
      id: item.id as string,
      name: item[needs.name] as string,
      owner: item[needs.owner] as string,
      workflow: item.workflow as Flow,
      row,
      needs,
    }));
  });

/**
 * Every open record, and every open review, that is the reader's move, newest first. The
 * gate of each one comes from the same read the page draws, so the list is one answer's and
 * never a race between twenty. Which records there are, and the words for their moves, are
 * what their rows declare (`needs`).
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
  const work = openWork(rows, home);
  // A blocker that names another record names it the way this app names it, here as on the
  // record's own page; the server's label is the fallback and an id names nobody.
  const recordNames: RecordNames = new Map(work.map((item) => [item.id, { name: item.name }]));
  const subjects = new Map(work.map((item) => [item.id, item]));
  const lines: Line[] = [];
  const reviewsRow = rows.find((row) => row.view.kind === 'reviews');
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
  for (const item of work) {
    const { row, needs } = item;
    const kind = row.view.kind;
    const decision = gate.get(item.id);
    // A record that only names the reviews of it is never a move of its own.
    if (needs.subjectOnly || !decision || underReview.has(item.id)) continue;
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
    const ask = !began || began === me ? askOf(decision, needs.asks) : undefined;
    const next = ask || decision.nextAction;
    // A move through a tool only a leased worker calls, such as a task's delivery naming its
    // worker's own commit, is never the reader's.
    if (needs.workerOnly?.includes(next?.tool ?? '') || !yours(decision, item.owner === me, !!ask))
      continue;
    const verdict = lastVerdict.get(item.id);
    // A record that stops on its own child (a cycle on its wave or its consolidation) is
    // stopped only when its gate refuses on one of the codes its row names, and then by
    // the child declared last; any other prerequisite of it may fail and stop nothing.
    const stop =
      needs.stops &&
      decision.blockers.some((blocker) => needs.stops!.includes(blocker.code)) &&
      decision.dependencies.filter((dependency) => dependency.failed).at(-1);
    const dependencies = decision.dependencies.filter(
      (dependency) => !needs.stops || !dependency.failed || dependency === stop,
    );
    const sentence = recordSentence(
      { nextAction: next, dependencies },
      !!verdict && verdict !== 'pass',
      needs.asks,
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
        sentence: reviewSentence(
          !!review.reviewerId,
          subject?.workflow.state,
          subject?.needs.reads,
        ),
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
      refreshTools('ui.home', 'review.list');
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
export function useNow(rows: Row[], every?: number) {
  const session = useSession();
  const home = useHome(every);
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
