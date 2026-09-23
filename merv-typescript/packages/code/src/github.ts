import {
  check,
  MervError,
  type Caller,
  type Sql,
  type State,
  type Scope,
  type Transaction,
  type DelegationSource,
} from '@merv/contracts';
import {
  githubRepositoryInputSchema,
  githubRevisionSchema,
  githubAutomationSchema,
  type GitHubAutomationInput,
  type CodeGitHub,
  type GitHubRepository,
  type GitHubRepositoryInput,
  type GitHubStatus,
} from '@merv/contracts';
import {
  GitHubClient,
  hashSecret,
  randomSecret,
  type GitHubConfig,
  type GitHubTokens,
} from './github-client.js';
import { parseCodeInput } from './input.js';

const schema = `
CREATE TABLE code_github (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  user_json TEXT,
  repository_json TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  credentials TEXT,
  refresh_id TEXT,
  refresh_until TEXT
);
CREATE TABLE code_github_flows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL,
  browser_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pending','ready','exchanging','complete')),
  payload TEXT NOT NULL
);
CREATE INDEX code_github_flows_project ON code_github_flows(project_id);
`;
interface Connection {
  project_id: string;
  revision: number;
  owner: string | null;
  user_json: string | null;
  repository_json: string | null;
  token_version: number;
  credentials: string | null;
  refresh_id: string | null;
  refresh_until: string | null;
  owner_source: string | null;
  automation: 'off' | 'read' | 'write';
  base_branch: string | null;
}
type Access = 'owner' | 'read' | 'write';
export interface GitHubBinding {
  revision: number;
  repository: GitHubRepository;
  baseBranch: string;
}
interface Flow {
  id: string;
  project_id: string;
  owner: string;
  revision: number;
  browser_hash: string;
  expires_at: string;
  phase: string;
  payload: string;
}
const owner = (caller: Caller) => JSON.stringify([caller.human!.issuer, caller.human!.subject]);
const timestamp = () => new Date().toISOString();
const empty = (projectId: string): Connection => ({
  project_id: projectId,
  revision: 0,
  owner: null,
  user_json: null,
  repository_json: null,
  token_version: 0,
  credentials: null,
  refresh_id: null,
  refresh_until: null,
  owner_source: null,
  automation: 'off',
  base_branch: null,
});

