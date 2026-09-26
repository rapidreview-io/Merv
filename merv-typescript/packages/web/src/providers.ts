/**
 * One bounded JSON POST to a search provider: a deadline over every attempt, no redirect (it
 * would carry the key somewhere nobody chose), a JSON answer of at most the configured bytes,
 * and at most two retries of what may pass (no answer, 408, 425, 429 or 5xx). A failure says
 * only its HTTP status: nothing a provider wrote is repeated.
 */
export const USER_AGENT = 'merv-web/0.1.0';
const RETRIES = 2;
const RETRIED = new Set([408, 425, 429, 500, 502, 503, 504]);

export type ProviderFailure =
  | { kind: 'network' }
  | { kind: 'status'; status: number }
  | { kind: 'invalid' }
  | { kind: 'too_large' };
export class ProviderError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    /** How long the provider asked to wait before a retry. */
    readonly wait?: number,
  ) {
    super(`Provider ${failure.kind}`);
  }
}

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

/** Retry-After in milliseconds, when it asks for five seconds or less. */
function retryAfter(value: string | null): number | undefined {
  const seconds = Number(value);
  return value !== null && Number.isFinite(seconds) && seconds >= 0 && seconds <= 5
    ? seconds * 1000
    : undefined;
}

async function send(
  url: string,
  key: string,
  body: unknown,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ProviderError({ kind: 'network' });
  }
  const refuse = (failure: ProviderFailure, wait?: number) => {
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderError(failure, wait);
  };
  if (!response.ok)
    refuse(
      { kind: 'status', status: response.status },
      retryAfter(response.headers.get('retry-after')),
    );
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!(type === 'application/json' || type?.endsWith('+json'))) refuse({ kind: 'invalid' });
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) refuse({ kind: 'too_large' });
  if (!response.body) throw new ProviderError({ kind: 'invalid' });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > maxBytes) throw new ProviderError({ kind: 'too_large' });
      chunks.push(item.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (signal.aborted) throw signal.reason;
    throw error instanceof ProviderError ? error : new ProviderError({ kind: 'network' });
  } finally {
    reader.releaseLock();
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ProviderError({ kind: 'invalid' });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new ProviderError({ kind: 'invalid' });
  return data as Record<string, unknown>;
}

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
      return await send(url, key, body, signal, options.maxBytes);
    } catch (error) {
      const failure = error instanceof ProviderError ? error.failure : undefined;
      const passing =
        failure?.kind === 'network' || (failure?.kind === 'status' && RETRIED.has(failure.status));
      // Backoff with jitter: about 250 ms, then 500 ms, or what Retry-After asks.
      const wait = Math.max(
        250 * 2 ** attempt * (0.5 + Math.random()),
        error instanceof ProviderError ? (error.wait ?? 0) : 0,
      );
      if (!passing || attempt >= RETRIES || Date.now() + wait >= deadline) throw error;
      await sleep(wait, signal);
    }
  }
}
