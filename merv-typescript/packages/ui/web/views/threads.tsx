import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
// A visit that holds its lease, offered or taken up, as Sessions calls its thread live.
import { live as leased } from '@merv/sessions/rules';
import type { ProcessGraph } from '@merv/workflows/models';
import type {
  LeaseLiveness,
  ThreadCalls,
  ThreadConversation,
  ThreadMessages,
  ThreadView,
  VisitView,
} from '@merv/sessions/models';
import { accountRequest, refreshTools, useTool } from '../api';
import {
  Ago,
  Live,
  LoadState,
  Ruled,
  Stamp,
  Submit,
  Summary,
  col,
  cx,
  useNow,
  words,
} from '../components';
import { CloseIcon } from '../icons';
import { clock, elapsed, say, type Clock, type Liveness } from '../liveness';
import { useCommand } from '../mutations';
import { StageList } from '../process';
import { useActor, useReadsAgents, writes, type Actor } from '../session';
import { AgentConversation, type ConversationVisit } from './agent-live';
import type { PersonLine } from '../conversation';
import { namesOf } from './people';
import { valueText } from './running-phrase';

/**
 * Who worked each stage of a record: Sessions' threads, each drawn on the stage whose state
 * it names, and opened in a dialog that reads what it said and every visit it made. Nothing
 * here knows a workflow: a thread stands on the stage with its own `state` string, and its
 * role is said in the workflow's own words.
 */

/** A lease's liveness as Sessions sent it, its clocks read on the page's own clock. */
export const leaseLiveness = ({ liveness }: { liveness: LeaseLiveness }, now: Clock): Liveness =>
  say(
    liveness.verdict,
    liveness.tone,
    liveness.rest.map((value) => valueText(value, { now, nameOf: () => undefined })).join(''),
  );
/** Whether the lease is still held, as the verdict beside it says, so the two never disagree. */
export const holding = ({ liveness }: { liveness: LeaseLiveness }) =>
  liveness.verdict === 'offered' || liveness.verdict === 'active';

export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** The visit whose agent runs now: the one whose stream a page reads. */
const active = (visit: VisitView) => visit.status === 'active';
/** A visit that ended before its agent ran. */
const failed = (visit: VisitView) =>
  !visit.launched && (visit.status === 'released' || visit.status === 'expired');
/** A close code as a person reads it: a process's exit, or the code's own words. */
const reason = (why: string | undefined) => {
  const exit = why?.match(/exit_code_(\d+)$/)?.[1];
  return exit ? `exit ${exit}` : why ? words(why) : undefined;
};
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/**
 * Each visit's name: the visits that ran are numbered in order, so the chip's count and the
 * table agree; a launch that failed is named as one, and a visit that answered a question too.
 */
function visitNames(visits: readonly VisitView[]): Map<string, string> {
  let ran = 0;
  return new Map(
    visits.map((visit) => [
      visit.sessionId,
      failed(visit)
        ? 'Launch failed'
        : visit.inquiry
          ? 'Answering a question'
          : [`Visit ${++ran}`, visit.resumed && 'resumed'].filter(Boolean).join(' · '),
    ]),
  );
}
/** The visit holding its lease, as Sessions words it. */
const liveLine = (thread: ThreadView, now: Clock) => {
  const visit = thread.visits.find(leased);
  return visit?.liveness ? leaseLiveness({ liveness: visit.liveness }, now).phrase : undefined;
};
/**
 * A live visit whose lease ran out: its machine went quiet or offline, and Sessions' liveness
 * says `lapsed`, the one verdict it calls bad.
 */
export const lapsed = (thread: ThreadView) =>
  thread.visits.some((visit) => visit.liveness?.verdict === 'lapsed');
export const threadName = (thread: ThreadView) =>
  `${capital(words(thread.role))} · ${words(thread.state)} · ${thread.status}`;

/** How many visits a thread made that ran, and how many launches failed. */
export function visitCount(thread: ThreadView) {
  const launches = thread.visits.filter(failed).length;
  return { visits: thread.visits.length - launches, launches };
}
/** Whether a visit of the thread holds its lease now, as Sessions says of the thread. */
export const isLive = (thread: ThreadView) => thread.status === 'live';
/** When the thread last did anything: the newest moment any of its visits records. */
export const lastActive = (thread: ThreadView) =>
  thread.visits
    .flatMap((visit) => [visit.offeredAt, visit.startedAt, visit.endedAt])
    .filter((at): at is string => !!at)
    .sort()
    .at(-1);

