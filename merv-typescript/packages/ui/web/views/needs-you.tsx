import type { UiRowDescription, UiRowNeeds } from '@merv/ui/rows';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { WorkflowDecision, WorkflowDependency } from '@merv/workflows/models';
import { refreshTools, type Loaded } from '../api';
import { useCommand } from '../mutations';
import { useSession } from '../session';
import {
  Ago,
  Failure,
  KindLabel,
  LoadState,
  StatusPill,
  Summary,
  kindOf,
  words,
} from '../components';
import { ArrowRightIcon, CheckIcon } from '../icons';
import { personMove } from '@merv/code-work/blockers';
import { pathOf } from '../navigation';
import { namesOf } from './people';
// The record shapes the home pages read are declared once, beside the graph they feed.
import { newest, useHome, type Flow, type HomeData } from './map-data';

/**
 * What needs the reader: Home's first part, Needs you. One column of record cards, each
 * saying its move in one sentence a person reads. Whose move a record is comes from its
 * owners, never from this page: its gate says whether it is the reader's own (`yours`, as its
 * program describes the record to Workflows) and with which sentence, Reviews says which
 * subjects are out for review and which a verdict sent back. A blocker another plugin published
 * names whose move ending it is, and the gate answers that too, naming the blocker: an agent's
 * question to its owner, or a publication nobody has merged — the one thing that puts ended
 * work here at all, a wait on a human and not a record that is running. Code words its own
 * blockers' moves for a person (`personMove`). The
 * server's own instruction is written for the agent holding the tool, so it is never the
 * headline: it stays on the card, folded. Every card is gated on its owning ui.shell row, so
 * it goes quiet with its plugin, and every fact here comes from the one read the rail shares.
 * An absent value is never rendered as zero and an error is never rendered as empty.
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

/** The owner's own words for a key of one of its maps, and nothing a map merely inherits. */
const word = (words: Record<string, string> | undefined, key = '') =>
  words && Object.hasOwn(words, key) ? words[key] : undefined;
/**
 * The owner's move as a sentence: a prerequisite that failed and its state, else the sentence
 * the gate says asks it of them, said as changes where a review sent the work back.
 */
