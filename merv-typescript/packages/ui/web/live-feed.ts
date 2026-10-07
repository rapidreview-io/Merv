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

/** A tool's arguments as one short phrase: the command, query or path they name, else the text. */
export function argument(input: string | undefined): string {
  if (!input) return '';
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    // Arguments the feed cut short are no longer JSON: the named one is read from its start.
    const named =
      /"(?:command|cmd|query|pattern|file_path|path|url|description)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(
        input,
      );
    return named ? named[1]!.replace(/\\(.)/g, '$1') : input;
  }
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return input;
  const fields = value as Record<string, unknown>;
  const named = ['command', 'cmd', 'query', 'pattern', 'file_path', 'path', 'url', 'description']
    .map((key) => fields[key])
    .find((item) => typeof item === 'string' || Array.isArray(item));
  const found = named ?? Object.values(fields).find((item) => typeof item === 'string');
  return Array.isArray(found) ? found.join(' ') : typeof found === 'string' ? found : '';
}

/** One line of a card's stream: what the agent says, does, thinks or reached. */
export type TailLine = { key: string; kind: 'text' | 'tool' | 'thinking' | 'status'; text: string };

/** The last `count` lines the agent said or did, oldest first. */
export function tailLines(blocks: readonly AgentBlock[], count = 6): TailLine[] {
  const lines: TailLine[] = [];
  for (const block of blocks) {
    if (block.kind === 'tool') {
      if (!block.name) continue;
      const said = argument(block.input).replace(/\s+/g, ' ').trim();
      lines.push({
        key: block.key,
        kind: 'tool',
        text: `› ${block.name}${said ? `: ${said}` : ''}`,
      });
    } else if (block.kind === 'status')
      lines.push({ key: block.key, kind: 'status', text: block.text });
    else if (block.kind === 'thinking') {
      const last = block.text.trim().split('\n').filter(Boolean).at(-1);
      if (last) lines.push({ key: block.key, kind: 'thinking', text: last });
    } else
      block.text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((text, at) => lines.push({ key: `${block.key}:${at}`, kind: 'text', text }));
  }
  return lines.slice(-count);
}