/**
 * The threads of `thread`'s stage in its role, oldest first: a reviewer is a new thread each
 * visit, and a producer's superseded thread stays beside the one that replaced it.
 */
export const groupOf = (threads: readonly ThreadView[], thread: ThreadView) => {
  const here = threads.filter((item) => item.state === thread.state && item.role === thread.role);
  return here.includes(thread) ? here : [thread];
};
/** The thread a group opens on: the live one, else the newest whose agent ran, else the newest. */
export const currentOf = (group: readonly ThreadView[]) =>
  group.find(isLive) ??
  group.filter((item) => item.visits.some((visit) => visit.launched)).at(-1) ??
  group.at(-1)!;
/** Every visit of the group's threads, oldest first. */
const visitsOf = (group: readonly ThreadView[]) =>
  group.flatMap((item) => item.visits).sort((a, b) => a.offeredAt.localeCompare(b.offeredAt));

/** A role's mark: its first letter, P for a producer and R for a reviewer. */
export const roleLetter = (role: string) => role.charAt(0).toUpperCase();
/** The small disc a thread's role is known by, on its chip and in the unit's history. */
export function RoleMark({ role }: { role: string }) {
  return (
    <span className="role-mark" aria-hidden="true">
      {roleLetter(role)}
    </span>
  );
}

/**
 * The thread that did one thing on a record: the one at that stage in that role, and of
 * several (a reviewer is a new thread each round), the newest that had begun by then.
 */
export function threadFor(
  threads: readonly ThreadView[],
  { stage, role, at }: { stage: string; role: string; at?: string },
): ThreadView | undefined {
  const began = (thread: ThreadView) => thread.visits[0]?.offeredAt ?? '';
  const here = threads
    .filter((thread) => thread.state === stage && thread.role === role)
    .sort((a, b) => began(a).localeCompare(began(b)));
  if (!at) return here.at(-1);
  return here.filter((thread) => began(thread) <= at).at(-1) ?? here[0];
}

/**
 * A stage's threads in one role as one chip: its role, a live dot while a visit holds its
 * lease, how many visits they made where more than one, and the launches that failed, counted
 * here rather than drawn. Its tooltip says how the lease stands and on which machine.
 */
function ThreadChip({
  group,
  now,
  onOpen,
}: {
  group: readonly ThreadView[];
  now: Clock;
  onOpen(): void;
}) {
  const { visits, launches } = group
    .map(visitCount)
    .reduce(
      (sum, each) => ({ visits: sum.visits + each.visits, launches: sum.launches + each.launches }),
      { visits: 0, launches: 0 },
    );
  const current = currentOf(group);
  const retired = group.every((item) => item.status === 'retired');
  return (
    <button
      type="button"
      className={cx(
        'agent-chip',
        retired && 'agent-chip--retired',
        group.some(lapsed) && 'agent-chip--bad',
      )}
      aria-haspopup="dialog"
      title={retired ? 'Retired thread' : liveLine(current, now)}
      onClick={onOpen}
    >
      {group.some(isLive) && (
        <span className="live-dot live-dot--live" aria-label="Live" role="img" />
      )}
      <RoleMark role={current.role} />
      <span>{capital(words(current.role))}</span>
      {visits > 1 && <span className="faint">· {visits} visits</span>}
      {launches > 0 && (
        <span className="faint">· {plural(launches, 'failed launch', 'failed launches')}</span>
      )}
    </button>
  );
}

