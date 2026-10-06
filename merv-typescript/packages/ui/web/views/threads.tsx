import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { Live, LoadState, Ruled, Stamp, col, cx, stamp, useNow, words } from '../components';
import { CloseIcon } from '../icons';
import { clock, elapsed } from '../liveness';
import { StageList } from '../process';
import { useReadsAgents } from '../session';
import type { ThreadConversation, ThreadList, ThreadView, VisitView } from '../thread-view';
import { AgentConversation, type ConversationVisit } from './agent-live';
import { leaseLiveness } from './agent-sessions-panel';

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
const visitName = (visit: VisitView, at: number) =>
  [`Visit ${at + 1}`, visit.resumed && 'resumed'].filter(Boolean).join(' · ');
const threadName = (thread: ThreadView) =>
  `${capital(words(thread.role))} · ${words(thread.state)} · ${thread.status}`;

/**
 * One thread as one chip: its role, a live dot while a visit holds its lease, how many visits
 * it made where more than one, and the launches that failed, counted here rather than drawn.
 */
function ThreadChip({ thread, onOpen }: { thread: ThreadView; onOpen(): void }) {
  const launches = thread.visits.filter(failed).length;
  const visits = thread.visits.length - launches;
  return (
    <button
      type="button"
      className={cx('agent-chip', thread.status === 'retired' && 'agent-chip--retired')}
      aria-haspopup="dialog"
      title={thread.status === 'retired' ? 'Retired thread' : undefined}
      onClick={onOpen}
    >
      {thread.visits.some(active) && (
        <span className="live-dot live-dot--live" aria-label="Live" role="img" />
      )}
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
  const rows = thread.visits.map((visit, at) => ({ visit, at }));
  type Row = (typeof rows)[number];
  return (
    <Ruled<Row>
      label="Visits"
      template="minmax(0, 1.2fr) repeat(2, minmax(0, 1.3fr)) minmax(0, 0.7fr) minmax(0, 1.5fr) minmax(0, 1.2fr)"
      keyOf={({ visit }) => visit.sessionId}
      rows={rows}
      columns={[
        col<Row>('visit', 'Visit', ({ visit, at }) => visitName(visit, at)),
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
            ? ['Did not start', reason(visit.why)].filter(Boolean).join(' · ')
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
  const visits = useMemo(
    () =>
      thread.visits.flatMap((visit, at): ConversationVisit[] =>
        visit.launched
          ? [
              {
                sessionId: visit.sessionId,
                divider: [visitName(visit, at), stamp(visit.startedAt ?? visit.offeredAt)].join(
                  ' · ',
                ),
                ...(active(visit)
                  ? { stream: `/sessions/${encodeURIComponent(visit.sessionId)}/events` }
                  : {
                      events: kept.data?.visits.find((item) => item.sessionId === visit.sessionId)
                        ?.events,
                    }),
              },
            ]
          : [],
      ),
    [thread, kept.data],
  );
  if (!kept.data && !liveId) return <LoadState {...kept} />;
  return <AgentConversation key={liveId ?? ''} label={label} visits={visits} />;
}

/**
 * One thread, in the browser's own modal dialog: Escape and a press on the backdrop close it,
 * and the focus stays in it while it is open. It hangs from the body, so the narrow sidebar's
 * own layout never reaches it. An operator reads its conversation and its
 * visits; anyone else, its visits alone, as the live stream has always been an operator's.
 */
function ThreadDialog({
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
 * A record's stages with its threads on them, for the Work page's sidebar. The threads are
 * read every 4 s while one of them is live, every 10 s otherwise.
 */
export function ThreadStages({ graph, title }: { graph: ProcessGraph; title: string }) {
  const [every, setEvery] = useState(10_000);
  const list = useTool<ThreadList>(
    `/sessions/threads?instanceId=${encodeURIComponent(graph.instanceId)}`,
    {},
    { every },
  );
  const threads = list.data?.threads ?? [];
  const live = threads.some((thread) => thread.status === 'live');
  useEffect(() => setEvery(live ? 4000 : 10_000), [live]);
  const [opened, setOpened] = useState<string>();
  const thread = threads.find((item) => item.id === opened);
  return (
    <>
      <StageList
        graph={graph}
        aside={(state) =>
          threads
            .filter((item) => item.state === state)
            .map((item) => (
              <ThreadChip key={item.id} thread={item} onOpen={() => setOpened(item.id)} />
            ))
        }
      />
      {thread && (
        <ThreadDialog
          thread={thread}
          title={title}
          loadedAt={list.loadedAt}
          onClose={() => setOpened(undefined)}
        />
      )}
    </>
  );
}
