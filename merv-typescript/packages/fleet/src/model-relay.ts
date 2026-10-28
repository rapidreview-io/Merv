import { isUtf8 } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eventData } from '@merv/contracts/text';
import { RESPONSES_URL } from './model-ledger.js';
import type {
  ModelRelayConfig,
  ModelRelayFailure,
  ModelRelayGrant,
  ModelRelayHandle,
} from './types.js';

class RelayFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const reject = (status: number, code: string): never => {
  throw new RelayFailure(status, code);
};
/** A verdict the authority or ledger gave, or 503 when it could not give one. */
const refusal = (error: unknown, status: number, code: string) =>
  Number((error as { status?: unknown } | null)?.status) >= 500
    ? new RelayFailure(503, 'relay_unavailable')
    : new RelayFailure(status, code);
/** Hands a record to its callback, which never changes the call; a failure is logged by name. */
const report = <T>(callback: ((record: T) => void | Promise<void>) | undefined, record: T) =>
  void Promise.resolve()
    .then(() => callback?.(record))
    .catch((error: unknown) => {
      const name = String((error as Error | null)?.name);
      process.stderr.write(`${JSON.stringify({ event: 'model_relay_callback_failed', name })}\n`);
    });
/** A content type's media type, without its parameters. */
const mediaType = (value: string | null | undefined) => value?.split(';')[0]?.trim().toLowerCase();
/** A grant whose expiry is past, or unreadable, is expired. */
const expired = (grant: ModelRelayGrant) => !(Date.parse(grant.expiresAt) > Date.now());
/** Streamed frames rely on an authority read at most this old; an authority that stops answering
 *  ends the stream. */
const authorityStaleMs = 5_000;
/** How long after one authority read starts a streaming call starts the next (at once, where
 *  that read took longer): each re-reads the grant from the database, and reads that each take
 *  up to `authorityStaleMs` keep frames within it. */
const authorityRecheckMs = 3_000;
/** A call's usage, whichever provider reported it; `input` counts cached and cache-written input
 *  too. */
type Usage = { input: number; cached: number; written?: number; output: number; reasoning: number };
const tokens = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
/** A frame's data as JSON, or undefined where it is none. */
const json = (data: string): { [key: string]: any } | undefined => {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
};
/** Whether a frame is itself an error: its own top-level type, not one its content quotes. */
const failedFrame = (data: string) => {
  if (!/"type"\s*:\s*"(?:error|response\.failed)"/.test(data)) return false;
  try {
    return ['error', 'response.failed'].includes(JSON.parse(data)?.type);
  } catch {
    return true;
  }
};
/** A failure the provider streamed, as the client receives it: its kind and code, which tell the
 *  client what to do (Codex compacts on `context_length_exceeded`), and none of its words. */
const providerCode = (data: string) => {
  const parsed = json(data);
  const errorOf = (value: unknown) => (value as { error?: { code?: unknown } } | null)?.error;
  // Anthropic names a failure by its error's type (`overloaded_error`).
  const raw =
    errorOf(parsed?.response)?.code ?? errorOf(parsed)?.code ?? parsed?.code ?? parsed?.error?.type;
  return typeof raw === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(raw) ? raw : 'upstream_failed';
};
const failureMessage = 'The model provider failed this call';
/** How a call ended, as its terminal frame says, and the usage it reported. */
interface Ending {
  status: 'completed' | 'incomplete' | 'failed';
  reason: 'max_output_tokens' | 'content_filter' | 'other' | null;
  usage: Usage | null;
}
/** What differs between the providers' streams: where a call goes and under which key headers,
 *  how one call's frames end it (`reader` reads them all, in order), and the relay's own
 *  failure frames in the client's format. */
interface Wire {
  url: string;
  auth(key: string): Record<string, string>;
  reader(): (content: string, data: string) => Ending | undefined;
  failure(data: string, failedResponse: boolean): string;
  interrupted: string;
}
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const anthropicError = (type: string, message: string) =>
  `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`;
