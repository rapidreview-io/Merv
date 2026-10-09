import type { UiRowDescription } from '@merv/ui/rows';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { MervError } from '@merv/contracts';
import { UiRegistry } from '@merv/ui';
import { SignJWT } from 'jose';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { researchUiPlugin } from '@merv/research/ui';
import { codeUiPlugin } from '@merv/code-work/ui';
import { buildNavigation } from '../packages/ui/web/navigation.js';
import { createApp } from './fixtures/app.js';
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
    row('x', 1, { path: '//evil' }),
    row('x', 1, { path: '/Work' }),
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
    bytes: Buffer;
  }>((resolve, reject) => {
    const req = request({ host: base.hostname, port: base.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          bytes: Buffer.concat(chunks),
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

test('human readers can read Settings membership without a People row or actor administration', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-members-'));
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
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const operatorToken = await issueToken('operator-user');
  const readerToken = await issueToken('reader-user');
  const operator = await app.ctx.scope.members.acceptVerifiedIdentity(
    await app.ctx.identity.verify(operatorToken),
  );
  const project = await app.ctx.scope.members.createProject(operator, {
    name: 'Shared UI',
    requestId: 'shared-ui',
  });
  await app.ctx.scope.members.addMember(operator, project.id, {
    subject: 'reader-user',
    role: 'reader',
  });
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
  assert.equal(
    shellData.result.rows.some((row) => row.id === 'people'),
    false,
  );
  assert.equal(
    shellData.result.rows.some((row) => row.id === 'settings'),
    true,
  );
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
  await app.ctx.scope.members.removeMember(operator, project.id, 'reader-user');
  assert.equal(
    (await fetch(`${app.ctx.api.url}/projects/${project.id}/members`, { headers })).status,
    403,
  );
});

test('a part of ui.home whose statement fails is null alone, and the rest of the snapshot reads on', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-home-'));
  const app = await createApp({
    directory: join(directory, 'data'),
    config: { plugins: plugins(join(directory, 'nowhere')) },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  // A part read first whose query fails, as a statement timeout in one part would.
  app.ctx.tools.register({
    name: 'test.failing_part',
    description: 'Fails its statement.',
    inputSchema: z.object({}).strict(),
    readOnly: true,
    handler: async () => await app.ctx.state.read(async (sql) => await sql.get('SELECT 1/0')),
  });
  app.ctx.ui.register({
    ...row('failing', -1),
    home: { tool: 'test.failing_part', keep: ['id'] },
  });
  const credentials = await app.ctx.scope.credentials.bootstrap({
    projectName: 'UI',
    actorName: 'Operator',
  });
  const response = await fetch(`${app.ctx.api.url}/tools/ui.home`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  // Before each part had its savepoint, the aborted snapshot failed the whole read.
  assert.equal(response.status, 200);
  const home = ((await response.json()) as any).result as Record<string, unknown>;
  assert.equal(home.failing, null);
  assert.deepEqual(home.tasks, []);
  assert.deepEqual(home.workflows, { workflows: [] });
  assert.equal((home.project as { id: string }).id, credentials.project.id);
});

test('the assembled application serves the bundle, lists rows per active plugin, and survives feed and UI removal', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-'));
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
    feed: true,
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const url = app.ctx.api.url!;
  const credentials = await app.ctx.scope.credentials.bootstrap({
    projectName: 'UI',
    actorName: 'Operator',
  });
  const operator = credentials.token;
  const reader = (
    await app.ctx.scope.credentials.issueActor(
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
  assert.equal(script.headers['content-encoding'], undefined);
  // A browser that takes gzip is sent text gzipped: the parser's worker alone is 115 kB.
  const packed = await raw(url, '/ui/assets/app.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(packed.headers['content-encoding'], 'gzip');
  assert.match(String(packed.headers.vary), /accept-encoding/i);
  assert.equal(gunzipSync(packed.bytes).toString('utf8'), script.body);
  assert.equal((await raw(url, '/ui/missing.css')).status, 404);
  // Dot segments, encoded or not, normalize away before routing: no longer a UI path, and nothing
  // serves the path they leave.
  for (const path of ['/ui/%2e%2e/secret.txt', '/ui/assets/../../secret.txt']) {
    const escaped = await raw(url, path);
    assert.equal(escaped.status, 404, path);
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
      order: number;
      path: string;
      status: Record<string, unknown>;
      readable: boolean;
      view: { kind: string };
    }[];
    plugins: { id: string; state: string }[];
  };
  assert.deepEqual(
    shell.rows.map((entry) => entry.id),
    [
      'research',
      'work',

      'tasks',
      'experiments',
      'paper',
      'reviews',

      'sessions',
      'code',
      'feed',
      'artifacts',
      'boards',
      'reflections',
      'settings',
    ],
  );
  // Retained artifacts are Files; the retired Knowledge page registers no row.
  const named = (id: string) => shell.rows.find((entry) => entry.id === id)?.label;
  assert.equal(named('artifacts'), 'Files');
  assert.equal(named('knowledge'), undefined);
  // Every row above keeps its registration, its record routes and its ui.read; the
  // rail is a separate table of kinds, and these are the places it lists.
  assert.deepEqual(
    buildNavigation(shell.rows as UiRowDescription[]).map((section) => [
      section.label,
      section.rows.map((entry) => entry.label),
    ]),
    [
      ['Research', ['Files', 'Board']],
      // What is running is reached from the Work page; the project's agents are a gallery of
      // their own, with the machines folded under it.
      ['Agents', ['Agents', 'Code']],
      ['Feed', ['Feed']],
    ],
  );
  // Every count in the chrome means open work.
  assert.deepEqual(shell.rows.find((entry) => entry.id === 'tasks')?.status, { count: 0 });
  assert.equal(named('people'), undefined);
  assert.equal(shell.rows.find((entry) => entry.id === 'settings')?.group, 'settings');
  // What is running is drawn on the Work page; it has no row of its own.
  assert.equal(named('running'), undefined);
  assert.deepEqual(shell.rows.find((entry) => entry.id === 'code')?.view, { kind: 'code' });
  assert.equal(shell.rows.find((entry) => entry.id === 'code')?.readable, true);
  // A record page reads its record and the gate it stands at in one answer.
  for (const id of ['tasks', 'experiments'])
    assert.equal(shell.rows.find((entry) => entry.id === id)?.readable, true);
  // New projects expose their real managed root even before any work or GitHub connection.
  await waitForManagedCode(app.ctx.codeWork, {
    projectId: credentials.project.id,
    actorId: credentials.actor.id,
    credentialId: credentials.credential.id,
  });
  const managedCode = (await tool('ui.read', operator, { rowId: 'code' })).body.result;
  assert.equal(managedCode.status.project.repositoryId, `merv:${credentials.project.id}`);
  assert.equal(managedCode.status.project.main.stored, true);
  assert.equal(managedCode.status.store.hosted, true);
  assert.deepEqual(managedCode.status.units, []);
  assert.deepEqual(managedCode.status.bases, []);
  assert.equal(managedCode.status.mirror.state, 'off');
  assert.deepEqual(
    managedCode.status.operations,
    [],
    'completed initialization is not active work',
  );
  assert.deepEqual((await tool('ui.read', reader, { rowId: 'code' })).body.result, managedCode);
  assert.equal(shell.plugins.length, plugins(assets).length);
  assert.ok(shell.plugins.every((entry) => entry.state === 'active'));
  // Code's read belongs to its UI adapter, so optional tool and REST adapters do not
  // decide whether its graph and integrations can be read. Both retain the same ACL.
  assert.deepEqual(managedCode.status.publication.records, []);
  assert.equal('publications' in managedCode, false, 'hosted records appear only once');
  for (const id of ['code-tools', 'code-work-api']) await app.setEnabled(id, false);
  assert.equal((await tool('code.status', reader)).status, 404);
  assert.equal(
    (await fetch(`${url}/code/github`, { headers: { authorization: `Bearer ${reader}` } })).status,
    503,
  );
  for (const token of [reader, operator]) {
    const read = await tool('ui.read', token, { rowId: 'code' });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.result, managedCode);
  }
  assert.equal((await tool('ui.read', 'invalid', { rowId: 'code' })).status, 401);
  for (const id of ['code-tools', 'code-work-api']) await app.setEnabled(id, true);
  // A reader sees the rows, and no row asks for a number it cannot answer for
  // this caller. A failing status reports itself instead of failing the shell;
  // the registry test above covers that path.
  const readerShell = (await tool('ui.shell', reader)).body.result.rows as {
    id: string;
    status: { state?: string };
  }[];
  assert.equal(
    readerShell.some((entry) => entry.id === 'people'),
    false,
  );
  assert.ok(readerShell.every((entry) => entry.status.state !== 'unavailable'));
  // What a state means comes with the shell: the owner's words on its row, and the gates the
  // catalog marks with the tool that leaves them. The browser holds no program's state words.
  const said = (await tool('ui.shell', reader)).body.result as {
    rows: { id: string; states?: Record<string, unknown> }[];
    workflows: { name: string; edges: { from: string; tool: string | null }[] }[];
  };
  assert.deepEqual(said.rows.find((entry) => entry.id === 'experiments')?.states, {
    planned: { idle: true },
    design_review: { submitted: 'Submitted the design' },
    experiment_review: { submitted: 'Submitted the results' },
  });
  assert.deepEqual(said.rows.find((entry) => entry.id === 'tasks')?.states, {
    in_review: { submitted: 'Delivered' },
  });
  const gates = (name: string) => [
    ...new Set(
      said.workflows
        .filter((shape) => shape.name === name)
        .flatMap((shape) => shape.edges.filter((edge) => edge.tool === 'review.submit'))
        .map((edge) => edge.from),
    ),
  ];
  assert.deepEqual(gates('experiment').sort(), ['design_review', 'experiment_review']);
  assert.deepEqual(gates('task'), ['in_review']);
  assert.deepEqual(gates('research'), []);
  assert.equal(
    (await tool('ui.read', operator, { rowId: 'knowledge' })).body.error.code,
    'row_unreadable',
  );
  // Paper still resolves scoped references through Knowledge without a UI adapter.
  const references = await tool('project.references', reader, { refs: ['artifact:missing'] });
  assert.equal(references.status, 200);
  assert.equal(references.body.result[0].status, 'missing');
  assert.equal((await tool('ui.read', operator, { rowId: 'absent' })).status, 404);
  // Now and the rail share one read, and a part this caller may not read is null rather
  // than a failure that would take the page with it.
  const home = (await tool('ui.home', operator)).body.result as Record<string, unknown>;
  // Code's moves and agents' questions reach it through the gates' blockers, not parts of their own.
  assert.deepEqual(Object.keys(home).sort(), [
    'actors',
    'experiments',
    'project',
    'reflections',
    'research',
    'reviews',
    'tasks',
    'workflows',
  ]);
  assert.ok(Array.isArray(home.experiments) && Array.isArray(home.tasks));
  assert.equal((home.project as { id: string }).id, credentials.project.id);
  assert.deepEqual((await tool('ui.home', reader)).body.result.actors, null);

  // Feed removal drops exactly the feed rows; everything else keeps working; restoration adds no duplicates.
  await app.setEnabled('feed', false);
  assert.deepEqual(await rowIds(), [
    'research',
    'work',

    'tasks',
    'experiments',
    'paper',
    'reviews',

    'sessions',
    'code',
    'artifacts',
    'boards',
    'reflections',
    'settings',
  ]);
  assert.equal(app.status().find((entry) => entry.id === 'feed-ui')?.state, 'pending');
  assert.equal((await raw(url, '/ui/')).status, 200);
  assert.equal((await tool('task.list', operator)).status, 200);
  await app.setEnabled('feed', true);
  assert.deepEqual(await rowIds(), [
    'research',
    'work',

    'tasks',
    'experiments',
    'paper',
    'reviews',

    'sessions',
    'code',
    'feed',
    'artifacts',
    'boards',
    'reflections',
    'settings',
  ]);

  // UI removal withdraws the bundle and its tools while HTTP and MCP keep serving domain tools.
  await app.setEnabled('ui', false);
  // A withdrawn mount answers 503 until it is mounted again.
  assert.equal((await raw(url, '/ui/')).status, 503);
  assert.equal((await tool('ui.shell', operator)).body.error.code, 'unknown_tool');
  assert.equal((await tool('task.list', operator)).status, 200);
  for (const id of [
    'research-ui',
    'paper-ui',
    'reflections-ui',

    'experiments-ui',
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
    'research',
    'work',

    'tasks',
    'experiments',
    'paper',
    'reviews',

    'sessions',
    'code',
    'feed',
    'artifacts',
    'boards',
    'reflections',
    'settings',
  ]);
});

test('a hashed asset is gzipped once, and a HEAD is gzipped never', async (t) => {
  const { serveBundle } = await import('../packages/ui/src/static.js');
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'assets'));
  const write = (path: string, text: string) => writeFileSync(join(directory, path), text);
  const serve = serveBundle(directory);
  const get = async (path: string, method = 'GET') => {
    let sent: { status: number; headers: Record<string, string>; body?: Uint8Array } | undefined;
    const res = {
      setHeader() {},
      writeHead: (status: number, headers: Record<string, string>) =>
        void (sent = { status, headers }),
      end: (body?: Uint8Array) => void (sent!.body = body),
    };
    const req = { method, url: `/ui/${path}`, headers: { 'accept-encoding': 'gzip' } };
    await serve(req as never, res as never, {} as never);
    return sent!;
  };
  const read = async (path: string) => gunzipSync((await get(path)).body!).toString('utf8');
  // A stand-in for "never gzipped again": an asset's name is its content's hash, so what is on
  // disk under it never changes, and what was gzipped first is sent from then on.
  write('assets/app-1.js', 'first');
  assert.equal(await read('assets/app-1.js'), 'first');
  write('assets/app-1.js', 'second');
  assert.equal(await read('assets/app-1.js'), 'first');
  // The page itself is not hashed: it is read and gzipped afresh.
  write('index.html', 'one');
  assert.equal(await read('index.html'), 'one');
  write('index.html', 'two');
  assert.equal(await read('index.html'), 'two');
  // A HEAD says what a GET would send and gzips nothing: what is gzipped first is the GET's.
  write('assets/app-2.js', 'before');
  const head = await get('assets/app-2.js', 'HEAD');
  assert.equal(head.headers['content-encoding'], 'gzip');
  assert.equal(head.body, undefined);
  write('assets/app-2.js', 'after');
  assert.equal(await read('assets/app-2.js'), 'after');
  // What was gzipped once is sent without reading the disk again.
  rmSync(join(directory, 'assets/app-1.js'));
  assert.equal(await read('assets/app-1.js'), 'first');
  // The page is never an asset: no path under assets/ reaches it, nor is cached a year.
  for (const path of ['assets/app', 'assets/missing/', 'assets%2F..%2Findex.html']) {
    const answer = await get(path);
    assert.equal(answer.status, 404, path);
    assert.doesNotMatch(answer.headers['cache-control']!, /immutable/, path);
  }
  write('index.html', 'three');
  assert.equal(await read('index.html'), 'three');
  assert.equal(await read('some/route'), 'three');
});

test('an unbuilt bundle reports itself instead of a blank page', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-unbuilt-'));
  const app = await createApp({
    directory: join(directory, 'data'),
    config: { plugins: plugins(join(directory, 'nowhere')) },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const response = await raw(app.ctx.api.url!, '/ui/');
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).error.code, 'ui_not_built');
});

test('ui.shell reports a rejected optional configuration as failed, as readiness does', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-plugins-'));
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins(join(directory, 'nowhere'), [
        {
          id: 'rejected',
          name: './tests/fixtures/loader-marker.ts',
          required: false,
          config: { value: 1 },
        },
      ]),
    },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const credentials = await app.ctx.scope.credentials.bootstrap({
    projectName: 'UI',
    actorName: 'Operator',
  });
  const response = await fetch(`${app.ctx.api.url}/tools/ui.shell`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const shell = ((await response.json()) as any).result as {
    plugins: { id: string; name: string; state: string }[];
  };
  // Cordis can leave this fiber pending; the table shows createApp's verdict instead.
  assert.equal(shell.plugins.find((entry) => entry.id === 'rejected')?.state, 'failed');
  assert.deepEqual(
    shell.plugins,
    app.status().map(({ id, name, state }) => ({ id, name, state })),
  );
});

test('the Connections row reports mount health and serves mount status through ui.read', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-ui-mounts-'));
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
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  // createApp does not wait for optional upstreams: wait until both mounts finish a round.
  const settled = () => app.ctx.mounts.status().every((mount) => mount.state !== 'connecting');
  for (let wait = 0; wait < 800 && !settled(); wait++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(settled(), 'a mount never settled');
  const credentials = await app.ctx.scope.credentials.bootstrap({
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
  assert.equal(connections.group, 'hidden');
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

test('The Cycles badge counts open cycles without reading every cycle', async () => {
  const ui = new UiRegistry();
  const research = {
    active: async () => 2,
    list: async () => assert.fail('The badge must not read every cycle'),
  };
  researchUiPlugin.apply({ research, ui, effect: (fn: () => unknown) => fn() } as never);
  const [cycles] = await ui.describe(caller);
  assert.deepEqual(cycles.status, { count: 2 });
});

test('Code UI reads publications only from the status it already queried', async () => {
  const ui = new UiRegistry();
  const records = [{ proposalId: 'new' }, { proposalId: 'old' }];
  const hosted = { publication: { records, controls: { blockers: [] } } };
  let failed = false;
  const codeWork = {
    list: async (input: unknown) => {
      assert.deepEqual(input, caller);
      return [];
    },
    status: async (input: unknown) => {
      assert.deepEqual(input, caller);
      if (failed) throw new MervError('unavailable', 'Code is reconnecting', 503);
      return hosted;
    },
    publications: async () => assert.fail('the status already carries the publications'),
  };
  codeUiPlugin.apply({ codeWork, ui, effect: (fn: () => unknown) => fn() } as never);
  assert.deepEqual(await ui.read(caller, 'code'), { commands: [], status: hosted });
  failed = true;
  await assert.rejects(ui.read(caller, 'code'), { code: 'unavailable' });
});