/** One optional connection per project. User tokens preserve GitHub's current user permissions. */
export class CodeGitHubService implements CodeGitHub {
  #client?: GitHubClient;
  #closed = false;
  #pending = new Set<Promise<unknown>>();
  constructor(
    private state: State,
    private scope: Scope,
    config?: GitHubConfig,
    fetcher?: typeof fetch,
  ) {
    if (config) this.#client = new GitHubClient(config, fetcher);
  }
  async initialize() {
    const automation = `ALTER TABLE code_github ADD COLUMN owner_source TEXT;
ALTER TABLE code_github ADD COLUMN automation TEXT NOT NULL DEFAULT 'off' CHECK (automation IN ('off','read','write'));
ALTER TABLE code_github ADD COLUMN base_branch TEXT;`;
    await this.state.migrate('code_github', [
      { version: 1, sql: schema },
      { version: 2, sql: automation },
    ]);
    await this.state.transaction((tx) =>
      tx.run('DELETE FROM code_github_flows WHERE expires_at<=?', timestamp()),
    );
  }
  private live() {
    check(!this.#closed, 'code_unavailable', 'Code is unavailable', 503);
  }
  private client() {
    this.live();
    check(this.#client, 'github_unconfigured', 'GitHub is not configured on this server', 503);
    return this.#client;
  }
  private run<Input, T>(input: Input, fn: (input: Input) => Promise<T>): Promise<T> {
    if (this.#closed)
      return Promise.reject(new MervError('code_unavailable', 'Code is unavailable', 503));
    const pending = fn(structuredClone(input));
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  async close() {
    this.#closed = true;
    this.#client?.close();
    await Promise.allSettled([...this.#pending]);
  }
  private async authorize(caller: Caller, tx: Transaction, admin = false) {
    this.live();
    const actor = await this.scope.require(caller, admin ? 'admin' : 'read', tx);
    this.live();
    if (admin)
      check(
        caller.human && !caller.key && !caller.session,
        'github_human_required',
        'Sign in with your Merv account to manage GitHub',
        403,
      );
    return actor;
  }
  private async row(sql: Sql, projectId: string) {
    return (
      (await sql.get<Connection>('SELECT * FROM code_github WHERE project_id=?', projectId)) ??
      empty(projectId)
    );
  }
  private async ensure(tx: Transaction, projectId: string) {
    await tx.run(
      'INSERT INTO code_github(project_id) VALUES (?) ON CONFLICT(project_id) DO NOTHING',
      projectId,
    );
  }
  private revision(row: Connection, expected: number) {
    check(
      row.revision === expected,
      'github_conflict',
      'The GitHub connection changed; reload before trying again',
      409,
    );
  }
  private async event(
    tx: Transaction,
    caller: Caller,
    type: string,
    data: Record<string, string | number | null> = {},
  ) {
    await this.state.appendEvent(tx, {
      projectId: caller.projectId,
      actorId: caller.actorId,
      subjectId: caller.projectId,
      type: `code.github.${type}`,
      data,
    });
  }
  private async describe(caller: Caller, tx: Transaction): Promise<GitHubStatus> {
    const actor = await this.authorize(caller, tx);
    const row = await this.row(tx, caller.projectId);
    const canManage = actor.role === 'operator' && !!caller.human && !caller.key && !caller.session;
    return {
      configured: !!this.#client,
      revision: row.revision,
      status: row.credentials
        ? 'connected'
        : row.refresh_id && row.refresh_until! > timestamp()
          ? 'refreshing'
          : row.owner
            ? 'needs_reconnect'
            : 'disconnected',
      user: row.user_json ? JSON.parse(row.user_json) : null,
      repository: row.repository_json ? JSON.parse(row.repository_json) : null,
      canManage,
      canBrowse: canManage && row.owner === owner(caller) && !!row.credentials,
      installUrl: canManage ? (this.#client?.installUrl ?? null) : null,
      automationConfigured: this.#client?.automationConfigured ?? false,
      automation: row.automation,
      baseBranch: row.base_branch,
    };
  }
  status(caller: Caller) {
    return this.run(caller, (caller) =>
      this.state.transaction(async (tx) => {
        const status = await this.describe(caller, tx);
        await tx.run('DELETE FROM code_github_flows WHERE expires_at<=?', timestamp());
        return status;
      }),
    );
  }
  begin(caller: Caller, value: { expectedRevision: number }) {
    return this.run(caller, async (caller) => {
      const input = parseCodeInput(githubRevisionSchema, value);
      const client = this.client(),
        id = randomSecret(),
        browser = randomSecret(),
        verifier = randomSecret();
      await this.state.transaction(async (tx) => {
        await this.authorize(caller, tx, true);
        await this.ensure(tx, caller.projectId);
        this.revision(await this.row(tx, caller.projectId), input.expectedRevision);
        await tx.run(
          'DELETE FROM code_github_flows WHERE expires_at<=? OR (project_id=? AND owner=?)',
          timestamp(),
          caller.projectId,
          owner(caller),
        );
        await tx.run(
          `INSERT INTO code_github_flows(id,project_id,owner,revision,browser_hash,expires_at,phase,payload)
          VALUES (?,?,?,?,?,?,'pending',?)`,
          id,
          caller.projectId,
          owner(caller),
          input.expectedRevision,
          hashSecret(browser),
          new Date(Date.now() + 600_000).toISOString(),
          client.seal({ verifier }, `flow:${id}`),
        );
      });
      return {
        url: client.authorizationUrl(id, verifier),
        cookie: `merv_github_flow=${id}.${browser}; HttpOnly; SameSite=Lax; Path=/code/github; Max-Age=600${client.origin.startsWith('https:') ? '; Secure' : ''}`,
      };
    });
  }
  private async flow(tx: Transaction, cookie: string, state?: string) {
    const match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
    check(
      match && (state === undefined || state === match[1]),
      'github_flow',
      'GitHub connection expired or belongs to another browser; start again',
      409,
    );
    const flow = await tx.get<Flow>('SELECT * FROM code_github_flows WHERE id=?', match[1]);
    check(
      flow && flow.expires_at > timestamp() && flow.browser_hash === hashSecret(match[2]),
      'github_flow',
      'GitHub connection expired or belongs to another browser; start again',
      409,
    );
    return flow;
  }
  callback(input: { state: string; code?: string; error?: string; cookie: string }) {
    return this.run(input, async (input) => {
      const client = this.client();
      await this.state.transaction(async (tx) => {
        this.live();
        const flow = await this.flow(tx, input.cookie, input.state);
        check(flow.phase === 'pending', 'github_flow', 'GitHub callback was already used', 409);
        if (input.error) {
          await tx.run('DELETE FROM code_github_flows WHERE id=?', flow.id);
          return;
        }
        check(
          input.code && input.code.length <= 2048,
          'github_denied',
          'GitHub authorization was not completed',
          400,
        );
        const payload = client.open<{ verifier: string }>(flow.payload, `flow:${flow.id}`);
        const result = await tx.run(
          "UPDATE code_github_flows SET phase='ready',payload=? WHERE id=? AND phase='pending'",
          client.seal({ ...payload, code: input.code }, `flow:${flow.id}`),
          flow.id,
        );
        check(result.changes === 1, 'github_flow', 'GitHub callback was already used', 409);
      });
      // Back to the page that finishes the flow: the connection lives under Settings.
      return `${client.origin}/ui/settings/integrations?github=${input.error ? 'denied' : 'complete'}`;
    });
  }
  finish(caller: Caller, cookie: string) {
    return this.run(caller, async (caller) => {
      const client = this.client();
      const flow = await this.state.transaction(async (tx) => {
        await this.authorize(caller, tx, true);
        const f = await this.flow(tx, cookie);
        check(
          f.project_id === caller.projectId && f.owner === owner(caller),
          'github_flow_owner',
          'Return to the Merv account and project that started this connection',
          403,
        );
        const current = await this.row(tx, caller.projectId);
        if (f.phase === 'complete') {
          this.revision(current, f.revision + 1);
          return null;
        }
        this.revision(current, f.revision);
        check(
          f.phase === 'ready',
          'github_flow',
          'GitHub connection is already being completed or must be restarted',
          409,
        );
        const result = await tx.run(
          "UPDATE code_github_flows SET phase='exchanging',payload='' WHERE id=? AND phase='ready'",
          f.id,
        );
        check(
          result.changes === 1,
          'github_flow',
          'GitHub authorization is already being completed',
          409,
        );
        return f;
      });
      if (!flow) return this.state.transaction((tx) => this.describe(caller, tx));
      const payload = client.open<{ verifier: string; code: string }>(
        flow.payload,
        `flow:${flow.id}`,
      );
      const tokens = await client.exchange(payload.code, payload.verifier);
      try {
        const user = await client.user(tokens.accessToken);
        return await this.state.transaction(async (tx) => {
          await this.authorize(caller, tx, true);
          const f = await this.flow(tx, cookie);
          check(f.phase === 'exchanging', 'github_flow', 'GitHub connection was replaced', 409);
          const current = await this.row(tx, caller.projectId);
          this.revision(current, flow.revision);
          const result = await tx.run(
            `UPDATE code_github SET revision=revision+1,owner=?,user_json=?,repository_json=NULL,owner_source=NULL,automation='off',base_branch=NULL,
          token_version=token_version+1,credentials=?,refresh_id=NULL,refresh_until=NULL WHERE project_id=? AND revision=?`,
            owner(caller),
            JSON.stringify(user),
            client.seal(tokens, `tokens:${caller.projectId}:${current.token_version + 1}`),
            caller.projectId,
            flow.revision,
          );
          check(
            result.changes === 1,
            'github_conflict',
            'GitHub connection changed during authorization',
            409,
          );
          await tx.run("UPDATE code_github_flows SET phase='complete' WHERE id=?", flow.id);
          await this.event(tx, caller, 'connected', { githubUserId: user.id });
          return this.describe(caller, tx);
        });
      } catch (error) {
        await client.revoke(tokens.accessToken);
        throw error;
      }
    });
  }
  private async authority(caller: Caller, tx: Transaction, row: Connection, access: Access) {
    await this.authorize(caller, tx, access === 'owner');
    if (access === 'owner')
      check(
        row.owner === owner(caller),
        'github_owner',
        'Connect your GitHub account to manage repositories for this project',
        403,
      );
    else {
      check(
        row.owner_source &&
          row.automation !== 'off' &&
          (access === 'read' || row.automation === 'write'),
        'github_automation_disabled',
        'The repository owner must enable the required GitHub automation',
        403,
      );
      const source = JSON.parse(row.owner_source) as DelegationSource;
      check(
        source.kind === 'human' &&
          source.projectId === caller.projectId &&
          row.owner === JSON.stringify([source.issuer, source.subject]),
        'github_owner',
        'GitHub owner binding is invalid',
        403,
      );
      await this.scope.requireDelegation(source, 'admin', tx);
    }
  }
  private async connection(caller: Caller, tx: Transaction, access: Access = 'owner') {
    if (access === 'write') await this.scope.require(caller, 'write', tx);
    const row = await this.row(tx, caller.projectId);
    await this.authority(caller, tx, row, access);
    if (row.refresh_id && row.refresh_until! > timestamp())
      throw new MervError(
        'github_busy',
        'GitHub credentials are refreshing; try again shortly',
        409,
      );
    check(row.credentials, 'github_reconnect', 'Reconnect GitHub to restore access', 409);
    return row;
  }
  private async token(caller: Caller, access: Access) {
    const client = this.client();
    const claim = randomSecret();
    const pending = await this.state.transaction(async (tx) => {
      const row = await this.connection(caller, tx, access);
      const tokens = client.open<GitHubTokens>(
        row.credentials!,
        `tokens:${caller.projectId}:${row.token_version}`,
      );
      if (tokens.expiresAt > Date.now() + 60_000) return { row, tokens, refresh: false };
      check(
        tokens.refreshExpiresAt > Date.now(),
        'github_reconnect',
        'Reconnect GitHub to restore access',
        409,
      );
      // Claim before contacting GitHub: a single-use refresh token must never be exchanged twice.
      // Removing the old ciphertext also makes a process crash require reconnection, not replay.
      const result = await tx.run(
        `UPDATE code_github SET credentials=NULL,refresh_id=?,refresh_until=?
        WHERE project_id=? AND token_version=? AND credentials=? AND refresh_id IS NULL`,
        claim,
        new Date(Date.now() + 30_000).toISOString(),
        caller.projectId,
        row.token_version,
        row.credentials,
      );
      check(
        result.changes === 1,
        'github_busy',
        'GitHub credentials are refreshing; try again shortly',
        409,
      );
      return { row, tokens, refresh: true };
    });
    if (!pending.refresh) return { token: pending.tokens.accessToken, row: pending.row };
    let tokens: GitHubTokens | undefined;
    try {
      tokens = await client.refresh(pending.tokens.refreshToken);
      const refreshed = tokens;
      return await this.state.transaction(async (tx) => {
        const row = await this.row(tx, caller.projectId);
        check(
          row.refresh_id === claim &&
            row.owner === pending.row.owner &&
            row.revision === pending.row.revision,
          'github_conflict',
          'GitHub connection changed while refreshing',
          409,
        );
        await this.authority(caller, tx, row, access);
        const result = await tx.run(
          `UPDATE code_github SET credentials=?,token_version=token_version+1,refresh_id=NULL,refresh_until=NULL
          WHERE project_id=? AND refresh_id=? AND revision=?`,
          client.seal(refreshed, `tokens:${caller.projectId}:${row.token_version + 1}`),
          caller.projectId,
          claim,
          row.revision,
        );
        check(
          result.changes === 1,
          'github_conflict',
          'GitHub connection changed while refreshing',
          409,
        );
        return { token: refreshed.accessToken, row: await this.row(tx, caller.projectId) };
      });
    } catch (error) {
      if (tokens) await client.revoke(tokens.accessToken);
      await this.state
        .transaction(async (tx) => {
          await tx.run(
            'UPDATE code_github SET refresh_id=NULL,refresh_until=NULL WHERE project_id=? AND refresh_id=?',
            caller.projectId,
            claim,
          );
        })
        .catch(() => {});
      throw error;
    }
  }
  private async withToken<T>(
    caller: Caller,
    fn: (token: string, row: Connection, authorize: () => Promise<void>) => Promise<T>,
    access: Access = 'owner',
    authorizeRequest?: (tx: Transaction) => Promise<unknown>,
  ) {
    const { token, row } = await this.token(caller, access);
    const authorize = () =>
      this.state.transaction(async (tx) => {
        await this.unchanged(caller, tx, row, access);
        await authorizeRequest?.(tx);
      });
    try {
      return await this.client().authorized(authorize, async () => {
        const result = await fn(token, row, authorize);
        await authorize();
        return result;
      });
    } catch (error) {
      if (error instanceof MervError && error.code === 'github_reconnect')
        await this.state.transaction(async (tx) => {
          await tx.run(
            'UPDATE code_github SET credentials=NULL WHERE project_id=? AND token_version=? AND revision=?',
            caller.projectId,
            row.token_version,
            row.revision,
          );
        });
      throw error;
    }
  }
  private async unchanged(
    caller: Caller,
    tx: Transaction,
    previous: Connection,
    access: Access = 'owner',
  ) {
    const row = await this.connection(caller, tx, access);
    this.revision(row, previous.revision);
    check(
      row.token_version === previous.token_version,
      'github_conflict',
      'GitHub credentials changed; retry the request',
      409,
    );
  }
  repositories(caller: Caller) {
    return this.run(caller, (caller) =>
      this.withToken(caller, (token) => this.client().repositories(token)),
    );
  }
  private repository(row: Connection): GitHubRepository {
    check(row.repository_json, 'github_repository_required', 'Link a GitHub repository first', 409);
    return JSON.parse(row.repository_json) as GitHubRepository;
  }
  /**
   * Where the server publishes a project's own work, with no caller and no human token: the
   * owner's link and the write automation they turned on are the whole authorisation, and
   * unlinking or turning it off is the off switch. A refusal is a state, not an error: work
   * never waits for publication, so the mirror simply says why it is not running.
   */
  async mirrorTarget(projectId: string): Promise<GitHubRepository | { blocked: string }> {
    if (this.#closed || !this.#client) return { blocked: 'github_unconfigured' };
    if (!this.#client.automationConfigured) return { blocked: 'github_automation_unconfigured' };
    const row = await this.state.read(async (sql) => await this.row(sql, projectId));
    if (!row.repository_json) return { blocked: 'github_repository_required' };
    if (row.automation !== 'write') return { blocked: 'github_automation_disabled' };
    return JSON.parse(row.repository_json) as GitHubRepository;
  }
  /**
   * One installation token for one repository, for the length of one operation. It is minted
   * per operation and given up again however that operation ends, and it never leaves the
   * server: no runner is ever lent write access to the linked repository.
   */
  async mirrorToken<T>(
    repository: GitHubRepository,
    use: (token: string) => Promise<T>,
  ): Promise<T> {
    return await this.run(repository, async (repository) => {
      const client = this.client();
      const grant = await client.installationToken(repository, true);
      try {
        return await use(grant.token);
      } finally {
        await client.revokeInstallationToken(grant.token).catch(() => {});
      }
    });
  }
  async assertBinding(
    caller: Caller,
    binding: GitHubBinding,
    tx: Transaction,
    access: 'read' | 'write',
  ) {
    ({ caller, binding } = structuredClone({ caller, binding }));
    const row = await this.connection(caller, tx, access);
    this.revision(row, binding.revision);
    check(
      this.repository(row).id === binding.repository.id && row.base_branch === binding.baseBranch,
      'github_conflict',
      'GitHub repository binding changed',
      409,
    );
  }
  configureAutomation(caller: Caller, value: GitHubAutomationInput) {
    return this.run(caller, async (caller) => {
      const input = parseCodeInput(githubAutomationSchema, value);
      if (input.mode !== 'off') {
        check(
          this.client().automationConfigured,
          'github_automation_unconfigured',
          'GitHub repository automation is not configured',
          503,
        );
        await this.withToken(caller, async (token, row) => {
          this.revision(row, input.expectedRevision);
          const repository = this.repository(row);
          await this.client().repositoryPermission(token, repository, input.mode === 'write');
          await this.client().branch(token, repository.fullName, input.baseBranch!);
        });
      }
      return this.state.transaction(async (tx) => {
        await this.authorize(caller, tx, true);
        const row = await this.row(tx, caller.projectId);
        this.revision(row, input.expectedRevision);
        // Any project operator may disable automation; only the connection owner may enable it.
        if (input.mode !== 'off') await this.connection(caller, tx);
        await this.ensure(tx, caller.projectId);
        const source =
          input.mode === 'off'
            ? null
            : JSON.stringify(await this.scope.delegationSource(caller, tx));
        await tx.run(
          'UPDATE code_github SET automation=?,base_branch=?,owner_source=?,revision=revision+1 WHERE project_id=?',
          input.mode,
          input.mode === 'off' ? null : input.baseBranch,
          source,
          caller.projectId,
        );
        await this.event(tx, caller, 'automation_changed', {
          mode: input.mode,
          baseBranch: input.baseBranch,
        });
        return this.describe(caller, tx);
      });
    });
  }
  private repositoryRead<T>(
    caller: Caller,
    fn: (client: GitHubClient, token: string, repo: GitHubRepository) => Promise<T>,
  ) {
    return this.run(caller, (caller) =>
      this.withToken(caller, (token, row) => fn(this.client(), token, this.repository(row))),
    );
  }
  branches(caller: Caller) {
    return this.repositoryRead(caller, (client, token, repo) =>
      client.branches(token, repo.fullName),
    );
  }
  pulls(caller: Caller) {
    return this.repositoryRead(caller, (client, token, repo) => client.pulls(token, repo.fullName));
  }
  pullDetails(caller: Caller, number: number) {
    return this.repositoryRead(caller, (client, token, repo) =>
      client.pullDetails(token, repo.fullName, number),
    );
  }
  /** Internal Code capability. The caller and original human owner's live authority are both required. */
  automation<T>(
    caller: Caller,
    access: 'read' | 'write',
    binding: GitHubBinding | undefined,
    fn: (client: GitHubClient, token: string, binding: GitHubBinding) => Promise<T>,
    authorizeRequest?: (tx: Transaction) => Promise<unknown>,
  ) {
    if (binding) binding = structuredClone(binding);
    return this.run(caller, (caller) =>
      this.withToken(
        caller,
        async (token, row, authorize) => {
          if (binding) this.revision(row, binding.revision);
          const repository = this.repository(row);
          check(row.base_branch, 'github_automation_disabled', 'Choose a GitHub base branch', 409);
          const current = { revision: row.revision, repository, baseBranch: row.base_branch };
          if (binding)
            check(
              binding.repository.id === repository.id &&
                binding.repository.fullName === repository.fullName &&
                binding.repository.installationId === repository.installationId &&
                binding.baseBranch === current.baseBranch,
              'github_conflict',
              'GitHub repository binding changed',
              409,
            );
          const client = this.client();
          await client.repositoryPermission(token, repository, access === 'write');
          await authorize();
          return fn(client, token, current);
        },
        access,
        authorizeRequest,
      ),
    );
  }
  async publicationBinding(caller: Caller, tx: Transaction) {
    const row = await this.connection(caller, tx, 'write');
    check(
      row.base_branch,
      'github_automation_disabled',
      'Choose main and enable write automation',
      409,
    );
    return {
      revision: row.revision,
      repository: this.repository(row),
      baseBranch: row.base_branch,
    };
  }
  publicationAutomation<T>(
    caller: Caller,
    access: 'read' | 'write',
    binding: GitHubBinding,
    fn: (client: GitHubClient, token: string, binding: GitHubBinding) => Promise<T>,
    authorize?: (tx: Transaction) => Promise<unknown>,
  ) {
    return this.automation(
      caller,
      access,
      binding,
      async (client, _token, current) => {
        const grant = await client.installationToken(current.repository, {
          contents: access,
          pull_requests: access,
          statuses: access,
          checks: 'read',
        });
        try {
          // Everything fn does carries the installation token, never the human's OAuth token.
          return await client.installed(() => fn(client, grant.token, current));
        } finally {
          await client.revokeInstallationToken(grant.token).catch(() => {});
        }
      },
      authorize,
    );
  }
  link(caller: Caller, value: GitHubRepositoryInput) {
    return this.run(caller, async (caller) => {
      const input = parseCodeInput(githubRepositoryInputSchema, value);
      let repository: GitHubRepository | null = null;
      let observed: Connection | undefined;
      if (input.repositoryId !== null) {
        await this.withToken(caller, async (token, row) => {
          this.revision(row, input.expectedRevision);
          repository =
            (await this.client().installationRepositories(token, input.installationId!)).find(
              (r) => r.id === input.repositoryId,
            ) ?? null;
          check(
            repository,
            'github_repository_forbidden',
            'This repository is not accessible to your GitHub account and this App',
            403,
          );
          observed = row;
        });
      }
      return this.state.transaction(async (tx) => {
        await this.authorize(caller, tx, true);
        await this.ensure(tx, caller.projectId);
        this.revision(await this.row(tx, caller.projectId), input.expectedRevision);
        if (observed) await this.unchanged(caller, tx, observed);
        const result = await tx.run(
          "UPDATE code_github SET repository_json=?,revision=revision+1,owner_source=NULL,automation='off',base_branch=NULL WHERE project_id=? AND revision=?",
          repository ? JSON.stringify(repository) : null,
          caller.projectId,
          input.expectedRevision,
        );
        check(
          result.changes === 1,
          'github_conflict',
          'GitHub repository changed; reload and try again',
          409,
        );
        await this.event(tx, caller, repository ? 'repository_linked' : 'repository_unlinked', {
          repositoryId: input.repositoryId,
        });
        return this.describe(caller, tx);
      });
    });
  }
  disconnect(caller: Caller, value: { expectedRevision: number }) {
    return this.run(caller, (caller) => {
      const input = parseCodeInput(githubRevisionSchema, value);
      return this.state.transaction(async (tx) => {
        await this.authorize(caller, tx, true);
        await this.ensure(tx, caller.projectId);
        this.revision(await this.row(tx, caller.projectId), input.expectedRevision);
        const result = await tx.run(
          `UPDATE code_github SET owner=NULL,user_json=NULL,credentials=NULL,refresh_id=NULL,refresh_until=NULL,owner_source=NULL,automation='off',base_branch=NULL,
        token_version=token_version+1,revision=revision+1 WHERE project_id=? AND revision=?`,
          caller.projectId,
          input.expectedRevision,
        );
        check(
          result.changes === 1,
          'github_conflict',
          'GitHub connection changed; reload and try again',
          409,
        );
        await tx.run('DELETE FROM code_github_flows WHERE project_id=?', caller.projectId);
        await this.event(tx, caller, 'disconnected');
        return this.describe(caller, tx);
      });
    });
  }
}
