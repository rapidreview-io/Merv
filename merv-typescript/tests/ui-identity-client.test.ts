import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
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
import { deferred } from './fixtures/deferred.js';

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
        : path.endsWith('project.read:whoami')
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
