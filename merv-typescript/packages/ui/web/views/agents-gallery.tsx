import { useEffect, useRef, useState } from 'react';
import type { ProjectThread, ProjectThreads } from '@merv/sessions/models';
import { accountRequest, refreshTools, useTool } from '../api';
import { LoadState, cx, kindOf, words } from '../components';
import { tailLines, useLiveFeed } from '../live-feed';
import { rowOf, useRows } from '../navigation';
import { useReadsAgents } from '../session';
import type { Row } from '../shell-types';
import { ThreadCard, ThreadCompose, ThreadDialog, capital, delivery, isLive } from './threads';

/**
 * The project's agents, one card each: those waiting on their owner's answer first, outlined,
 * each with its question and the box that answers it; then those at work, each card's body the
 * last lines its agent said or did, read for every card over one live feed; then, folded, the
 * rest, a page at a time. A card is titled by the stage its work stands at and opens its thread.
 * Every word of a stage, a kind and a role is its owner's: the page names none.
 */

/** A thread's work as a reader knows it: its kind, as the row that lists it names it, and name. */
const workOf = (rows: readonly Row[], thread: ProjectThread) => {
  const row = thread.workflow ? rowOf(rows, thread.workflow) : undefined;
  const kind = (row && kindOf(row.view.kind).label) || capital(words(thread.workflow));
  return [kind, thread.name].filter(Boolean).join(' · ');
};

/** The last lines its agent said or did, from the feed. */
function Tail({ blocks }: { blocks: Parameters<typeof tailLines>[0] | undefined }) {
  const lines = tailLines(blocks ?? []);
  return (
    <ol className="agent-tail" aria-label="Live" aria-live="off">
      {lines.map((line) => (
        <li key={line.key} className={`agent-tail--${line.kind}`}>
          {line.text}
        </li>
      ))}
    </ol>
  );
}

/** The newest message to the thread, and whether its agent has read it, with its reply; a
 *  question to its agent (an inquiry), where its answer is. */
function Said({ message }: { message: NonNullable<ProjectThread['message']> }) {
  const open = !message.inquiry || message.inquiry.open;
  return (
    <div className="agent-card-said">
      <p>
        <span
          className={cx('agent-said-state', !message.acknowledgedAt && open && 'agent-said--sent')}
        >
          {capital(delivery(message))}
        </span>{' '}
        {message.body}
      </p>
      {message.reply && <p className="muted">↳ {message.reply}</p>}
    </div>
  );
}

export function AgentsGallery() {
  const rows = useRows();
  const reads = useReadsAgents();
  // Quick while an agent works; a question waits on a person, who answers here.
  const first = useTool<ProjectThreads>(
    '/sessions/threads',
    {},
    { every: (data) => (data?.threads.some(isLive) ? 4000 : 30_000) },
  );
  const [older, setOlder] = useState<{ threads: ProjectThread[]; next: string | null }>();
  const [busy, setBusy] = useState(false);
  const [recent, showRecent] = useState(false);
  const [opened, setOpened] = useState<string>();
  const shown = [...(first.data?.threads ?? []), ...(older?.threads ?? [])];
  // The newest page's own read of a thread comes first; one it has moved off stays as shown.
  const seen = new Set<string>();
  const threads = shown.filter((item) => !seen.has(item.id) && seen.add(item.id));
  const next = older ? older.next : (first.data?.next ?? null);
  const waiting = threads.filter((item) => item.question);
  // What wants attention without asking its owner, as Sessions says: at work, being asked, or
  // holding a message its agent will still read.
  const working = threads
    .filter((item) => !item.question && (isLive(item) || item.attention))
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)));
  const rest = threads.filter((item) => !item.question && !isLive(item) && !item.attention);
  const live = threads.filter(isLive).length;
  const tails = useLiveFeed(reads && threads.some(isLive));
  // The rail's badge counts the same agents: it is told when they change.
  const counted = useRef<string>();
  const counts = first.data ? `${live}:${waiting.length}` : undefined;
  useEffect(() => {
    if (counted.current !== undefined && counts !== counted.current) refreshTools('ui.shell');
    if (counts !== undefined) counted.current = counts;
  }, [counts]);
  const more = async () => {
    // The page after the oldest thread shown, so none a newer one pushed off the first is lost;
    // the first page's threads are kept with the older ones as they stand now.
    const kept = threads.filter((item) => item.seq !== undefined);
    const oldest = kept.reduce<string | null>(
      (low, item) => (low === null || Number(item.seq) < Number(low) ? item.seq! : low),
      null,
    );
    setBusy(true);
    try {
      const page = await accountRequest<ProjectThreads>(
        `/sessions/threads?before=${encodeURIComponent(oldest ?? next!)}`,
        { scoped: true },
      );
      setOlder({ threads: [...kept, ...page.threads], next: page.next });
    } finally {
      setBusy(false);
    }
  };
  const card = (thread: ProjectThread) => (
    <li key={thread.id}>
      <ThreadCard
        thread={thread}
        title={capital(words(thread.state))}
        subtitle={workOf(rows, thread)}
        waiting={!!thread.question}
        onOpen={() => setOpened(thread.id)}
      >
        {thread.question && <p className="agent-card-question wrap">{thread.question.question}</p>}
        {thread.question && <ThreadCompose thread={thread} answering />}
        {reads && isLive(thread) && <Tail blocks={tails.byThread.get(thread.id)} />}
        {thread.message && !thread.question && <Said message={thread.message} />}
      </ThreadCard>
    </li>
  );
  const thread = threads.find((item) => item.id === opened);
  return (
    <section className="stack agents-gallery" aria-label="Agents">
      <p className="agents-count muted">
        {live} working · {waiting.length} waiting on you
      </p>
      {(!first.data || first.error) && <LoadState {...first} />}
      {waiting.length + working.length > 0 && (
        <ul className="agent-grid">
          {waiting.map(card)}
          {working.map(card)}
        </ul>
      )}
      {(rest.length > 0 || next) && (
        <div className="stack">
          <div>
            <button
              type="button"
              className="btn-text agents-recent"
              aria-expanded={recent}
              onClick={() => showRecent((open) => !open)}
            >
              Recent {recent ? '▾' : '▸'}{' '}
              <span className="section-n">
                {rest.length}
                {next ? '+' : ''}
              </span>
            </button>
          </div>
          {recent && rest.length > 0 && <ul className="agent-grid">{rest.map(card)}</ul>}
          {recent && next && (
            <div>
              <button
                type="button"
                className="btn-text"
                disabled={busy}
                onClick={() => void more()}
              >
                {busy ? 'Loading…' : 'Show older'}
              </button>
            </div>
          )}
        </div>
      )}
      {thread && (
        <ThreadDialog
          thread={thread}
          title={workOf(rows, thread)}
          loadedAt={first.loadedAt}
          onClose={() => setOpened(undefined)}
        />
      )}
    </section>
  );
}
