import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import {
  accountRequest,
  call,
  currentToken,
  keyClient,
  onAccessLost,
  projectSelection,
  resolveAccountSession,
  scopeVersion,
  setProject,
  setToken,
  setTokenRefresher,
  type Account,
  type UserKey,
} from '../packages/ui/web/api.js';
import { browserAuth, setAuthMode } from '../packages/ui/web/auth.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(t: TestContext) {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  setAuthMode('local');
  setTokenRefresher(undefined);
  t.after(() => {
    setAuthMode('local');
    setTokenRefresher(undefined);
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  });
  return values;
}
const unauthorized = () =>
  Response.json(
    { error: { code: 'unauthorized', message: 'The original credential expired' } },
    { status: 401 },
  );
const session = (user: string, token: string) =>
  ({ user: { id: user }, access_token: token }) as Session;
const login = { url: 'https://shared.example', publishableKey: 'sb_publishable_fixture_only' };
const project = { id: 'project-a', name: 'Project A', createdAt: '2026-09-16T00:00:00.000Z' };
const account = (projects = [project]): Account => ({
  kind: 'user',
  user: { issuer: `${login.url}/auth/v1`, subject: 'user-a', createdAt: project.createdAt },
  projects,
});
function sdk() {
  let callback: (event: AuthChangeEvent, session: Session | null) => void = () => {};
  let created = 0,
    stopped = 0,
    refreshed = 0;
  let refresh = async () => ({ data: { session: session('user-a', 'new-token') }, error: null });
  const create = (_url: string, _key: string, options: any) => {
    created++;
    assert.equal(options.auth.flowType, 'pkce');
    assert.equal(options.auth.persistSession, true);
    assert.equal(options.auth.storage.getItem('missing'), null);
    return {
      auth: {
        onAuthStateChange(fn: typeof callback) {
          callback = fn;
          return {
            data: {
              subscription: {
                unsubscribe() {
                  callback = () => {};
                },
              },
            },
          };
        },
        async refreshSession() {
          refreshed++;
          return refresh();
        },
        async stopAutoRefresh() {
          stopped++;
        },
      },
    } as unknown as SupabaseClient;
  };
  return {
    options: {
      createClient: create as unknown as typeof import('@supabase/supabase-js').createClient,
      fetch: (async (_path: string, options?: RequestInit) => {
        assert.equal(new Headers(options?.headers).has('authorization'), false);
        assert.equal(options?.credentials, 'omit');
        return Response.json({ enabled: true, login });
      }) as typeof fetch,
    },
    emit: (event: AuthChangeEvent, value: Session | null) => callback(event, value),
    refreshWith(fn: typeof refresh) {
      refresh = fn;
    },
    counts: () => ({ created, stopped, refreshed }),
  };
}

test('tool calls bind the captured project and reject results after project or account switches', async (t) => {
  setup(t);
  for (const switchAccount of [false, true]) {
    setToken('actor-a');
    setProject('project-a');
    const pending = deferred<Response>();
    t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer actor-a');
      assert.equal(headers.get('x-merv-project-id'), 'project-a');
      assert.equal(init?.credentials, 'omit');
      return pending.promise;
    });
    const read = call('task.get', { taskId: 'old-task' });
    if (switchAccount) setToken('actor-b');
    else setProject('project-b');
    pending.resolve(Response.json({ result: { secret: 'old-project-data' } }));
    await assert.rejects(read, { code: 'scope_changed' });
    assert.equal(projectSelection(), switchAccount ? null : 'project-b');
  }
});

test('late response bodies and errors cannot invalidate the new identity or leak old data', async (t) => {
  setup(t);
  setToken('old-token');
  setProject('project-a');
  const body = deferred<unknown>(),
    reading = deferred<void>();
  const errors: string[] = [];
  const remove = onAccessLost((error) => errors.push(error.code));
  t.after(remove);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      ({
        status: 401,
        ok: false,
        json: () => {
          reading.resolve();
          return body.promise;
        },
      }) as Response,
  );
  const result = accountRequest('/account');
  await reading.promise;
  setToken('new-account');
  body.resolve({ error: { code: 'unauthorized', message: 'Old account' } });
  await assert.rejects(result, { code: 'scope_changed' });
  assert.deepEqual(errors, []);
  assert.equal(currentToken(), 'new-account');
});

