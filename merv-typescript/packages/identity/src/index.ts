import type { Context } from 'cordis';
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from 'jose';
import { MervError, type VerifiedIdentity } from '@merv/contracts';
import type { IdentityConfig, IdentityConfiguration, IdentityProvider } from './types.js';

export type { IdentityConfig, IdentityConfiguration, IdentityProvider } from './types.js';

const MAX_JWT_BYTES = 16_384;
const MAX_JWKS_BYTES = 65_536;
const JWKS_TIMEOUT_MS = 5000;
const fields = new Set([
  'supabaseUrl',
  'mode',
  'secretEnv',
  'publishableKeyEnv',
  'audience',
  'allowLocalHttp',
]);
const environmentName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const compactJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalidConfig = () =>
  new MervError('invalid_identity_config', 'Invalid identity configuration');
const unauthorized = () =>
  new MervError('unauthorized', 'Invalid or unavailable user identity', 401);

function environment(reference: unknown): string {
  if (typeof reference !== 'string' || !environmentName.test(reference)) throw invalidConfig();
  const value = process.env[reference];
  if (!value || value.length > MAX_JWT_BYTES || value.trim() !== value) throw invalidConfig();
  return value;
}

function publicKey(reference: unknown): string {
  const value = environment(reference);
  if (/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(value)) return value;
  // This classifies an operator-supplied public API key, not an authenticated user.
  // Supabase's legacy anon keys are JWTs; service-role JWTs must never reach the UI.
  try {
    if (
      compactJwt.test(value) &&
      decodeProtectedHeader(value).alg === 'HS256' &&
      decodeJwt(value).role === 'anon'
    )
      return value;
  } catch {
    // Neither parsing errors nor the configured value leave this boundary.
  }
  throw invalidConfig();
}

/** Bound the response body as well as the network request; never follow JWKS redirects. */
async function jwksResponse(
  fetcher: typeof globalThis.fetch,
  url: string,
  options: { headers: Headers; signal: AbortSignal },
): Promise<Response> {
  const response = await fetcher(url, {
    method: 'GET',
    headers: options.headers,
    signal: options.signal,
    redirect: 'error',
    credentials: 'omit',
  });
  if (response.status !== 200 || !response.body || options.signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw unauthorized();
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_JWKS_BYTES))
      throw unauthorized();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_JWKS_BYTES) throw unauthorized();
      chunks.push(part.value);
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (
      !object(parsed) ||
      !Array.isArray(parsed.keys) ||
      parsed.keys.length === 0 ||
      parsed.keys.length > 32 ||
      parsed.keys.some(
        (key: unknown) =>
          !object(key) ||
          !['EC', 'RSA'].includes(String(key.kty)) ||
          ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((field) => Object.hasOwn(key, field)),
      )
    )
      throw unauthorized();
    return new Response(JSON.stringify(parsed), { status: 200 });
  } finally {
    options.signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function boundedFetch(fetcher: typeof globalThis.fetch, clock: () => number): FetchImplementation {
  let retryAt = 0;
  return async (url, options) => {
    if (clock() < retryAt) throw unauthorized();
    if (options.signal.aborted) throw unauthorized();
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(unauthorized());
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const response = await Promise.race([jwksResponse(fetcher, url, options), stopped]);
      retryAt = 0;
      return response;
    } catch {
      retryAt = clock() + 30_000;
      throw unauthorized();
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
  };
}

/** Verifies external user identities; it owns no project, actor or membership state. */
export class SupabaseIdentity implements IdentityProvider {
  #public: IdentityConfiguration = { enabled: false };
  #key?: Uint8Array | JWTVerifyGetKey;
  #issuer = '';
  #audience = 'authenticated';
  #algorithms: string[] = [];
  #clock: () => number;

  constructor(
    config: IdentityConfig = {},
    options: { clock?: () => number; fetch?: typeof globalThis.fetch } = {},
  ) {
    this.#clock = options.clock ?? Date.now;
    if (!object(config) || Object.keys(config).some((key) => !fields.has(key)))
      throw invalidConfig();
    if (Object.keys(config).length === 0) return;
    try {
      if (
        typeof config.supabaseUrl !== 'string' ||
        config.supabaseUrl.length > 2048 ||
        config.supabaseUrl.trim() !== config.supabaseUrl ||
        (config.allowLocalHttp !== undefined && typeof config.allowLocalHttp !== 'boolean')
      )
        throw invalidConfig();
      const url = new URL(config.supabaseUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && config.allowLocalHttp === true && local)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw invalidConfig();
      this.#issuer = `${url.origin}/auth/v1`;
      if (config.audience !== undefined) {
        if (
          typeof config.audience !== 'string' ||
          !config.audience ||
          config.audience.length > 200 ||
          config.audience.trim() !== config.audience
        )
          throw invalidConfig();
        this.#audience = config.audience;
      }
      const mode = config.mode ?? 'jwks';
      if (mode === 'hs256') {
        const secret = environment(config.secretEnv);
        if (Buffer.byteLength(secret) < 32) throw invalidConfig();
        this.#key = new TextEncoder().encode(secret);
        this.#algorithms = ['HS256'];
      } else if (mode === 'jwks' && config.secretEnv === undefined) {
        this.#key = createRemoteJWKSet(new URL(`${this.#issuer}/.well-known/jwks.json`), {
          timeoutDuration: JWKS_TIMEOUT_MS,
          cacheMaxAge: 300_000,
          cooldownDuration: 30_000,
          [customFetch]: boundedFetch(options.fetch ?? globalThis.fetch, this.#clock),
        });
        this.#algorithms = ['ES256', 'RS256'];
      } else throw invalidConfig();
      this.#public = {
        enabled: true,
        ...(config.publishableKeyEnv === undefined
          ? {}
          : { login: { url: url.origin, publishableKey: publicKey(config.publishableKeyEnv) } }),
      };
    } catch {
      throw invalidConfig();
    }
  }

  configuration(): IdentityConfiguration {
    return structuredClone(this.#public);
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      if (
        !this.#key ||
        typeof token !== 'string' ||
        token.length > MAX_JWT_BYTES ||
        !compactJwt.test(token)
      )
        throw unauthorized();
      const now = this.#clock();
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: this.#algorithms,
        issuer: this.#issuer,
        audience: this.#audience,
        requiredClaims: ['iss', 'aud', 'sub', 'exp'],
        clockTolerance: 0,
        currentDate: new Date(now),
      });
      if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        payload.sub.trim() !== payload.sub ||
        payload.sub.length > 200 ||
        typeof payload.exp !== 'number' ||
        !Number.isFinite(payload.exp) ||
        !Number.isFinite(now) ||
        payload.exp * 1000 <= this.#clock() ||
        payload.is_anonymous ||
        payload.role !== 'authenticated'
      )
        throw unauthorized();
      return {
        issuer: this.#issuer,
        subject: payload.sub,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
      };
    } catch {
      throw unauthorized();
    }
  }
}

export const identityPlugin = {
  name: 'merv-identity',
  inject: [],
  apply(ctx: Context, config: IdentityConfig = {}) {
    ctx.provide('identity', new SupabaseIdentity(config));
  },
};
export default identityPlugin;
