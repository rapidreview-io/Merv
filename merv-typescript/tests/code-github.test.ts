import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { request as httpRequest } from 'node:http';
import { PostgresState } from '@merv/state';
import { createService, type State, type Caller } from '@merv/contracts';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { CodeGitHubService } from '../packages/code/src/github.js';
import {
  GitHubClient,
  githubConfig,
  type GitHubConfig,
} from '../packages/code/src/github-client.js';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';

const config: GitHubConfig = {
  origin: 'http://127.0.0.1:4317',
  appSlug: 'merv-test',
  clientId: 'Iv1.synthetic',
  clientSecret: 'synthetic-client-secret',
  encryptionKey: 'bc'.repeat(32),
};
const user = { id: 42, login: 'test-owner' };
const privateRepo = {
  id: 101,
  full_name: 'test-owner/private-research',
  private: true,
  default_branch: 'main',
};
const issuer = 'https://identity.example/auth/v1';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fakeGitHub() {
  const calls: { url: string; token?: string; body?: Record<string, string> }[] = [];
  const control = {
    expiresIn: 3600,
    failRefresh: false,
    revoked: false,
    hidden: false,
    pauseRefresh: undefined as ReturnType<typeof deferred> | undefined,
    refreshEntered: deferred(),
    pauseList: undefined as ReturnType<typeof deferred> | undefined,
    listEntered: deferred(),
    pauseExchange: undefined as ReturnType<typeof deferred> | undefined,
    exchangeEntered: deferred(),
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(
      url.startsWith('https://api.github.com/') ||
        url === 'https://github.com/login/oauth/access_token',
    );
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, token: headers.get('authorization') ?? undefined, body });
    if (init?.method === 'DELETE') {
      assert.ok(url.endsWith('/applications/Iv1.synthetic/token'));
      assert.ok(headers.get('authorization')?.startsWith('Basic '));
      return new Response(null, { status: 204 });
    }
    let result: unknown;
    if (url.includes('/login/oauth/access_token')) {
      assert.equal(body.client_secret, config.clientSecret);
      if (body.grant_type === 'refresh_token') {
        control.refreshEntered.resolve();
        await control.pauseRefresh?.promise;
        if (control.failRefresh) throw new Error('synthetic secret that must not escape');
      } else {
        assert.equal(body.redirect_uri, `${config.origin}/code/github/callback`);
        assert.equal(body.code_verifier.length, 43);
        control.exchangeEntered.resolve();
        await control.pauseExchange?.promise;
      }
      result = {
        access_token: 'ghu_synthetic-private-token',
        refresh_token: 'ghr_synthetic-refresh-token',
        expires_in: body.grant_type ? 3600 : control.expiresIn,
        refresh_token_expires_in: 3600 * 24 * 30,
      };
    } else if (control.revoked) return new Response('{}', { status: 401 });
    else if (url.endsWith('/user')) result = user;
    else if (url.includes('/user/installations/17/repositories')) {
      control.listEntered.resolve();
      await control.pauseList?.promise;
      result = { repositories: control.hidden ? [] : [privateRepo] };
    } else if (url.includes('/user/installations?')) result = { installations: [{ id: 17 }] };
    else return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetcher, calls, control };
}
async function foundation(t: TestContext, storage?: State) {
  const state = storage ?? new SqliteState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const principal = await scope.acceptVerifiedIdentity({
    issuer,
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const other = await scope.acceptVerifiedIdentity({
    issuer,
    subject: 'other',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const project = await scope.createProject(principal, {
    name: 'GitHub project',
    requestId: 'one',
  });
  const second = await scope.createProject(principal, { name: 'Second project', requestId: 'two' });
  await scope.addMember(principal, project.id, { subject: 'other', role: 'operator' });
  const caller = await scope.caller(principal, project.id);
  const otherCaller = await scope.caller(other, project.id);
  const gh = fakeGitHub();
  const service = await createService(new CodeGitHubService(state, scope, config, gh.fetcher));
  t.after(() => service.close());
  if (!storage)
    t.after(async () => {
      await service.close();
      await (state as SqliteState).close();
    });
  async function ready(who = caller) {
    const begin = await service.begin(who, {
      expectedRevision: (await service.status(who)).revision,
    });
    const cookie = begin.cookie.split(';')[0].slice('merv_github_flow='.length);
    const flow = new URL(begin.url).searchParams.get('state')!;
    await service.callback({ state: flow, code: 'synthetic-code', cookie });
    return { cookie, flow, begin };
  }
  async function connect(who = caller) {
    const flow = await ready(who);
    await service.finish(who, flow.cookie);
    return flow;
  }
  return {
    state,
    scope,
    principal,
    other,
    project,
    second,
    caller,
    otherCaller,
    service,
    gh,
    ready,
    connect,
  };
}

test('GitHub lives in Code: encrypted connection, user-authorized selection, project reference, and disconnect', async (t) => {
  const f = await foundation(t);
  const startingCaller = structuredClone(f.caller);
  const starting = f.service.begin(startingCaller, { expectedRevision: 0 });
  startingCaller.actorId = 'missing';
  const begin = await starting;
  const cookie = begin.cookie.split(';')[0].slice('merv_github_flow='.length);
  const flow = new URL(begin.url).searchParams.get('state')!;
  const callback = { state: flow, code: 'synthetic-code', cookie };
  const returning = f.service.callback(callback);
  callback.cookie = 'changed';
  callback.code = 'changed';
  await returning;
  assert.match(begin.cookie, /HttpOnly; SameSite=Lax; Path=\/code\/github; Max-Age=600/);
  assert.equal(f.gh.calls.length, 0, 'public callback does not exchange credentials');
  assert.equal((await f.service.status(f.caller)).status, 'disconnected');
  const finishingCaller = structuredClone(f.caller);
  const finishing = f.service.finish(finishingCaller, cookie);
  finishingCaller.actorId = 'missing';
  const connected = await finishing;
  assert.equal(connected.revision, 1);
  assert.deepEqual(connected.user, user);
  assert.deepEqual(
    await f.service.finish(f.caller, cookie),
    connected,
    'uncertain finish can be retried without re-exchanging code',
  );
  assert.equal(f.gh.calls.filter((c) => c.body?.code).length, 1);
  await assert.rejects(f.service.callback({ state: flow, code: 'replayed', cookie }), {
    code: 'github_flow',
  });
  const repos = await f.service.repositories(f.caller);
  assert.deepEqual(repos, [
    {
      id: 101,
      installationId: 17,
      fullName: privateRepo.full_name,
      url: `https://github.com/${privateRepo.full_name}`,
      defaultBranch: 'main',
      private: true,
    },
  ]);
  assert.ok(
    f.gh.calls.every((c) => !c.url.includes('/installation/repositories')),
    'never enumerate installation-wide repositories',
  );
  await assert.rejects(
    f.service.link(f.caller, { expectedRevision: 1, installationId: 17, repositoryId: 999 }),
    { code: 'github_repository_forbidden' },
  );
  const linkingCaller = structuredClone(f.caller);
  const linking = f.service.link(linkingCaller, {
    expectedRevision: 1,
    installationId: 17,
    repositoryId: 101,
  });
  linkingCaller.actorId = 'missing';
  const linked = await linking;
  assert.equal(linked.revision, 2);
  assert.equal(linked.repository?.id, 101);
  const data = await f.state.read(async (sql) =>
    JSON.stringify([
      await sql.all('SELECT * FROM code_github'),
      await sql.all('SELECT * FROM code_github_flows'),
    ]),
  );
  for (const value of [
    'ghu_synthetic-private-token',
    'ghr_synthetic-refresh-token',
    'synthetic-code',
    cookie,
  ])
    assert.ok(!data.includes(value));
  const events = await f.state.events(f.project.id);
  assert.ok(events.some((e) => e.type === 'code.github.repository_linked'));
  assert.ok(!JSON.stringify(events).includes('ghu_'));
  const disconnectingCaller = structuredClone(f.caller),
    revision = { expectedRevision: 2 };
  const disconnecting = f.service.disconnect(disconnectingCaller, revision);
  disconnectingCaller.actorId = 'missing';
  revision.expectedRevision = 999;
  const detached = await disconnecting;
  assert.equal(detached.status, 'disconnected');
  assert.deepEqual(
    detached.repository,
    linked.repository,
    'disconnect retains reference and receipts',
  );
  const unlinked = await f.service.link(f.caller, {
    expectedRevision: 3,
    installationId: null,
    repositoryId: null,
  });
  assert.equal(unlinked.repository, null);
});

test('flow is bound to browser, initiating human and project, with expiry and revision fences', async (t) => {
  const f = await foundation(t);
  const ready = await f.ready();
  await assert.rejects(
    f.service.finish(
      f.caller,
      ready.cookie.slice(0, -1) + (ready.cookie.endsWith('x') ? 'y' : 'x'),
    ),
    { code: 'github_flow' },
  );
  await assert.rejects(f.service.finish(f.otherCaller, ready.cookie), {
    code: 'github_flow_owner',
  });
  await assert.rejects(
    f.service.finish(await f.scope.caller(f.principal, f.second.id), ready.cookie),
    { code: 'github_flow_owner' },
  );
  assert.equal(f.gh.calls.length, 0);
  await f.state.transaction((tx) =>
    tx.run('UPDATE code_github_flows SET expires_at=?', '2000-01-01T00:00:00.000Z'),
  );
  await assert.rejects(f.service.finish(f.caller, ready.cookie), { code: 'github_flow' });
  const newer = await f.ready();
  await f.service.link(f.caller, { expectedRevision: 0, installationId: null, repositoryId: null });
  await assert.rejects(f.service.finish(f.caller, newer.cookie), { code: 'github_conflict' });
});

test('credentials cannot cross Merv user/project boundaries; machine and reader authority cannot administer', async (t) => {
  const f = await foundation(t);
  await f.connect();
  const otherStatus = await f.service.status(f.otherCaller);
  assert.equal(otherStatus.canBrowse, false);
  await assert.rejects(f.service.repositories(f.otherCaller), { code: 'github_owner' });
  const second = await f.scope.caller(f.principal, f.second.id);
  assert.equal((await f.service.status(second)).status, 'disconnected');
  await assert.rejects(f.service.repositories(second), { code: 'github_owner' });
  const issued = await f.scope.createKey(f.principal, { projectId: f.project.id });
  const machine = await f.scope.caller({
    kind: 'key',
    key: await f.scope.authenticateKey(issued.token),
  });
  for (const action of [
    () => f.service.begin(machine, { expectedRevision: 1 }),
    () => f.service.repositories(machine),
    () => f.service.disconnect(machine, { expectedRevision: 1 }),
  ])
    await assert.rejects(action(), { code: 'github_human_required' });
  await f.scope.changeMemberRole(f.principal, f.project.id, { subject: 'other', role: 'reader' });
  const reader = await f.scope.caller(f.other, f.project.id);
  assert.equal((await f.service.status(reader)).canManage, false);
  await assert.rejects(f.service.disconnect(reader, { expectedRevision: 1 }), {
    code: 'forbidden',
  });
});

test('permission removal during GitHub I/O prevents returning repositories or saving a binding', async (t) => {
  const f = await foundation(t);
  await f.connect();
  f.gh.control.pauseList = deferred();
  const pending = f.service.link(f.caller, {
    expectedRevision: 1,
    installationId: 17,
    repositoryId: 101,
  });
  const rejected = assert.rejects(pending, (error: any) =>
    ['membership_required', 'forbidden', 'unauthorized'].includes(error.code),
  );
  await f.gh.control.listEntered.promise;
  await f.scope.removeMember(f.other, f.project.id, 'owner');
  f.gh.control.pauseList.resolve();
  await rejected;
  assert.equal((await f.service.status(f.otherCaller)).repository, null);
});

test('single-use refresh is claimed before I/O across service instances; disconnect fences late results', async (t) => {
  const f = await foundation(t);
  f.gh.control.expiresIn = 1;
  await f.connect();
  const second = await createService(new CodeGitHubService(f.state, f.scope, config, f.gh.fetcher));
  t.after(() => second.close());
  f.gh.control.pauseRefresh = deferred();
  const pending = f.service.repositories(f.caller);
  const rejected = assert.rejects(pending, { code: 'github_conflict' });
  await f.gh.control.refreshEntered.promise;
  await assert.rejects(second.repositories(f.caller), { code: 'github_busy' });
  assert.equal(f.gh.calls.filter((c) => c.body?.grant_type === 'refresh_token').length, 1);
  await second.disconnect(f.caller, { expectedRevision: 1 });
  f.gh.control.pauseRefresh.resolve();
  await rejected;
  assert.equal((await second.status(f.caller)).status, 'disconnected');
  assert.equal(
    await f.state.read(
      async (sql) =>
        (await sql.get<{ credentials: string | null }>('SELECT credentials FROM code_github'))!
          .credentials,
    ),
    null,
  );
});

test('refresh success persists new tokens; uncertain refresh and upstream revocation require reconnect', async (t) => {
  const f = await foundation(t);
  f.gh.control.expiresIn = 1;
  await f.connect();
  await f.service.repositories(f.caller);
  await f.service.repositories(f.caller);
  assert.equal(f.gh.calls.filter((c) => c.body?.grant_type).length, 1);
  f.gh.control.revoked = true;
  await assert.rejects(f.service.repositories(f.caller), { code: 'github_reconnect' });
  assert.equal((await f.service.status(f.caller)).status, 'needs_reconnect');
  f.gh.control.revoked = false;
  await f.connect();
  f.gh.control.failRefresh = true;
  await assert.rejects(
    f.service.repositories(f.caller),
    (e: any) => e.code === 'github_unavailable' && !e.message.includes('synthetic'),
  );
  await assert.rejects(f.service.repositories(f.caller), { code: 'github_reconnect' });
  assert.equal((await f.service.status(f.caller)).status, 'needs_reconnect');
});

test('restart preserves pending authorization and connection, while disconnecting one project leaves another intact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'merv-code-github-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const firstState = new SqliteState(join(dir, 'state.sqlite'));
  const f = await foundation(t, firstState);
  const ready = await f.ready();
  await f.service.close();
  await firstState.close();
  const state = new SqliteState(join(dir, 'state.sqlite'));
  const scope = await createService(new ProjectScope(state));
  const service = await createService(new CodeGitHubService(state, scope, config, f.gh.fetcher));
  t.after(async () => {
    await service.close();
    await state.close();
  });
  await service.finish(f.caller, ready.cookie);
  const second = await scope.caller(f.principal, f.second.id);
  const start = await service.begin(second, { expectedRevision: 0 });
  const cookie = start.cookie.split(';')[0].slice('merv_github_flow='.length);
  await service.callback({
    cookie,
    code: 'second-code',
    state: new URL(start.url).searchParams.get('state')!,
  });
  await service.finish(second, cookie);
  await service.disconnect(f.caller, { expectedRevision: 1 });
  assert.equal((await service.repositories(second)).length, 1);
});

test('missing GitHub configuration preserves Code and cannot admit connections; encryption binds its record', async (t) => {
  const f = await foundation(t);
  const disabled = await createService(new CodeGitHubService(f.state, f.scope));
  t.after(() => disabled.close());
  assert.equal((await disabled.status(f.caller)).configured, false);
  await assert.rejects(disabled.begin(f.caller, { expectedRevision: 0 }), {
    code: 'github_unconfigured',
  });
  assert.equal(githubConfig({}), undefined);
  assert.throws(() => githubConfig({ MERV_GITHUB_CLIENT_ID: 'only-one-value' }), {
    code: 'invalid_github_config',
  });
  const client = new GitHubClient(config, f.gh.fetcher);
  const sealed = client.seal({ secret: 'private' }, 'one');
  assert.deepEqual(client.open(sealed, 'one'), { secret: 'private' });
  assert.throws(() => client.open(sealed, 'two'), { code: 'github_reconnect' });
  assert.ok(!JSON.stringify(client).includes(config.clientSecret));
  await disabled.close();
  await assert.rejects(disabled.status(f.caller), { code: 'code_unavailable' });
});

test('denied authorization returns to Merv and consumes the flow; empty state cannot advance a flow', async (t) => {
  const f = await foundation(t);
  const start = await f.service.begin(f.caller, { expectedRevision: 0 });
  const cookie = start.cookie.split(';')[0].slice('merv_github_flow='.length);
  const state = new URL(start.url).searchParams.get('state')!;
  await assert.rejects(f.service.callback({ cookie, state: '', code: 'synthetic' }), {
    code: 'github_flow',
  });
  assert.equal(
    await f.service.callback({ cookie, state, error: 'access_denied' }),
    `${config.origin}/ui/settings/integrations?github=denied`,
  );
  await assert.rejects(f.service.callback({ cookie, state, code: 'synthetic' }), {
    code: 'github_flow',
  });
  assert.equal(f.gh.calls.length, 0);
});

test('disconnect during authorization discards and revokes newly issued tokens; close drains an admitted request', async (t) => {
  const f = await foundation(t);
  const ready = await f.ready();
  f.gh.control.pauseExchange = deferred();
  const finish = f.service.finish(f.caller, ready.cookie);
  const rejected = assert.rejects(finish, { code: 'github_flow' });
  await f.gh.control.exchangeEntered.promise;
  await f.service.disconnect(f.caller, { expectedRevision: 0 });
  f.gh.control.pauseExchange.resolve();
  await rejected;
  assert.ok(f.gh.calls.some((c) => c.url.endsWith('/applications/Iv1.synthetic/token')));
  f.gh.control.pauseExchange = undefined;
  await f.connect();
  f.gh.control.pauseList = deferred();
  const listing = f.service.repositories(f.caller);
  const stopped = assert.rejects(listing, { code: 'code_unavailable' });
  await f.gh.control.listEntered.promise;
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  f.gh.control.pauseList.resolve();
  await stopped;
  await closing;
  assert.equal(closed, true);
});

test(
  'PostgreSQL persists GitHub connections and fences refresh across separate connections',
  { skip: !process.env.MERV_TEST_POSTGRES_URL },
  async (t) => {
    const connectionString = process.env.MERV_TEST_POSTGRES_URL!;
    const schema = `github_${randomUUID().replaceAll('-', '')}`;
    const state = await PostgresState.open({ connectionString, schema });
    const f = await foundation(t, state);
    const secondState = await PostgresState.open({ connectionString, schema });
    const secondScope = await createService(new ProjectScope(secondState));
    const second = await createService(
      new CodeGitHubService(secondState, secondScope, config, f.gh.fetcher),
    );
    t.after(async () => {
      await f.service.close();
      await second.close();
      await state.close();
      await secondState.close();
      const pool = new Pool({ connectionString });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    });
    f.gh.control.expiresIn = 1;
    await f.connect();
    assert.equal((await second.status(f.caller)).status, 'connected');
    f.gh.control.pauseRefresh = deferred();
    const first = f.service.repositories(f.caller);
    await f.gh.control.refreshEntered.promise;
    await assert.rejects(second.repositories(f.caller), { code: 'github_busy' });
    f.gh.control.pauseRefresh.resolve();
    assert.equal((await first).length, 1);
    const linked = await second.link(f.caller, {
      expectedRevision: 1,
      installationId: 17,
      repositoryId: 101,
    });
    assert.equal(linked.repository?.id, 101);
    assert.equal((await f.service.status(f.caller)).repository?.id, 101);
  },
);

test('actual HTTP routes authenticate Merv, keep callback cookies out of JSON, and reject callback/identity substitution', async (t) => {
  const f = await foundation(t);
  const tools = new ToolRegistry(f.scope);
  const api = new ApiServer(
    f.scope,
    tools,
    { port: 0 },
    {
      configuration: () => ({ enabled: true }),
      verify: async (token) => {
        assert.equal(token, 'owner.jwt.token');
        return {
          issuer,
          subject: 'owner',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
    },
  );
  const dispose = api.registerCode({
    github: f.service,
    nextCommand: async () => null,
    completeCommand: async () => {
      throw new Error('unused');
    },
  });
  const url = await api.start();
  t.after(async () => {
    dispose();
    await api.stop();
    await tools.close();
  });
  const headers = {
    authorization: 'Bearer owner.jwt.token',
    'x-merv-project-id': f.project.id,
    'content-type': 'application/json',
  };
  assert.equal((await fetch(`${url}/code/github`)).status, 401);
  const begun = await fetch(`${url}/code/github/begin`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(begun.status, 200);
  const cookie = begun.headers.get('set-cookie')!.split(';')[0];
  const body = (await begun.json()) as { url: string };
  assert.deepEqual(Object.keys(body), ['url']);
  const flow = new URL(body.url).searchParams.get('state');
  const callback = `${url}/code/github/callback?state=${flow}&code=synthetic-code`;
  assert.equal((await fetch(callback, { redirect: 'manual' })).status, 409);
  const githubIssuer = encodeURIComponent('https://github.com/login/oauth');
  for (const query of [
    '&iss=https://evil.example',
    '&iss=',
    `&iss=${githubIssuer}&iss=${githubIssuer}`,
    `&iss=${githubIssuer}%2F`,
    '&unexpected=value',
  ]) {
    assert.equal(
      (await fetch(callback + query, { headers: { cookie }, redirect: 'manual' })).status,
      400,
      `Reject callback without consuming its flow: ${query}`,
    );
  }
  const redirected = await fetch(`${callback}&iss=${githubIssuer}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(redirected.status, 303);
  assert.equal(redirected.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(
    redirected.headers.get('location'),
    `${config.origin}/ui/settings/integrations?github=complete`,
  );
  const finished = await fetch(`${url}/code/github/finish`, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: '{}',
  });
  assert.equal(finished.status, 200);
  assert.equal(((await finished.json()) as any).status, 'connected');
  const badOrigin = await fetch(`${url}/code/github/begin`, {
    method: 'POST',
    headers: { ...headers, origin: 'https://evil.example' },
    body: '{"expectedRevision":1}',
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(
    (await fetch(`${url}/code/github/repositories?projectId=another`, { headers })).status,
    400,
  );
  // The adapter can disappear while a POST body is arriving. Do not use a captured provider.
  const partialBody = '{"expectedRevision":1}';
  const waiting = new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      `${url}/code/github/begin`,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(partialBody) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.flushHeaders();
    req.write(partialBody.slice(0, -1));
    setTimeout(() => {
      dispose();
      req.end(partialBody.slice(-1));
    }, 20);
  });
  assert.equal(await waiting, 503);
  assert.equal((await fetch(`${url}/code/github`, { headers })).status, 503);
});

test('GitHub client rejects malformed/oversized replies and does not reflect upstream secrets', async () => {
  for (const fake of [
    async () => Response.json({ message: 'upstream-private-token' }, { status: 403 }),
    async () => new Response('x'.repeat(2_000_001)),
    async () => Response.json({ id: 'not-an-id', login: 'test' }),
  ]) {
    const client = new GitHubClient(config, fake);
    await assert.rejects(client.user('synthetic-token'), (e: any) => {
      assert.ok(['github_unavailable', 'github_response'].includes(e.code));
      assert.ok(!e.message.includes('upstream-private-token'));
      return true;
    });
    client.close();
  }
});

test('GitHub branch names retain valid Unicode and reject invalid UTF-8 bytes', async (t) => {
  let name = Buffer.from('研究�');
  const client = new GitHubClient(
    config,
    async () =>
      new Response(
        Buffer.concat([
          Buffer.from('[{"name":"'),
          name,
          Buffer.from(`","commit":{"sha":"${'a'.repeat(40)}"},"protected":false}]`),
        ]),
      ),
  );
  t.after(() => client.close());
  assert.equal((await client.branches('synthetic-token', 'fixture/private'))[0].name, '研究�');
  for (const bytes of [[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
    name = Buffer.from(bytes);
    await assert.rejects(client.branches('synthetic-token', 'fixture/private'), {
      code: 'github_unavailable',
    });
  }
});
