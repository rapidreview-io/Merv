import { isUtf8 } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ModelRelayConfig,
  ModelRelayFailure,
  ModelRelayGrant,
  MountHandler,
} from './types.js';

const responsesUrl = 'https://api.openai.com/v1/responses';

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
/** Hands a record to its callback, which never changes the call. */
const report = <T>(callback: ((record: T) => void | Promise<void>) | undefined, record: T) => {
  try {
    void Promise.resolve(callback?.(record)).catch(() => {});
  } catch {}
};
/** The Responses API's `usage`, as a finished call's last frame carries it. */
type Usage = {
  input_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown } | null;
  output_tokens?: unknown;
  output_tokens_details?: { reasoning_tokens?: unknown } | null;
};
const tokens = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

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
  if (req.headers['content-type']?.toLowerCase() !== 'application/json')
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

/** Streams a worker's Responses call upstream under the provider key the worker never holds. */
export class ModelRelay<G extends ModelRelayGrant, N extends string = string> {
  private readonly options: Required<
    Pick<
      ModelRelayConfig<G, N>,
      | 'maxRequestBytes'
      | 'maxResponseBytes'
      | 'totalTimeoutMs'
      | 'idleTimeoutMs'
      | 'reasoningIdleTimeoutMs'
      | 'maxConcurrent'
      | 'maxRequestsPerGrant'
      | 'maxGrantEntries'
    >
  >;
  private readonly active = new Set<AbortController>();
  private readonly lanes = new Set<string>();
  private readonly grants = new Map<string, { count: number; expiry: number; binding: string }>();
  private stopped = false;

  constructor(private readonly config: ModelRelayConfig<G, N>) {
    if (typeof config.providerKey !== 'function')
      throw new Error('Model relay requires a provider key source');
    // No output cap is added here: a feature's payload sets one where it wants it. A maximal
    // answer streams about 40 MB of events, and ends with frames that each repeat its whole
    // text; a call that falls silent for idleTimeoutMs ends at once.
    this.options = {
      maxRequestBytes: limit(config.maxRequestBytes),
      maxResponseBytes: limit(config.maxResponseBytes, 256 * 1024 * 1024),
      totalTimeoutMs: limit(config.totalTimeoutMs),
      idleTimeoutMs: limit(config.idleTimeoutMs, 20_000),
      reasoningIdleTimeoutMs: limit(config.reasoningIdleTimeoutMs, 120_000),
      maxConcurrent: limit(config.maxConcurrent, 200),
      maxRequestsPerGrant: limit(config.maxRequestsPerGrant, 72),
      maxGrantEntries: limit(config.maxGrantEntries, 4096),
    };
  }

