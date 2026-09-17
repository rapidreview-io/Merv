import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { MervError } from '@merv/contracts';
import { UiRegistry } from '@merv/ui';
import { createApp } from '../src/app.js';
import { RemoteFixture } from './fixtures/remote-server.js';

const caller = { actorId: 'actor_test', projectId: 'project_test' };
const row = (id: string, order = 1, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  group: 'work',
  order,
  path: `/${id}`,
  view: { kind: id },
  ...extra,
});

test('UiRegistry validates rows, orders them, reports live status, and disposes only its own registration', async () => {
  const ui = new UiRegistry();
  for (const invalid of [
    row('Bad Id'),
    row('x', 1, { label: '' }),
    row('x', 1, { group: 'Work' }),
    row('x', 1.5),
    row('x', 1, { path: 'relative' }),
    row('x', 1, { view: {} }),
  ])
    assert.throws(
      () => ui.register(invalid as never),
      (error: unknown) => {
        assert.ok(error instanceof MervError);
        assert.equal(error.code, 'invalid_row');
        return true;
      },
    );
  const disposeB = ui.register(row('b', 2, { status: () => ({ count: 3 }) }));
  ui.register(row('a', 1, { read: () => ({ hello: 'world' }) }));
  ui.register(
    row('c', 3, {
      status: () => {
        throw new MervError('forbidden', 'Operators only', 403);
      },
    }),
  );
  assert.throws(() => ui.register(row('a')), /already registered/);
  assert.deepEqual(
    ui.rows().map((entry) => entry.id),
    ['a', 'b', 'c'],
  );
  const described = await ui.describe(caller);
  assert.deepEqual(
    described.map(({ id, status, readable }) => ({ id, status, readable })),
    [
      { id: 'a', status: {}, readable: true },
      { id: 'b', status: { count: 3 }, readable: false },
      { id: 'c', status: { state: 'unavailable', detail: 'Operators only' }, readable: false },
    ],
  );
  assert.deepEqual(await ui.read(caller, 'a'), { hello: 'world' });
  await assert.rejects(async () => await ui.read(caller, 'b'), /no readable data/);
  disposeB();
  disposeB();
  assert.deepEqual(
    ui.rows().map((entry) => entry.id),
    ['a', 'c'],
  );
  // A stale disposer never removes a newer registration under the same id.
  const disposeOld = ui.register(row('b'));
  disposeOld();
  const disposeNew = ui.register(row('b'));
  disposeOld();
  assert.ok(ui.rows().some((entry) => entry.id === 'b'));
  disposeNew();
  assert.ok(!ui.rows().some((entry) => entry.id === 'b'));
});

test('UiRegistry awaits asynchronous status and reads, containing a failed row status', async () => {
  const ui = new UiRegistry();
  ui.register(
    row('async', 1, {
      status: async () => {
        await Promise.resolve();
        return { count: 7 };
      },
      read: async () => {
        await Promise.resolve();
        return { agents: [{ id: 'continuing-agent', currentExecutionId: 'execution' }] };
      },
    }),
  );
  ui.register(
    row('failed', 2, {
      status: async () => {
        await Promise.resolve();
        throw new MervError('unavailable', 'Status is temporarily unavailable', 503);
      },
      read: async () => {
        throw new MervError('unavailable', 'Read is temporarily unavailable', 503);
      },
    }),
  );
  const rows = await ui.describe(caller);
  assert.deepEqual(
    rows.map(({ status }) => status),
    [{ count: 7 }, { state: 'unavailable', detail: 'Status is temporarily unavailable' }],
  );
  assert.deepEqual(await ui.read(caller, 'async'), {
    agents: [{ id: 'continuing-agent', currentExecutionId: 'execution' }],
  });
  await assert.rejects(ui.read(caller, 'failed'), { code: 'unavailable' });
});

