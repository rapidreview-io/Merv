/**
 * Calls to a service outside Merv (@merv/web's providers, @merv/nisa): the origins one may name,
 * one bounded JSON request, the calls in flight, and what an answer may weigh.
 */
import { isIP } from 'node:net';
import { check, MervError } from './index.js';
import type { Json } from './data.js';

/** An https origin, or a loopback http one for a test's fake service. */
export function allowedOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value) return false;
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (url.hostname === 'localhost' ||
          url.hostname === '[::1]' ||
          (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))))
    );
  } catch {
    return false;
  }
}

/** A URL on an allowed origin, naming no credentials, query or fragment; any path. */
export function allowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !/[\x00-\x20\x7f?#]/.test(value) &&
      !url.username &&
      !url.password &&
      allowedOrigin(url.origin)
    );
  } catch {
    return false;
  }
}

/**
 * The allowed origin `value` names, with nothing after it but a slash: the one rule for every
 * service origin an operator configures. Anything else is refused under `code`.
 */
export function origin(value: unknown, code: string, message: string, status = 400): string {
  const text = typeof value === 'string' ? value : '';
  check(allowedUrl(text) && new URL(text).pathname === '/', code, message, status);
  return new URL(text).origin;
}

type OutboundFailure =
  | { kind: 'network' }
  | { kind: 'status'; status: number }
  | { kind: 'invalid' }
  | { kind: 'too_large' };
export class OutboundError extends Error {
  constructor(
    readonly failure: OutboundFailure,
    /** How long the service asked to wait before a retry. */
    readonly wait?: number,
    /** The service's own JSON error body, read only when the caller asked for one. */
    readonly body?: Record<string, unknown>,
  ) {
    super(`Outbound ${failure.kind}`);
  }
}

/** Retry-After in milliseconds, when it asks for five seconds or less. */
function retryAfter(value: string | null): number | undefined {
  const seconds = Number(value);
  return value !== null && Number.isFinite(seconds) && seconds >= 0 && seconds <= 5
    ? seconds * 1000
    : undefined;
}

/** The body's JSON, read as it arrives and refused past `maxBytes`; the signal's reason ends it. */
async function readJson(response: Response, maxBytes: number, signal: AbortSignal) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new OutboundError({ kind: 'too_large' });
  }
  if (!response.body) throw new OutboundError({ kind: 'invalid' });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > maxBytes) throw new OutboundError({ kind: 'too_large' });
      chunks.push(item.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (signal.aborted) throw signal.reason;
    throw error instanceof OutboundError ? error : new OutboundError({ kind: 'network' });
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    throw new OutboundError({ kind: 'invalid' });
  }
}

type FetchOptions = {
  method?: 'GET' | 'POST' | 'DELETE';
  /** A 204 is an empty answer, to any method. */
  empty?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
  userAgent?: string;
  maxBytes: number;
  /** Read at most this much of a failure's JSON body into the error; none is read without it. */
  errorBytes?: number;
  signal: AbortSignal;
  fetcher?: typeof fetch;
};

/**
 * One JSON request: a GET, or a POST of `body`, unless `method` says otherwise. The key is sent
 * as a bearer token, or `headers` carry the credential instead. A redirect is never followed (it
 * would carry the key somewhere nobody chose) but refused as its 3xx status, and a JSON object of at most `maxBytes` back (any JSON value with
 * `anyJson`), or `{}` for a 204 when `empty` allows one.
 * A failure says only its kind and HTTP status, and the service's error body when `errorBytes`
 * asks for it; the signal's own reason is thrown when it ends the call.
 */
export async function fetchJson(
  url: string | URL,
  key: string | null,
  options: FetchOptions & { anyJson: true },
): Promise<Json>;
export async function fetchJson(
  url: string | URL,
  key: string | null,
  options: FetchOptions,
): Promise<Record<string, unknown>>;
export async function fetchJson(
  url: string | URL,
  key: string | null,
  options: FetchOptions & { anyJson?: boolean },
): Promise<unknown> {
  const { body, maxBytes, signal } = options;
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(key !== null && { authorization: `Bearer ${key}` }),
        ...options.headers,
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(options.userAgent !== undefined && { 'user-agent': options.userAgent }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal,
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new OutboundError({ kind: 'network' });
  }
  const refuse = (failure: OutboundFailure): never => {
    void response.body?.cancel().catch(() => undefined);
    throw new OutboundError(failure);
  };
  if (!response.ok) {
    const said = options.errorBytes
      ? await readJson(response, options.errorBytes, signal).catch(() => undefined)
      : void response.body?.cancel().catch(() => undefined);
    throw new OutboundError(
      { kind: 'status', status: response.status },
      retryAfter(response.headers.get('retry-after')),
      record(said),
    );
  }
  if (response.status === 204 && options.empty) {
    void response.body?.cancel().catch(() => undefined);
    return {};
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!(type === 'application/json' || type?.endsWith('+json'))) refuse({ kind: 'invalid' });
  const data = await readJson(response, maxBytes, signal);
  const answer = options.anyJson ? data : record(data);
  if (answer === undefined) throw new OutboundError({ kind: 'invalid' });
  return answer;
}

