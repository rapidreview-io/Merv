import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import { MervError, type Json } from '@merv/contracts';
import { UiRegistry } from '@merv/ui';
import { SandboxService, sandboxesPlugin } from '../packages/sandboxes/src/index.js';
import { SandboxClient } from '../packages/sandboxes/src/client.js';
import { sandboxesUiPlugin } from '../packages/sandboxes/src/ui.js';
import { parseManifest } from '../packages/sandboxes/src/manifest.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const caller = { actorId: 'actor_demo', projectId: 'project_demo' };
const stranger = { actorId: 'actor_other', projectId: 'project_other' };
const tokenEnv = 'MERV_SANDBOXES_TEST_TOKEN';
const urlEnv = 'MERV_SANDBOXES_TEST_URL';
const column = (type: string, rest: Json = {}) => ({ label: type, type, ...(rest as object) });
const manifest = (rest: Json = {}) => ({
  version: 1,
  rows: [
    {
      id: 'sandboxes',
      label: 'Sandboxes',
      group: 'operations',
      order: 45,
      icon: 'code',
      collection: {
        noun: { singular: 'sandbox', plural: 'sandboxes' },
        read: '/v1/sandboxes',
        key: 'id',
        title: 'name',
        columns: [column('name', { field: 'name' }), column('state', { field: 'state' })],
        empty: { title: 'No sandboxes', hint: 'A sandbox appears while a machine is leased.' },
        ...(rest as { collection?: object }).collection,
      },
      record: {
        read: '/v1/sandboxes/{id}',
        title: 'name',
        act: [
          { id: 'release', label: 'Release', verb: 'release', tool: 'sandbox.delete' },
          { id: 'extend', label: 'Extend', verb: 'extend', tool: 'sandbox.renew' },
        ],
      },
      ...(rest as object),
    },
  ],
});
const listBody = {
  sandboxes: [{ id: 'sbx_one', name: 'one', state: 'ready', token: 'sbxt_leaked_list' }],
};
const recordBody = {
  id: 'sbx_one',
  name: 'one',
  Secret: 'hidden',
  endpoint: { host: 'one.invalid', token: 'sbxt_leaked_record' },
};

interface Options {
  identity?: Json;
  manifest?: unknown;
  redirect?: boolean;
}
/** A steerable stand-in for merv-sandboxes that records what actually reached it. */
async function fixture(t: TestContext, options: Options = {}) {
  const seen: { path: string; namespace?: string; authorization?: string }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    seen.push({
      path,
      namespace: request.headers['x-sandbox-namespace'] as string | undefined,
      authorization: request.headers.authorization,
    });
    if (options.redirect && path === '/v1/sandboxes') {
      response.writeHead(302, { location: 'https://elsewhere.invalid/v1/sandboxes' });
      return response.end();
    }
    const body =
      path === '/v1/auth/me'
        ? (options.identity ?? { role: 'consumer', namespace: 'demo' })
        : path === '/v1/ui/manifest'
          ? (options.manifest ?? manifest())
          : path === '/v1/sandboxes'
            ? listBody
            : path === '/v1/sandboxes/sbx_one'
              ? recordBody
              : undefined;
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: { code: 'not_found' } }));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  process.env[urlEnv] = `http://127.0.0.1:${port}`;
  process.env[tokenEnv] = 'sbxt_test_consumer_grant';
  t.after(async () => {
    server.close();
    await once(server, 'close');
    delete process.env[urlEnv];
    delete process.env[tokenEnv];
  });
  return { seen, url: process.env[urlEnv]!, close: () => server.close() };
}
const configuration = {
  urlEnv,
  connections: [{ projectId: caller.projectId, namespace: 'demo', tokenEnv }],
  refreshMs: 3_600_000,
};
/** The real composition: the service under a Cordis context with the UI registry. */
async function composed(t: TestContext) {
  const ctx = new Context();
  const ui = new UiRegistry();
  ctx.provide('ui', ui);
  const fiber = ctx.plugin(sandboxesPlugin, configuration);
  ctx.plugin(sandboxesUiPlugin);
  t.after(() => ctx.fiber.dispose());
  await fiber.await();
  await ctx.sandboxes.refresh();
  return { ctx, ui };
}
const failure = (code: string) => (error: unknown) => {
  assert.ok(error instanceof MervError, `${String(error)} is not a MervError`);
  assert.equal(error.code, code);
  return true;
};