/** Raw request so path escapes such as %2e%2e reach the server unnormalized. */
function raw(url: string, path: string, headers: Record<string, string> = {}, method = 'GET') {
  const base = new URL(url);
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = request({ host: base.hostname, port: base.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

interface Entry {
  id: string;
  name: string;
  config?: Record<string, unknown>;
  required?: boolean;
  disabled?: boolean;
}
/** The committed default composition, bound to an ephemeral port and a fixture bundle. */
function plugins(assets: string, extra: Entry[] = []): Entry[] {
  const { plugins } = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as { plugins: Entry[] };
  return [
    ...plugins.map((entry) =>
      entry.id === 'api'
        ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
        : entry.id === 'ui'
          ? { ...entry, config: { assets } }
          : entry,
    ),
    ...extra,
  ];
}

test('human readers can open People and read active project membership without actor administration', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-members-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const assets = join(directory, 'bundle');
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Members</title>');
  const secret = 'synthetic-merv-ui-membership-key-with-at-least-32-bytes';
  const environment = 'MERV_UI_MEMBERSHIP_TEST_SECRET';
  process.env[environment] = secret;
  t.after(() => {
    delete process.env[environment];
  });
  const issuer = 'https://shared-ui.example/auth/v1';
  const issueToken = (subject: string) =>
    new SignJWT({ role: 'authenticated', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setSubject(subject)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins(assets).map((entry) =>
        entry.id === 'identity'
          ? {
              ...entry,
              config: {
                supabaseUrl: 'https://shared-ui.example',
                mode: 'hs256',
                secretEnv: environment,
              },
            }
          : entry,
      ),
    },
  });
  t.after(() => app.stop());
  const operatorToken = await issueToken('operator-user');
  const readerToken = await issueToken('reader-user');
  const operator = await app.ctx.scope.acceptVerifiedIdentity(
    await app.ctx.identity.verify(operatorToken),
  );
  const project = await app.ctx.scope.createProject(operator, {
    name: 'Shared UI',
    requestId: 'shared-ui',
  });
  await app.ctx.scope.addMember(operator, project.id, { subject: 'reader-user', role: 'reader' });
  const headers = { authorization: `Bearer ${readerToken}`, 'x-merv-project-id': project.id };
  const shell = await fetch(`${app.ctx.api.url}/tools/ui.shell`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(shell.status, 200);
  const shellData = (await shell.json()) as {
    result: { rows: { id: string; label: string; status: object }[] };
  };
  const people = shellData.result.rows.find((row) => row.id === 'people');
  assert.equal(people?.label, 'People');
  assert.deepEqual(people?.status, {}, 'a human reader does not need operator-only actor listing');
  const members = await fetch(`${app.ctx.api.url}/projects/${project.id}/members`, { headers });
  assert.equal(members.status, 200);
  const listed = (await members.json()) as { memberships: { subject: string; active: boolean }[] };
  assert.deepEqual(
    listed.memberships
      .filter((member) => member.active)
      .map((member) => member.subject)
      .sort(),
    ['operator-user', 'reader-user'],
  );
  const actors = await fetch(`${app.ctx.api.url}/tools/actor.list`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(actors.status, 403);
  const forbiddenMutation = await fetch(`${app.ctx.api.url}/projects/${project.id}/members`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'another-user', role: 'operator' }),
  });
  assert.equal(forbiddenMutation.status, 403);
  await app.ctx.scope.removeMember(operator, project.id, 'reader-user');
  assert.equal(
    (await fetch(`${app.ctx.api.url}/projects/${project.id}/members`, { headers })).status,
    403,
  );
});

