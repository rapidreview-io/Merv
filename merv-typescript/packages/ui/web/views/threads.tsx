import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runningKey } from '@merv/contracts/running';
import type { ProcessGraph } from '@merv/workflows/models';
import type {
  LeaseLiveness,
  ThreadCalls,
  ThreadConversation,
  ThreadMessages,
  ThreadView,
  VisitView,
} from '@merv/sessions/models';
import { accountRequest, useTool } from '../api';
import {
  Ago,
  Live,
  LoadState,
  Ruled,
  Stamp,
  StatusPill,
  Submit,
  col,
  cx,
  stamp,
  useNow,
  words,
} from '../components';
import { CloseIcon } from '../icons';
import { clock, elapsed, say, type Clock, type Liveness } from '../liveness';
import { useCommand } from '../mutations';
import { StageList } from '../process';
import { useActor, useReadsAgents, writes, type Actor } from '../session';
import { AgentConversation, type ConversationVisit } from './agent-live';
import { namesOf } from './people';
import { Target, valueText } from './running-phrase';

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

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
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
 * table agree, and a launch that failed is named as one.
 */
function visitNames(visits: readonly VisitView[]): Map<string, string> {
  let ran = 0;
  return new Map(
    visits.map((visit) => [
      visit.sessionId,
      failed(visit)
        ? 'Launch failed'
        : [`Visit ${++ran}`, visit.resumed && 'resumed'].filter(Boolean).join(' · '),
    ]),
  );
}
/** The visit holding its lease, as Sessions words it, with the machine it runs on. */
const liveLine = (thread: ThreadView, now: Clock) => {
  const visit = thread.visits.find(active);
  return visit?.liveness
    ? [leaseLiveness({ liveness: visit.liveness }, now).phrase, visit.runnerId]
        .filter(Boolean)
        .join(' · ')
    : undefined;
};
/**
 * A live visit whose lease ran out: its machine went quiet or offline, and Sessions' liveness
 * says `lapsed`, the one verdict it calls bad.
 */
const lapsed = (thread: ThreadView) =>
  thread.visits.some((visit) => visit.liveness?.verdict === 'lapsed');
export const threadName = (thread: ThreadView) =>
  `${capital(words(thread.role))} · ${words(thread.state)} · ${thread.status}`;

/** How many visits a thread made that ran, and how many launches failed. */
export function visitCount(thread: ThreadView) {
  const launches = thread.visits.filter(failed).length;
  return { visits: thread.visits.length - launches, launches };
}
/** Whether a visit of the thread holds its lease now. */
export const isLive = (thread: ThreadView) => thread.visits.some(active);
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

/** Each visit on one row: when it ran, how long, how it ended, and where. */
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
      template="minmax(0, 1.2fr) repeat(2, minmax(0, 1.3fr)) minmax(0, 0.7fr) minmax(0, 1.5fr) minmax(0, 1.2fr)"
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
        col<Row>('outcome', 'Outcome', ({ visit }) =>
          failed(visit)
            ? (reason(visit.why) ?? 'did not start')
            : [visit.outcome && words(visit.outcome), reason(visit.why)]
                .filter(Boolean)
                .join(' · ') || '—',
        ),
        col<Row>(
          'runner',
          'Runner',
          ({ visit }) => [visit.harness, visit.runnerId].filter(Boolean).join(' · ') || '—',
        ),
      ]}
    />
  );
}

/**
 * What the thread said, visit by visit. The visit that holds its lease is read from its live
 * stream; the rest are what Sessions kept, read again whenever another visit goes live.
 */
function Conversation({
  thread,
  names,
  label,
}: {
  thread: ThreadView;
  names: Map<string, string>;
  label: string;
}) {
  const kept = useTool<ThreadConversation>(
    `/sessions/threads/${encodeURIComponent(thread.id)}/conversation`,
  );
  const { reload } = kept;
  const liveId = thread.visits.find(active)?.sessionId;
  const read = useRef(liveId);
  useEffect(() => {
    if (read.current === liveId) return;
    read.current = liveId;
    reload();
  }, [liveId, reload]);
  const visits = useMemo(() => {
    return thread.visits.flatMap((visit): ConversationVisit[] => {
      if (!visit.launched) return [];
      // Sessions sends each visit's live stream while it keeps it, else its stored transcript,
      // else nothing (`from: 'none'`), which the divider says.
      const said = kept.data?.visits.find((item) => item.sessionId === visit.sessionId);
      const live = active(visit);
      return [
        {
          sessionId: visit.sessionId,
          divider: [
            names.get(visit.sessionId),
            stamp(visit.startedAt ?? visit.offeredAt),
            !live && said?.from === 'none' && 'nothing kept',
            !live && said?.from === 'unavailable' && 'unavailable',
          ]
            .filter(Boolean)
            .join(' · '),
          ...(live
            ? { stream: `/sessions/${encodeURIComponent(visit.sessionId)}/events` }
            : { events: said?.events }),
        },
      ];
    });
  }, [thread, names, kept.data]);
  if (!kept.data && !liveId) return <LoadState {...kept} />;
  return <AgentConversation key={liveId ?? ''} label={label} visits={visits} />;
}

