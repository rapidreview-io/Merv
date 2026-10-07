import {
  check,
  fetchJson,
  MervError,
  origin,
  OutboundError,
  record,
  sha256Hex,
  type Json,
} from '@merv/contracts';
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

/** An origin the operator configured: the service's, a bucket's, or Merv's own public one. */
export const sandboxOrigin = (value: unknown) =>
  origin(
    value,
    'invalid_sandboxes_config',
    'Sandboxes requires an HTTPS origin without credentials, query or path',
  );

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

/**
 * A refused call: a redirect never followed, and for a write the service's own error code and
 * message (a lease that cannot be renewed, a budget that is spent), nothing else from its body.
 */
function refusal(status: number, said: Record<string, unknown> | undefined): MervError {
  if (status >= 300 && status < 400)
    return new MervError('sandbox_redirect_refused', 'merv-sandboxes answered a redirect', 502);
  const error = record(said?.error);
  const code = error?.code;
  const reason = record(error?.details)?.reason;
  const envelope =
    typeof code === 'string' && errorCode.test(code)
      ? {
          code: `sandbox_${typeof reason === 'string' && walletReasons.has(reason) ? reason : code}`,
          message:
            typeof error?.message === 'string' && error.message
              ? error.message.slice(0, 200)
              : code,
        }
      : undefined;
  return new MervError(
    envelope?.code ??
      (status === 404
        ? 'sandbox_not_found'
        : status < 500
          ? 'sandbox_forbidden'
          : 'sandbox_unavailable'),
    envelope?.message ?? `merv-sandboxes refused the request (HTTP ${status})`,
    // The service's 401 is about Merv's grant, never the caller's own sign-in.
    envelope
      ? status === 401
        ? 403
        : status
      : status === 429 || status === 404
        ? status
        : status < 500
          ? 403
          : 503,
  );
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
  async read(connection: SandboxConnection, path: string): Promise<Json> {
    connection = { ...connection };
    const secret = await this.#prove(connection);
    return await this.#send(connection, secret, 'GET', path);
  }

  /** Change one sandbox, under the same proved grant. The body is the service's own request. */
  async write(
    connection: SandboxConnection,
    method: 'POST' | 'DELETE',
    path: string,
    body: Json,
  ): Promise<Json> {
    connection = { ...connection };
    body = structuredClone(body);
    const secret = await this.#prove(connection);
    return await this.#send(connection, secret, method, path, body);
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
    const fingerprint = sha256Hex(secret);
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
  ): Promise<Json> {
    check(
      this.#credential(connection) === secret,
      'sandbox_credential_changed',
      'The configured sandbox grant changed before dispatch; retry with the current grant',
      503,
    );
    const url = new URL(sandboxRoute(path), this.#origin);
    check(
      url.origin === this.#origin,
      'sandbox_origin_refused',
      'Only the configured sandbox origin may be called',
      403,
    );
    try {
      return await fetchJson(url, secret, {
        method,
        headers: {
          'x-sandbox-namespace': connection.namespace,
          ...(connection.subject ? { 'x-sandbox-subject': connection.subject } : {}),
        },
        // A write is the caller's own act on one sandbox it named, and why the service refused
        // it is the answer; a read's failure body can carry signed URLs and policy detail.
        ...(body !== undefined && { body, errorBytes: 4096 }),
        anyJson: true,
        maxBytes: bodyLimit,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const failure = error instanceof OutboundError ? error.failure : { kind: 'network' as const };
      if (failure.kind === 'status') throw refusal(failure.status, (error as OutboundError).body);
      if (failure.kind === 'too_large')
        throw new MervError('sandbox_unavailable', 'The answer is too large', 502);
      if (failure.kind === 'invalid')
        throw new MervError('sandbox_unavailable', 'merv-sandboxes answered invalid JSON', 502);
      throw new MervError('sandbox_unavailable', 'merv-sandboxes is unreachable', 503);
    }
  }
}
