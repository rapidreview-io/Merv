import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createService, type Caller, type State } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { CodeGitHubService } from '../packages/code/src/github.js';
import type { GitHubConfig } from '../packages/code/src/github-client.js';
import type { PostgresState } from '@merv/state';

export const baseOid = 'a'.repeat(40),
  headOid = 'b'.repeat(40),
  treeOid = 'c'.repeat(40),
  mergeOid = 'd'.repeat(40);
export const repository = {
  id: 101,
  installationId: 17,
  fullName: 'fixture/private',
  url: 'https://github.com/fixture/private',
  defaultBranch: 'main',
  private: true,
};
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
export const config: GitHubConfig = {
  origin: 'http://127.0.0.1:4317',
  appSlug: 'fixture',
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  encryptionKey: 'bc'.repeat(32),
  privateKey: Buffer.from(key).toString('base64'),
};
export async function githubFixture(t: TestContext, storage?: State, existingCaller?: Caller) {
  // Imported only when needed: scripts/ui-demo-git.ts passes its own state and runs outside tests.
  const state = storage ?? (await (await import('./fixtures/state.js')).openState(':memory:'));
  const scope = await createService(new ProjectScope(state));
  const identity = {
    issuer: 'https://fixture.test/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const principal = await scope.acceptVerifiedIdentity(identity);
  const project = await scope.createProject(principal, {
    name: 'GitHub fixture',
    requestId: 'project',
  });
  const other = await scope.acceptVerifiedIdentity({ ...identity, subject: 'reviewer' });
  await scope.addMember(principal, project.id, { subject: 'reviewer', role: 'operator' });
  const caller = existingCaller ?? (await scope.caller(principal, project.id)),
    reviewer = await scope.caller(other, project.id);
  const branches = new Map([['main', baseOid]]);
  const pulls: any[] = [];
  const calls: { path: string; method: string; body: any; authorization: string }[] = [];
  const control = {
    push: true,
    hidden: false,
    loseCreateReply: false,
    loseMergeReply: false,
    badTokenScope: false,
    checks: [] as any[],
    expiresIn: 3600,
    mergeSha: mergeOid,
    rulesIncomplete: false,
    strict: true,
    before: undefined as ((path: string) => Promise<void>) | undefined,
    /** Paths GitHub answers with 403, as it does for a resource the App may not read. */
    refuse: undefined as ((path: string) => boolean) | undefined,
  };
  const statuses = new Map<string, unknown[]>();
  const comments: { body: string }[] = [];
  const repo = () => ({
    id: repository.id,
    full_name: repository.fullName,
    private: true,
    default_branch: 'main',
    permissions: { pull: true, push: control.push },
  });
  const commit = (sha: string) => ({
    sha,
    html_url: `https://github.com/fixture/private/commit/${sha}`,
    commit: { message: 'fixture', tree: { sha: treeOid } },
    parents: [{ sha: baseOid }],
  });
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url)),
      path = decodeURIComponent(u.pathname),
      method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      method,
      body,
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    });
    assert.equal(init?.redirect, 'error');
    await control.before?.(path);
    if (control.refuse?.(path))
      return new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
    let result: unknown;
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (path === '/login/oauth/access_token')
      result = {
        access_token: 'synthetic-oauth-token',
        refresh_token: 'synthetic-refresh',
        expires_in: control.expiresIn,
        refresh_token_expires_in: 86400,
      };
    else if (path === '/user') result = { id: 42, login: 'fixture' };
    else if (path === '/user/installations') result = { installations: [{ id: 17 }] };
    else if (path === '/user/installations/17/repositories')
      result = { repositories: control.hidden ? [] : [repo()] };
    else if (path === '/app/installations/17/access_tokens')
      result = {
        token: 'synthetic-installation-secret',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: body.permissions,
        repositories: [{ id: control.badTokenScope ? 999 : 101 }],
      };
    else if (path === '/apps/fixture') result = { id: 777 };
    else if (path.endsWith('/rules/branches/main'))
      result = [
        { type: 'pull_request' },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: control.strict,
            required_status_checks: [
              { context: 'merv/consolidation-approved', integration_id: 777 },
            ],
          },
        },
      ];
    else if (path.endsWith('/rulesets'))
      result = [{ id: 1, source_type: control.rulesIncomplete ? 'Organization' : 'Repository' }];
    else if (path.endsWith('/rulesets/1')) result = { bypass_actors: [] };
    else if (path.includes('/issues/') && path.endsWith('/comments')) {
      if (method === 'POST') comments.push(body);
      result = comments;
    } else if (path.includes('/statuses/')) {
      const sha = path.split('/').at(-1)!;
      const status = { ...body, sha, creator: { login: 'fixture[bot]' } };
      statuses.set(sha, [status]);
      result = status;
    } else if (path === '/repos/fixture/private') result = repo();
    else if (path.startsWith('/repos/fixture/private/branches/')) {
      const name = path.slice('/repos/fixture/private/branches/'.length),
        sha = branches.get(name);
      if (!sha) return new Response('{}', { status: 404 });
      result = { name, commit: { sha }, protected: name === 'main' };
    } else if (path === '/repos/fixture/private/branches')
      result = [...branches].map(([name, sha]) => ({ name, commit: { sha }, protected: false }));
    else if (path === '/repos/fixture/private/git/refs') {
      const name = body.ref.slice('refs/heads/'.length);
      if (branches.has(name)) return new Response('{}', { status: 422 });
      branches.set(name, body.sha);
      result = {};
    } else if (path === '/repos/fixture/private/pulls') {
      if (method === 'POST') {
        assert.equal(body.maintainer_can_modify, false);
        const pull = {
          id: pulls.length + 1,
          number: pulls.length + 1,
          node_id: `pull${pulls.length + 1}`,
          html_url: `https://github.com/fixture/private/pull/${pulls.length + 1}`,
          title: body.title,
          body: body.body,
          state: 'open',
          draft: body.draft,
          head: { ref: body.head, sha: branches.get(body.head), repo: { id: 101 } },
          base: { ref: body.base, sha: branches.get(body.base), repo: { id: 101 } },
          merged: false,
          merge_commit_sha: null,
          mergeable: true,
          mergeable_state: 'clean',
          updated_at: new Date().toISOString(),
        };
        pulls.push(pull);
        result = pull;
        if (control.loseCreateReply) {
          control.loseCreateReply = false;
          throw new Error('synthetic lost reply');
        }
      } else
        result = pulls.filter(
          (p) =>
            !u.searchParams.get('head') || `fixture:${p.head.ref}` === u.searchParams.get('head'),
        );
    } else if (path.startsWith('/repos/fixture/private/pulls/')) {
      const [, number, suffix] = /\/pulls\/(\d+)(?:\/(.*))?$/.exec(path)!;
      const pull = pulls.find((p) => p.number === Number(number));
      if (!pull) return new Response('{}', { status: 404 });
      if (suffix === 'files' || suffix === 'reviews') result = [];
      else if (suffix === 'commits') result = [commit(pull.head.sha)];
      else if (suffix === 'merge') {
        assert.equal(body.sha, pull.head.sha);
        assert.equal(body.merge_method, 'merge');
        pull.merged = true;
        pull.state = 'closed';
        pull.merge_commit_sha = control.mergeSha;
        branches.set(pull.base.ref, control.mergeSha);
        result = { merged: true, sha: control.mergeSha };
        if (control.loseMergeReply) {
          control.loseMergeReply = false;
          throw new Error('synthetic lost reply');
        }
      } else {
        if (method === 'PATCH') Object.assign(pull, body);
        if (!pull.merged) pull.base.sha = branches.get(pull.base.ref);
        result = pull;
      }
    } else if (path.includes('/commits/')) {
      if (path.endsWith('/statuses')) result = statuses.get(path.split('/').at(-2)!) ?? [];
      else if (path.endsWith('/check-runs')) result = { check_runs: control.checks };
      else if (path.endsWith('/status'))
        result = {
          state: statuses.has(path.split('/').at(-2)!) ? 'success' : 'pending',
          total_count: statuses.has(path.split('/').at(-2)!) ? 1 : 0,
        };
      else result = commit(path.split('/').at(-1)!);
    } else if (path === '/graphql') {
      const pull = pulls.find((p) => p.node_id === body.variables.id)!;
      pull.draft = false;
      result = {
        data: {
          markPullRequestReadyForReview: { pullRequest: { id: pull.node_id, isDraft: false } },
        },
      };
    } else return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const github = await createService(new CodeGitHubService(state, scope, config, fetcher));
  t.after(async () => {
    await github.close();
    if (!storage) await (state as PostgresState).close();
  });
  const begin = await github.begin(caller, { expectedRevision: 0 });
  const cookie = begin.cookie.split(';')[0].slice('merv_github_flow='.length);
  await github.callback({
    state: new URL(begin.url).searchParams.get('state')!,
    code: 'fixture-code',
    cookie,
  });
  await github.finish(caller, cookie);
  await github.link(caller, { expectedRevision: 1, installationId: 17, repositoryId: 101 });
  const enable = async (mode: 'read' | 'write' = 'write') =>
    github.configureAutomation(caller, {
      expectedRevision: (await github.status(caller)).revision,
      mode,
      baseBranch: 'main',
    });
  return {
    state,
    scope,
    principal,
    caller,
    reviewer,
    github,
    fetcher,
    control,
    pulls,
    statuses,
    comments,
    branches,
    calls,
    enable,
    project,
  };
}