/** Each visit on one row: when it ran, how long, and how it ended. */
function Visits({
  visits,
  names,
  loadedAt,
}: {
  visits: readonly VisitView[];
  names: Map<string, string>;
  loadedAt?: string;
}) {
  const live = visits.some(active);
  const now = clock(undefined, loadedAt, useNow(live ? 1000 : 0), 20_000);
  const rows = visits.map((visit) => ({ visit, name: names.get(visit.sessionId)! }));
  type Row = (typeof rows)[number];
  return (
    <Ruled<Row>
      label="Visits"
      template="minmax(0, 1.2fr) repeat(2, minmax(0, 1.3fr)) minmax(0, 0.7fr) minmax(0, 1.5fr)"
      keyOf={({ visit }) => visit.sessionId}
      rows={rows}
      columns={[
        col<Row>('visit', 'Visit', ({ name }) => name),
        col<Row>('start', 'Started', ({ visit }) =>
          visit.startedAt ? <Stamp at={visit.startedAt} /> : '—',
        ),
        col<Row>('end', 'Ended', ({ visit }) =>
          visit.endedAt ? (
            <Stamp at={visit.endedAt} />
          ) : visit.liveness ? (
            <Live of={leaseLiveness({ liveness: visit.liveness }, now)} />
          ) : (
            '—'
          ),
        ),
        col<Row>('took', 'Duration', ({ visit }) =>
          visit.startedAt ? (
            <span className="tabular">
              {elapsed(
                (visit.endedAt ? Date.parse(visit.endedAt) : now.at) - Date.parse(visit.startedAt),
              )}
            </span>
          ) : (
            '—'
          ),
        ),
        col<Row>('outcome', 'Outcome', ({ visit }) => outcomeOf(visit) ?? '—'),
      ]}
    />
  );
}

/** How a visit ended, in words: its outcome and its close code, or why it never started. */
const outcomeOf = (visit: VisitView) =>
  failed(visit)
    ? (reason(visit.why) ?? 'did not start')
    : [visit.outcome && words(visit.outcome), reason(visit.why)].filter(Boolean).join(' · ') ||
      undefined;

/**
 * A visit's divider: its name, whether it resumed, how long it ran and how it ended, e.g.
 * "Visit 2 · resumed · 48m · submitted". A launch that failed says so and why.
 */
const dividerOf = (visit: VisitView, name: string) =>
  [
    name,
    visit.startedAt &&
      visit.endedAt &&
      elapsed(Date.parse(visit.endedAt) - Date.parse(visit.startedAt)),
    outcomeOf(visit),
  ]
    .filter(Boolean)
    .join(' · ');

/** The people's lines of a thread: each message to it, and each question its agent asked. */
function peopleOf(
  said: ThreadMessages | undefined,
  me: string | undefined,
  nameOf: (id: string) => string | undefined,
): PersonLine[] {
  if (!said) return [];
  return [
    ...said.questions.map((question): PersonLine => ({
      key: question.id,
      at: question.askedAt,
      who: 'Agent asked',
      body: question.question,
      note: question.open ? 'waiting on an answer' : undefined,
      asked: { open: question.open },
    })),
    ...said.messages.map((message): PersonLine => ({
      key: message.id,
      at: message.createdAt,
      who: message.senderActorId === me ? 'You' : (nameOf(message.senderActorId) ?? 'Someone'),
      body: message.body,
      note: delivery(message),
      reply: message.reply ?? undefined,
    })),
  ];
}

/**
 * What the thread said, visit by visit, with the people's lines among it. An operator reads
 * what the agent said: the visit that holds its lease from its live stream, the rest from what
 * Sessions kept, read again whenever another visit goes live. Anyone else reads the visits'
 * dividers and the people's lines alone, and the conversation is never asked for.
 */
function Conversation({
  thread,
  visits: all,
  names,
  people,
  label,
  reads,
}: {
  thread: ThreadView;
  visits: readonly VisitView[];
  names: Map<string, string>;
  people: readonly PersonLine[];
  label: string;
  reads: boolean;
}) {
  const kept = useTool<ThreadConversation>(
    reads ? `/sessions/threads/${encodeURIComponent(thread.id)}/conversation` : null,
  );
  const { reload } = kept;
  const liveId = reads ? thread.visits.find(active)?.sessionId : undefined;
  const read = useRef(liveId);
  useEffect(() => {
    if (read.current === liveId) return;
    read.current = liveId;
    reload();
  }, [liveId, reload]);
  const visits = useMemo(
    () =>
      all.map((visit): ConversationVisit => {
        // Sessions sends each visit's live stream while it keeps it, else its stored
        // transcript, else nothing (`from: 'none'`).
        const said = kept.data?.visits.find((item) => item.sessionId === visit.sessionId);
        const name = names.get(visit.sessionId)!;
        return {
          sessionId: visit.sessionId,
          at: visit.startedAt ?? visit.offeredAt,
          divider: dividerOf(visit, name),
          ...(failed(visit) && { tone: 'error' as const }),
          ...(visit.sessionId === liveId
            ? { stream: `/sessions/${encodeURIComponent(visit.sessionId)}/events` }
            : { events: said?.events }),
        };
      }),
    [all, names, kept.data, liveId],
  );
  if (reads && !kept.data && !liveId && !kept.error) return <LoadState {...kept} />;
  return (
    <AgentConversation
      key={liveId ?? ''}
      label={label}
      visits={visits}
      people={people}
      empty={reads ? 'Nothing said yet.' : ''}
    />
  );
}