test('the assembled application serves the bundle, lists rows per active plugin, and survives feed and UI removal', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const assets = join(directory, 'bundle');
  mkdirSync(join(assets, 'assets'), { recursive: true });
  writeFileSync(
    join(assets, 'index.html'),
    '<!doctype html><title>Merv</title><div id="root"></div>',
  );
  writeFileSync(join(assets, 'assets', 'app.js'), 'console.log("bundle")');
  writeFileSync(join(directory, 'secret.txt'), 'outside the bundle');
  const app = await createApp({
    directory: join(directory, 'data'),
    config: { plugins: plugins(assets) },
  });
  t.after(() => app.stop());
  const url = app.ctx.api.url!;
  const credentials = await app.ctx.scope.bootstrap({ projectName: 'UI', actorName: 'Operator' });
  const operator = credentials.token;
  const reader = (
    await app.ctx.scope.issueActor(
      { actorId: credentials.actor.id, projectId: credentials.project.id },
      { name: 'Reader', role: 'reader' },
    )
  ).token;
  const tool = async (
    name: string,
    token: string,
    input = {},
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const rowIds = async (token = operator) =>
    (await tool('ui.shell', token)).body.result.rows.map((entry: { id: string }) => entry.id);

  // Static bundle: redirect, SPA fallback, hashed assets, and no path escapes.
  const redirect = await raw(url, '/ui?x=1');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/ui/?x=1');
  const index = await raw(url, '/ui/');
  assert.equal(index.status, 200);
  assert.match(String(index.headers['content-type']), /text\/html/);
  assert.match(index.body, /id="root"/);
  assert.equal((await raw(url, '/ui/tasks/task_123')).body, index.body);
  const script = await raw(url, '/ui/assets/app.js');
  assert.equal(script.status, 200);
  assert.match(String(script.headers['content-type']), /javascript/);
  assert.match(String(script.headers['cache-control']), /immutable/);
  assert.equal((await raw(url, '/ui/missing.css')).status, 404);
  // Dot segments, encoded or not, normalize away before routing: no longer a UI path, so a token is required.
  for (const path of ['/ui/%2e%2e/secret.txt', '/ui/assets/../../secret.txt']) {
    const escaped = await raw(url, path);
    assert.equal(escaped.status, 401, path);
    assert.doesNotMatch(escaped.body, /outside the bundle/);
  }
  assert.equal((await raw(url, '/ui/', {}, 'POST')).status, 405);
  assert.equal((await raw(url, '/ui/', {}, 'HEAD')).body, '');

  // Same-origin browsers pass the Origin check; foreign origins still do not.
  const host = new URL(url).host;
  const ok = await tool('ui.shell', operator, {}, { origin: `http://${host}` });
  assert.equal(ok.status, 200);
  assert.equal(
    (await tool('ui.shell', operator, {}, { origin: 'http://evil.example' })).status,
    403,
  );
  assert.equal((await fetch(`${url}/tools/ui.shell`, { method: 'POST' })).status, 401);

  const shell = ok.body.result as {
    rows: {
      id: string;
      label: string;
      group: string;
      status: Record<string, unknown>;
      readable: boolean;
      view: { kind: string };
    }[];
    plugins: { id: string; state: string }[];
  };
  assert.deepEqual(
    shell.rows.map((entry) => entry.id),
    [
      'people',
      'research',
      'claims',
      'tasks',
      'experiments',
      'paper',
      'knowledge',
      'reviews',
      'consolidation',
      'sessions',
      'code',
      'feed',
      'artifacts',
      'reflections',
      'settings',
    ],
  );
  // One word per thing: the inventory is Knowledge, and retained artifacts are Files.
  const named = (id: string) => shell.rows.find((entry) => entry.id === id)?.label;
  assert.deepEqual([named('knowledge'), named('artifacts')], ['Knowledge', 'Files']);
  // Every count in the chrome means open work; rows that are inventories report none.
  assert.deepEqual(shell.rows.find((entry) => entry.id === 'tasks')?.status, { count: 0 });
  for (const id of ['people', 'claims', 'knowledge'])
    assert.deepEqual(shell.rows.find((entry) => entry.id === id)?.status, {});
  assert.equal(shell.rows.find((entry) => entry.id === 'settings')?.group, 'settings');
  assert.deepEqual(shell.rows.find((entry) => entry.id === 'code')?.view, { kind: 'code' });
  assert.equal(shell.rows.find((entry) => entry.id === 'code')?.readable, true);
  assert.deepEqual((await tool('ui.read', operator, { rowId: 'code' })).body.result, {
    operations: [],
    proposals: [],
  });
  assert.deepEqual((await tool('ui.read', reader, { rowId: 'code' })).body.result, {
    operations: [],
    proposals: [],
  });
  assert.equal(shell.plugins.length, plugins(assets).length);
  assert.ok(shell.plugins.every((entry) => entry.state === 'active'));
  // A reader sees the rows, and no row asks for a number it cannot answer for
  // this caller: People is a directory and reports nothing. (A status that does
  // fail still reports itself instead of failing the shell; the registry test
  // above covers that path.)
  const readerShell = (await tool('ui.shell', reader)).body.result.rows as {
    id: string;
    status: { state?: string };
  }[];
  assert.deepEqual(readerShell.find((entry) => entry.id === 'people')?.status, {});
  assert.ok(readerShell.every((entry) => entry.status.state !== 'unavailable'));
  assert.equal(
    (await tool('ui.read', operator, { rowId: 'tasks' })).body.error.code,
    'row_unreadable',
  );
  assert.equal((await tool('ui.read', operator, { rowId: 'absent' })).status, 404);

  // Feed removal drops exactly the feed rows; everything else keeps working; restoration adds no duplicates.
  await app.setEnabled('feed', false);
  assert.deepEqual(await rowIds(), [
    'people',
    'research',
    'claims',
    'tasks',
    'experiments',
    'paper',
    'knowledge',
    'reviews',
    'consolidation',
    'sessions',
    'code',
    'artifacts',
    'reflections',
    'settings',
  ]);
  assert.equal(app.status().find((entry) => entry.id === 'feed-ui')?.state, 'pending');
  assert.equal((await raw(url, '/ui/')).status, 200);
  assert.equal((await tool('task.list', operator)).status, 200);
  await app.setEnabled('feed', true);
  assert.deepEqual(await rowIds(), [
    'people',
    'research',
    'claims',
    'tasks',
    'experiments',
    'paper',
    'knowledge',
    'reviews',
    'consolidation',
    'sessions',
    'code',
    'feed',
    'artifacts',
    'reflections',
    'settings',
  ]);

  // UI removal withdraws the bundle and its tools while HTTP and MCP keep serving domain tools.
  await app.setEnabled('ui', false);
  // With the public mount gone, /ui/ is an ordinary unauthenticated path again.
  assert.equal((await raw(url, '/ui/')).status, 401);
  assert.equal((await tool('ui.shell', operator)).body.error.code, 'unknown_tool');
  assert.equal((await tool('task.list', operator)).status, 200);
  for (const id of [
    'scope-ui',
    'claims-ui',
    'research-ui',
    'paper-ui',
    'reflections-ui',
    'consolidation-ui',
    'experiments-ui',
    'knowledge-ui',
    'tasks-ui',
    'reviews-ui',
    'artifacts-ui',
    'sessions-ui',
    'code-ui',
    'feed-ui',
  ])
    assert.equal(app.status().find((entry) => entry.id === id)?.state, 'pending', id);
  await app.setEnabled('ui', true);
  assert.equal((await raw(url, '/ui/')).status, 200);
  assert.deepEqual(await rowIds(), [
    'people',
    'research',
    'claims',
    'tasks',
    'experiments',
    'paper',
    'knowledge',
    'reviews',
    'consolidation',
    'sessions',
    'code',
    'feed',
    'artifacts',
    'reflections',
    'settings',
  ]);
});

