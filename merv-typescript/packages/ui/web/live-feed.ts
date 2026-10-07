import { useRef, useState } from 'react';
import type { LiveFeedFrame } from '@merv/sessions/models';
import { NO_TIMELINE, mergeEvents, type AgentBlock } from './agent-stream';
import { useEventStream } from './event-stream';

/**
 * The project's live feed as the Agents page reads it: one connection (`/sessions/live`) for
 * every live visit, however many cards draw one. Each visit's events are merged into blocks as
 * a thread's own stream is, and only the newest few are kept: a card is a glance.
 */
type Timeline = ReturnType<typeof mergeEvents>;
/** The blocks a visit keeps; a card draws the last lines of these. */
const KEEP = 16;

const kept = (timeline: Timeline): Timeline => {
  if (timeline.blocks.length <= KEEP) return timeline;
  const blocks = timeline.blocks.slice(-KEEP);
  return {
    blocks,
    index: new Map(blocks.map((block, at) => [block.key, at])),
    last: timeline.last,
  };
};

/** What the page holds of the feed: each live visit's thread and its newest blocks. */
export interface LiveTails {
  /** The newest blocks of each thread whose visit is live, by thread id. */
  byThread: ReadonlyMap<string, AgentBlock[]>;
}
const NO_TAILS: LiveTails = { byThread: new Map() };

/**
 * The feed's frames applied to what is held, by visit: a snapshot starts over, a visit marked
 * `reset` starts its own tail over, and a visit no longer live is let go.
 */
export function applyFrame(
  held: ReadonlyMap<string, { threadId: string; timeline: Timeline }>,
  frame: LiveFeedFrame,
  snapshot: boolean,
) {
  const next = new Map<string, { threadId: string; timeline: Timeline }>();
  const live = new Set(frame.live.map((visit) => visit.sessionId));
  if (!snapshot) for (const [id, visit] of held) if (live.has(id)) next.set(id, visit);
  for (const visit of frame.visits) {
    const before = visit.reset || snapshot ? NO_TIMELINE : next.get(visit.sessionId)?.timeline;
    next.set(visit.sessionId, {
      threadId: visit.threadId,
      timeline: kept(mergeEvents(before ?? NO_TIMELINE, visit.events)),
    });
  }
  return next;
}

/**
 * The feed, read while `enabled` (`useEventStream`). Each connection starts over from the
 * server's snapshot.
 */
export function useLiveFeed(enabled: boolean): LiveTails {
  const [tails, setTails] = useState(NO_TAILS);
  const held = useRef(new Map<string, { threadId: string; timeline: Timeline }>());
  useEventStream(enabled ? '/sessions/live' : null, (event, value) => {
    if (event !== 'snapshot' && event !== 'tail') return;
    const frame = value as LiveFeedFrame;
    if (!Array.isArray(frame.live) || !Array.isArray(frame.visits)) return;
    held.current = applyFrame(held.current, frame, event === 'snapshot');
    const byThread = new Map<string, AgentBlock[]>();
    for (const visit of held.current.values()) byThread.set(visit.threadId, visit.timeline.blocks);
    setTails({ byThread });
  });
  return enabled ? tails : NO_TAILS;
}
