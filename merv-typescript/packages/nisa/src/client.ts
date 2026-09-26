/**
 * One bounded JSON request to Nisa, ported from the removed REST adapter: a deadline over headers
 * and body together, no redirect (it would carry the key somewhere nobody chose), a JSON object
 * of at most the configured bytes, and no retry (Nisa retries its own index). A failure says only
 * its kind and HTTP status: nothing Nisa wrote is repeated.
 */
import { MervError } from '@merv/contracts';

// Never python-httpx/…, which Nisa still reads as its old SDK asking for agent enrichment.
export const USER_AGENT = 'merv-nisa/0.1.0';

export type NisaFailure =
  | { kind: 'network' }
  | { kind: 'status'; status: number }
  | { kind: 'invalid' }
  | { kind: 'too_large' };
export class NisaHttpError extends Error {
  constructor(readonly failure: NisaFailure) {
    super(`Nisa ${failure.kind}`);
  }
}

/** The signal's own reason is thrown when it ends the call: a TimeoutError at the deadline. */
export async function request(
  url: string,
  key: string,
  options: { body?: unknown; timeoutMs: number; maxBytes: number; signal: AbortSignal },
): Promise<Record<string, unknown>> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...(options.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      redirect: 'error',
      signal,
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new NisaHttpError({ kind: 'network' });
  }
  const refuse = (failure: NisaFailure): never => {
    void response.body?.cancel().catch(() => undefined);
    throw new NisaHttpError(failure);
  };
  if (!response.ok) refuse({ kind: 'status', status: response.status });
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!(type === 'application/json' || type?.endsWith('+json'))) refuse({ kind: 'invalid' });
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > options.maxBytes) refuse({ kind: 'too_large' });
  if (!response.body) throw new NisaHttpError({ kind: 'invalid' });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > options.maxBytes) throw new NisaHttpError({ kind: 'too_large' });
      chunks.push(item.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (signal.aborted) throw signal.reason;
    throw error instanceof NisaHttpError ? error : new NisaHttpError({ kind: 'network' });
  } finally {
    reader.releaseLock();
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new NisaHttpError({ kind: 'invalid' });
  }
  // A success that carries an error is not one.
  if (data === null || typeof data !== 'object' || Array.isArray(data) || 'error' in data)
    throw new NisaHttpError({ kind: 'invalid' });
  return data as Record<string, unknown>;
}

/** Calls in flight, at most `total`; the next waits its turn, in order, for up to `waitMs`. */
export class Slots {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly total: number) {}

  acquire(waitMs: number, signal: AbortSignal, busy: () => MervError): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.running < this.total) return Promise.resolve(this.take());
    return new Promise((resolve, reject) => {
      const start = () => {
        settle();
        resolve(this.take());
      };
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const stop = () => {
        settle();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        settle();
        reject(busy());
      }, waitMs);
      signal.addEventListener('abort', stop, { once: true });
      this.queue.push(start);
    });
  }

  private take(): () => void {
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.queue[0]?.();
    };
  }
}
