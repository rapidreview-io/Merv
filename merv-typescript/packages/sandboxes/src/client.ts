import { createHash } from 'node:crypto';
import { check, MervError, type Json } from '@merv/contracts';
import type { SandboxConnection } from './types.js';

const grant = /^sbxt_[A-Za-z0-9_-]{4,512}$/;
const route = /^\/v1\/[A-Za-z0-9._~/-]*$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** The service's published error vocabulary: a lowercase token, never free text. */
const errorCode = /^[a-z][a-z_]{0,39}$/;
const walletReasons = new Set([
  'budget_exceeded',
  'spending_suspended',
  'provider_disabled',
  'usage_unresolved',
  'concurrency_exceeded',
  'storage_cap_exceeded',
]);
const bodyLimit = 4_000_000;

/** Count decoded response bytes as they arrive, even with absent/compressed Content-Length. */
async function boundedText(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  check(
    Number.isSafeInteger(length) && length >= 0 && length <= limit,
    'sandbox_unavailable',
    'merv-sandboxes answered with an unusable body',
    502,
  );
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      check(size <= limit, 'sandbox_unavailable', 'The answer is too large', 502);
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, size),
    );
  } finally {
    // The transport's finally cancels unfinished bodies after this lock is released.
    reader.releaseLock();
  }
}

/** The one origin this plugin may call, taken from the operator's environment. */
function sandboxOrigin(value: unknown): string {
  let url: URL | undefined;
  try {
    url = new URL(String(value));
  } catch {
    url = undefined;
  }
  check(
    url &&
      ['http:', 'https:'].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['', '/'].includes(url.pathname),
    'invalid_sandboxes_config',
    'The sandboxes URL must be an HTTP(S) origin without credentials, query or path',
  );
  return url.origin;
}

/** Service routes are plain `/v1` paths; `{id}` is the only substitution, and never a path. */
export function sandboxRoute(path: string, id?: string): string {
  let resolved = path;
  if (id !== undefined) {
    check(
      identifier.test(id),
      'invalid_sandbox_id',
      'A sandbox identifier is letters, digits, dashes and underscores',
    );
    resolved = path.replaceAll('{id}', encodeURIComponent(id));
  }
  check(
    route.test(resolved) && !resolved.includes('..') && !resolved.includes('//'),
    'invalid_sandbox_route',
    'The service route is not a plain /v1 path',
  );
  return resolved;
}

/** The slowest link a part upload is still given time to finish on: one megabit a second. */
const MIN_UPLOAD_BYTES_PER_SECOND = 131_072;

/**
 * Authenticated, namespace-scoped transport to merv-sandboxes. Budget policy, accounting and
 * administration stay in the service; this reads published JSON and changes one named sandbox's
 * lease or life, nothing else. Each connection proves its current consumer grant before
 * resource access; a replacement grant must establish its own identity.
 */
export class SandboxClient {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #storageOrigins: readonly string[];
  readonly #consumers = new Map<string, string>();

  constructor(origin: unknown, timeoutMs = 15_000, storageOrigins: readonly string[] = []) {
    this.#origin = sandboxOrigin(origin);
    this.#timeoutMs = timeoutMs;
    this.#storageOrigins = storageOrigins.map((entry) => sandboxOrigin(entry));
  }