test('concurrent 401s refresh once, retry once and preserve the current project/cache scope', async (t) => {
  setup(t);
  setToken('old-token');
  setProject('project-a');
  const originalScope = scopeVersion();
  const refresh = deferred<string | null>(),
    started = deferred<void>();
  let renewals = 0,
    calls = 0;
  setTokenRefresher(() => {
    renewals++;
    started.resolve();
    return refresh.promise;
  });
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    calls++;
    return new Headers(init?.headers).get('authorization') === 'Bearer new-token'
      ? Response.json({ result: calls })
      : unauthorized();
  });
  const reads = Promise.all([call('probe'), call('probe')]);
  await started.promise;
  refresh.resolve('new-token');
  await reads;
  assert.equal(renewals, 1);
  assert.equal(calls, 4);
  assert.equal(currentToken(), 'new-token');
  assert.equal(projectSelection(), 'project-a');
  assert.equal(scopeVersion(), originalScope);
  setToken('another-account');
  assert.ok(scopeVersion() > originalScope);
  assert.equal(projectSelection(), null);
});

test('failed refresh preserves the original 401, while role denial never refreshes or signs out', async (t) => {
  setup(t);
  setToken('token');
  let renewals = 0;
  const errors: string[] = [];
  const remove = onAccessLost((error) => errors.push(error.code));
  t.after(remove);
  setTokenRefresher(async () => {
    renewals++;
    return null;
  });
  t.mock.method(globalThis, 'fetch', async () => unauthorized());
  await assert.rejects(accountRequest('/account'), {
    code: 'unauthorized',
    message: 'The original credential expired',
  });
  assert.equal(renewals, 1);
  assert.deepEqual(errors, ['unauthorized']);
  errors.length = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: { code: 'forbidden', message: 'Role lacks permission' } },
      { status: 403 },
    ),
  );
  await assert.rejects(call('actor.list'), { code: 'forbidden' });
  assert.equal(renewals, 1);
  assert.deepEqual(errors, []);
  assert.equal(currentToken(), 'token');
});

test('async StrictMode subscribers share one SDK client and dispose only their own refresher', async (t) => {
  setup(t);
  setAuthMode('shared');
  const fake = sdk();
  let firstChanges = 0,
    secondChanges = 0;
  const [first, second] = await Promise.all([
    browserAuth(() => firstChanges++, fake.options),
    browserAuth(() => secondChanges++, fake.options),
  ]);
  t.after(() => {
    first.dispose();
    second.dispose();
  });
  assert.equal(fake.counts().created, 1);
  first.dispose();
  fake.emit('INITIAL_SESSION', session('user-a', 'old-token'));
  assert.equal(firstChanges, 0);
  assert.equal(secondChanges, 1);
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) =>
    new Headers(init?.headers).get('authorization') === 'Bearer new-token'
      ? Response.json({ ok: true })
      : unauthorized(),
  );
  await accountRequest('/account');
  assert.equal(fake.counts().refreshed, 1);
  assert.equal(fake.counts().stopped, 0);
  second.dispose();
  assert.equal(fake.counts().stopped, 1);
});

test('SDK refresh cannot overwrite an actor login or a newly signed-in shared account', async (t) => {
  setup(t);
  setAuthMode('shared');
  const fake = sdk();
  const auth = await browserAuth(() => {}, fake.options);
  t.after(() => auth.dispose());
  fake.emit('INITIAL_SESSION', session('user-a', 'old-token'));
  setProject('project-a');
  const refreshed = deferred<{ data: { session: Session }; error: null }>(),
    started = deferred<void>();
  fake.refreshWith(() => {
    started.resolve();
    return refreshed.promise;
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return unauthorized();
  });
  const read = accountRequest('/account');
  await started.promise;
  setAuthMode('local');
  setToken('actor-token');
  setProject('actor-project');
  fake.emit('TOKEN_REFRESHED', session('user-a', 'stale-refresh'));
  assert.equal(currentToken(), 'actor-token');
  assert.equal(projectSelection(), 'actor-project');
  setAuthMode('shared');
  fake.emit('TOKEN_REFRESHED', session('user-a', 'stale-refresh'));
  assert.equal(currentToken(), null, 'An old refresh cannot complete a new sign-in attempt');
  fake.emit('SIGNED_IN', session('user-b', 'user-b-token'));
  setProject('project-b');
  fake.emit('TOKEN_REFRESHED', session('user-a', 'stale-sdk-event'));
  assert.equal(currentToken(), 'user-b-token', 'A late SDK refresh cannot switch accounts');
  refreshed.resolve({ data: { session: session('user-a', 'stale-refresh') }, error: null });
  await assert.rejects(read, { code: 'scope_changed' });
  assert.equal(currentToken(), 'user-b-token');
  assert.equal(projectSelection(), 'project-b');
  assert.equal(calls, 1);
});