const wires: Record<NonNullable<ModelRelayConfig<ModelRelayGrant>['wire']>, Wire> = {
  responses: {
    url: RESPONSES_URL,
    auth: (key) => ({ authorization: `Bearer ${key}` }),
    reader: () => (content, data) => {
      const status =
        (/(?:^|\r?\n)event:\s*response\.(completed|incomplete|failed)\s*(?:\r?\n|$)/i.exec(
          content,
        )?.[1] ??
          /^\{\s*"type"\s*:\s*"response\.(completed|incomplete|failed)"/.exec(data)?.[1]) as
          Ending['status'] | undefined;
      if (!status) return undefined;
      const response = json(data)?.response;
      const usage = response?.usage;
      const reason = status === 'incomplete' && response?.incomplete_details?.reason;
      return {
        status,
        reason:
          status !== 'incomplete'
            ? null
            : reason === 'max_output_tokens' || reason === 'content_filter'
              ? reason
              : 'other',
        usage:
          usage && typeof usage === 'object'
            ? {
                input: tokens(usage.input_tokens),
                cached: tokens(usage.input_tokens_details?.cached_tokens),
                output: tokens(usage.output_tokens),
                reasoning: tokens(usage.output_tokens_details?.reasoning_tokens),
              }
            : null,
      };
    },
    failure: (data, failedResponse) => {
      const code = providerCode(data);
      return failedResponse || json(data)?.type === 'response.failed'
        ? `event: response.failed\ndata: ${JSON.stringify({
            type: 'response.failed',
            response: { status: 'failed', error: { code, message: failureMessage } },
          })}\n\n`
        : `event: error\ndata: ${JSON.stringify({ type: 'error', code, message: failureMessage })}\n\n`;
    },
    // The relay's own end of a stream it cut short, as the Responses API frames an error.
    interrupted: `event: error\ndata: ${JSON.stringify({
      type: 'error',
      code: 'relay_interrupted',
      message: 'The model relay ended this call',
    })}\n\n`,
  },
  anthropic: {
    url: ANTHROPIC_MESSAGES_URL,
    auth: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    // Input arrives with message_start and output with each message_delta, both cumulative;
    // message_stop ends the call, and an error frame fails it.
    reader: () => {
      let usage: Usage | null = null;
      let stop: unknown;
      return (_content, data) => {
        const frame = json(data);
        const counts =
          frame?.type === 'message_start'
            ? frame.message?.usage
            : frame?.type === 'message_delta'
              ? frame.usage
              : undefined;
        if (counts && typeof counts === 'object') {
          const input =
            tokens(counts.input_tokens) +
            tokens(counts.cache_read_input_tokens) +
            tokens(counts.cache_creation_input_tokens);
          usage = {
            input: Math.max(usage?.input ?? 0, input),
            cached: Math.max(usage?.cached ?? 0, tokens(counts.cache_read_input_tokens)),
            written: Math.max(usage?.written ?? 0, tokens(counts.cache_creation_input_tokens)),
            output: Math.max(usage?.output ?? 0, tokens(counts.output_tokens)),
            reasoning: Math.max(
              usage?.reasoning ?? 0,
              tokens(counts.output_tokens_details?.thinking_tokens),
            ),
          };
        }
        if (frame?.type === 'message_delta') stop = frame.delta?.stop_reason;
        // A failure partway through is billed what Anthropic counted before it.
        if (frame?.type === 'error') return { status: 'failed', reason: null, usage };
        if (frame?.type !== 'message_stop') return undefined;
        const cut = stop === 'max_tokens' || stop === 'model_context_window_exceeded';
        return {
          status: cut || stop === 'refusal' ? 'incomplete' : 'completed',
          reason: cut ? 'max_output_tokens' : stop === 'refusal' ? 'content_filter' : null,
          usage,
        };
      };
    },
    failure: (data) => anthropicError(providerCode(data), failureMessage),
    interrupted: anthropicError('relay_interrupted', 'The model relay ended this call'),
  },
};

function limit(value: number | undefined, fallback = 0): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error('Invalid model relay limit');
  return resolved;
}