const count = (value: number) => value.toLocaleString();
/**
 * What the thread's Merv calls came to, in one line. Tokens are payload sizes, an estimate;
 * each call is a step in the conversation already.
 */
function CallTotals({ thread }: { thread: ThreadView }) {
  const read = useTool<ThreadCalls>(`/sessions/threads/${encodeURIComponent(thread.id)}/calls`);
  if (!read.data) return <LoadState {...read} />;
  const { totals } = read.data;
  return (
    <p className="faint tabular">
      {plural(totals.calls, 'Merv call', 'Merv calls')} · ≈ {count(totals.inputTokens)} in · ≈{' '}
      {count(totals.outputTokens)} out
    </p>
  );
}

/**
 * The box that speaks to a thread, for someone who may write to the project. A thread that takes
 * a message now (live, dormant on open work, or answering its question) is sent one, which its
 * live or next visit reads at its next tool call. One Sessions says may be asked (`asks`) is asked:
 * a short visit resumes its conversation, answers and stops. Any other stands disabled.
 */
export function ThreadCompose({
  thread,
  answering = false,
  onSent,
}: {
  thread: ThreadView;
  /** Its agent asked a question this answers. */
  answering?: boolean;
  onSent?(): void;
}) {
  const actor = useActor();
  const base = `/sessions/threads/${encodeURIComponent(thread.id)}`;
  const sends = thread.takesMessage;
  const path = `${base}/${sends ? 'messages' : 'ask'}`;
  const may = !!actor && writes(actor);
  const [draft, setDraft] = useState('');
  const send = useCommand<{ message?: { id?: unknown }; inquiry?: { id?: unknown } } | null>({
    tool: path,
    send: (body) => accountRequest(path, { method: 'POST', body, scoped: true }),
    validate: (result) => typeof (sends ? result?.message?.id : result?.inquiry?.id) === 'string',
    onSuccess: () => {
      setDraft('');
      // The thread's messages, the Agents page's cards, and Needs you, which an answer clears.
      refreshTools(`${base}/messages`, '/sessions/threads', 'ui.home');
      onSent?.();
    },
  });
  if (!may) return null;
  const word = answering ? 'Answer' : sends ? 'Message' : 'Ask';
  const off = !sends && !thread.asks;
  return (
    <form
      className="thread-compose"
      onSubmit={(event) => {
        event.preventDefault();
        const body = draft.trim();
        if (!off && body) void send.submit({ body });
      }}
    >
      <textarea
        className="textarea"
        rows={1}
        maxLength={8000}
        aria-label={word}
        placeholder={word}
        value={draft}
        disabled={off}
        readOnly={send.locked}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Submit
        label={sends ? 'Send' : 'Ask'}
        saving="Sending…"
        busy={send.busy}
        retry={send.retry}
        disabled={off || !draft.trim()}
      />
      {send.error && (
        <p className="error-message" role="alert">
          {send.error}
        </p>
      )}
    </form>
  );
}

/**
 * Whether a message has reached its agent: Sent until its agent acknowledges it, then Read. A
 * question to an agent (an inquiry) says where its answer is instead.
 */
export const delivery = (message: {
  acknowledgedAt: string | null;
  inquiry?: { label: string };
}) => (message.inquiry ? message.inquiry.label : message.acknowledgedAt ? 'Read' : 'Sent');

/**
 * Who a thread is and what it does, on one line: its role and stage, and while a visit holds
 * its lease a dot and how long that visit has run (red once its lease lapsed); otherwise its
 * status, quietly. No machine, lease or id.
 */
