import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  sign,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { check, MervError } from '@merv/contracts';
import type {
  GitHubRepository,
  GitHubBranch,
  GitHubPullDetails,
  GitHubPullRequest,
} from '@merv/contracts';
import { z } from 'zod';
import {
  githubResponse,
  githubPull,
  githubCommit,
  githubOid,
  githubFileSchema,
  githubCheckSchema,
  githubReviewSchema,
  repositoryPath,
} from './github-responses.js';

export interface GitHubConfig {
  origin: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  /** Optional server-only RSA key, base64 encoded PEM. Enables repository automation. */
  privateKey?: string;
}
export function githubConfig(env = process.env): GitHubConfig | undefined {
  const clientId = env.MERV_GITHUB_CLIENT_ID;
  const clientSecret = env.MERV_GITHUB_CLIENT_SECRET;
  const appSlug = env.MERV_GITHUB_APP_SLUG;
  const encryptionKey = env.MERV_GITHUB_ENCRYPTION_KEY;
  const privateKey = env.MERV_GITHUB_PRIVATE_KEY_BASE64;
  if (![clientId, clientSecret, appSlug, encryptionKey, privateKey].some(Boolean)) return;
  check(
    clientId && clientSecret && appSlug && encryptionKey && env.MERV_TS_PUBLIC_ORIGIN,
    'invalid_github_config',
    'GitHub configuration is incomplete',
  );
  return {
    clientId,
    clientSecret,
    appSlug,
    encryptionKey,
    privateKey,
    origin: env.MERV_TS_PUBLIC_ORIGIN,
  };
}
export const randomSecret = () => randomBytes(32).toString('base64url');
export const hashSecret = (value: string) => createHash('sha256').update(value).digest('base64url');
// 2026-03-10 removes merge_commit_sha, which durable merge recovery needs.
// Keep the supported 2022 contract until that recovery path is migrated.
const githubApiVersion = '2022-11-28';
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
  #appKey?: KeyObject;
  #stop = new AbortController();
  #authorization = new AsyncLocalStorage<(() => Promise<void>) | undefined>();
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
    if (config.privateKey) {
      try {
        this.#appKey = createPrivateKey(Buffer.from(config.privateKey, 'base64'));
        check(
          this.#appKey.asymmetricKeyType === 'rsa',
          'invalid_github_config',
          'GitHub requires an RSA App key',
        );
      } catch {
        throw new MervError('invalid_github_config', 'GitHub App private key is invalid');
      }
    }
    this.origin = config.origin;
    this.installUrl = `https://github.com/apps/${config.appSlug}/installations/new`;
  }
  close() {
    this.#stop.abort();
  }
  authorized<T>(authorize: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
    return this.#authorization.run(authorize, operation);
  }
  get automationConfigured() {
    return !!this.#appKey;
  }
  /** Only the original connection owner's current repository rights authorize automation. */
  async repositoryPermission(token: string, repository: GitHubRepository, write: boolean) {
    const result = githubResponse(
      repositorySchema.extend({ permissions: z.object({ pull: z.boolean(), push: z.boolean() }) }),
      await this.request(`https://api.github.com${repositoryPath(repository.fullName)}`, token),
    );
    check(
      result.id === repository.id && result.permissions.pull && (!write || result.permissions.push),
      'github_repository_forbidden',
      'The GitHub connection owner no longer has the required repository permission',
      403,
    );
    const installed = await this.installationRepositories(token, repository.installationId);
    check(
      installed.some((r) => r.id === repository.id && r.fullName === repository.fullName),
      'github_repository_forbidden',
      'The repository is no longer available to this GitHub installation',
      403,
    );
  }
  /** Never return an unrestricted installation token. No OAuth token is lent to a runner. */
  async installationToken(
    repository: GitHubRepository,
    permission:
      | boolean
      | {
          contents: 'read' | 'write';
          pull_requests?: 'read' | 'write';
          statuses?: 'read' | 'write';
          checks?: 'read';
        },
  ) {
    check(
      this.#appKey,
      'github_automation_unconfigured',
      'GitHub repository automation is not configured',
      503,
    );
    const permissions =
      typeof permission === 'boolean'
        ? { contents: permission ? 'write' : 'read' }
        : { ...permission };
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.#config.clientId }),
    ).toString('base64url');
    const unsigned = `${header}.${body}`;
    const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), this.#appKey).toString('base64url')}`;
    const result = githubResponse(
      z.object({
        token: z.string().min(1).max(16384),
        expires_at: z.string().datetime(),
        permissions: z.record(z.string()),
        repositories: z.array(z.object({ id })),
      }),
      await this.request(
        `https://api.github.com/app/installations/${repository.installationId}/access_tokens`,
        jwt,
        { repository_ids: [repository.id], permissions },
      ),
    );
    const valid =
      result.repositories.length === 1 &&
      result.repositories[0].id === repository.id &&
      Object.entries(permissions).every(([name, level]) => result.permissions[name] === level) &&
      Object.entries(result.permissions).every(
        ([name, level]) => name in permissions || (name === 'metadata' && level === 'read'),
      ) &&
      Date.parse(result.expires_at) > Date.now();
    if (!valid) await this.revokeInstallationToken(result.token).catch(() => {});
    check(valid, 'github_response', 'GitHub returned an invalid installation token scope', 502);
    return { token: result.token, expiresAt: result.expires_at };
  }
  async revokeInstallationToken(token: string) {
    // Revoking a token is cleanup and must still work after the grant loses authority.
    await this.#authorization.run(undefined, () =>
      this.request('https://api.github.com/installation/token', token, undefined, 'DELETE'),
    );
  }
  async ensureBranch(token: string, repository: string, branch: string, sha: string) {
    githubResponse(githubOid, sha);
    try {
      const current = await this.branch(token, repository, branch);
      check(
        current.sha === sha,
        'github_head_changed',
        'The publication branch contains different code',
        409,
      );
      return;
    } catch (error) {
      if (!(error instanceof MervError && error.code === 'github_not_found')) throw error;
    }
    try {
      await this.request(`https://api.github.com${repositoryPath(repository)}/git/refs`, token, {
        ref: `refs/heads/${branch}`,
        sha,
      });
    } catch (error) {
      // Ref creation can succeed even when its reply is lost. Never update an existing ref.
      const current = await this.branch(token, repository, branch).catch(() => null);
      if (current?.sha !== sha) throw error;
    }
    check(
      (await this.branch(token, repository, branch)).sha === sha,
      'github_head_changed',
      'The publication branch contains different code',
      409,
    );
  }
  async readyPull(token: string, nodeId: string) {
    const result = githubResponse(
      z.object({
        data: z.object({
          markPullRequestReadyForReview: z.object({
            pullRequest: z.object({ id: z.string(), isDraft: z.boolean() }),
          }),
        }),
      }),
      await this.request('https://api.github.com/graphql', token, {
        query:
          'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
        variables: { id: nodeId },
      }),
    );
    check(
      result.data.markPullRequestReadyForReview.pullRequest.id === nodeId &&
        !result.data.markPullRequestReadyForReview.pullRequest.isDraft,
      'github_response',
      'GitHub did not confirm that the pull request is ready',
      502,
    );
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
    body?: Record<string, unknown>,
    method = body ? 'POST' : 'GET',
  ): Promise<unknown> {
    try {
      await this.#authorization.getStore()?.();
      this.#stop.signal.throwIfAborted();
      const response = await this.fetcher(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(15_000)]),
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'merv-code',
          'x-github-api-version': githubApiVersion,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404)
          throw new MervError('github_not_found', 'GitHub resource is absent or inaccessible', 404);
        if (response.status === 409 || response.status === 422)
          throw new MervError(
            'github_conflict',
            'GitHub refused this change; refresh the repository or pull request before retrying',
            409,
          );
        throw new MervError(
          response.status === 401 ? 'github_reconnect' : 'github_unavailable',
          response.status === 401
            ? 'Reconnect GitHub to restore access'
            : 'GitHub could not complete the request; check repository access or try again later',
          response.status === 401 ? 409 : 502,
        );
      }
      if (response.status === 204) return null;
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
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      );
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
            'x-github-api-version': githubApiVersion,
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
  /** Bounded REST collections; callers never mistake a truncated result for a complete one. */
  private async collection(token: string, path: string, field?: string): Promise<unknown[]> {
    const result: unknown[] = [];
    const deadline = Date.now() + 30_000;
    for (let page = 1; page <= 20; page++) {
      check(Date.now() < deadline, 'github_unavailable', 'GitHub listing took too long', 502);
      const value = await this.request(
        `https://api.github.com${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        token,
      );
      const entries = field ? (value as Record<string, unknown>)?.[field] : value;
      check(
        Array.isArray(entries) && entries.length <= 100,
        'github_response',
        'GitHub returned an invalid list',
        502,
      );
      result.push(...entries);
      if (entries.length < 100) return result;
    }
    throw new MervError(
      'github_limit',
      'GitHub result exceeds the supported limit; narrow the request',
      409,
    );
  }
  async branches(token: string, repository: string): Promise<GitHubBranch[]> {
    const schema = z.object({
      name: z.string().min(1).max(1024),
      commit: z.object({ sha: githubOid }),
      protected: z.boolean(),
    });
    return (await this.collection(token, `${repositoryPath(repository)}/branches`)).map((value) => {
      const b = githubResponse(schema, value);
      return { name: b.name, sha: b.commit.sha, protected: b.protected };
    });
  }
  async branch(token: string, repository: string, branch: string): Promise<GitHubBranch> {
    const b = githubResponse(
      z.object({ name: z.string(), commit: z.object({ sha: githubOid }), protected: z.boolean() }),
      await this.request(
        `https://api.github.com${repositoryPath(repository)}/branches/${encodeURIComponent(branch)}`,
        token,
      ),
    );
    check(b.name === branch, 'github_response', 'GitHub returned a different branch', 502);
    return { name: b.name, sha: b.commit.sha, protected: b.protected };
  }
  async commit(token: string, repository: string, sha: string) {
    githubResponse(githubOid, sha);
    const result = githubCommit(
      await this.request(
        `https://api.github.com${repositoryPath(repository)}/commits/${sha}`,
        token,
      ),
    );
    check(result.sha === sha, 'github_response', 'GitHub returned a different commit', 502);
    return result;
  }
  async pulls(
    token: string,
    repository: string,
    input: { state?: 'open' | 'closed' | 'all'; head?: string } = {},
  ) {
    const query = new URLSearchParams({
      state: input.state ?? 'open',
      ...(input.head ? { head: input.head } : {}),
    });
    return (await this.collection(token, `${repositoryPath(repository)}/pulls?${query}`)).map(
      githubPull,
    );
  }
  async pull(token: string, repository: string, number: number): Promise<GitHubPullRequest> {
    githubResponse(id, number);
    const result = githubPull(
      await this.request(
        `https://api.github.com${repositoryPath(repository)}/pulls/${number}`,
        token,
      ),
    );
    check(
      result.number === number,
      'github_response',
      'GitHub returned a different pull request',
      502,
    );
    return result;
  }
  async createPull(
    token: string,
    repository: string,
    input: { title: string; body: string; head: string; base: string; draft: boolean },
  ) {
    return githubPull(
      await this.request(`https://api.github.com${repositoryPath(repository)}/pulls`, token, {
        ...input,
        maintainer_can_modify: false,
      }),
    );
  }
  async updatePull(
    token: string,
    repository: string,
    number: number,
    input: { title?: string; body?: string; state?: 'open' | 'closed' },
  ) {
    githubResponse(id, number);
    return githubPull(
      await this.request(
        `https://api.github.com${repositoryPath(repository)}/pulls/${number}`,
        token,
        input,
        'PATCH',
      ),
    );
  }
  async mergePull(token: string, repository: string, number: number, expectedHead: string) {
    githubResponse(id, number);
    githubResponse(githubOid, expectedHead);
    return githubResponse(
      z.object({ merged: z.boolean(), sha: githubOid }),
      await this.request(
        `https://api.github.com${repositoryPath(repository)}/pulls/${number}/merge`,
        token,
        { sha: expectedHead, merge_method: 'merge' },
        'PUT',
      ),
    );
  }
  async approvalStatus(
    token: string,
    repository: string,
    sha: string,
    emit = false,
  ): Promise<boolean> {
    githubResponse(githubOid, sha);
    const path = `https://api.github.com${repositoryPath(repository)}`;
    const statuses = await this.collection(
      token,
      `${repositoryPath(repository)}/commits/${sha}/statuses`,
    );
    const found = statuses.find(
      (entry) => (entry as { context?: string }).context === 'merv/consolidation-approved',
    );
    const approved =
      !!found &&
      githubResponse(
        z.object({ sha: githubOid, state: z.string(), creator: z.object({ login: z.string() }) }),
        found,
      ).sha === sha &&
      (found as { state: string }).state === 'success' &&
      (found as { creator: { login: string } }).creator.login === `${this.#config.appSlug}[bot]`;
    if (approved || !emit) return approved;
    await this.request(`${path}/statuses/${sha}`, token, {
      state: 'success',
      context: 'merv/consolidation-approved',
      description: 'Independent Merv review of this exact commit passed',
    });
    return this.approvalStatus(token, repository, sha);
  }
  async rules(token: string, repository: string, branch: string) {
    // Effective branch rules omit bypass lists; visibility is incomplete until every ruleset
    // can be inspected. A missing field is never evidence that nobody bypasses the rule.
    const rules = await this.collection(
      token,
      `${repositoryPath(repository)}/rules/branches/${encodeURIComponent(branch)}`,
    );
    const details: unknown[] = [];
    let incomplete = false;
    let sets: unknown[] = [];
    try {
      sets = await this.collection(
        token,
        `${repositoryPath(repository)}/rulesets?includes_parents=true`,
      );
    } catch (error) {
      // Not being able to list the rulesets hides the bypass lists, and says nothing about the
      // effective rules just read: those are what the merge gate turns on, and they stand.
      if (!(error instanceof MervError)) throw error;
      incomplete = true;
    }
    for (const value of sets) {
      const set = githubResponse(z.object({ id, source_type: z.string() }), value);
      if (set.source_type !== 'Repository') {
        incomplete = true;
        continue;
      }
      try {
        const detail = await this.request(
          `https://api.github.com${repositoryPath(repository)}/rulesets/${set.id}`,
          token,
        );
        details.push(detail);
        if (!Array.isArray((detail as { bypass_actors?: unknown }).bypass_actors))
          incomplete = true;
      } catch (error) {
        if (
          !(error instanceof MervError) ||
          !['github_forbidden', 'github_not_found'].includes(error.code)
        )
          throw error;
        incomplete = true;
      }
    }
    const app = githubResponse(
      z.object({ id }),
      await this.request(
        `https://api.github.com/apps/${encodeURIComponent(this.#config.appSlug)}`,
        token,
      ),
    );
    const required = rules.filter(
      (r) => (r as { type?: string }).type === 'required_status_checks',
    ) as {
      parameters?: {
        strict_required_status_checks_policy?: boolean;
        required_status_checks?: { context: string; integration_id?: number }[];
      };
    }[];
    return {
      rules,
      details,
      incomplete,
      available: true,
      required: [
        ...new Set(
          required.flatMap(
            (r) => r.parameters?.required_status_checks?.map((s) => s.context) ?? [],
          ),
        ),
      ],
      strict: required.some(
        (r) =>
          r.parameters?.strict_required_status_checks_policy &&
          r.parameters.required_status_checks?.some(
            (s) => s.context === 'merv/consolidation-approved' && s.integration_id === app.id,
          ),
      ),
      pullRequest: rules.some((r) => (r as { type?: string }).type === 'pull_request'),
    };
  }
  async requiredChecks(
    token: string,
    repository: string,
    sha: string,
    required: string[],
    checks: GitHubPullDetails['checks'],
  ) {
    const statuses = await this.collection(
      token,
      `${repositoryPath(repository)}/commits/${sha}/statuses`,
    );
    return required.every((name) => {
      const latest = statuses.find(
        (status) => (status as { context?: string }).context === name,
      ) as { sha?: string; state?: string } | undefined;
      return (
        (latest?.sha === sha && latest.state === 'success') ||
        checks.some(
          (c) =>
            c.name === name &&
            c.status === 'completed' &&
            ['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''),
        )
      );
    });
  }
  async successorComment(token: string, repository: string, number: number, successor: string) {
    const body = `Superseded by Merv proposal ${successor}. Main moved; a new independent review is required.`;
    const path = `${repositoryPath(repository)}/issues/${number}/comments`;
    const comments = await this.collection(token, path);
    if (!comments.some((comment) => (comment as { body?: string }).body === body))
      await this.request(`https://api.github.com${path}`, token, { body });
  }
  async pullDetails(token: string, repository: string, number: number): Promise<GitHubPullDetails> {
    const pull = await this.pull(token, repository, number);
    const path = repositoryPath(repository);
    const [files, commits, checks, reviews, status] = await Promise.all([
      this.collection(token, `${path}/pulls/${number}/files`),
      this.collection(token, `${path}/pulls/${number}/commits`),
      this.collection(token, `${path}/commits/${pull.head.sha}/check-runs`, 'check_runs'),
      this.collection(token, `${path}/pulls/${number}/reviews`),
      this.request(`https://api.github.com${path}/commits/${pull.head.sha}/status`, token),
    ]);
    const latest = await this.pull(token, repository, number);
    check(
      latest.head.sha === pull.head.sha &&
        latest.base.sha === pull.base.sha &&
        latest.base.repositoryId === pull.base.repositoryId &&
        latest.base.ref === pull.base.ref,
      'github_conflict',
      'The pull request changed while loading; refresh it',
      409,
    );
    const combined = githubResponse(
      z.object({
        state: z.enum(['pending', 'success', 'failure']),
        total_count: z.number().int().nonnegative(),
      }),
      status,
    );
    return {
      pull: latest,
      files: files.map((value) => {
        const f = githubResponse(githubFileSchema, value);
        return {
          path: f.filename,
          previousPath: f.previous_filename ?? null,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
        };
      }),
      commits: commits.map(githubCommit),
      checks: checks.map((value) => {
        const c = githubResponse(githubCheckSchema, value);
        return { name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url };
      }),
      reviews: reviews.map((value) => {
        const r = githubResponse(githubReviewSchema, value);
        return {
          id: r.id,
          user: r.user?.login ?? '[deleted]',
          state: r.state,
          commitSha: r.commit_id,
          body: r.body,
          submittedAt: r.submitted_at ?? null,
        };
      }),
      commitStatus: combined.state,
      statusCount: combined.total_count,
    };
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
