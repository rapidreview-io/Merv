import { isUtf8 } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MountHandler } from '@merv/api/types';
import type { PiRelayGrant } from './types.js';
import { turnCeilingMs } from './limits.js';
import {
  piRelayGrantSchema,
  piResponsesSchema,
  relayRequestBytes,
  validPiPayload,
} from './relay-schema.js';

export type { PiRelayGrant } from './types.js';

const responsesUrl = 'https://api.openai.com/v1/responses';
const failureCodes = [
  'disconnected',
  'grant_forbidden',
  'invalid_json',
  'invalid_payload',
  'relay_busy',
  'relay_timeout',
  'relay_unavailable',
  'request_aborted',
  'request_too_large',
  'response_too_large',
  'unsupported_media_type',
  'upstream_failed',
] as const;

export interface PiRelayFailureRecord {
  event: 'pi_relay_failure';
  phase: 'request' | 'upstream' | 'stream';
  code: (typeof failureCodes)[number];
  elapsedMs: number;
  upstreamHttpStatus?: number;
}

export interface PiRelayConfig {
  enabled?: boolean;
  model: string;
  providerKey: () => string | Promise<string>;
  authority?: {
    authorize(token: string): Promise<PiRelayGrant>;
    validate(grant: PiRelayGrant): Promise<void>;
  };
  fetchImpl?: typeof fetch;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConcurrent?: number;
  maxRequestsPerGrant?: number;
  maxGrantEntries?: number;
  onFailure?: (record: PiRelayFailureRecord) => void | Promise<void>;
}

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

function limit(value: number | undefined, fallback: number, minimum = 1): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum)
    throw new Error('Invalid Pi relay limit');
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

export class PiModelRelay {
  private readonly options: Required<
    Pick<
      PiRelayConfig,
      | 'maxRequestBytes'
      | 'maxResponseBytes'
      | 'totalTimeoutMs'
      | 'idleTimeoutMs'
      | 'maxConcurrent'
      | 'maxRequestsPerGrant'
      | 'maxGrantEntries'
    >
  >;
  private readonly active = new Set<AbortController>();
  /** One model call at a time per conversation: a person's conversations share one machine. */
  private readonly conversations = new Set<string>();
  private readonly grants = new Map<string, { count: number; expiry: number; binding: string }>();
  private stopped = false;

  constructor(private readonly config: PiRelayConfig) {
    if (!config.model || typeof config.providerKey !== 'function')
      throw new Error('Pi relay requires a model and provider key source');
    // No output cap is added: the model's own maximum ends an answer. A maximal answer streams
    // about 40 MB of events, and ends with frames that each repeat its whole text; a call that
    // falls silent for idleTimeoutMs ends at once.
    this.options = {
      maxRequestBytes: limit(config.maxRequestBytes, relayRequestBytes),
      maxResponseBytes: limit(config.maxResponseBytes, 256 * 1024 * 1024),
      totalTimeoutMs: limit(config.totalTimeoutMs, turnCeilingMs),
      idleTimeoutMs: limit(config.idleTimeoutMs, 20_000),
      maxConcurrent: limit(config.maxConcurrent, 200),
      maxRequestsPerGrant: limit(config.maxRequestsPerGrant, 72),
      maxGrantEntries: limit(config.maxGrantEntries, 4096),
    };
  }

  readonly handle: MountHandler = async (req, res) => {
    if (req.url !== '/pi-model/responses') {
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
    if (!token || !/^pir_[A-Za-z0-9_-]{43}$/.test(token)) {
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
    let admitted: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let admittedAt = 0;
    let phase: PiRelayFailureRecord['phase'] = 'request';
    let upstreamHttpStatus: number | undefined;
    try {
      const authority = this.config.authority;
      let grant: PiRelayGrant;
      try {
        grant = piRelayGrantSchema.parse(await interruptible(authority.authorize(token), signal));
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        return this.error(res, 401, 'unauthorized');
      }
      let validatedAt = 0;
      // Streamed frames reuse an authority read up to a second old; the fence refreshes it.
      const validate = async (recent = false) => {
        if (signal.aborted) throw signal.reason;
        if (Date.parse(grant.expiresAt) <= Date.now() || grant.model !== this.config.model)
          reject(403, 'grant_forbidden');
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
      if (this.conversations.has(grant.conversationId)) reject(429, 'relay_busy');
      this.conversations.add(grant.conversationId);
      admitted = grant.conversationId;
      admittedAt = Date.now();
      const raw = await interruptible(
        readRequest(req, this.options.maxRequestBytes, signal),
        signal,
      );
      const parsed = piResponsesSchema.safeParse(raw);
      if (!parsed.success) throw new RelayFailure(400, 'invalid_payload');
      const request = parsed.data;
      if (request.model !== this.config.model || !validPiPayload(request, grant.toolNames))
        reject(400, 'invalid_payload');
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
          body: JSON.stringify(request),
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
        idle = setTimeout(() => abort(504, 'relay_timeout'), this.options.idleTimeoutMs);
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
      if (admitted && this.config.onFailure) {
        const code =
          failureCodes.find((candidate) => candidate === failure.code) ?? 'upstream_failed';
        const record: PiRelayFailureRecord = {
          event: 'pi_relay_failure',
          phase,
          code,
          elapsedMs: Math.min(900_000, Math.max(0, Date.now() - admittedAt)),
          ...(upstreamHttpStatus === undefined ? {} : { upstreamHttpStatus }),
        };
        try {
          void Promise.resolve(this.config.onFailure(record)).catch(() => {});
        } catch {}
      }
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
      if (admitted) this.conversations.delete(admitted);
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

/**
 * One small call to the relay's own upstream that names a conversation from its first exchange.
 * Anything short of a usable title is '', so the conversation keeps the name it has.
 */
export async function piTitle(model: string, key: string, user: string, reply: string) {
  try {
    const response = await fetch(responsesUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 24,
        reasoning: { effort: 'none' },
        instructions: 'Title this conversation in 2 to 6 words. Reply with the title only.',
        input: `User: ${user.slice(0, 2000)}\n\nAgent: ${reply.slice(0, 2000)}`,
      }),
    });
    if (!response.ok) return '';
    const { output } = (await response.json()) as {
      output: { content?: { type: string; text: string }[] }[];
    };
    return output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('')
      .replace(/[*_`"“”«»]/g, '')
      .replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ')
      .replace(/^[\s#>'‘’-]*(?:title:)?[\s'‘’]*|[\s'‘’.]+$/gi, '')
      .slice(0, 80)
      .trim();
  } catch {
    return '';
  }
}