/**
 * A service's failure as the caller sees it, under the owner's `code` prefix: its HTTP status at
 * most, never its words. `status` words the statuses the owner tells apart (a refused key never
 * as 401 or 403, which a transport would read as the caller's own); any other is a 502.
 */
export function outboundFailure(
  error: unknown,
  code: string,
  name: string,
  invalid: string,
  status: (status: number) => MervError | undefined,
): MervError {
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return new MervError(`${code}_timeout`, `${name} did not answer in time`, 504);
  const failure = error instanceof OutboundError ? error.failure : { kind: 'network' as const };
  if (failure.kind === 'too_large')
    return new MervError(
      `${code}_response_too_large`,
      `${name} answered more than the configured byte limit`,
      502,
    );
  if (failure.kind === 'invalid')
    return new MervError(`${code}_invalid_response`, `${name} answered ${invalid}`, 502);
  if (failure.kind === 'network')
    return new MervError(`${code}_upstream_error`, `${name} is unreachable`, 502);
  if (failure.status === 400)
    return new MervError(`${code}_request_refused`, `${name} refused this request (HTTP 400)`, 422);
  return (
    status(failure.status) ??
    new MervError(`${code}_upstream_error`, `${name} failed (HTTP ${failure.status})`, 502)
  );
}

/**
 * Calls in flight: at most `total` in the process and `perProject` for one project, so no one
 * project's calls take every slot. A call past either waits its turn, in order, for up to
 * `waitMs`: an answer that searches six things at once runs them all, a few at a time, rather
 * than having some refused.
 */
export class Slots {
  private running = 0;
  private readonly held = new Map<string, number>();
  private readonly queue: { project: string; start: () => void }[] = [];

  constructor(
    private readonly total: number,
    private readonly perProject: number,
  ) {}

  acquire(
    project: string,
    waitMs: number,
    signal: AbortSignal,
    busy: () => MervError,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    // Anyone waiting is waiting on a limit this call does not share, or it would have started.
    if (this.free(project)) return Promise.resolve(this.take(project));
    return new Promise((resolve, reject) => {
      const waiter = {
        project,
        start: () => {
          settle();
          resolve(this.take(project));
        },
      };
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        const index = this.queue.indexOf(waiter);
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
      this.queue.push(waiter);
    });
  }

  private free(project: string): boolean {
    return this.running < this.total && (this.held.get(project) ?? 0) < this.perProject;
  }

  private take(project: string): () => void {
    this.running++;
    this.held.set(project, (this.held.get(project) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      const left = this.held.get(project)! - 1;
      if (left > 0) this.held.set(project, left);
      else this.held.delete(project);
      // The first waiter a freed slot admits, in the order they came.
      this.queue.find((waiter) => this.free(waiter.project))?.start();
    };
  }
}

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** What Pi shows the model of one result, at most (packages/pi/src/fit.ts), less room for the
 * envelope a transport adds: a larger answer would reach the model cut, or as a bare index. */
export const MAX_ANSWER_BYTES = 28_000;
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * The fullest `make(chars)`, chars from `whole` down, whose JSON fits MAX_ANSWER_BYTES: UTF-8
 * bytes are what an agent is shown, so text that escapes or takes several bytes a character
 * shortens sooner than a character cap alone would cut it.
 */
export function sized<T>(whole: number, make: (chars: number) => T): { value: T; chars: number } {
  const fits = (value: T) => jsonBytes(value) <= MAX_ANSWER_BYTES;
  const full = make(whole);
  if (fits(full)) return { value: full, chars: whole };
  let [low, high] = [0, whole - 1];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(make(middle))) low = middle;
    else high = middle - 1;
  }
  return { value: make(low), chars: low };
}
