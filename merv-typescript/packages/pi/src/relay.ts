import { isUtf8 } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MountHandler } from '@merv/api/types';
import type { PiRelayGrant } from './types.js';
import { piRelayGrantSchema, piResponsesSchema, validPiPayload } from './relay-schema.js';

export type { PiRelayGrant } from './types.js';

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
  maxOutputTokens?: number;
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
      | 'maxOutputTokens'
      | 'totalTimeoutMs'
      | 'idleTimeoutMs'
      | 'maxConcurrent'
      | 'maxRequestsPerGrant'
      | 'maxGrantEntries'
    >
  >;
  private readonly active = new Set<AbortController>();
  private readonly users = new Set<string>();
  private readonly grants = new Map<string, { count: number; expiry: number; binding: string }>();
  private stopped = false;

  constructor(private readonly config: PiRelayConfig) {
    if (!config.model || typeof config.providerKey !== 'function')
      throw new Error('Pi relay requires a model and provider key source');
    this.options = {
      maxRequestBytes: limit(config.maxRequestBytes, 512 * 1024),
      maxResponseBytes: limit(config.maxResponseBytes, 8 * 1024 * 1024),
      maxOutputTokens: limit(config.maxOutputTokens, 4096, 16),
      totalTimeoutMs: limit(config.totalTimeoutMs, 120_000),
      idleTimeoutMs: limit(config.idleTimeoutMs, 20_000),
      maxConcurrent: limit(config.maxConcurrent, 8),
      maxRequestsPerGrant: limit(config.maxRequestsPerGrant, 8),
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
    let admittedUser: string | undefined;
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
      const validate = async () => {
        if (signal.aborted) throw signal.reason;
        if (Date.parse(grant.expiresAt) <= Date.now() || grant.model !== this.config.model)
          reject(403, 'grant_forbidden');
        try {
          await interruptible(authority.validate(grant), signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          return reject(403, 'grant_forbidden');
        }
        if (Date.parse(grant.expiresAt) <= Date.now()) reject(403, 'grant_forbidden');
      };
      await validate();
      if (this.users.has(grant.userId)) reject(429, 'relay_busy');
      this.users.add(grant.userId);
      admittedUser = grant.userId;
      admittedAt = Date.now();
      const raw = await interruptible(
        readRequest(req, this.options.maxRequestBytes, signal),
        signal,
      );
      const parsed = piResponsesSchema.safeParse(raw);
      if (!parsed.success) throw new RelayFailure(400, 'invalid_payload');
      const request = parsed.data;
      if (
        request.model !== this.config.model ||
        (request.max_output_tokens ?? this.options.maxOutputTokens) >
          this.options.maxOutputTokens ||
        !validPiPayload(request, grant.toolNames)
      )
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
      const payload = {
        ...request,
        max_output_tokens: request.max_output_tokens ?? this.options.maxOutputTokens,
      };
      const upstream = await interruptible(
        (this.config.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
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
      let pending = Buffer.alloc(0);
      while (true) {
        const next = await interruptible(reader.read(), signal);
        await validate();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > this.options.maxResponseBytes) reject(502, 'response_too_large');
        for (let offset = 0; offset < next.value.byteLength; offset += 64 * 1024) {
          pending = Buffer.concat([pending, next.value.subarray(offset, offset + 64 * 1024)]);
          while (true) {
            const boundary = /\r?\n\r?\n/.exec(pending.toString('latin1'));
            if (!boundary) break;
            const end = boundary.index + boundary[0].length;
            const frame = pending.subarray(0, end);
            pending = pending.subarray(end);
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
            await validate();
            startStream();
            await writeChunk(res, frame, signal);
            resetIdle();
          }
          if (pending.byteLength > Math.min(this.options.maxResponseBytes, 256 * 1024))
            reject(502, 'response_too_large');
        }
      }
      if (!signal.aborted) {
        startStream();
        res.end();
      }
    } catch (error) {
      const failure =
        error instanceof RelayFailure ? error : new RelayFailure(502, 'upstream_failed');
      if (admittedUser && this.config.onFailure) {
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
      if (admittedUser) this.users.delete(admittedUser);
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
