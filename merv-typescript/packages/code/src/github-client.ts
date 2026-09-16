import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { check, MervError } from '@merv/contracts';
import type { GitHubRepository } from '@merv/contracts';
import { z } from 'zod';

export interface GitHubConfig {
  origin: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
}
export function githubConfig(env = process.env): GitHubConfig | undefined {
  const clientId = env.MERV_GITHUB_CLIENT_ID;
  const clientSecret = env.MERV_GITHUB_CLIENT_SECRET;
  const appSlug = env.MERV_GITHUB_APP_SLUG;
  const encryptionKey = env.MERV_GITHUB_ENCRYPTION_KEY;
  if (![clientId, clientSecret, appSlug, encryptionKey].some(Boolean)) return;
  check(
    clientId && clientSecret && appSlug && encryptionKey && env.MERV_TS_PUBLIC_ORIGIN,
    'invalid_github_config',
    'GitHub configuration is incomplete',
  );
  return { clientId, clientSecret, appSlug, encryptionKey, origin: env.MERV_TS_PUBLIC_ORIGIN };
}
export const randomSecret = () => randomBytes(32).toString('base64url');
export const hashSecret = (value: string) => createHash('sha256').update(value).digest('base64url');
const id = z.number().int().positive().safe();
const userSchema = z.object({ id, login: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) });
const repositorySchema = z.object({
  id,
  full_name: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(300),
  default_branch: z.string().max(1024).nullable(),
  private: z.boolean(),
});
const tokensSchema = z.object({
  access_token: z.string().min(1).max(8192),
  expires_in: z.number().int().positive().max(86400),
  refresh_token: z.string().min(1).max(8192),
  refresh_token_expires_in: z
    .number()
    .int()
    .positive()
    .max(366 * 86400),
});
export interface GitHubTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

