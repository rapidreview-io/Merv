import { check, MervError, type Json } from '@merv/contracts';
import type { SandboxConnection } from './types.js';

const grant = /^sbxt_[A-Za-z0-9_-]{4,512}$/;
const route = /^\/v1\/[A-Za-z0-9._~/-]*$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** The service's published error vocabulary: a lowercase token, never free text. */
const errorCode = /^[a-z][a-z_]{0,39}$/;
const bodyLimit = 4_000_000;

/** The one origin this plugin may call, taken from the operator's environment. */
export function sandboxOrigin(value: unknown): string {
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

/**
 * Authenticated, namespace-scoped transport to merv-sandboxes. Budget policy, accounting and
 * administration stay in the service; this reads published JSON and changes one named sandbox's
 * lease or life, nothing else. Each connection proves a consumer grant once, before its first
 * resource request.
 */
export class SandboxClient {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #consumers = new Set<string>();

  constructor(origin: string, timeoutMs = 15_000) {
    this.#origin = sandboxOrigin(origin);
    this.#timeoutMs = timeoutMs;
  }

  get origin(): string {
    return this.#origin;
  }

  /** GET one route for one connection, after the connection's identity is established. */
  async read(connection: SandboxConnection, path: string): Promise<Json> {
    await this.#prove(connection);
    return await this.#send(connection, 'GET', path);
  }

  /** Change one sandbox, under the same proved grant. The body is the service's own request. */
  async write(
    connection: SandboxConnection,
    method: 'POST' | 'DELETE',
    path: string,
    body: Json,
  ): Promise<Json> {
    await this.#prove(connection);
    return await this.#send(connection, method, path, body);
  }

  async #prove(connection: SandboxConnection): Promise<void> {
    if (!this.#consumers.has(connection.projectId)) {
      const identity = (await this.#send(connection, 'GET', '/v1/auth/me')) as Record<
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
      this.#consumers.add(connection.projectId);
    }
  }

  async #send(
    connection: SandboxConnection,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Json,
  ): Promise<Json> {
    const secret = process.env[connection.tokenEnv];
    check(
      typeof secret === 'string' && grant.test(secret),
      'sandbox_credential_unavailable',
      'The configured sandbox consumer grant is unavailable or malformed',
      503,
    );
    const url = new URL(sandboxRoute(path), this.#origin);
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
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new MervError('sandbox_unavailable', 'merv-sandboxes is unreachable', 503);
    }
    const status = response.status;
    if (status === 0 || (status >= 300 && status < 400))
      throw new MervError('sandbox_redirect_refused', 'merv-sandboxes answered a redirect', 502);
    if (status >= 400) throw await this.#refusal(status, response, body !== undefined);
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    const length = Number(response.headers.get('content-length') ?? 0);
    check(
      type === 'application/json' && length <= bodyLimit,
      'sandbox_unavailable',
      'merv-sandboxes answered with an unusable body',
      502,
    );
    try {
      const text = await response.text();
      check(text.length <= bodyLimit, 'sandbox_unavailable', 'The answer is too large', 502);
      return JSON.parse(text) as Json;
    } catch (error) {
      if (error instanceof MervError) throw error;
      throw new MervError('sandbox_unavailable', 'merv-sandboxes answered invalid JSON', 502);
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
        ? `sandbox_${envelope.code}`
        : status === 404
          ? 'sandbox_not_found'
          : status < 500
            ? 'sandbox_forbidden'
            : 'sandbox_unavailable',
      envelope?.message ?? `merv-sandboxes refused the request (HTTP ${status})`,
      envelope ? status : status === 404 ? 404 : status < 500 ? 403 : 503,
    );
  }

  async #envelope(response: Response): Promise<{ code: string; message: string } | undefined> {
    try {
      const text = await response.text();
      if (text.length > 4096) return undefined;
      const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
      const code = error?.code;
      return typeof code === 'string' && errorCode.test(code)
        ? {
            code,
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