test('a new shared account does not join the previous account refresh promise', async (t) => {
  setup(t);
  setAuthMode('shared');
  const fake = sdk();
  const auth = await browserAuth(() => {}, fake.options);
  t.after(() => auth.dispose());
  fake.emit('INITIAL_SESSION', session('user-a', 'old-token'));
  const first = deferred<{ data: { session: Session }; error: null }>();
  const firstStarted = deferred<void>();
  fake.refreshWith(() => {
    firstStarted.resolve();
    return first.promise;
  });
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) =>
    new Headers(init?.headers).get('authorization') === 'Bearer user-b-refreshed'
      ? Response.json({ ok: true })
      : unauthorized(),
  );
  const oldRequest = accountRequest('/account');
  await firstStarted.promise;
  setAuthMode('shared');
  fake.emit('SIGNED_IN', session('user-b', 'user-b-token'));
  setProject('project-b');
  fake.refreshWith(async () => ({
    data: { session: session('user-b', 'user-b-refreshed') },
    error: null,
  }));
  await accountRequest('/account');
  assert.equal(fake.counts().refreshed, 2);
  assert.equal(currentToken(), 'user-b-refreshed');
  first.resolve({ data: { session: session('user-a', 'stale-refresh') }, error: null });
  await assert.rejects(oldRequest, { code: 'scope_changed' });
  assert.equal(currentToken(), 'user-b-refreshed');
  assert.equal(projectSelection(), 'project-b');
});

test('project switch during shared refresh rejects the old request but keeps the renewed same-account token', async (t) => {
  setup(t);
  setAuthMode('shared');
  const fake = sdk();
  const auth = await browserAuth(() => {}, fake.options);
  t.after(() => auth.dispose());
  fake.emit('INITIAL_SESSION', session('user-a', 'old-token'));
  setProject('project-a');
  const refresh = deferred<{ data: { session: Session }; error: null }>(),
    started = deferred<void>();
  fake.refreshWith(() => {
    started.resolve();
    return refresh.promise;
  });
  t.mock.method(globalThis, 'fetch', async () => unauthorized());
  const result = call('probe');
  await started.promise;
  setProject('project-b');
  refresh.resolve({ data: { session: session('user-a', 'renewed-token') }, error: null });
  await assert.rejects(result, { code: 'scope_changed' });
  assert.equal(currentToken(), 'renewed-token');
  assert.equal(projectSelection(), 'project-b');
});

test('same-account SDK restoration preserves selection while account replacement invalidates it', async (t) => {
  const storage = setup(t);
  setAuthMode('shared');
  setToken('cached-token');
  setProject('project-a');
  storage.set('merv:shared-account', `${login.url}\nuser-a`);
  const before = scopeVersion();
  const fake = sdk();
  const auth = await browserAuth(() => {}, fake.options);
  t.after(() => auth.dispose());
  fake.emit('INITIAL_SESSION', session('user-a', 'restored-token'));
  assert.equal(projectSelection(), 'project-a');
  assert.equal(scopeVersion(), before);
  fake.emit('SIGNED_IN', session('user-b', 'different-token'));
  assert.equal(projectSelection(), null);
  assert.ok(scopeVersion() > before);
});

test('zero-project onboarding discovers the account before any scoped call and opens a newly created project', async (t) => {
  setup(t);
  setToken('shared-user');
  let created = false;
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    paths.push(path);
    const headers = new Headers(init?.headers);
    if (path === '/account') {
      assert.equal(headers.has('x-merv-project-id'), false);
      return Response.json(account(created ? [project] : []));
    }
    if (path === '/projects') {
      created = true;
      assert.equal(headers.has('x-merv-project-id'), false);
      return Response.json({ project });
    }
    assert.equal(headers.get('x-merv-project-id'), project.id);
    const actor = {
      id: 'human-project-actor',
      projectId: project.id,
      name: 'User A',
      role: 'operator',
      active: true,
    };
    return Response.json({
      result: path.endsWith('ui.shell')
        ? { actor, project, rows: [], plugins: [] }
        : path.endsWith('actor.whoami')
          ? actor
          : project,
    });
  });
  const empty = await resolveAccountSession();
  assert.equal(empty.phase, 'projects');
  assert.deepEqual(empty.account.projects, []);
  assert.deepEqual(paths, ['/account']);
  const result = await accountRequest<{ project: typeof project }>('/projects', {
    method: 'POST',
    body: { name: project.name, requestId: 'stable-creation' },
  });
  setProject(result.project.id);
  const ready = await resolveAccountSession();
  assert.equal(ready.phase, 'ready');
  if (ready.phase === 'ready') assert.equal(ready.actor.id, 'human-project-actor');
  if (ready.phase === 'ready') assert.equal(ready.project.id, project.id);
  // Opening a project is one scoped read: the shell answers who and where with the rows.
  assert.deepEqual(
    paths.filter((path) => path.startsWith('/tools/')),
    ['/tools/ui.shell'],
  );
});

