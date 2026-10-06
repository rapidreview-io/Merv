import type { Context } from 'cordis';
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { MervError, type VerifiedIdentity } from '@merv/contracts';
import type { IdentityConfig, IdentityConfiguration, IdentityProvider } from './types.js';

export type { IdentityConfig, IdentityConfiguration, IdentityProvider } from './types.js';

const MAX_JWT_BYTES = 16_384;
const MAX_JWKS_BYTES = 65_536;
const JWKS_TIMEOUT_MS = 5000;
/** Refresh in the background after 5 min; retry at most every 30 s; trust the last good set for 24 h. */
const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const MAX_STALE_MS = 24 * 60 * 60_000;
const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
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
/** No usable key set: the token is unjudged, so the caller retries instead of signing out. */
const unavailable = () =>
  new MervError('identity_unavailable', 'User identity keys are unavailable; retry shortly', 503);

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

/** GET the key set: no redirects or cookies, at most 64 KiB, abandoned when `signal` aborts. */
async function loadJwks(
  fetcher: typeof globalThis.fetch,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, {
    method: 'GET',
    signal,
    redirect: 'error',
    credentials: 'omit',
  });
  if (response.status !== 200 || !response.body || signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw unauthorized();
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** A public signing key this verifier can use; everything else in a set is ignored. */
const usable = (key: unknown) =>
  object(key) &&
  !PRIVATE_FIELDS.some((field) => Object.hasOwn(key, field)) &&
  ((key.kty === 'EC' && key.crv === 'P-256') ||
    key.kty === 'RSA' ||
    (key.kty === 'OKP' && key.crv === 'Ed25519'));

/** The last good Supabase key set. No request waits on a refresh while the set is usable. */
class RemoteKeys {
  #keys?: JWTVerifyGetKey;
  #loadedAt = -Infinity;
  #triedAt = -Infinity;
  #pending?: Promise<void>;

  constructor(
    private readonly load: (signal: AbortSignal) => Promise<unknown>,
    private readonly clock: () => number,
  ) {}

  /** A clock that stepped back makes an instant due for refresh, never expired. */
  #age(time: number): number {
    const age = this.clock() - time;
    return age >= 0 ? age : REFRESH_MS;
  }

  #mayFetch(): boolean {
    return this.#pending !== undefined || this.#age(this.#triedAt) >= RETRY_MS;
  }

  #usable(): boolean {
    return this.#keys !== undefined && this.#age(this.#loadedAt) < MAX_STALE_MS;
  }

  /** Single flight. A response with no usable key throws, so the last good set stays. */
  #refresh(): Promise<void> {
    this.#pending ??= (async () => {
      this.#triedAt = this.clock();
      const signal = AbortSignal.timeout(JWKS_TIMEOUT_MS);
      // Settles even if a fetcher ignores its signal: one hung request cannot wedge refresh.
      const timedOut = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(unauthorized()), { once: true });
      });
      const json = await Promise.race([this.load(signal), timedOut]);
      const keys = object(json) && Array.isArray(json.keys) ? json.keys.filter(usable) : [];
      if (keys.length === 0) throw unauthorized();
      this.#keys = createLocalJWKSet({ keys } as JSONWebKeySet);
      this.#loadedAt = this.clock();
    })().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  getKey: JWTVerifyGetKey = async (header, token) => {
    if (!this.#usable()) {
      if (this.#mayFetch()) await this.#refresh().catch(() => undefined);
    } else if (this.#age(this.#loadedAt) >= REFRESH_MS && this.#mayFetch())
      void this.#refresh().catch(() => undefined);
    if (!this.#usable()) throw unavailable();
    try {
      return await this.#keys!(header, token);
    } catch (error) {
      // A new kid joins or starts one refresh; unknown-kid spam fetches at most every 30 s.
      if (!(error instanceof errors.JWKSNoMatchingKey) || !this.#mayFetch()) throw error;
      await this.#refresh();
      return await this.#keys!(header, token);
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
        const fetcher = options.fetch ?? globalThis.fetch;
        const jwks = `${this.#issuer}/.well-known/jwks.json`;
        this.#key = new RemoteKeys((signal) => loadJwks(fetcher, jwks, signal), this.#clock).getKey;
        this.#algorithms = ['ES256', 'RS256', 'EdDSA', 'Ed25519'];
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
    } catch (error) {
      throw error instanceof MervError && error.status === 503 ? error : unauthorized();
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