async function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation
      .then(resolve, rejectPromise)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {});
  });
}

async function readRequest(
  req: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (req.destroyed || req.aborted) reject(400, 'request_aborted');
  if (mediaType(req.headers['content-type']) !== 'application/json')
    reject(415, 'unsupported_media_type');
  const declared = req.headers['content-length'];
  if (declared && Number(declared) > maxBytes) reject(413, 'request_too_large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    if (signal.aborted) throw signal.reason;
    bytes += chunk.length;
    if (bytes > maxBytes) reject(413, 'request_too_large');
    chunks.push(chunk);
  }
  if (signal.aborted) throw signal.reason;
  const body = Buffer.concat(chunks);
  if (!isUtf8(body)) reject(400, 'invalid_json');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return reject(400, 'invalid_json');
  }
}

async function writeChunk(
  res: ServerResponse,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, rejectPromise) => {
    const clean = () => {
      res.off('drain', drained);
      signal.removeEventListener('abort', aborted);
    };
    const drained = () => {
      clean();
      resolve();
    };
    const aborted = () => {
      clean();
      rejectPromise(signal.reason);
    };
    res.once('drain', drained);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** The relay's fixed limits and its upstream fetch, which only tests change. */
export interface RelayTuning {
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  idleTimeoutMs?: number;
  /** For calls whose effort is not `none`, which may reason in silence. */
  reasoningIdleTimeoutMs?: number;
  maxConcurrent?: number;
  maxGrantEntries?: number;
}

/** Streams a worker's model call upstream under the provider key the worker never holds. */
export class ModelRelay<
  G extends ModelRelayGrant,
  N extends string = string,
  R = unknown,
> implements ModelRelayHandle {
  private readonly fetchImpl?: typeof fetch;
  private readonly options: Required<Omit<RelayTuning, 'fetchImpl'>> &
    Required<
      Pick<ModelRelayConfig<G>, 'maxRequestBytes' | 'totalTimeoutMs' | 'maxRequestsPerGrant'>
    >;
  private readonly active = new Set<AbortController>();
  private readonly lanes = new Set<string>();
  private readonly grants = new Map<string, { count: number; expiry: number; binding: string }>();
  private stopped = false;
  private readonly wire: Wire;

  constructor(
    private readonly config: ModelRelayConfig<G, N, R>,
    tuning: RelayTuning = {},
  ) {
    if (typeof config.providerKey !== 'function')
      throw new Error('Model relay requires a provider key source');
    this.wire = wires[config.wire ?? 'responses'];
    // No output cap is added here: a feature's payload sets one where it wants it. A maximal
    // answer streams about 40 MB of events, and ends with frames that each repeat its whole
    // text; a call that falls silent for idleTimeoutMs ends at once.
    this.fetchImpl = tuning.fetchImpl;
    this.options = {
      maxRequestBytes: limit(config.maxRequestBytes),
      maxResponseBytes: limit(tuning.maxResponseBytes, 256 * 1024 * 1024),
      totalTimeoutMs: limit(config.totalTimeoutMs),
      idleTimeoutMs: limit(tuning.idleTimeoutMs, 20_000),
      reasoningIdleTimeoutMs: limit(tuning.reasoningIdleTimeoutMs, 120_000),
      maxConcurrent: limit(tuning.maxConcurrent, 200),
      maxRequestsPerGrant: limit(config.maxRequestsPerGrant, 72),
      maxGrantEntries: limit(tuning.maxGrantEntries, 4096),
    };
  }

  readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url !== this.config.route) return this.error(res, 404, 'not_found');
    if (req.method !== 'POST') return this.error(res, 405, 'method_not_allowed');
    if (req.headers.origin !== undefined) return this.error(res, 403, 'browser_forbidden');
    if (this.stopped) return this.error(res, 503, 'relay_unavailable');
    const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token || !this.config.token.test(token)) return this.error(res, 401, 'unauthorized');
    if (this.active.size >= this.options.maxConcurrent) return this.error(res, 429, 'relay_busy');

    const controller = new AbortController();
    const { signal } = controller;
    let done = false;
    const abort = (status: number, code: string) => {
      if (!done && !signal.aborted) {
        controller.abort(new RelayFailure(status, code));
        if (!req.complete) req.destroy();
      }
    };
    // Node emits close for a normally ended response too.
    const disconnected = () => {
      if (!res.writableEnded) abort(499, 'disconnected');
    };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    this.active.add(controller);
    const total = setTimeout(() => abort(504, 'relay_timeout'), this.options.totalTimeoutMs);
    let idle: NodeJS.Timeout | undefined;
    let fence: NodeJS.Timeout | undefined;
    let admitted: G | undefined;
    let lane: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let admittedAt = 0;
    let phase: ModelRelayFailure['phase'] = 'request';
    let upstreamHttpStatus: number | undefined;
    let completed = false;
    let reserved = undefined as R;
    /** Whether the call holds a charge, returned if the provider never takes the call. */
    let charged = false;
    /** Whether the provider answered with a success status, once it answered. */
    let taken: boolean | undefined;
    /** How a failure the provider streamed was billed: settled to the usage it reported, or not
     *  at all when it reported none. */
    let providerFailed: 'settled' | 'unbilled' | undefined;
    /** The code of a failure the provider streamed, as its frame named it. */
    let failedWith: string | undefined;
    try {
      const authority = this.config.authority;
      let grant: G;
      try {
        grant = this.config.grant(await interruptible(authority.authorize(token), signal));
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw refusal(error, 401, 'unauthorized');
      }
      let validatedAt = 0;
      let readStartedAt = 0;
      const validate = async () => {
        if (signal.aborted) throw signal.reason;
        readStartedAt = Date.now();
        if (expired(grant)) reject(403, 'grant_forbidden');
        try {
          await interruptible(authority.validate(grant), signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw refusal(error, 403, 'grant_forbidden');
        }
        if (expired(grant)) reject(403, 'grant_forbidden');
        // Stamped when the read returns: the next starts 3 s after this one started, so frames
        // are at most max(3, d) old where every read takes d seconds.
        validatedAt = Date.now();
      };
      await validate();
      if (this.lanes.has(this.config.lane(grant))) reject(429, 'relay_busy');
      lane = this.config.lane(grant);
      this.lanes.add(lane);
      admitted = grant;
      admittedAt = Date.now();
      const raw = await interruptible(
        readRequest(req, this.options.maxRequestBytes, signal),
        signal,
      );
      const body = this.config.payload(raw, grant) ?? reject(400, 'invalid_payload');
      const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort;
      // Every refusal but the last authority read comes before the call is charged; that one
      // returns the charge.
      const key = await interruptible(
        Promise.resolve().then(() => this.config.providerKey()),
        signal,
      );
      if (typeof key !== 'string' || !key.trim()) reject(503, 'relay_unavailable');
      for (const [id, entry] of this.grants) if (entry.expiry <= Date.now()) this.grants.delete(id);
      const previous = this.grants.get(grant.id);
      const binding = JSON.stringify(grant);
      if (previous && previous.binding !== binding) reject(403, 'grant_forbidden');
      // Calls in flight may each add a new grant across reserve, so the entry cap is soft by up to
      // maxConcurrent; one lane per grant keeps each grant's count exact.
      if (
        (previous?.count ?? 0) >= this.options.maxRequestsPerGrant ||
        (!previous && this.grants.size >= this.options.maxGrantEntries)
      )
        reject(429, 'relay_busy');
      if (this.config.reserve) {
        // Awaited even after a disconnect, so a charge that commits late is returned below.
        try {
          reserved = await this.config.reserve(grant, body);
          charged = true;
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          const code = (error as { code?: unknown }).code;
          throw refusal(
            error,
            403,
            typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'grant_forbidden',
          );
        }
        if (signal.aborted) throw signal.reason;
      }
      this.grants.set(grant.id, {
        count: (previous?.count ?? 0) + 1,
        expiry: Date.parse(grant.expiresAt),
        binding,
      });
      await validate();
      phase = 'upstream';
      const upstream = await interruptible(
        (this.fetchImpl ?? fetch)(this.config.responsesUrl ?? this.wire.url, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            ...this.config.headers?.(body),
            ...this.wire.auth(key),
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
        signal,
      );
      if (Number.isInteger(upstream.status) && upstream.status >= 100 && upstream.status <= 599)
        upstreamHttpStatus = upstream.status;
      taken = upstream.ok;
      if (
        !upstream.ok ||
        !upstream.body ||
        mediaType(upstream.headers.get('content-type')) !== 'text/event-stream'
      )
        reject(502, 'upstream_failed');
      await validate();
      phase = 'stream';
      reader = upstream.body!.getReader();
      const startStream = () => {
        if (!res.headersSent)
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
      };
      const resetIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(
          () => abort(504, 'relay_timeout'),
          effort === 'none' ? this.options.idleTimeoutMs : this.options.reasoningIdleTimeoutMs,
        );
      };
      resetIdle();
      // One authority read in flight at a time, 3 s after the last one started; frames never wait
      // on one. Timed from its start, a slow read does not also delay the next by its own length.
      const tick = () => {
        if (!done)
          fence = setTimeout(
            () =>
              void validate().then(tick, (error: unknown) =>
                error instanceof RelayFailure
                  ? abort(error.status, error.code)
                  : abort(403, 'grant_forbidden'),
              ),
            Math.max(0, authorityRecheckMs - (Date.now() - readStartedAt)),
          );
      };
      tick();
      let bytes = 0;
      // A frame ends at a blank line. Each byte is searched once, as the last frames of a long
      // answer each repeat its whole text: only a frame's own bytes are held, and at most 3 of
      // them searched again.
      let held: Buffer[] = [];
      let heldBytes = 0;
      let tail = '';
      let usage: Usage | null | undefined;
      let terminalReported = false;
      const read = this.wire.reader();
      // Usage is kept the moment its frame arrives: a client may hang up right after it.
      const keep = (ending: Ending) => {
        if (usage !== undefined) return;
        usage = ending.usage;
        if (usage)
          report((record) => this.config.onUsage?.(record, grant, reserved), {
            event: `${this.config.name}_relay_usage` as const,
            model: grant.model,
            inputTokens: usage.input,
            cachedTokens: usage.cached,
            ...(usage.written ? { cacheWriteTokens: usage.written } : {}),
            outputTokens: usage.output,
            reasoningTokens: usage.reasoning,
          });
      };
      while (true) {
        const next = await interruptible(reader.read(), signal);
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > this.options.maxResponseBytes) reject(502, 'response_too_large');
        const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        const window = tail + chunk.toString('latin1');
        const boundary = /\r?\n\r?\n/g;
        let from = 0;
        for (let found; (found = boundary.exec(window));) {
          const end = found.index + found[0].length - tail.length;
          const frame = Buffer.concat([...held, chunk.subarray(from, end)]);
          [held, heldBytes, from] = [[], 0, end];
          const content = frame.toString('utf8');
          const data = eventData(content);
          const ending = read(content, data);
          const terminal = ending?.status;
          if (ending) {
            keep(ending);
            if (!terminalReported) {
              terminalReported = true;
              report(this.config.onTerminal, {
                event: `${this.config.name}_relay_terminal` as const,
                model: grant.model,
                status: ending.status,
                incompleteReason: ending.reason,
                elapsedMs: Math.max(0, Date.now() - admittedAt),
              });
            }
          }
          completed ||= terminal === 'completed';
          if (terminal === 'failed' || /^event:\s*error\s*$/im.test(content) || failedFrame(data)) {
            // The provider's failure reaches the client, so it reads why (a context overflow it
            // can compact for) instead of a stream cut short.
            startStream();
            await writeChunk(
              res,
              Buffer.from(this.wire.failure(data, terminal === 'failed')),
              signal,
            );
            providerFailed = usage ? 'settled' : 'unbilled';
            failedWith = providerCode(data);
            reject(502, 'upstream_failed');
          }
          if (expired(grant)) reject(403, 'grant_forbidden');
          if (Date.now() - validatedAt > authorityStaleMs) reject(504, 'relay_timeout');
          // GMI adds routing metadata before any answer. Do not expose this non-output
          // frame to workers: it would end their pre-answer transient-error retry window.
          if (json(data)?.type === 'response.metadata') continue;
          startStream();
          await writeChunk(res, frame, signal);
          resetIdle();
        }
        held.push(chunk.subarray(from));
        heldBytes += chunk.byteLength - from;
        tail = window.slice(Math.max(from && tail.length + from, window.length - 3));
        // A frame may repeat a whole answer (messageChars, escaped).
        if (heldBytes > Math.min(this.options.maxResponseBytes, 16 * 1024 * 1024))
          reject(502, 'response_too_large');
      }
      // A stream that ends without its terminal frame did not finish.
      if (!terminalReported) reject(502, 'upstream_failed');
      if (!signal.aborted) {
        startStream();
        res.end();
      }
    } catch (error) {
      const failure =
        error instanceof RelayFailure ? error : new RelayFailure(502, 'upstream_failed');
      // A Codex client can close after the terminal frame. Usage was already settled in keep().
      if (admitted && !(failure.code === 'disconnected' && completed))
        report((record) => this.config.onFailure?.(record, admitted!), {
          event: `${this.config.name}_relay_failure` as const,
          phase,
          code: failure.code,
          model: admitted.model,
          elapsedMs: Math.max(0, Date.now() - admittedAt),
          ...(upstreamHttpStatus === undefined ? {} : { upstreamHttpStatus }),
          ...(failedWith === undefined ? {} : { providerCode: failedWith }),
        });
      // Refused before it was sent, answered with an error status, or failed with no usage, the
      // call cost nothing. One the provider may have run (no answer, or a stream cut off) keeps
      // its charge.
      if (charged && (phase === 'request' || taken === false || providerFailed === 'unbilled'))
        report((record) => this.config.onUsage?.(record, admitted!, reserved), {
          event: `${this.config.name}_relay_usage` as const,
          model: admitted!.model,
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          refund: true as const,
        });
      if (failure.status !== 499 && !res.destroyed) {
        if (res.headersSent) res.end(providerFailed ? undefined : this.wire.interrupted);
        else this.error(res, failure.status, failure.code);
      }
    } finally {
      done = true;
      // Releases a fence read still pending when a frame ended the call.
      if (!signal.aborted) controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      clearTimeout(total);
      if (idle) clearTimeout(idle);
      if (fence) clearTimeout(fence);
      req.off('aborted', disconnected);
      res.off('close', disconnected);
      this.active.delete(controller);
      if (lane !== undefined) this.lanes.delete(lane);
    }
  };

  close(): void {
    this.stopped = true;
    for (const controller of this.active)
      controller.abort(new RelayFailure(503, 'relay_unavailable'));
    this.grants.clear();
  }

  private error(res: ServerResponse, status: number, code: string): void {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: code }));
  }
}