test('membership loss refreshes project selection without treating it as a failed login', async (t) => {
  setup(t);
  setToken('shared-user');
  setProject(project.id);
  let lost = false;
  const remove = onAccessLost((error) => {
    assert.equal(error.code, 'membership_required');
    lost = true;
    setProject(null);
  });
  t.after(remove);
  t.mock.method(globalThis, 'fetch', async (path: string) =>
    path === '/account'
      ? Response.json(account([]))
      : Response.json(
          { error: { code: 'membership_required', message: 'Membership was removed' } },
          { status: 403 },
        ),
  );
  await assert.rejects(call('task.get'), { code: 'membership_required' });
  assert.equal(lost, true);
  assert.equal(currentToken(), 'shared-user');
  const next = await resolveAccountSession();
  assert.equal(next.phase, 'projects');
  assert.deepEqual(next.account.projects, []);
});

const key: UserKey = {
  id: 'ukey-fixture',
  owner: { issuer: `${login.url}/auth/v1`, subject: 'user-a' },
  projectId: project.id,
  grantScope: 'project',
  label: 'Research agent',
  createdAt: project.createdAt,
  expiresAt: null,
  revokedAt: null,
  previousId: null,
};

test('pasted machine keys keep project grants fixed and require an explicit account-grant selection', async (t) => {
  setup(t);
  let grant: UserKey['grantScope'] = 'account';
  const otherProject = { ...project, id: 'project-b' };
  const calls: { path: string; project: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ path, project: headers.get('x-merv-project-id') });
    if (path === '/account')
      return Response.json({
        kind: 'key',
        key: { ...key, grantScope: grant },
        projects: [project, otherProject],
      });
    const selected = headers.get('x-merv-project-id');
    return Response.json({
      result: path.endsWith('actor.whoami')
        ? {
            id: `member-${selected}`,
            projectId: selected,
            name: 'Owner',
            role: 'producer',
            active: true,
          }
        : { ...project, id: selected },
    });
  });
  setAuthMode('local');
  setToken('mk_account');
  const choose = await resolveAccountSession();
  assert.equal(choose.phase, 'projects');
  assert.deepEqual(calls, [{ path: '/account', project: null }]);
  setProject(otherProject.id);
  const selected = await resolveAccountSession();
  assert.equal(selected.phase, 'ready');
  if (selected.phase === 'ready') assert.equal(selected.project.id, otherProject.id);
  grant = 'project';
  setToken('mk_project');
  setProject(otherProject.id);
  const bound = await resolveAccountSession();
  assert.equal(bound.phase, 'ready');
  if (bound.phase === 'ready') assert.equal(bound.project.id, project.id);
  assert.equal(currentToken(), 'mk_project');
});

test('owner key administration is unscoped, returns a secret without logging it in, and preserves rotation expiry omission', async (t) => {
  const storage = setup(t);
  setToken('human-jwt');
  setProject('unrelated-current-project');
  const requests: { path: string; method: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer human-jwt');
    assert.equal(headers.has('x-merv-project-id'), false);
    assert.equal(init?.credentials, 'omit');
    requests.push({
      path,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (init?.method === 'DELETE') return Response.json({ revoked: true });
    if (init?.method === 'POST') return Response.json({ key, token: 'mk_once-only' });
    return Response.json({ keys: [key] });
  });
  assert.deepEqual((await keyClient.list()).keys, [key]);
  const issued = await keyClient.create({
    projectId: project.id,
    grantScope: 'account',
    label: 'agent',
  });
  assert.equal(issued.token, 'mk_once-only');
  await keyClient.rotate(key.id);
  await keyClient.rotate(key.id, { expiresAt: null });
  await keyClient.revoke(key.id);
  assert.deepEqual(requests, [
    { path: '/account/keys', method: 'GET', body: null },
    {
      path: '/account/keys',
      method: 'POST',
      body: { projectId: project.id, grantScope: 'account', label: 'agent' },
    },
    { path: `/account/keys/${key.id}/rotate`, method: 'POST', body: {} },
    { path: `/account/keys/${key.id}/rotate`, method: 'POST', body: { expiresAt: null } },
    { path: `/account/keys/${key.id}`, method: 'DELETE', body: null },
  ]);
  assert.equal(currentToken(), 'human-jwt');
  assert.equal(projectSelection(), 'unrelated-current-project');
  assert.equal([...storage.values()].includes('mk_once-only'), false);
});

test('a delayed key issuance response cannot expose its secret after the selected account changes', async (t) => {
  const storage = setup(t);
  setToken('old-human');
  const response = deferred<Response>();
  t.mock.method(globalThis, 'fetch', () => response.promise);
  const issued = keyClient.create({ projectId: project.id });
  setToken('other-human');
  response.resolve(Response.json({ key, token: 'mk_old-account-secret' }));
  await assert.rejects(issued, { code: 'scope_changed' });
  assert.equal(currentToken(), 'other-human');
  assert.equal([...storage.values()].includes('mk_old-account-secret'), false);
});
