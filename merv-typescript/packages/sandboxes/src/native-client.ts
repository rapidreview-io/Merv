import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { check, MervError, type Json } from '@merv/contracts';

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
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        headers: {
          ...(options.application
            ? { 'x-sandbox-application-secret': secret }
            : { authorization: `Bearer ${secret}` }),
          ...(options.scope
            ? {
                'x-sandbox-namespace': options.scope.namespace,
                'x-sandbox-subject': options.scope.subject,
              }
            : {}),
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new MervError('sandbox_unavailable', 'Sandboxes is unreachable', 503);
    }
    try {
      check(
        response.status >= 200 && response.status < 300,
        response.status === 409
          ? 'sandbox_conflict'
          : response.status === 404
            ? 'sandbox_not_found'
            : response.status === 401 || response.status === 403
              ? 'sandbox_access_revoked'
              : 'sandbox_unavailable',
        response.status === 401 || response.status === 403
          ? 'Reconnect Sandboxes to restore access'
          : `Sandboxes could not complete this request (HTTP ${response.status})`,
        response.status === 409
          ? 409
          : response.status === 404
            ? 404
            : response.status === 401 || response.status === 403
              ? 403
              : 503,
      );
      if (response.status === 204) return undefined as T;
      check(
        response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json',
        'sandbox_unavailable',
        'Sandboxes returned an invalid response',
        502,
      );
      const reader = response.body?.getReader();
      check(reader, 'sandbox_unavailable', 'Sandboxes returned an empty response', 502);
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          check(
            size <= 8 * 1024 * 1024,
            'sandbox_unavailable',
            'Sandboxes response is too large',
            502,
          );
          chunks.push(part.value);
        }
      } catch (error) {
        if (error instanceof MervError) throw error;
        throw new MervError('sandbox_unavailable', 'Sandboxes response was interrupted', 503);
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
      } catch {
        throw new MervError('sandbox_unavailable', 'Sandboxes returned invalid JSON', 502);
      }
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
}