export function recordSentence(
  gate: { ask?: string; dependencies: Pick<WorkflowDependency, 'name' | 'state' | 'failed'>[] },
  returned = false,
): string {
  const ended = gate.dependencies.find((item) => item.failed);
  if (ended) return `Decide what happens next: ${ended.name} ${words(ended.state)}`;
  if (!gate.ask) return 'Needs your input';
  return returned
    ? `Changes requested: ${gate.ask[0].toLowerCase()}${gate.ask.slice(1)}`
    : gate.ask;
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

/** An open record of a row that says how Home reads it, before its gate is read. */
interface Open {
  id: string;
  /** The record whose page and card it stands on: itself, or the record it is a part of. */
  page: string;
  name: string;
  owner: string;
  workflow: Flow;
  row: UiRowDescription;
  needs: UiRowNeeds;
}
/**
 * The records of every row that declares how Home reads them, from the row's own home part, and
 * the records inside each that the row names (`parts`), such as a wave's lenses, under its name.
 */
const openWork = (rows: UiRowDescription[], home: HomeData | undefined): Open[] =>
  rows.flatMap(({ needs, ...row }) => {
    const items = (home as Record<string, unknown> | undefined)?.[row.id];
    if (!needs || !Array.isArray(items)) return [];
    return (items as Record<string, unknown>[]).flatMap((item) => {
      const record = {
        page: item.id as string,
        name: item[needs.name] as string,
        owner: item[needs.owner] as string,
        row,
        needs,
      };
      const parts = needs.parts ? item[needs.parts] : undefined;
      return [item, ...(Array.isArray(parts) ? (parts as Record<string, unknown>[]) : [])].map(
        (each) => ({ ...record, id: each.id as string, workflow: each.workflow as Flow }),
      );
    });
  });

/**
 * Every open record, and every open review, that is the reader's move, newest first. The
 * gate of each one comes from the same read the page draws, so the list is one answer's and
 * never a race between twenty. Which records there are, and the words for the reviews of
 * them, are what their rows declare (`needs`).
 */
export function needsYou(
  rows: UiRowDescription[],
  home: HomeData | undefined,
  /** Who is reading: whose move each record is, the server has already said for them. */
  viewer: { id: string },
  named: Named,
): Line[] {
  const me = viewer.id;
  const gate = new Map((home?.workflows?.workflows ?? []).map((item) => [item.instanceId, item]));
  const work = openWork(rows, home);
  const subjects = new Map(work.map((item) => [item.id, item]));
  const lines: Line[] = [];
  const reviewsRow = rows.find((row) => row.view.kind === 'reviews');
  const reviews = reviewsRow ? (home?.reviews ?? []) : [];
  const openReviews = reviews.filter((item) => item.open);
  // A record out for review is its reviewer's move, never its owner's.
  const underReview = new Set(openReviews.map((item) => item.subjectId));
  // Work whose newest verdict sent it back, as against work never delivered.
  const returned = new Set(reviews.filter((item) => item.returned).map((item) => item.subjectId));
  for (const item of work) {
    const { row, needs } = item;
    const kind = row.view.kind;
    const decision = gate.get(item.id);
    const yours = decision?.yours;
    if (!decision || !yours) continue;
    // A blocker another plugin published that the gate names as the reader's move outranks the
    // record's own gate and stands here whatever that gate says — including on work that has
    // ended and waits on somebody to carry its accepted code to main.
    const blocker =
      yours.blocker &&
      decision.providerBlockers.find(
        (each) => each.provider === yours.blocker!.provider && each.key === yours.blocker!.key,
      );
    // At a used-up limit, or suspended where only an admin's allowance moves it on, as the gate
    // says (`limit`): a project admin's move, and nothing more happens by itself.
    const limit = yours.limit;
    // A record that only names the reviews of it is never a move of its own, nor is one out
    // for review, unless a blocker or an admin's move at its limit makes it the reader's.
    if (!blocker && !limit && (needs.subjectOnly || underReview.has(item.id))) continue;
    if (blocker) {
      // Whose move it is and whether this app can make it are two questions: a move no page
      // here carries out is still the reader's, with no control at all. Code words its own.
      const move = personMove(blocker);
      const sentence = move?.sentence ?? yours.ask ?? 'Needs your input';
      // A blocker that names a thread is answered in that thread's box, on the work's Agents tab.
      const thread = blocker.related?.find((each) => each.kind === 'thread');
      const work = thread && pathOf(rows, 'work');
      lines.push({
        id: item.id,
        kind,
        name: item.name,
        to: work
          ? `${work}?key=work:${item.page}&thread=${encodeURIComponent(thread.id)}`
          : `${row.path}/${item.page}`,
        at: blocker.since,
        sentence,
        ...(move ? { who: move.who } : {}),
        says: [...said(decision), blocker.message, blocker.next].filter(
          (text, index, all) => !!text && all.indexOf(text) === index && text !== sentence,
        ),
        ...(move?.control ? { desk: { label: move.control.label, to: move.control.to } } : {}),
      });
      continue;
    }
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
    // A move a used-up limit asks of an admin is not the producer's changes.
    const sentence = recordSentence(
      { ask: yours.ask, dependencies },
      returned.has(item.id) && !limit,
    );
    // Another round is allowed, and suspended work resumed, on the work's own card on the Work
    // map, so such a line goes there; the record's own page holds no such control.
    const work = limit && pathOf(rows, 'work');
    lines.push({
      id: item.id,
      kind,
      name: item.name,
      to: `${row.path}/${item.page}`,
      at: item.workflow.updatedAt,
      sentence,
      ...(work
        ? {
            desk: {
              label: limit === 'exhausted' ? 'Allow another round' : 'Resume',
              to: `${work}?key=work:${item.page}`,
            },
          }
        : {}),
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
      // A held review is its holder's. Whether an unclaimed one is this viewer's move is the
      // server's answer, not ours: the list holds the contributor exclusions, which this page
      // never sees, and the gate the rest, such as a Git task's review, which only a leased
      // reviewer may claim.
      const mine = review.reviewerId
        ? review.reviewerId === me
        : !!review.claimable && start?.status !== 'blocked';
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

/**
 * One part of Home under its heading and its count: its rows, or the one quiet line that
 * stands for them — loading, nothing there, or the read that failed — so a part that cannot
 * answer costs its own line and never the page.
 */
export function Part({
  title,
  count,
  failed,
  loading,
  empty,
  children,
}: {
  title: string;
  count?: number;
  failed?: ReactNode;
  loading?: boolean;
  empty?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="ov-block" aria-label={title}>
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
      {failed && (
        <div className="home-quiet home-failed" role="status">
          {failed}
        </div>
      )}
      {loading ? (
        <LoadState loading />
      ) : empty ? (
        <div className="home-quiet">{empty}</div>
      ) : (
        <ul className="ov-list">{children}</ul>
      )}
    </section>
  );
}

/** A row that cannot speak for itself needs someone, and says so in its own state. */
const unwellOf = (rows: UiRowDescription[]) =>
  rows.filter((row) => row.status.state === 'degraded' || row.status.state === 'unavailable');

/** What needs the reader, from the one home the whole page shares; the rail counts exactly this. */
export function useNow(rows: UiRowDescription[], every?: number) {
  const session = useSession();
  const home = useHome(every);
  const lines = needsYou(rows, home.data, session.actor, namesOf(home.data?.actors));
  return { home, lines, count: lines.length + unwellOf(rows).length };
}

/** What needs the reader: their own moves, then every row that cannot speak for itself. */
export function NeedsYou({
  rows,
  lines,
  load,
}: {
  rows: UiRowDescription[];
  lines: Line[];
  load: Pick<Loaded<HomeData>, 'loading' | 'error' | 'data' | 'loadedAt'>;
}) {
  const unwell = unwellOf(rows);
  const count = lines.length + unwell.length;
  return (
    <Part
      title="Needs you"
      count={count}
      // A failed refresh keeps the cards that loaded, and says so in the one line every stale
      // read says it in.
      failed={
        load.error && (load.data ? <LoadState {...load} /> : 'Could not read what needs you.')
      }
      loading={load.loading && !count}
      empty={
        load.data && !count ? (
          // Nothing to do is good news, and wears the colour of it.
          <p className="home-clear">
            <CheckIcon size={14} /> Nothing needs you
          </p>
        ) : undefined
      }
    >
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
    </Part>
  );
}