  readonly handle: MountHandler = async (req, res) => {
    if (req.url !== this.config.route) {
      this.error(res, 404, 'not_found');
      return;
    }
    if (req.method !== 'POST') {
      this.error(res, 405, 'method_not_allowed');
      return;
    }
    if (req.headers.origin !== undefined) {
      this.error(res, 403, 'browser_forbidden');
      return;
    }
    if (!this.config.enabled || !this.config.authority || this.stopped) {
      this.error(res, 503, 'relay_unavailable');
      return;
    }
    const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token || !this.config.token.test(token)) {
      this.error(res, 401, 'unauthorized');
      return;
    }
    if (this.active.size >= this.options.maxConcurrent) {
      this.error(res, 429, 'relay_busy');
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    const abort = (status: number, code: string) => {
      if (!signal.aborted) {
        controller.abort(new RelayFailure(status, code));
        if (!req.complete) req.destroy();
      }
    };
    const disconnected = () => abort(499, 'disconnected');
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
    try {
      const authority = this.config.authority;
      let grant: G;
      try {
        grant = this.config.grant(await interruptible(authority.authorize(token), signal));
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        return this.error(res, 401, 'unauthorized');
      }
      let validatedAt = 0;
      // Streamed frames reuse an authority read up to a second old; the fence refreshes it.
      const validate = async (recent = false) => {
        if (signal.aborted) throw signal.reason;
        if (Date.parse(grant.expiresAt) <= Date.now()) reject(403, 'grant_forbidden');
        if (recent && Date.now() - validatedAt < 1000) return;
        const started = Date.now();
        try {
          await interruptible(authority.validate(grant), signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          return reject(403, 'grant_forbidden');
        }
        if (Date.parse(grant.expiresAt) <= Date.now()) reject(403, 'grant_forbidden');
        validatedAt = started;
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
      let reserved = 0;
      if (this.config.reserve)
        try {
          reserved = await interruptible(this.config.reserve(grant, body), signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          const code = (error as { code?: unknown }).code;
          reject(
            403,
            typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'grant_forbidden',
          );
        }
      phase = 'upstream';
      const key = await interruptible(
        Promise.resolve().then(() => this.config.providerKey()),
        signal,
      );
      await validate();
      if (typeof key !== 'string' || !key.trim()) reject(503, 'relay_unavailable');
      for (const [id, entry] of this.grants) if (entry.expiry <= Date.now()) this.grants.delete(id);
      const previous = this.grants.get(grant.id);
      const binding = JSON.stringify(grant);
      if (previous && previous.binding !== binding) reject(403, 'grant_forbidden');
      if (
        (previous?.count ?? 0) >= this.options.maxRequestsPerGrant ||
        (!previous && this.grants.size >= this.options.maxGrantEntries)
      )
        reject(429, 'relay_busy');
      this.grants.set(grant.id, {
        count: (previous?.count ?? 0) + 1,
        expiry: Date.parse(grant.expiresAt),
        binding,
      });
      const upstream = await interruptible(
        (this.config.fetchImpl ?? fetch)(responsesUrl, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        signal,
      );
      if (Number.isInteger(upstream.status) && upstream.status >= 100 && upstream.status <= 599)
        upstreamHttpStatus = upstream.status;
      if (
        !upstream.ok ||
        !upstream.body ||
        !upstream.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')
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
      fence = setInterval(() => {
        void validate().catch(() => abort(403, 'grant_forbidden'));
      }, 1000);
      let bytes = 0;
      // A frame ends at a blank line. Each byte is searched once, as the last frames of a long
      // answer each repeat its whole text: only a frame's own bytes are held, and at most 3 of
      // them searched again.
      let held: Buffer[] = [];
      let heldBytes = 0;
      let tail = '';
      let usage: Usage | null | undefined;
      // Usage is kept the moment its frame arrives: a client may hang up right after it.
      const keep = (data: string) => {
        if (usage !== undefined) return;
        try {
          usage = JSON.parse(data).response?.usage ?? null;
        } catch {
          usage = null;
        }
        if (usage && typeof usage === 'object')
          report((record) => this.config.onUsage?.(record, grant, reserved), {
            event: `${this.config.name}_relay_usage` as const,
            model: grant.model,
            inputTokens: tokens(usage.input_tokens),
            cachedTokens: tokens(usage.input_tokens_details?.cached_tokens),
            outputTokens: tokens(usage.output_tokens),
            reasoningTokens: tokens(usage.output_tokens_details?.reasoning_tokens),
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
          const data = content
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (
            /^event:\s*response\.(?:completed|incomplete|failed)\s*$/im.test(content) ||
            /^\{\s*"type"\s*:\s*"response\.(?:completed|incomplete|failed)"/.test(data)
          )
            keep(data);
          if (
            /^event:\s*(?:error|response\.failed)\s*$/im.test(content) ||
            /"type"\s*:\s*"(?:error|response\.failed)"/.test(data)
          )
            reject(502, 'upstream_failed');
          await validate(true);
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
      if (!signal.aborted) {
        startStream();
        res.end();
      }
    } catch (error) {
      const failure =
        error instanceof RelayFailure ? error : new RelayFailure(502, 'upstream_failed');
      if (admitted)
        report(this.config.onFailure, {
          event: `${this.config.name}_relay_failure` as const,
          phase,
          code: failure.code,
          model: admitted.model,
          elapsedMs: Math.min(900_000, Math.max(0, Date.now() - admittedAt)),
          ...(upstreamHttpStatus === undefined ? {} : { upstreamHttpStatus }),
        });
      if (failure.status !== 499 && !res.destroyed) {
        if (res.headersSent) res.end('event: error\ndata: {"error":"relay_interrupted"}\n\n');
        else this.error(res, failure.status, failure.code);
      }
    } finally {
      if (reader) void reader.cancel().catch(() => {});
      clearTimeout(total);
      if (idle) clearTimeout(idle);
      if (fence) clearInterval(fence);
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