export function ThreadTitle({ thread, now }: { thread: ThreadView; now: Clock }) {
  const live = isLive(thread);
  const bad = live && lapsed(thread);
  const visit = thread.visits.find(leased);
  const since = visit?.startedAt ?? visit?.offeredAt;
  return (
    <>
      {live && (
        <span
          className={cx('live-dot', bad ? 'live-dot--attn' : 'live-dot--live')}
          role="img"
          aria-label={bad ? 'Lapsed' : 'Live'}
        />
      )}
      <span>
        {capital(words(thread.role))} · {capital(words(thread.state))}
      </span>{' '}
      <span className="thread-head-state">
        ·{' '}
        {bad
          ? 'lapsed'
          : live
            ? since
              ? elapsed(now.at - Date.parse(since))
              : 'starting'
            : thread.status}
      </span>
    </>
  );
}

/**
 * One thread as a card, on the Agents page and in a unit's Agents tab alike: its title and the
 * line under it, a green dot while a visit holds its lease (red once that lease lapsed), what
 * the page sets inside it, and its role, visits and last activity at its foot. A press anywhere
 * on it but a control inside it opens the thread.
 */
export function ThreadCard({
  thread,
  title,
  subtitle,
  label = threadName(thread),
  waiting = false,
  onOpen,
  children,
}: {
  thread: ThreadView;
  title: ReactNode;
  subtitle?: ReactNode;
  label?: string;
  /** Its agent waits on the reader's answer. */
  waiting?: boolean;
  onOpen(): void;
  children?: ReactNode;
}) {
  const live = isLive(thread);
  const bad = live && lapsed(thread);
  const { visits } = visitCount(thread);
  const last = lastActive(thread);
  return (
    <article
      className={cx(
        'agent-card',
        waiting && 'agent-card--waiting',
        bad && 'agent-card--bad',
        thread.status === 'retired' && 'agent-card--retired',
      )}
      onClick={(event) => {
        if (!(event.target as Element).closest('a, button, form')) onOpen();
      }}
    >
      <button
        type="button"
        className="agent-card-open"
        aria-haspopup="dialog"
        aria-label={label}
        onClick={onOpen}
      >
        <span className="agent-card-title">
          {live && (
            <span
              className={cx('live-dot', bad ? 'live-dot--attn' : 'live-dot--live')}
              role="img"
              aria-label={bad ? 'Lapsed' : 'Live'}
            />
          )}
          <span className="agent-card-word">{title}</span>
        </span>
        {subtitle && <span className="agent-card-sub">{subtitle}</span>}
      </button>
      {children}
      <span className="agent-card-meta faint">
        <RoleMark role={thread.role} />
        <span className="tabular">
          {visits} {visits === 1 ? 'visit' : 'visits'}
        </span>
        {last && <Ago at={last} />}
      </span>
    </article>
  );
}

/**
 * One thread, in the browser's own modal dialog: Escape and a press on the backdrop close it,
 * and the focus stays in it while it is open. It hangs from the body, so the narrow sidebar's
 * own layout never reaches it. Its head is who and what (`ThreadTitle`) over the work it is on;
 * it reads as `ThreadReading` does, and `group` is the thread's stage and role, whose every
 * visit it lists.
 */
export function ThreadDialog({
  thread,
  group = [thread],
  title,
  loadedAt,
  onClose,
}: {
  thread: ThreadView;
  group?: readonly ThreadView[];
  title: string;
  loadedAt?: string;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);
  const now = clock(undefined, loadedAt, useNow(isLive(thread) ? 1000 : 0), 20_000);
  return createPortal(
    <dialog
      ref={dialog}
      className="thread-dialog"
      aria-labelledby="thread-dialog-title"
      onClose={onClose}
      // The dialog has no padding of its own, so a press on it rather than its body is the backdrop.
      onClick={(event) => event.target === event.currentTarget && event.currentTarget.close()}
    >
      <div className="thread-dialog-body">
        <header className="thread-head">
          <div className="thread-head-text">
            <h2 id="thread-dialog-title" className="thread-head-title">
              <ThreadTitle thread={thread} now={now} />
            </h2>
            <p className="thread-head-unit">{title}</p>
          </div>
          <button
            type="button"
            className="btn-icon"
            aria-label="Close"
            title="Close"
            onClick={() => dialog.current?.close()}
          >
            <CloseIcon />
          </button>
        </header>
        <ThreadReading thread={thread} group={group} loadedAt={loadedAt} />
      </div>
    </dialog>,
    document.body,
  );
}