  /**
   * PUT one part of a check's source to the bucket URL the service issued. This is the only
   * request this plugin ever makes off the sandbox origin, so the origin must have been named
   * in deployment configuration, and no Merv credential is attached: the signature in the URL
   * is the whole authority. It cannot go through #send, whose contract is a JSON answer; a
   * bucket answers an empty body with the headers that matter.
   */
  async upload(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<void> {
    let target: URL | undefined;
    try {
      target = new URL(url);
    } catch {
      target = undefined;
    }
    check(
      target?.protocol === 'https:' && this.#storageOrigins.includes(target.origin),
      'sandbox_origin_refused',
      'A check source is uploaded only to a configured storage origin over HTTPS',
      403,
    );
    let response: Response;
    try {
      response = await fetch(target!, {
        method: 'PUT',
        redirect: 'manual',
        headers,
        // A blob of exactly this part's bytes. The copy is what detaches the part from the
        // whole source: a view over a shared buffer is not a body type the platform accepts.
        body: new Blob([new Uint8Array(bytes)]),
        // A part carries tens of megabytes, and the configured timeout is the control
        // plane's, written for small JSON answers. Giving the body the control-plane budget
        // would abort every real repository on any ordinary link and read as a dead service.
        signal: AbortSignal.timeout(
          this.#timeoutMs + Math.ceil((bytes.byteLength / MIN_UPLOAD_BYTES_PER_SECOND) * 1000),
        ),
      });
    } catch {
      throw new MervError('sandbox_unavailable', 'The check source store is unreachable', 503);
    }
    try {
      const status = response.status;
      check(
        !(status === 0 || (status >= 300 && status < 400)),
        'sandbox_redirect_refused',
        'The check source store answered a redirect',
        502,
      );
      check(
        status < 400,
        'sandbox_unavailable',
        `The check source store refused a part (HTTP ${status})`,
        502,
      );
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }

  get origin(): string {
    return this.#origin;
  }

  /** GET one route for one connection, after the connection's identity is established. */
  async read(
    connection: SandboxConnection,
    path: string,
    query?: { start_part: number },
  ): Promise<Json> {
    connection = { ...connection };
    const secret = await this.#prove(connection);
    return await this.#send(connection, secret, 'GET', path, undefined, query);
  }

  /** Change one sandbox, under the same proved grant. The body is the service's own request. */
  async write(
    connection: SandboxConnection,
    method: 'POST' | 'DELETE',
    path: string,
    body: Json,
    timeoutMs?: number,
  ): Promise<Json> {
    connection = { ...connection };
    body = structuredClone(body);
    const secret = await this.#prove(connection);
    return await this.#send(connection, secret, method, path, body, undefined, timeoutMs);
  }

  /** Whether this connection's grant is present at all; without it no call can be made. */
  configured(connection: SandboxConnection): boolean {
    return grant.test(process.env[connection.tokenEnv] ?? '');
  }

  #credential(connection: SandboxConnection): string {
    check(
      this.configured(connection),
      'sandbox_credential_unavailable',
      'The configured sandbox consumer grant is unavailable or malformed',
      503,
    );
    return process.env[connection.tokenEnv]!;
  }

  async #prove(connection: SandboxConnection): Promise<string> {
    const secret = this.#credential(connection);
    const key = JSON.stringify([
      connection.projectId,
      connection.namespace,
      connection.tokenEnv,
      connection.subject,
    ]);
    const fingerprint = createHash('sha256').update(secret).digest('hex');
    if (this.#consumers.get(key) !== fingerprint) {
      const identity = (await this.#send(connection, secret, 'GET', '/v1/auth/me')) as Record<
        string,
        unknown
      >;
      // An administrator sees every namespace; Merv reads only its own.
      check(
        identity?.role === 'consumer',
        'sandbox_forbidden',
        'Merv requires a consumer grant for the configured namespace',
        403,
      );
      check(
        identity.namespace === connection.namespace,
        'sandbox_forbidden',
        'The grant does not select the configured namespace',
        403,
      );
      this.#consumers.set(key, fingerprint);
    }
    return secret;
  }

  async #send(
    connection: SandboxConnection,
    secret: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Json,
    query?: { start_part: number },
    timeoutMs = this.#timeoutMs,
  ): Promise<Json> {
    check(
      this.#credential(connection) === secret,
      'sandbox_credential_changed',
      'The configured sandbox grant changed before dispatch; retry with the current grant',
      503,
    );
    const url = new URL(sandboxRoute(path), this.#origin);
    if (query) {
      check(
        Number.isInteger(query.start_part) && query.start_part >= 1 && query.start_part <= 10000,
        'invalid_upload_part',
        'Upload part must be between 1 and 10,000',
      );
      url.searchParams.set('start_part', String(query.start_part));
    }
    check(
      url.origin === this.#origin,
      'sandbox_origin_refused',
      'Only the configured sandbox origin may be called',
      403,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        // No redirects: a redirect would send this grant somewhere nobody authorized.
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${secret}`,
          'x-sandbox-namespace': connection.namespace,
          ...(connection.subject ? { 'x-sandbox-subject': connection.subject } : {}),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new MervError('sandbox_unavailable', 'merv-sandboxes is unreachable', 503);
    }
    try {
      const status = response.status;
      if (status === 0 || (status >= 300 && status < 400))
        throw new MervError('sandbox_redirect_refused', 'merv-sandboxes answered a redirect', 502);
      if (status >= 400) throw await this.#refusal(status, response, body !== undefined);
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      check(
        type === 'application/json',
        'sandbox_unavailable',
        'merv-sandboxes answered with an unusable body',
        502,
      );
      try {
        return JSON.parse(await boundedText(response, bodyLimit)) as Json;
      } catch (error) {
        if (error instanceof MervError) throw error;
        throw new MervError('sandbox_unavailable', 'merv-sandboxes answered invalid JSON', 502);
      }
    } finally {
      // Rejected headers, redirects and undisclosed errors never leave an unread stream
      // occupying a connection. Cancellation failures must not replace the public error.
      await response.body?.cancel().catch(() => {});
    }
  }

  /**
   * A read's failure body can carry signed URLs and policy detail, so a read reports the shape
   * only. A write is the caller's own act on one sandbox it named, and why the service refused
   * it — a lease that cannot be renewed, a budget that is spent — is the answer: the service's
   * own error code and message are reported, and nothing else from the body.
   */
  async #refusal(status: number, response: Response, disclose: boolean): Promise<MervError> {
    const envelope = disclose ? await this.#envelope(response) : undefined;
    return new MervError(
      envelope
        ? `sandbox_${envelope.reason && walletReasons.has(envelope.reason) ? envelope.reason : envelope.code}`
        : status === 404
          ? 'sandbox_not_found'
          : status < 500
            ? 'sandbox_forbidden'
            : 'sandbox_unavailable',
      envelope?.message ?? `merv-sandboxes refused the request (HTTP ${status})`,
      envelope ? status : status === 404 ? 404 : status < 500 ? 403 : 503,
    );
  }

  async #envelope(
    response: Response,
  ): Promise<{ code: string; message: string; reason?: string } | undefined> {
    try {
      const text = await boundedText(response, 4096);
      const error = (
        JSON.parse(text) as {
          error?: { code?: unknown; message?: unknown; details?: { reason?: unknown } };
        }
      ).error;
      const code = error?.code;
      return typeof code === 'string' && errorCode.test(code)
        ? {
            code,
            reason: typeof error?.details?.reason === 'string' ? error.details.reason : undefined,
            message:
              typeof error?.message === 'string' && error.message
                ? error.message.slice(0, 200)
                : code,
          }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