test('a manifest is accepted only in the published shape, and unusable controls never register', () => {
  const rows = parseManifest(manifest(), () => false);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].record?.act, [], 'no sandbox tool is registered, so nothing may act');
  const kept = parseManifest(manifest(), (tool) => tool === 'sandbox.renew');
  assert.deepEqual(
    kept[0].record?.act?.map((entry) => entry.tool),
    ['sandbox.renew'],
  );
  const relaxed = parseManifest(
    manifest({
      icon: null,
      record: {
        read: '/v1/sandboxes/{id}',
        title: 'name',
        state: null,
        act: null,
        console: { label: 'Open in the console', href: '/ui/sandboxes/{id}' },
      },
    }),
    () => false,
  );
  assert.equal(relaxed[0].icon, undefined, 'an unavailable value is null, and null means absent');
  assert.equal(relaxed[0].record?.console?.href, '/ui/sandboxes/{id}');
  const rejected: Json[] = [
    manifest({ collection: { columns: [column('sparkline', { field: 'cost' })] } }) as Json,
    manifest({ collection: { read: 'https://elsewhere.invalid/v1/sandboxes' } }) as Json,
    manifest({ collection: { title: 'name); DROP' } }) as Json,
    manifest({ group: 'machines' }) as Json,
    manifest({ id: 'Sandboxes' }) as Json,
    { version: 2, rows: [] } as Json,
  ];
  for (const value of rejected)
    assert.throws(() => parseManifest(value, () => false), failure('invalid_sandbox_manifest'));
});

test('published rows register with the manifest identity, route and view', async (t) => {
  await fixture(t);
  const { ui } = await composed(t);
  const rows = ui.rows();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, 'sandboxes-sandboxes');
  assert.equal(row.path, '/sandboxes');
  assert.equal(row.label, 'Sandboxes');
  assert.equal(row.group, 'operations');
  assert.equal(row.order, 45);
  assert.equal(row.view.kind, 'collection');
  assert.equal(row.view.icon, 'code');
  assert.equal((row.view.spec as { read: string }).read, '/v1/sandboxes');
  assert.deepEqual((row.view.record as { act: [] }).act, []);
  const described = await ui.describe(caller);
  assert.deepEqual(described[0].status, { state: 'ready' });
  assert.ok(!('count' in described[0].status), 'a proxied row cannot know what is open work');
});

test('reads proxy the collection and one record, namespace-scoped and free of secrets', async (t) => {
  const service = await fixture(t);
  const { ui } = await composed(t);
  const list = (await ui.read(caller, 'sandboxes-sandboxes')) as typeof listBody;
  assert.deepEqual(list.sandboxes, [{ id: 'sbx_one', name: 'one', state: 'ready' }]);
  const record = (await ui.read(caller, 'sandboxes-sandboxes', { id: 'sbx_one' })) as Json;
  assert.deepEqual(record, {
    id: 'sbx_one',
    name: 'one',
    endpoint: { host: 'one.invalid' },
    // The manifest's console link may be a path on the service; this says where it lives.
    console_origin: service.url,
  });
  assert.equal(service.seen[0].path, '/v1/auth/me', 'identity is proved before any resource');
  assert.deepEqual(
    service.seen.map((entry) => entry.path).filter((path) => path.startsWith('/v1/sandboxes')),
    ['/v1/sandboxes', '/v1/sandboxes/sbx_one'],
  );
  for (const entry of service.seen) {
    assert.equal(entry.namespace, 'demo');
    assert.equal(entry.authorization, 'Bearer sbxt_test_consumer_grant');
  }
  await assert.rejects(
    ui.read(stranger, 'sandboxes-sandboxes'),
    failure('sandbox_not_connected'),
    'another project has no connection, and input never selects one',
  );
  for (const id of ['../auth/me', 'sbx one', 'sbx_one?x=1'])
    await assert.rejects(
      ui.read(caller, 'sandboxes-sandboxes', { id }),
      failure('invalid_sandbox_id'),
    );
});

test('an administrator grant is refused before any resource is read', async (t) => {
  const service = await fixture(t, { identity: { role: 'administrator', namespace: 'demo' } });
  const sandboxes = new SandboxService(configuration);
  await assert.rejects(
    sandboxes.read(caller, 'sandboxes-sandboxes'),
    failure('row_unreadable'),
    'no manifest has been accepted yet',
  );
  await sandboxes.refresh();
  assert.deepEqual(sandboxes.rows(), []);
  assert.equal(sandboxes.status().state, 'degraded');
  assert.deepEqual(
    service.seen.map((entry) => entry.path),
    ['/v1/auth/me'],
  );
  const wrongNamespace = await fixture(t, { identity: { role: 'consumer', namespace: 'other' } });
  await new SandboxService(configuration).refresh();
  assert.deepEqual(
    wrongNamespace.seen.map((entry) => entry.path),
    ['/v1/auth/me'],
  );
});

