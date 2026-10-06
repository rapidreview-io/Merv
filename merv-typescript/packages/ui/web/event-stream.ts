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
