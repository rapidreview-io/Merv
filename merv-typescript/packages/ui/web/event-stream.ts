import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sameOriginPath } from '@merv/contracts/running';
import { currentToken, projectSelection } from './api';

type Frame = { event: string; data: string };

/** A live stream the server refused, or answered with no body: its HTTP status says why. */
export class StreamError extends Error {
  constructor(readonly status: number) {
    super(`Live stream unavailable (${status})`);
  }
}

/** Splits a server-sent event stream into frames, dropping any frame larger than the cap. */
export function frameParser(accept: (frame: Frame) => void, maxFrameChars = 65_536) {
  let pending = '';
  let event = '';
  let data = '';
  let discarded = false;
  let overflow = false;
  const line = (value: string) => {
    if (!value) {
      if (!discarded && data) accept({ event: event || 'message', data: data.slice(0, -1) });
      event = '';
      data = '';
      discarded = false;
      return;
    }
    if (discarded || value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = content;
    if (field === 'data') {
      if (data.length + content.length > maxFrameChars) {
        discarded = true;
        data = '';
      } else data += `${content}\n`;
    }
  };
  return (chunk: string) => {
    let start = 0;
    let end = chunk.indexOf('\n');
    while (end !== -1) {
      if (overflow) {
        overflow = false;
        pending = '';
      } else if (pending.length + end - start > maxFrameChars) {
        pending = '';
        discarded = true;
      } else {
        line((pending + chunk.slice(start, end)).replace(/\r$/, ''));
        pending = '';
      }
      start = end + 1;
      end = chunk.indexOf('\n', start);
    }
    if (!overflow && pending.length + chunk.length - start > maxFrameChars) {
      pending = '';
      discarded = true;
      overflow = true;
    } else if (!overflow) {
      pending += chunk.slice(start);
    }
  };
}

/**
 * Reads one server-sent event stream of this app (`path`, with the caller's credential and
 * project) until it ends or `signal` aborts, handing each frame's event name and its JSON
 * object to `accept`. Resolves true when the server closed the stream on purpose (`rotate`),
 * so reconnecting says nothing.
 */
export async function readEventStream(
  path: string,
  signal: AbortSignal,
  accept: (event: string, value: object) => void,
): Promise<boolean> {
  // The credential goes to this app's own host and nowhere else, whatever path it is handed.
  if (!sameOriginPath(path)) throw new StreamError(403);
  const response = await fetch(path, {
    signal,
    credentials: 'omit',
    headers: {
      accept: 'text/event-stream',
      ...(currentToken() ? { authorization: `Bearer ${currentToken()}` } : {}),
      ...(projectSelection() ? { 'x-merv-project-id': projectSelection()! } : {}),
    },
  });
  if (!response.ok || !response.body) throw new StreamError(response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rotated = false;
  const parse = frameParser(
    ({ event, data }) => {
      if (event === 'rotate') rotated = true;
      try {
        const value: unknown = JSON.parse(data);
        if (value && typeof value === 'object') accept(event, value);
      } catch {}
    },
    32 * 1024 * 1024,
  );
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      parse(decoder.decode(value, { stream: true }));
    }
    parse(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return rotated;
}

const shown = () => document.visibilityState !== 'hidden';
const onShown = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

export type EventStreamState = 'connecting' | 'stalled' | 'open' | 'retrying' | 'ended' | 'refused';

/**
 * How long a connection may go without its first frame before the page says it is slow rather
 * than connecting. A proxy that compresses the stream holds every frame until the server rotates
 * the connection; the page then says so and offers to try again, never "Connecting…" for good.
 */
export const STALL_MS = 10_000;

/**
 * One server-sent event stream of this app, read while `url` is given and the tab is shown,
 * each frame handed to `onEvent`. A hidden tab closes it and showing the tab opens it again. A
 * stream the server rotates is opened again at once; a dropped one waits, doubling with each
 * failure up to half a minute; one the server is too busy to open (429) waits the same way from
 * five seconds, still connecting, with nothing to say; one the server ends (`end`) or refuses is
 * left closed. `after`
 * names the last event the reader holds, so a reconnect asks only for what follows it
 * (`?after=`). A stream with no frame STALL_MS after it was first opened from nothing held, and
 * not ended or refused, is `stalled`; `retry` opens the stream again at once, from the last event
 * held.
 */
export function useEventStream(
  url: string | null,
  onEvent: (event: string, value: object) => void,
  after?: () => number,
): { state: EventStreamState; retry(): void } {
  const [state, setState] = useState<EventStreamState>('connecting');
  const [attempt, setAttempt] = useState(0);
  const visible = useSyncExternalStore(onShown, shown);
  const latest = useRef({ onEvent, after });
  latest.current = { onEvent, after };
  useEffect(() => {
    if (!visible || !url) return;
    // A new stream (another url, or the tab shown again) owes nothing to the last one's state.
    setState('connecting');
    let stopped = false;
    let failures = 0;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * When reading began, until the first frame came. A stream opened again from the last event
     * held owes no frame while its agent is quiet, so it is never slow; nor is one that ended.
     */
    let waiting: number | null = latest.current.after?.() ? null : Date.now();
    // Read on the page's clock each second, so a moved clock counts as time that passed.
    const watch = setInterval(() => {
      if (!stopped && waiting !== null && Date.now() - waiting >= STALL_MS) {
        waiting = null;
        setState('stalled');
      }
    }, 1000);
    const controller = new AbortController();
    const connect = async () => {
      const since = Date.now();
      const from = latest.current.after?.() ?? 0;
      let ended = false;
      try {
        const rotated = await readEventStream(
          from ? `${url}${url.includes('?') ? '&' : '?'}after=${from}` : url,
          controller.signal,
          (event, value) => {
            if (event === 'end') ended = true;
            if (stopped || event === 'end' || event === 'rotate') return;
            failures = 0;
            waiting = null;
            setState('open');
            latest.current.onEvent(event, value);
          },
        );
        if (stopped) return;
        if (ended) {
          waiting = null;
          return setState('ended');
        }
        if (rotated && Date.now() - since > 5000) return void connect();
        busy = false;
      } catch (cause) {
        if (stopped) return;
        if (cause instanceof StreamError && [401, 403, 404, 410].includes(cause.status)) {
          waiting = null;
          return setState('refused');
        }
        busy = cause instanceof StreamError && cause.status === 429;
      }
      if (!busy) setState('retrying');
      timer = setTimeout(
        () => void (stopped || connect()),
        Math.min(30_000, (busy ? 5000 : 1000) * 2 ** failures++),
      );
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      clearInterval(watch);
    };
  }, [url, visible, attempt]);
  return { state, retry: () => setAttempt((count) => count + 1) };
}
