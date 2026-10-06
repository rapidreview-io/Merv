import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentStreamEvent } from '@merv/contracts/agent-stream';
import { StreamError, readEventStream } from './pi-stream';

/**
 * A worker agent's live stream as the page reads it: the events Sessions relays, merged into
 * the blocks a person reads. A thinking or a text block grows piece by piece under one id; a
 * tool call and its result share an id and are one block; a status is a line of its own. Each
 * event is taken once, by its sequence number, so a reconnect that asks from the last one it
 * holds (`?after=`) and a snapshot that overlaps what is already here add nothing twice.
 */
export type AgentBlock =
  | { kind: 'thinking' | 'text'; key: string; at: string; text: string; done: boolean; cut: number }
  | {
      kind: 'tool';
      key: string;
      at: string;
      /** Absent where only the result arrived: its call came before what the stream kept. */
      name?: string;
      input?: string;
      cut: number;
      result?: { output: string; error: boolean; cut: number };
    }
  | { kind: 'status'; key: string; at: string; text: string };

export interface AgentTimeline {
  blocks: AgentBlock[];
  /** Where each block's key stands in `blocks`. */
  index: ReadonlyMap<string, number>;
  /** The newest sequence number taken. */
  last: number;
}
export const NO_TIMELINE: AgentTimeline = { blocks: [], index: new Map(), last: 0 };

/**
 * The timeline with these events in it. A block that changes is a new object and every other
 * block is the one it was, so a list drawn from it redraws only what changed; events already
 * taken leave the timeline as it was, the same object.
 */
export function mergeEvents(timeline: AgentTimeline, events: AgentStreamEvent[]): AgentTimeline {
  const fresh = events.filter((item) => item.seq > timeline.last).sort((a, b) => a.seq - b.seq);
  if (!fresh.length) return timeline;
  const blocks = [...timeline.blocks];
  const index = new Map(timeline.index);
  let last = timeline.last;
  for (const { seq, at, event } of fresh) {
    if (seq <= last) continue;
    last = seq;
    const key = `${event.kind === 'tool_result' ? 'tool_call' : event.kind}:${event.id}`;
    const place = index.get(key);
    const before = place === undefined ? undefined : blocks[place];
    let next: AgentBlock;
    if (event.kind === 'thinking' || event.kind === 'text')
      next =
        before?.kind === event.kind
          ? {
              ...before,
              text: before.text + event.delta,
              done: before.done || !!event.done,
              cut: before.cut + (event.cut ?? 0),
            }
          : {
              kind: event.kind,
              key,
              at,
              text: event.delta,
              done: !!event.done,
              cut: event.cut ?? 0,
            };
    else if (event.kind === 'status') next = { kind: 'status', key, at, text: event.text };
    else {
      const tool = before?.kind === 'tool' ? before : { kind: 'tool' as const, key, at, cut: 0 };
      next =
        event.kind === 'tool_call'
          ? { ...tool, name: event.name, input: event.input, cut: event.cut ?? 0 }
          : {
              ...tool,
              result: { output: event.output, error: !!event.error, cut: event.cut ?? 0 },
            };
    }
    if (place === undefined) {
      index.set(key, blocks.length);
      blocks.push(next);
    } else blocks[place] = next;
  }
  return { blocks, index, last };
}

/** The events a frame carries, as a list or under `events`; anything else carries none. */
const eventsOf = (value: object): AgentStreamEvent[] => {
  const list: unknown = Array.isArray(value) ? value : (value as { events?: unknown }).events;
  return Array.isArray(list)
    ? list.filter(
        (item): item is AgentStreamEvent =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as AgentStreamEvent).seq === 'number' &&
          typeof (item as AgentStreamEvent).event?.kind === 'string',
      )
    : [];
};

const shown = () => document.visibilityState !== 'hidden';
const onShown = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

export type AgentStreamState = 'connecting' | 'open' | 'retrying' | 'ended' | 'refused';

/**
 * One session's stream, read while the page that shows it is mounted and its tab is shown. A
 * hidden tab closes it, and showing the tab again opens it from the last event held, as a
 * dropped connection does after a wait that doubles with each failure, up to half a minute.
 * A stream the server rotates is opened again at once; one the server says has ended is left
 * closed. A snapshot that does not follow what is held (a reader that fell too far behind)
 * starts the timeline over, so no block is joined across what was missed.
 */
export function useAgentStream(url: string) {
  const held = useRef(NO_TIMELINE);
  const [timeline, setTimeline] = useState(NO_TIMELINE);
  const [state, setState] = useState<AgentStreamState>('connecting');
  const visible = useSyncExternalStore(onShown, shown);
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const connect = async () => {
      const since = Date.now();
      const after = held.current.last;
      let ended = false;
      try {
        const rotated = await readEventStream(
          after ? `${url}${url.includes('?') ? '&' : '?'}after=${after}` : url,
          controller.signal,
          (event, value) => {
            if (event === 'end') ended = true;
            if (stopped || (event !== 'snapshot' && event !== 'events')) return;
            failures = 0;
            setState('open');
            const events = eventsOf(value);
            const gap =
              event === 'snapshot' &&
              events.length > 0 &&
              Math.min(...events.map((item) => item.seq)) > held.current.last + 1;
            const next = mergeEvents(gap ? NO_TIMELINE : held.current, events);
            if (next === held.current) return;
            held.current = next;
            setTimeline(next);
          },
        );
        if (stopped) return;
        if (ended) return setState('ended');
        if (rotated && Date.now() - since > 5000) return void connect();
      } catch (cause) {
        if (stopped) return;
        if (cause instanceof StreamError && [401, 403, 404, 410].includes(cause.status))
          return setState('refused');
      }
      setState('retrying');
      timer = setTimeout(
        () => void (stopped || connect()),
        Math.min(30_000, 1000 * 2 ** failures++),
      );
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, visible]);
  return { timeline, state };
}