const count = (value: number) => value.toLocaleString();
const duration = (ms: number | null) =>
  ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
/**
 * The Merv calls the thread's visits made, newest first with in-flight ones on top, and what
 * they all came to. Tokens are payload sizes, an estimate; Sessions keeps no arguments.
 */
function Calls({ thread, names }: { thread: ThreadView; names: Map<string, string> }) {
  const read = useTool<ThreadCalls>(
    `/sessions/threads/${encodeURIComponent(thread.id)}/calls`,
    {},
    { every: isLive(thread) ? 4000 : undefined },
  );
  if (!read.data) return <LoadState {...read} />;
  const { calls, totals } = read.data;
  type Row = (typeof calls)[number];
  return (
    <>
      <p className="faint tabular">
        {plural(totals.calls, 'call', 'calls')} · ≈ {count(totals.inputTokens)} in · ≈{' '}
        {count(totals.outputTokens)} out
        {totals.calls > calls.length && ` · newest ${calls.length}`}
      </p>
      {calls.length > 0 && (
        <Ruled<Row>
          label="Calls"
          template="minmax(0, 1.6fr) minmax(0, 0.9fr) minmax(0, 1fr) minmax(0, 0.9fr) minmax(0, 0.7fr) minmax(0, 0.7fr) minmax(0, 0.7fr)"
          keyOf={(call) => call.id}
          rows={calls}
          columns={[
            col<Row>('tool', 'Tool', (call) => <code>{call.tool}</code>),
            col<Row>('visit', 'Visit', (call) => names.get(call.sessionId) ?? '—'),
            col<Row>('status', 'Status', (call) => <StatusPill value={call.status} />),
            col<Row>('start', 'Started', (call) => <Ago at={call.startedAt} />),
            col<Row>('took', 'Took', (call) => (
              <span className="tabular">{duration(call.durationMs)}</span>
            )),
            col<Row>('in', 'In', (call) => (
              <span className="tabular">≈ {count(call.inputTokens)}</span>
            )),
            col<Row>('out', 'Out', (call) => (
              <span className="tabular">
                {call.outputTokens === null ? '—' : `≈ ${count(call.outputTokens)}`}
              </span>
            )),
          ]}
        />
      )}
    </>
  );
}

/**
 * What passed between the thread and the people over it, oldest first, and the box that sends
 * it a message, which its live or next visit reads. A question its agent asked stands over the
 * box, which answers it. Only someone who may write to the project is offered the box; a
 * retired thread takes a message only as an answer.
 */
