import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { check, fetchJson, MervError, OutboundError, type Json } from '@merv/contracts';

/** Server-only credentials. Domain-separated authenticated encryption binds each
 * value to its durable row; moving ciphertext between connections cannot work. */
export class NativeCredentials {
  readonly #key: Buffer;
  constructor(encoded: string | undefined) {
    const key =
      encoded && /^[A-Za-z0-9_-]{43}$/.test(encoded)
        ? Buffer.from(encoded, 'base64url')
        : undefined;
    check(
      key?.length === 32,
      'sandbox_setup_required',
      'Configure Sandboxes credential storage',
      503,
    );
    this.#key = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'merv/sandboxes/v1', 32));
  }
  seal(value: object, binding: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(binding));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  open<T>(value: string, binding: string): T {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid encoding');
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== value)
        throw new Error('invalid encoding');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(binding));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      ) as T;
    } catch {
      throw new MervError(
        'sandbox_credentials_unavailable',
        'Reconnect Sandboxes to restore access',
        503,
      );
    }
  }
}

export function nativeOrigin(value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    /* reported without credentials below */
  }
  check(
    !/[\x00-\x20\x7f]/.test(value) &&
      url &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    'invalid_sandboxes_config',
    'Sandboxes requires an HTTPS origin',
    400,
  );
  return url.origin;
}

/**
 * Each page of one cursor-paged list, first to last: the first is read with no cursor, each
 * later one with the cursor the page before it named. A list naming a cursor twice is `stuck`.
 */
export async function* pages<T extends { next: string | null }>(
  read: (after: string | undefined) => Promise<T>,
  stuck: () => never,
): AsyncGenerator<T, void, undefined> {
  const seen = new Set<string>();
  for (let after: string | undefined; ;) {
    const page = await read(after);
    yield page;
    if (page.next === null) return;
    if (seen.has(page.next)) stuck();
    seen.add((after = page.next));
  }
}

/** The fixed-origin connection bridge. Native agents use MCP directly; this
 * transport only handles consent, grants, cleanup and evidence registration. */
export class NativeSandboxClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.origin = nativeOrigin(origin);
  }
  async request<T>(
    path: string,
    secret: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      application?: boolean;
      scope?: { namespace: string; subject: string };
      body?: Json;
      query?: Record<string, string>;
    } = {},
  ): Promise<T> {
    check(
      /^\/v1\/(?:delegations|auth\/connections)(?:\/[A-Za-z0-9._~-]+)*$/.test(path) &&
        !path.includes('..'),
      'invalid_sandbox_route',
      'Invalid native connection route',
    );
    check(
      secret.length >= 16 && secret.length <= 4096 && /^[!-~]+$/.test(secret),
      'sandbox_credentials_unavailable',
      'Sandboxes access is unavailable',
      503,
    );
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);
    try {
      return (await fetchJson(url, options.application ? null : secret, {
        method: options.method ?? 'GET',
        // The native service answers some actions with 204, whatever their method.
        empty: true,
        headers: {
          ...(options.application && { 'x-sandbox-application-secret': secret }),
          ...(options.scope && {
            'x-sandbox-namespace': options.scope.namespace,
            'x-sandbox-subject': options.scope.subject,
          }),
        },
        ...(options.body ? { body: options.body } : {}),
        maxBytes: 8 * 1024 * 1024,
        signal: AbortSignal.timeout(15_000),
        fetcher: this.fetcher,
      })) as T;
    } catch (error) {
      const failure = error instanceof OutboundError ? error.failure : { kind: 'network' as const };
      if (failure.kind === 'status') {
        const status = failure.status;
        const revoked = status === 401 || status === 403;
        throw new MervError(
          status === 409
            ? 'sandbox_conflict'
            : status === 404
              ? 'sandbox_not_found'
              : revoked
                ? 'sandbox_access_revoked'
                : 'sandbox_unavailable',
          revoked
            ? 'Reconnect Sandboxes to restore access'
            : `Sandboxes could not complete this request (HTTP ${status})`,
          status === 409 ? 409 : status === 404 ? 404 : revoked ? 403 : 503,
        );
      }
      throw failure.kind === 'network'
        ? new MervError('sandbox_unavailable', 'Sandboxes is unreachable', 503)
        : new MervError('sandbox_unavailable', 'Sandboxes returned an invalid response', 502);
    }
  }
}