/**
 * What one thread did, as a chat: one timeline of its visits, what its agent said and did (for
 * an operator) and what passed between it and the people over it, then the box that speaks to
 * it at the foot. Its visits' table and what its calls came to fold under Details. The visits
 * are those of its whole `group`, the stage's threads in its role, numbered in one count.
 */
export function ThreadReading({
  thread,
  group = [thread],
  loadedAt,
}: {
  thread: ThreadView;
  group?: readonly ThreadView[];
  loadedAt?: string;
}) {
  const reads = useReadsAgents();
  const actor = useActor();
  const actors = useTool<Actor[]>(actor?.role === 'operator' ? 'actor.list' : null).data;
  const said = useTool<ThreadMessages>(
    `/sessions/threads/${encodeURIComponent(thread.id)}/messages`,
    {},
    { every: isLive(thread) ? 5000 : 15_000 },
  );
  const visits = useMemo(() => visitsOf(group), [group]);
  const names = useMemo(() => visitNames(visits), [visits]);
  const people = useMemo(
    () => peopleOf(said.data, actor?.id, namesOf(actors)),
    [said.data, actor?.id, actors],
  );
  const [details, setDetails] = useState(false);
  // The question that still stands, as Sessions says: one about work that ended is answered by
  // nothing, so the box does not offer to.
  const open = said.data?.questions.some((question) => question.open) ?? false;
  return (
    <div className="thread-reading">
      <Conversation
        thread={thread}
        visits={thread.visits}
        names={names}
        people={people}
        label={threadName(thread)}
        reads={reads}
      />
      <details
        className="thread-details"
        onToggle={(event) => setDetails(event.currentTarget.open)}
      >
        <Summary>Details</Summary>
        {details && (
          <div className="thread-details-body">
            <Visits visits={visits} names={names} loadedAt={loadedAt} />
            <CallTotals thread={thread} />
          </div>
        )}
      </details>
      <ThreadCompose thread={thread} answering={open} onSent={said.reload} />
    </div>
  );
}

/**
 * The threads of a record, or of several in one read (a unit and the records inside it), read
 * every 4 s while one of them is live, every 10 s otherwise; no instance named reads nothing.
 */
export function useThreadList(instanceIds: string | readonly string[] | undefined) {
  const ids = typeof instanceIds === 'string' ? [instanceIds] : (instanceIds ?? []);
  const list = useTool<{ threads: ThreadView[] }>(
    ids.length
      ? `/sessions/threads?${ids.map((id) => `instanceId=${encodeURIComponent(id)}`).join('&')}`
      : null,
    {},
    { every: (data) => (data?.threads.some(isLive) ? 4000 : 10_000) },
  );
  const threads = list.data?.threads ?? [];
  return { threads, loadedAt: list.loadedAt, loaded: !!list.data };
}

/**
 * A record's stages with its threads on them, for the Work page's sidebar, each chip the way
 * to its threads' dialog.
 */
export function ThreadStages({ graph, title }: { graph: ProcessGraph; title: string }) {
  const { threads, loadedAt } = useThreadList(graph.instanceId);
  const [opened, setOpened] = useState<string>();
  const thread = threads.find((item) => item.id === opened);
  return (
    <>
      <StageThreads graph={graph} threads={threads} loadedAt={loadedAt} onOpen={setOpened} />
      {thread && (
        <ThreadDialog
          thread={thread}
          group={groupOf(threads, thread)}
          title={title}
          loadedAt={loadedAt}
          onClose={() => setOpened(undefined)}
        />
      )}
    </>
  );
}

/**
 * The stage card with each stage's threads as chips, one a role; a chip opens its group's
 * current thread through `onOpen`.
 */
export function StageThreads({
  graph,
  threads,
  loadedAt,
  onOpen: setOpened,
}: {
  graph: ProcessGraph;
  threads: readonly ThreadView[];
  loadedAt?: string;
  onOpen(threadId: string): void;
}) {
  const now = clock(undefined, loadedAt, Date.now(), 20_000);
  const aside = (state: string) => {
    const here = threads.filter((item) => item.state === state);
    return [...new Set(here.map((item) => item.role))].map((role) => {
      const group = here.filter((item) => item.role === role);
      return (
        <ThreadChip
          key={role}
          group={group}
          now={now}
          onOpen={() => setOpened(currentOf(group).id)}
        />
      );
    });
  };
  return <StageList graph={graph} aside={aside} />;
}
