/**
 * One bounded JSON POST to a search provider (see fetchJson): a deadline over every attempt and
 * at most two retries of what may pass (no answer, 408, 425, 429 or 5xx).
 */
import { fetchJson, OutboundError } from '@merv/contracts';

export const USER_AGENT = 'merv-web/0.1.0';
const RETRIES = 2;
const RETRIED = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

/** POSTs `body` until an answer, a failure that will not pass, two retries, or the deadline. The
 * signal's own reason is thrown when it ends the call: a TimeoutError at the deadline. */
export async function post(
  url: string,
  key: string,
  body: unknown,
  options: { timeoutMs: number; maxBytes: number; signal: AbortSignal },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + options.timeoutMs;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJson(url, key, { ...options, body, userAgent: USER_AGENT, signal });
    } catch (error) {
      const failure = error instanceof OutboundError ? error.failure : undefined;
      const passing =
        failure?.kind === 'network' || (failure?.kind === 'status' && RETRIED.has(failure.status));
      // Backoff with jitter: about 250 ms, then 500 ms, or what Retry-After asks.
      const wait = Math.max(
        250 * 2 ** attempt * (0.5 + Math.random()),
        error instanceof OutboundError ? (error.wait ?? 0) : 0,
      );
      if (!passing || attempt >= RETRIES || Date.now() + wait >= deadline) throw error;
      await sleep(wait, signal);
    }
  }
}
