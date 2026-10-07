import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runningKey } from '@merv/contracts/running';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import type { ThreadConversation, ThreadView, VisitView } from '@merv/sessions/models';
import { useTool } from '../api';
import { Live, LoadState, Ruled, Stamp, col, cx, stamp, useNow, words } from '../components';
import { CloseIcon } from '../icons';
import { clock, elapsed, type Clock } from '../liveness';
import { StageList } from '../process';
import { useReadsAgents } from '../session';
import { AgentConversation, type ConversationVisit } from './agent-live';
import { leaseLiveness } from './agent-sessions-panel';
import { Target } from './running-phrase';

/**
 * Who worked each stage of a record: Sessions' threads, each drawn on the stage whose state
 * it names, and opened in a dialog that reads what it said and every visit it made. Nothing
 * here knows a workflow: a thread stands on the stage with its own `state` string, and its
 * role is said in the workflow's own words.
 */

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
function visitNames(thread: ThreadView): Map<string, string> {
  let ran = 0;
  return new Map(
    thread.visits.map((visit) => [
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
const threadName = (thread: ThreadView) =>
  `${capital(words(thread.role))} · ${words(thread.state)} · ${thread.status}`;

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
 * One thread as one chip: its role, a live dot while a visit holds its lease, how many visits
 * it made where more than one, and the launches that failed, counted here rather than drawn.
 * Its tooltip says how the lease stands and on which machine.
 */
function ThreadChip({ thread, now, onOpen }: { thread: ThreadView; now: Clock; onOpen(): void }) {
  const launches = thread.visits.filter(failed).length;
  const visits = thread.visits.length - launches;
  return (
    <button
      type="button"
      className={cx(
        'agent-chip',
        thread.status === 'retired' && 'agent-chip--retired',
        lapsed(thread) && 'agent-chip--bad',
      )}
      aria-haspopup="dialog"
      title={thread.status === 'retired' ? 'Retired thread' : liveLine(thread, now)}
      onClick={onOpen}
    >
      {thread.visits.some(active) && (
        <span className="live-dot live-dot--live" aria-label="Live" role="img" />
      )}
      <RoleMark role={thread.role} />
      <span>{capital(words(thread.role))}</span>
      {visits > 1 && <span className="faint">· {visits} visits</span>}
      {launches > 0 && (
        <span className="faint">· {plural(launches, 'failed launch', 'failed launches')}</span>
      )}
    </button>
  );
}

/** Each visit on one row: when it ran, how long, how it ended, and where. */
function Visits({ thread, loadedAt }: { thread: ThreadView; loadedAt?: string }) {
  const live = thread.visits.some(active);
  const now = clock(undefined, loadedAt, useNow(live ? 1000 : 0), 20_000);
  const names = visitNames(thread);
  const rows = thread.visits.map((visit) => ({ visit, name: names.get(visit.sessionId)! }));
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
function Conversation({ thread, label }: { thread: ThreadView; label: string }) {
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
    const names = visitNames(thread);
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
          ]
            .filter(Boolean)
            .join(' · '),
          ...(live
            ? { stream: `/sessions/${encodeURIComponent(visit.sessionId)}/events` }
            : { events: said?.events }),
        },
      ];
    });
  }, [thread, kept.data]);
  if (!kept.data && !liveId) return <LoadState {...kept} />;
  return <AgentConversation key={liveId ?? ''} label={label} visits={visits} />;
}

/**
 * One thread, in the browser's own modal dialog: Escape and a press on the backdrop close it,
 * and the focus stays in it while it is open. It hangs from the body, so the narrow sidebar's
 * own layout never reaches it. An operator reads its conversation and its
 * visits; anyone else, its visits alone, as the live stream has always been an operator's.
 */
export function ThreadDialog({
  thread,
  title,
  loadedAt,
  onClose,
}: {
  thread: ThreadView;
  title: string;
  loadedAt?: string;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reads = useReadsAgents();
  const [tab, setTab] = useState<'conversation' | 'visits'>(reads ? 'conversation' : 'visits');
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
        {reads && (
          <div className="tabs tabs--strip" role="group" aria-label="Thread">
            {(['conversation', 'visits'] as const).map((each) => (
              <button
                type="button"
                key={each}
                aria-pressed={tab === each}
                onClick={() => setTab(each)}
              >
                {capital(each)}
              </button>
            ))}
          </div>
        )}
        {reads && tab === 'conversation' ? (
          <Conversation thread={thread} label={name} />
        ) : (
          <Visits thread={thread} loadedAt={loadedAt} />
        )}
      </div>
    </dialog>,
    document.body,
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
 * to its thread's dialog.
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
          title={title}
          loadedAt={loadedAt}
          onClose={() => setOpened(undefined)}
        />
      )}
    </>
  );
}

/** The stage card with each stage's threads as chips; a chip opens its thread through `onOpen`. */
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
  // The stage's current threads first; one retired beside them is the quiet "+1 earlier",
  // which opens the newest of them. Retired threads with nothing current are chips themselves.
  const aside = (state: string) => {
    const here = threads.filter((item) => item.state === state);
    const current = here.filter((item) => item.status !== 'retired');
    const earlier = here.filter((item) => item.status === 'retired');
    const chip = (item: ThreadView) => (
      <ThreadChip key={item.id} thread={item} now={now} onOpen={() => setOpened(item.id)} />
    );
    if (!current.length) return earlier.map(chip);
    return [
      ...current.map(chip),
      earlier.length > 0 && (
        <button
          type="button"
          key="earlier"
          className="btn-text stage-earlier"
          aria-haspopup="dialog"
          onClick={() => setOpened(earlier.at(-1)!.id)}
        >
          +{earlier.length} earlier
        </button>
      ),
    ];
  };
  return <StageList graph={graph} aside={aside} />;
}