export function ThreadMessageBox({ thread }: { thread: ThreadView }) {
  const actor = useActor();
  const nameOf = namesOf(useTool<Actor[]>(actor?.role === 'operator' ? 'actor.list' : null).data);
  const path = `/sessions/threads/${encodeURIComponent(thread.id)}/messages`;
  const read = useTool<ThreadMessages>(path, {}, { every: isLive(thread) ? 5000 : 15_000 });
  const [draft, setDraft] = useState('');
  const send = useCommand<{ message: { id: string } }>({
    tool: path,
    send: (body) => accountRequest(path, { method: 'POST', body, scoped: true }),
    validate: (result) => typeof result.message?.id === 'string',
    onSuccess: () => {
      setDraft('');
      read.reload();
    },
  });
  const said = read.data;
  const open = said?.questions.filter((question) => !question.answeredAt).at(-1);
  const can = !!actor && writes(actor) && (thread.status !== 'retired' || !!open);
  const lines = said
    ? [
        ...said.questions
          .filter((question) => question !== open)
          .map((question) => ({ at: question.askedAt, key: question.id, asked: question })),
        ...said.messages.map((message) => ({ at: message.createdAt, key: message.id, message })),
      ].sort((a, b) => a.at.localeCompare(b.at))
    : [];
  if (!lines.length && !open && !can) return null;
  return (
    <section className="thread-messages" aria-label="Messages">
      {lines.length > 0 && (
        <ol className="thread-message-list">
          {lines.map((line) =>
            'asked' in line && line.asked ? (
              <li key={line.key}>
                <span className="faint">
                  Agent asked · <Ago at={line.at} />
                </span>
                <p className="wrap">{line.asked.question}</p>
              </li>
            ) : 'message' in line && line.message ? (
              <li key={line.key}>
                <span className="faint">
                  {line.message.senderActorId === actor?.id
                    ? 'You'
                    : (nameOf(line.message.senderActorId) ?? 'Someone')}{' '}
                  · <Ago at={line.at} />
                  {line.message.acknowledgedAt ? ' · read' : ' · queued'}
                </span>
                <p className="wrap">{line.message.body}</p>
                {line.message.reply && <p className="wrap muted">↳ {line.message.reply}</p>}
              </li>
            ) : null,
          )}
        </ol>
      )}
      {open && (
        <div className="thread-question">
          <span className="label">Answer</span>
          <p className="wrap">{open.question}</p>
        </div>
      )}
      {can && (
        <form
          className="thread-compose"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) void send.submit({ body: draft.trim() });
          }}
        >
          <textarea
            className="textarea"
            rows={2}
            maxLength={8000}
            aria-label={open ? 'Answer' : 'Message to this thread'}
            placeholder={open ? 'Answer' : 'Message'}
            value={draft}
            readOnly={send.busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Submit
            label="Send"
            saving="Sending…"
            busy={send.busy}
            retry={send.retry}
            disabled={!draft.trim()}
          />
          {send.error && (
            <p className="error-message" role="alert">
              {send.error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

/**
 * One thread, in the browser's own modal dialog: Escape and a press on the backdrop close it,
 * and the focus stays in it while it is open. It hangs from the body, so the narrow sidebar's
 * own layout never reaches it. It reads as `ThreadReading` does; `group` is the thread's stage
 * and role, whose every visit it lists.
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
  const name = threadName(thread);
  const lease = thread.visits.find(active);
  const now = clock(undefined, loadedAt, useNow(lease ? 1000 : 0), 20_000);
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
        <header className="cluster cluster--between">
          <div>
            <h2 id="thread-dialog-title">{name}</h2>
            <p className="muted">{title}</p>
            {/* The visit holding its lease: how it stands, and the way to the lease's controls. */}
            {lease && (
              <p className="cluster agent-help">
                {lease.liveness && <Live of={leaseLiveness({ liveness: lease.liveness }, now)} />}
                <Target to={{ key: runningKey('session', lease.sessionId) }} className="hit">
                  {lease.runnerId ? `Lease on ${lease.runnerId}` : 'Lease'}
                </Target>
              </p>
            )}
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

type Tab = 'conversation' | 'visits' | 'calls';
/**
 * What one thread did: its messages and the box to it, then for an operator its conversation,
 * and for anyone its visits and its Merv calls, a press apart. The visits are those of its whole
 * `group`, the stage's threads in its role, numbered in one count.
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
  const tabs: Tab[] = reads ? ['conversation', 'visits', 'calls'] : ['visits', 'calls'];
  const [tab, setTab] = useState<Tab>(tabs[0]!);
  const visits = useMemo(() => visitsOf(group), [group]);
  const names = useMemo(() => visitNames(visits), [visits]);
  return (
    <>
      <ThreadMessageBox thread={thread} />
      <div className="tabs tabs--strip" role="group" aria-label="Thread">
        {tabs.map((each) => (
          <button type="button" key={each} aria-pressed={tab === each} onClick={() => setTab(each)}>
            {capital(each)}
          </button>
        ))}
      </div>
      {tab === 'conversation' ? (
        <Conversation thread={thread} names={names} label={threadName(thread)} />
      ) : tab === 'calls' ? (
        <Calls thread={thread} names={names} />
      ) : (
        <Visits visits={visits} names={names} loadedAt={loadedAt} />
      )}
    </>
  );
}

/**
 * A record's threads, read every 4 s while one of them is live, every 10 s otherwise; an
 * instance not named reads nothing.
 */
export function useThreadList(instanceId: string | undefined) {
  const [every, setEvery] = useState(10_000);
  const list = useTool<{ threads: ThreadView[] }>(
    instanceId ? `/sessions/threads?instanceId=${encodeURIComponent(instanceId)}` : null,
    {},
    { every },
  );
  const threads = list.data?.threads ?? [];
  const live = threads.some((thread) => thread.status === 'live');
  useEffect(() => setEvery(live ? 4000 : 10_000), [live]);
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