/** Adapted from Merv GitHub's OAuth/PKCE client. Only GitHub.com is supported. */
export class GitHubClient {
  readonly origin: string;
  readonly installUrl: string;
  #config: GitHubConfig;
  #key: Buffer;
  #stop = new AbortController();
  constructor(
    config: GitHubConfig,
    private fetcher: typeof fetch = fetch,
  ) {
    let origin: URL;
    try {
      origin = new URL(config.origin);
    } catch {
      throw new MervError('invalid_github_config', 'GitHub needs an exact public origin');
    }
    check(
      origin.origin === config.origin &&
        !origin.username &&
        !origin.password &&
        (origin.protocol === 'https:' ||
          (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))),
      'invalid_github_config',
      'GitHub needs an HTTPS origin or local development origin',
    );
    check(
      /^[a-z0-9][a-z0-9-]{0,99}$/.test(config.appSlug) &&
        config.clientId.length > 0 &&
        config.clientSecret.length > 0,
      'invalid_github_config',
      'GitHub App configuration is invalid',
    );
    check(
      /^[a-fA-F0-9]{64}$/.test(config.encryptionKey),
      'invalid_github_config',
      'GitHub encryption key must be 32 bytes encoded as hexadecimal',
    );
    this.#config = { ...config };
    this.#key = Buffer.from(config.encryptionKey, 'hex');
    this.origin = config.origin;
    this.installUrl = `https://github.com/apps/${config.appSlug}/installations/new`;
  }
  close() {
    this.#stop.abort();
  }
  seal(value: unknown, binding: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(binding));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  open<T>(ciphertext: string, binding: string): T {
    try {
      const bytes = Buffer.from(ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(binding));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      ) as T;
    } catch {
      throw new MervError('github_reconnect', 'Reconnect GitHub to restore access', 409);
    }
  }
  authorizationUrl(state: string, verifier: string) {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.#config.clientId,
      redirect_uri: `${this.origin}/code/github/callback`,
      state,
      code_challenge: hashSecret(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return url.href;
  }
  private async request(
    url: string,
    token?: string,
    body?: Record<string, string>,
  ): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(15_000)]),
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'merv-code',
          'x-github-api-version': '2026-03-10',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new MervError(
          response.status === 401 ? 'github_reconnect' : 'github_unavailable',
          response.status === 401
            ? 'Reconnect GitHub to restore access'
            : 'GitHub could not complete the request; check repository access or try again later',
          response.status === 401 ? 409 : 502,
        );
      }
      const reader = response.body?.getReader();
      check(reader, 'github_response', 'GitHub returned an invalid response', 502);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          check(bytes <= 2_000_000, 'github_response', 'GitHub response exceeded the limit', 502);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof MervError) throw error;
      throw new MervError(
        'github_unavailable',
        'GitHub could not complete the request; try again later',
        502,
      );
    }
  }
  private async tokens(body: Record<string, string>): Promise<GitHubTokens> {
    const result = tokensSchema.safeParse(
      await this.request('https://github.com/login/oauth/access_token', undefined, {
        ...body,
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
      }),
    );
    check(
      result.success,
      'github_reconnect',
      'GitHub authorization failed; reconnect with expiring user tokens enabled',
      409,
    );
    const t = result.data;
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      refreshExpiresAt: Date.now() + t.refresh_token_expires_in * 1000,
    };
  }
  exchange(code: string, verifier: string) {
    return this.tokens({
      code,
      code_verifier: verifier,
      redirect_uri: `${this.origin}/code/github/callback`,
    });
  }
  refresh(token: string) {
    return this.tokens({ grant_type: 'refresh_token', refresh_token: token });
  }
  /** Revoke only the discarded token, never the user's grant or another project's tokens. */
  async revoke(token: string): Promise<void> {
    try {
      const response = await this.fetcher(
        `https://api.github.com/applications/${encodeURIComponent(this.#config.clientId)}/token`,
        {
          method: 'DELETE',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          headers: {
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'x-github-api-version': '2026-03-10',
            'user-agent': 'merv-code',
            authorization: `Basic ${Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString('base64')}`,
          },
          body: JSON.stringify({ access_token: token }),
        },
      );
      await response.body?.cancel();
    } catch {
      /* Local authority is already withdrawn. The remote token is also short-lived. */
    }
  }
  async user(token: string) {
    const user = userSchema.safeParse(await this.request('https://api.github.com/user', token));
    check(user.success, 'github_response', 'GitHub returned an invalid user', 502);
    return user.data;
  }
  private async pages(
    token: string,
    path: string,
    field: string,
    deadline = Date.now() + 30_000,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      check(
        Date.now() < deadline,
        'github_unavailable',
        'GitHub listing took too long; try again later',
        502,
      );
      const body = (await this.request(
        `https://api.github.com${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        token,
      )) as Record<string, unknown>;
      const rows = body && body[field];
      check(
        Array.isArray(rows) && rows.length <= 100,
        'github_response',
        'GitHub returned an invalid list',
        502,
      );
      items.push(...rows);
      if (rows.length < 100) return items;
    }
    throw new MervError(
      'github_limit',
      'Too many repositories; narrow the GitHub App installation to selected repositories',
      409,
    );
  }
  async repositories(token: string): Promise<GitHubRepository[]> {
    const deadline = Date.now() + 30_000;
    const installations = await this.pages(token, '/user/installations', 'installations');
    check(
      installations.length <= 20,
      'github_limit',
      'Too many installations for one connection',
      409,
    );
    const repositories: GitHubRepository[] = [];
    for (const raw of installations) {
      const installation = z.object({ id }).safeParse(raw);
      check(
        installation.success,
        'github_response',
        'GitHub returned an invalid installation',
        502,
      );
      repositories.push(
        ...(await this.installationRepositories(token, installation.data.id, deadline)),
      );
      check(
        repositories.length <= 2000,
        'github_limit',
        'Too many repositories; narrow the GitHub App installation',
        409,
      );
    }
    return repositories;
  }
  async installationRepositories(
    token: string,
    installationId: number,
    deadline?: number,
  ): Promise<GitHubRepository[]> {
    const rows = await this.pages(
      token,
      `/user/installations/${installationId}/repositories`,
      'repositories',
      deadline,
    );
    return rows.map((raw) => {
      const parsed = repositorySchema.safeParse(raw);
      check(parsed.success, 'github_response', 'GitHub returned an invalid repository', 502);
      const repo = parsed.data;
      return {
        id: repo.id,
        installationId,
        fullName: repo.full_name,
        url: `https://github.com/${repo.full_name}`,
        defaultBranch: repo.default_branch,
        private: repo.private,
      };
    });
  }
}