test('redirects, foreign origins and credentials outside the environment are refused', async (t) => {
  await fixture(t, { redirect: true });
  const { ui } = await composed(t);
  await assert.rejects(ui.read(caller, 'sandboxes-sandboxes'), failure('sandbox_redirect_refused'));
  const bad = 'MERV_SANDBOXES_TEST_BAD_URL';
  t.after(() => delete process.env[bad]);
  for (const url of [
    undefined,
    'https://sandboxes.invalid/v1',
    'https://user:pw@sandboxes.invalid',
    'https://sandboxes.invalid?namespace=other',
    'sandboxes.invalid',
  ]) {
    if (url === undefined) delete process.env[bad];
    else process.env[bad] = url;
    assert.throws(
      () => new SandboxService({ ...configuration, urlEnv: bad }),
      failure('invalid_sandboxes_config'),
      String(url),
    );
  }
  const client = new SandboxClient(process.env[urlEnv]!);
  await assert.rejects(
    client.read(configuration.connections[0], 'https://elsewhere.invalid/v1/sandboxes'),
    failure('invalid_sandbox_route'),
    'only plain /v1 routes under the configured origin are ever fetched',
  );
  assert.throws(
    () =>
      new SandboxService({
        ...configuration,
        connections: [{ ...configuration.connections[0], token: 'sbxt_inline' }],
      } as never),
    failure('invalid_sandboxes_config'),
    'a secret can only ever be named, never configured',
  );
  const grant = process.env[tokenEnv];
  process.env[tokenEnv] = 'ms_a_merv_credential';
  const local = new SandboxService(configuration);
  await local.refresh();
  assert.equal(local.status().state, 'degraded');
  process.env[tokenEnv] = grant;
});

test('an unreachable service degrades the row and keeps the last manifest', async (t) => {
  const service = await fixture(t);
  const { ui, ctx } = await composed(t);
  assert.equal(ui.rows().length, 1);
  service.close();
  await ctx.sandboxes.refresh();
  const described = await ui.describe(caller);
  assert.equal(described.length, 1, 'the row stays while its last manifest is known');
  assert.equal(described[0].status.state, 'degraded');
  assert.ok(described[0].status.detail, 'the row says why, rather than showing an error page');
  await assert.rejects(ui.read(caller, 'sandboxes-sandboxes'), failure('sandbox_unavailable'));
});

test('the fake control plane publishes a manifest and a fleet this build accepts', async (t) => {
  const port = 3210 + Math.floor(Math.random() * 500) + 1;
  const child = spawn('node', ['--import', 'tsx', 'scripts/fake-sandboxes.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => void child.kill());
  const [ready] = (await once(child.stdout, 'data')) as [Buffer];
  assert.equal(JSON.parse(ready.toString()).url, `http://127.0.0.1:${port}`);
  process.env[urlEnv] = `http://127.0.0.1:${port}`;
  process.env[tokenEnv] = 'sbxt_demo_consumer';
  t.after(() => {
    delete process.env[urlEnv];
    delete process.env[tokenEnv];
  });
  const sandboxes = new SandboxService(configuration);
  await sandboxes.refresh();
  assert.equal(sandboxes.status().state, 'ready');
  assert.equal(sandboxes.rows()[0]?.path, '/sandboxes');
  const list = (await sandboxes.read(caller, 'sandboxes-sandboxes')) as {
    sandboxes: { id: string; state: string; attention: string | null }[];
  };
  assert.deepEqual(
    list.sandboxes.map((entry) => entry.state),
    ['ready', 'ready', 'provisioning', 'ready', 'failed', 'stopped'],
  );
  assert.deepEqual(
    list.sandboxes.filter((entry) => entry.attention).map((entry) => entry.attention),
    ['lease ends in 6m', 'provisioning failed'],
  );
  const record = (await sandboxes.read(caller, 'sandboxes-sandboxes', { id: 'sbx_aurora' })) as {
    ladder: { state: string }[];
    endpoint: Record<string, unknown>;
  };
  assert.equal(record.ladder.length, 5);
  assert.ok(!('token' in record.endpoint), 'the endpoint grant never reaches the browser');
});
