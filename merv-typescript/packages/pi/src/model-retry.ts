/**
 * A model call the provider turns away for a moment (overloaded, rate limited, a server error)
 * before it has said anything is sent again, after 2 s, 4 s, 8 s, rather than ending the person's
 * turn. Only a failure that comes before the first frame of the answer is retried, so nothing the
 * agent read is ever read twice; anything else (a refusal, a context overflow, a failure partway
 * through an answer) reaches the agent as it came. The relay refunds a failed call.
 */
import { sleep as wait } from '@merv/contracts/async';
import { eventData } from '@merv/contracts/text';

/** Provider codes that say "try again shortly", as the relay passes them on. */
const TRANSIENT = /overloaded|rate_limit|server_error|service_unavailable|temporarily_unavailable/i;
/** Frames that open a response before it says anything. */
const OPENING = new Set(['response.created', 'response.in_progress', 'response.queued']);
/** How much of a stream is held while deciding; an answer this far in is passed on as it is. */
const PEEK_BYTES = 256 * 1024;

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  onRetry?: (attempt: number, code: string) => void;
}

type Frame = { type?: unknown; code?: unknown; response?: { error?: { code?: unknown } } };
/** A frame's JSON data, or null when it holds none. */
function frameJson(frame: string): Frame | null {
  try {
    return JSON.parse(eventData(frame)) as Frame | null;
  } catch {
    return null;
  }
}

/** The code of a frame that is a failure, or null for any other frame. */
function failureCode(frame: string): string | null {
  const parsed = frameJson(frame);
  if (parsed?.type === 'error') return typeof parsed.code === 'string' ? parsed.code : '';
  if (parsed?.type !== 'response.failed') return null;
  const code = parsed.response?.error?.code;
  return typeof code === 'string' ? code : '';
}

function frameType(frame: string): string | null {
  const type = frameJson(frame)?.type;
  return typeof type === 'string' ? type : null;
}

/** Sends `send()` and, while the provider turns it away before answering, sends it again. */
export async function retryTransient(
  send: () => Promise<Response>,
  signal: AbortSignal | null | undefined,
  { attempts = 3, baseDelayMs = 2_000, sleep = wait, onRetry }: RetryOptions = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const held: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let retryCode: string | null = null;
    // Read until the first frame that is not an opening one, or the stream ends.
    peek: while (bytes < PEEK_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      held.push(next.value);
      bytes += next.value.byteLength;
      text += decoder.decode(next.value, { stream: true });
      const frames = text.split(/\r?\n\r?\n/);
      frames.pop();
      for (const frame of frames) {
        if (!frame.trim()) continue;
        const type = frameType(frame);
        if (type && OPENING.has(type)) continue;
        const code = failureCode(frame);
        if (code !== null && TRANSIENT.test(code) && attempt < attempts) retryCode = code;
        break peek;
      }
    }
    if (retryCode !== null) {
      await reader.cancel().catch(() => undefined);
      onRetry?.(attempt + 1, retryCode);
      await sleep(baseDelayMs * 2 ** attempt, signal);
      continue;
    }
    // What was read so far, then the rest of the stream as it comes.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of held) controller.enqueue(chunk);
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