test('an unbuilt bundle reports itself instead of a blank page', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-unbuilt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await createApp({
    directory: join(directory, 'data'),
    config: { plugins: plugins(join(directory, 'nowhere')) },
  });
  t.after(() => app.stop());
  const response = await raw(app.ctx.api.url!, '/ui/');
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).error.code, 'ui_not_built');
});

test('the Connections row reports mount health and serves mount status through ui.read', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-mounts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = new RemoteFixture();
  await remote.start();
  t.after(() => remote.close());
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins(join(directory, 'nowhere'), [
        {
          id: 'mounts',
          name: '@merv/mounts',
          required: false,
          config: {
            mounts: [
              {
                id: 'nisa',
                url: remote.url,
                tools: ['inspect'],
                timeoutMs: 2000,
                reconnectMs: 60000,
              },
              {
                id: 'dead',
                url: 'http://127.0.0.1:9',
                tools: ['inspect'],
                timeoutMs: 500,
                reconnectMs: 60000,
              },
            ],
          },
        },
        { id: 'mounts-ui', name: '@merv/mounts/ui', required: false },
      ]),
    },
  });
  t.after(() => app.stop());
  const credentials = await app.ctx.scope.bootstrap({
    projectName: 'Mounts',
    actorName: 'Operator',
  });
  const tool = async (name: string, input = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return (await response.json()) as any;
  };
  const shell = (await tool('ui.shell')).result as {
    rows: {
      id: string;
      group: string;
      readable: boolean;
      status: { state?: string; count?: number; detail?: string };
    }[];
  };
  const connections = shell.rows.find((entry) => entry.id === 'connections');
  assert.ok(connections, 'the mounts adapter registers its row');
  assert.equal(connections.group, 'system');
  assert.equal(connections.readable, true);
  assert.equal(connections.status.count, undefined, 'an inventory reports no count');
  assert.equal(connections.status.state, 'degraded');
  assert.equal(connections.status.detail, '1 of 2 not ready');
  const status = (await tool('ui.read', { rowId: 'connections' })).result as {
    id: string;
    state: string;
    toolCount: number;
    origin: string;
  }[];
  assert.deepEqual(
    status
      .map(({ id, state, toolCount }) => ({ id, state, toolCount }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'dead', state: 'failed', toolCount: 0 },
      { id: 'nisa', state: 'ready', toolCount: 1 },
    ],
  );
  assert.ok(status.every((mount) => !mount.origin.includes('?') && !mount.origin.includes('@')));
  await app.setEnabled('mounts', false);
  assert.ok(
    !(await tool('ui.shell')).result.rows.some(
      (entry: { id: string }) => entry.id === 'connections',
    ),
  );
  assert.equal((await tool('ui.read', { rowId: 'connections' })).error.code, 'row_unreadable');
});
