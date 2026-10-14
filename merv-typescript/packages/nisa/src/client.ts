/**
 * One bounded JSON request to Nisa (see fetchJson), ported from the removed REST adapter: a
 * deadline over headers and body together and no retry (Nisa retries its own index).
 */
import { fetchJson, OutboundError } from '@merv/contracts';

// Never python-httpx/…, which Nisa still reads as its old SDK asking for agent enrichment.
export const USER_AGENT = 'merv-nisa/0.1.0';

/** The signal's own reason is thrown when it ends the call: a TimeoutError at the deadline. */
export async function request(
  url: string,
  key: string,
  options: { body?: unknown; timeoutMs: number; maxBytes: number; signal: AbortSignal },
): Promise<Record<string, unknown>> {
  // AbortSignal.any() holds its sources weakly, and on Node 22 a long-lived source keeps a trace
  // of every signal composed from it: this call's own two are composed and held until it ends.
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const stopped = new AbortController();
  const stop = () => stopped.abort(options.signal.reason);
  if (options.signal.aborted) stop();
  else options.signal.addEventListener('abort', stop, { once: true });
  const signal = AbortSignal.any([stopped.signal, timeout]);
  const data = await fetchJson(url, key, { ...options, userAgent: USER_AGENT, signal }).finally(
    () => {
      options.signal.removeEventListener('abort', stop);
      return timeout;
    },
  );
  // A success that carries an error is not one.
  if ('error' in data) throw new OutboundError({ kind: 'invalid' });
  return data;
}
