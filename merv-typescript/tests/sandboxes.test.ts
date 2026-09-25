import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Context } from 'cordis';
import { check, MervError, type Caller, type Json } from '@merv/contracts';
import { UiRegistry } from '@merv/ui';
import { SandboxService, sandboxesPlugin, sandboxTools } from '../packages/sandboxes/src/index.js';
import { SandboxClient } from '../packages/sandboxes/src/client.js';
import { sandboxesUiPlugin } from '../packages/sandboxes/src/ui.js';
import { sandboxesToolsPlugin } from '../packages/sandboxes/src/tools.js';
import { parseManifest } from '../packages/sandboxes/src/manifest.js';
import { fleetConfig } from '../packages/fleet/src/index.js';
import { piConfig } from '../packages/pi/src/schema.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const caller = { actorId: 'actor_demo', projectId: 'project_demo' };
const reader = { actorId: 'actor_reader', projectId: 'project_demo' };
const stranger = { actorId: 'actor_other', projectId: 'project_other' };
const proved = { namespace: 'demo', authorization: 'Bearer sbxt_test_consumer_grant' };
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
          { id: 'release', label: 'Release', verb: 'release', tool: 'sandbox.release' },
          { id: 'extend', label: 'Extend', verb: 'extend', tool: 'sandbox.extend' },
          { id: 'attach', label: 'Attach', verb: 'claim', tool: 'sandbox.attach' },
        ],
      },
      ...(rest as object),
    },
  ],
});
/** A hosted agent's machine in the same namespace: Fleet's, never a project row's. */
const hostedBody = {
  id: 'sbx_agent',
  name: 'agent',
  state: 'ready',
  request: { protected_runtime: true },
};
const listBody = {
  sandboxes: [
    { id: 'sbx_one', name: 'one', state: 'ready', token: 'sbxt_leaked_list' },
    hostedBody,
  ],
};
const recordBody = {
  id: 'sbx_one',
  revision: 1,
  name: 'one',
  Secret: 'hidden',
  endpoint: { host: 'one.invalid', token: 'sbxt_leaked_record' },
};

interface Options {
  identity?: Json;
  manifest?: unknown;
  redirect?: boolean;
}
interface Seen {
  path: string;
  method: string;
  sent?: Json;
  namespace?: string;
  authorization?: string;
}
/** A steerable stand-in for merv-sandboxes that records what actually reached it. */
async function fixture(t: TestContext, options: Options = {}) {
  const seen: Seen[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    let text = '';
    for await (const chunk of request) text += String(chunk);
    seen.push({
      path,
      method,
      ...(text ? { sent: JSON.parse(text) as Json } : {}),
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
            : path === '/v1/sandboxes/sbx_one/renew'
              ? {
                  ...recordBody,
                  lease_seconds: (seen.at(-1)?.sent as { lease_seconds?: number })?.lease_seconds,
                }
              : path === '/v1/sandboxes/sbx_one'
                ? recordBody
                : path === '/v1/sandboxes/sbx_agent'
                  ? hostedBody
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
test('configured project connections accept 33 and 256, but reject 257 and duplicates', (t) => {
  const previousUrl = process.env[urlEnv];
  process.env[urlEnv] = 'https://sandboxes.example';
  t.after(() => {
    if (previousUrl === undefined) delete process.env[urlEnv];
    else process.env[urlEnv] = previousUrl;
  });
  const connections = Array.from({ length: 257 }, (_, index) => ({
    projectId: `project_${index}`,
    namespace: `namespace_${index}`,
    tokenEnv: `SANDBOX_GRANT_${index}`,
  }));
  for (const count of [33, 256]) {
    const service = new SandboxService({
      ...configuration,
      connections: connections.slice(0, count),
    });
    service.close();
  }
  assert.throws(
    () => new SandboxService({ ...configuration, connections }),
    failure('invalid_sandboxes_config'),
  );
  assert.throws(
    () =>
      new SandboxService({
        ...configuration,
        connections: [...connections.slice(0, 32), connections[0]],
      }),
    failure('invalid_sandboxes_config'),
  );
});
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
/** The tools as this process registers them, over a scope that records what they demanded. */
async function armed(t: TestContext) {
  const demanded: string[] = [];
  const defined = new Map<string, { inputSchema: Schema; handler: Handler }>();
  const ctx = new Context();
  ctx.provide('tools', {
    register: (definition: { name: string; inputSchema: Schema; handler: Handler }) => {
      defined.set(definition.name, definition);
      return () => defined.delete(definition.name);
    },
  } as never);
  ctx.provide('scope', {
    require: async (actor: Caller, permission: string) => {
      demanded.push(permission);
      check(
        permission === 'read' || actor.actorId !== reader.actorId,
        'forbidden',
        'A reader may not change a sandbox',
        403,
      );
    },
  } as never);
  const fiber = ctx.plugin(sandboxesPlugin, configuration);
  await ctx.plugin(sandboxesToolsPlugin).await();
  t.after(() => ctx.fiber.dispose());
  await fiber.await();
  /** Exactly what a transport does: refuse the input the schema refuses, then dispatch. */
  const call = async (name: string, actor: Caller, input: Json) => {
    const definition = defined.get(name);
    check(definition, 'unknown_tool', `${name} is not registered`);
    const parsed = definition.inputSchema.safeParse(input);
    check(parsed.success, 'invalid_input', 'The tool refused its input');
    return await definition.handler(actor, parsed.data as Json);
  };
  return { call, defined, demanded, ctx };
}
type Schema = { safeParse(value: unknown): { success: boolean; data: unknown } };
type Handler = (actor: Caller, input: Json) => Promise<Json>;

/** The shipped fake control plane on its own port, answering as the real service does. */
async function plane(t: TestContext) {
  const child = spawn('node', ['--import', 'tsx', 'scripts/fake-sandboxes.ts'], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => void child.kill());
  const [ready] = (await once(child.stdout, 'data')) as [Buffer];
  const url = new URL(JSON.parse(ready.toString()).url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0);
  process.env[urlEnv] = url.origin;
  process.env[tokenEnv] = 'sbxt_demo_consumer';
  t.after(() => {
    delete process.env[urlEnv];
    delete process.env[tokenEnv];
  });
}

const failure = (code: string) => (error: unknown) => {
  assert.ok(error instanceof MervError, `${String(error)} is not a MervError`);
  assert.equal(error.code, code);
  return true;
};

test('a manifest is accepted only in the published shape, and unusable controls never register', () => {
  const kept = parseManifest(manifest());
  assert.equal(kept.length, 1);
  assert.deepEqual(
    kept[0].record?.act?.map((entry) => entry.tool),
    ['sandbox.release', 'sandbox.extend'],
    'the two tools this package ships survive; sandbox.attach is not one of them',
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
    assert.throws(() => parseManifest(value), failure('invalid_sandbox_manifest'));
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
  assert.deepEqual(
    (row.view.record as { act: { tool: string }[] }).act.map((entry) => entry.tool),
    ['sandbox.release', 'sandbox.extend'],
    'the plugin answers for its own tools, so the browser renders controls it can dispatch',
  );
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
    revision: 1,
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
    ui.read(caller, 'sandboxes-sandboxes', { id: 'sbx_agent' }),
    failure('sandbox_protected'),
  );
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
  await plane(t);
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

test('the two tools send the service exactly one change, under a write grant', async (t) => {
  const service = await fixture(t);
  const { call, defined, demanded } = await armed(t);
  assert.deepEqual([...defined.keys()], sandboxTools);
  const renewed = await call('sandbox.extend', caller, { id: 'sbx_one', seconds: 3600 });
  assert.deepEqual(demanded, ['write'], 'changing a machine is a write, like every other change');
  assert.equal((renewed as { lease_seconds: number }).lease_seconds, 3600);
  const released = await call('sandbox.release', caller, { id: 'sbx_one' });
  assert.deepEqual(released, {
    id: 'sbx_one',
    revision: 1,
    name: 'one',
    endpoint: { host: 'one.invalid' },
  });
  // The browser's guard is the retention confirmation the legacy tool asked for in a second call.
  assert.deepEqual(
    service.seen.filter((entry) => entry.method !== 'GET'),
    [
      {
        path: '/v1/sandboxes/sbx_one/renew',
        method: 'POST',
        sent: { lease_seconds: 3600, expected_revision: 1 },
        ...proved,
      },
      {
        path: '/v1/sandboxes/sbx_one',
        method: 'DELETE',
        sent: { confirm_retained: true },
        ...proved,
      },
    ],
  );
  assert.match(
    service.seen.map((entry) => entry.method).join(' '),
    /GET POST GET DELETE GET$/,
    'a lease is read before it is renewed; a release reads the record before and after',
  );
  const refused: [string, Caller, Json, string][] = [
    ['sandbox.extend', reader, { id: 'sbx_one', seconds: 3600 }, 'forbidden'],
    ['sandbox.release', stranger, { id: 'sbx_one' }, 'sandbox_not_connected'],
    ['sandbox.extend', caller, { id: 'sbx_one', seconds: 30 }, 'invalid_input'],
    ['sandbox.extend', caller, { id: 'sbx_one', seconds: 90_000 }, 'invalid_input'],
    ['sandbox.extend', caller, { id: 'sbx_one', seconds: 3600.5 }, 'invalid_input'],
    ['sandbox.release', caller, {}, 'invalid_input'],
    ['sandbox.release', caller, { id: 'sbx_one', force: true }, 'invalid_input'],
    ['sandbox.release', caller, { id: 'sbx one' }, 'invalid_sandbox_id'],
    ['sandbox.release', caller, { id: 'sbx_agent' }, 'sandbox_protected'],
    ['sandbox.extend', caller, { id: 'sbx_agent', seconds: 3600 }, 'sandbox_protected'],
  ];
  for (const [name, actor, input, code] of refused)
    await assert.rejects(call(name, actor, input), failure(code), JSON.stringify(input));
  assert.ok(
    service.seen.every((entry) => entry.method === 'GET' || entry.path.includes('sbx_one')),
  );
});

test('sandbox operations retain their original project and target while queued', async (t) => {
  const remote = await fixture(t);
  const service = new SandboxService(configuration);
  t.after(() => service.close());
  await service.refresh();
  for (const operation of ['read', 'extend', 'release'] as const) {
    await t.test(operation, async () => {
      const source = { ...caller };
      const input = { id: 'sbx_one', seconds: 600, params: { id: 'sbx_one' } };
      const pending =
        operation === 'read'
          ? service.read(source, 'sandboxes-sandboxes', { params: input.params })
          : service[operation](source, input);
      source.projectId = stranger.projectId;
      input.id = input.params.id = 'sbx_missing';
      input.seconds = 999;
      const result = (await pending) as { id: string; lease_seconds?: number };
      assert.equal(result.id, 'sbx_one');
      if (operation === 'extend') assert.equal(result.lease_seconds, 600);
      const denied = { ...stranger },
        before = remote.seen.length;
      const refused =
        operation === 'read'
          ? service.read(denied, 'sandboxes-sandboxes')
          : service[operation](denied, { id: 'sbx_one', seconds: 600 });
      denied.projectId = caller.projectId;
      await assert.rejects(refused, { code: 'sandbox_not_connected' });
      assert.equal(remote.seen.length, before);
    });
  }
});

test('the service refuses what it may not do, and a released machine releases once', async (t) => {
  await plane(t);
  const { call } = await armed(t);
  // flint is stopped: the refusal is the service's own, not a guess this process makes.
  await assert.rejects(
    call('sandbox.extend', caller, { id: 'sbx_flint', seconds: 1800 }),
    (error) => {
      assert.ok(error instanceof MervError);
      assert.deepEqual(
        [error.code, error.message, error.status],
        ['sandbox_operation_state', 'sandbox lease can only be renewed while it is live', 409],
      );
      return true;
    },
  );
  const gone = call('sandbox.extend', caller, { id: 'sbx_absent', seconds: 1800 });
  await assert.rejects(gone, failure('sandbox_not_found'));
  // basalt has about three hours left; adding one leaves about four, never one.
  const extended = (await call('sandbox.extend', caller, { id: 'sbx_basalt', seconds: 3600 })) as {
    lease_seconds: number;
    lease_expires_at: string;
  };
  const asked = 181 * 60 + 3600;
  assert.ok(Math.abs(extended.lease_seconds - asked) <= 2, String(extended.lease_seconds));
  const left = (Date.parse(extended.lease_expires_at) - Date.now()) / 1000;
  assert.ok(left > asked - 10 && left <= asked, `${left} seconds left, not about four hours`);
  const states: string[] = [];
  for (const _ of [0, 1])
    states.push(
      ((await call('sandbox.release', caller, { id: 'sbx_dunes' })) as Record<string, string>)
        .state,
    );
  assert.deepEqual(states, ['stopped', 'stopped'], 'releasing twice is releasing once');
  await assert.rejects(
    call('sandbox.extend', caller, { id: 'sbx_dunes', seconds: 1800 }),
    failure('sandbox_operation_state'),
  );
});

test('a deployment composes the sandboxes plugins only when the service is named', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-sandboxes-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'dist/config'), { recursive: true });
  mkdirSync(join(directory, 'deploy'));
  for (const name of ['render-config.mjs', 'schema.mjs'])
    copyFileSync(join(root, 'deploy', name), join(directory, 'deploy', name));
  writeFileSync(
    join(directory, 'dist/config/default.json'),
    JSON.stringify({
      plugins: 'state scope blobs identity api ui code code-research sessions'
        .split(' ')
        .map((id) => ({ id, name: id })),
    }),
  );
  const output = join(directory, 'rendered.json');
  const env = Object.fromEntries(
    `MERV_TS_AUTH_MODE=hs256 MERV_BLOB_PREFIX=merv-ts MERV_DB_URL=postgresql://unused
     MERV_BLOB_BUCKET=x MERV_BLOB_ENDPOINT_URL=https://storage.example MERV_BLOB_ACCESS_KEY_ID=x
     MERV_BLOB_SECRET_ACCESS_KEY=x SUPABASE_ANON_KEY=x SUPABASE_JWT_SECRET=x
     SUPABASE_URL=https://identity.example MERV_TS_PUBLIC_ORIGIN=https://merv.example`
      .split(/\s+/)
      .map((pair): [string, string] => [
        pair.slice(0, pair.indexOf('=')),
        pair.slice(pair.indexOf('=') + 1),
      ]),
  );
  const run = (extra: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [join(directory, 'deploy/render-config.mjs'), output], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    }).status;
  const rendered = () =>
    (JSON.parse(readFileSync(output, 'utf8')) as { plugins: { name: string; config?: Json }[] })
      .plugins;
  assert.equal(run({}), 0);
  assert.equal(rendered().length, 9, 'a deployment that has named no service composes none of it');
  const connections = [
    { projectId: 'project_one', namespace: 'research', tokenEnv: 'MERV_SANDBOXES_TOKEN' },
  ];
  const named = {
    MERV_SANDBOXES_URL: 'https://sandboxes.example',
    MERV_SANDBOXES_CONNECTIONS: JSON.stringify(connections),
    MERV_SANDBOXES_TOKEN: 'sbxt_fixture',
  };
  assert.equal(run(named), 0);
  assert.deepEqual(
    rendered()
      .slice(9)
      .map((entry) => entry.name),
    ['@merv/sandboxes/tools', '@merv/sandboxes/ui', '@merv/sandboxes'],
  );
  assert.deepEqual(rendered().at(-1)?.config, { urlEnv: 'MERV_SANDBOXES_URL', connections });
  for (const broken of [
    { MERV_SANDBOXES_CONNECTIONS: undefined },
    { MERV_SANDBOXES_CONNECTIONS: '[]' },
    { MERV_SANDBOXES_URL: 'https://sandboxes.example/v1' },
    // A literal grant can never be configured: only the name of a variable holding one.
    {
      MERV_SANDBOXES_CONNECTIONS: '[{"projectId":"p","namespace":"n","tokenEnv":"T","token":"s"}]',
    },
    { MERV_SANDBOXES_CONNECTIONS: '[{"projectId":"p","namespace":"N","tokenEnv":"T"}]' },
  ])
    assert.notEqual(run({ ...named, ...broken }), 0, JSON.stringify(broken));

  // One machine catalog feeds Sandboxes, Fleet and Pi, and every Pi machine is rented by the
  // connected host project: what the deployment renders, each plugin's own schema accepts.
  const machine = (key: string, offerId: string, releaseDigit: string) => ({
    key,
    label: key[0].toUpperCase() + key.slice(1),
    provider: key === 'standard' ? 'cloudflare-fleet' : 'cloudflare-fleet-large',
    offerId,
    releaseId: `rt1_${releaseDigit.repeat(64)}`,
    leaseSeconds: 900,
  });
  const hosted = {
    ...named,
    MERV_SANDBOXES_CONNECTIONS: JSON.stringify([
      ...connections,
      { projectId: 'project_host', namespace: 'merv-pi-host', tokenEnv: 'MERV_PI_HOST_GRANT' },
    ]),
    MERV_PI_HOST_GRANT: 'sbxt_host_fixture',
    MERV_FLEET_ENABLED: 'true',
    MERV_FLEET_MANAGED_SECRET_ENV: 'MERV_MANAGED',
    MERV_MANAGED: 'm'.repeat(32),
    MERV_FLEET_RUNTIMES: JSON.stringify([
      { ...machine('standard', 'standard-1:cloudflare', 'a'), slots: 3 },
      { ...machine('large', 'standard-3:cloudflare', 'b'), slots: 4, agent: true },
    ]),
    MERV_FLEET_PROJECT_LIMITS: '{"project_host":50}',
    MERV_PI_ENABLED: 'true',
    MERV_PI_SECRET_ENV: 'MERV_PI_SECRET_FIXTURE',
    MERV_PI_SECRET_FIXTURE: 'p'.repeat(32),
    MERV_PI_MODEL_API_KEY_ENV: 'MERV_PI_MODEL_FIXTURE',
    MERV_PI_MODEL_FIXTURE: 'model-key',
    MERV_PI_HOST_PROJECT_ID: 'project_host',
    MERV_PI_HOST_KEY_ENV: 'MERV_PI_HOST_KEY',
    MERV_PI_HOST_KEY: 'k'.repeat(43),
    MERV_PI_AGENT_MOVES: 'true',
  };
  assert.equal(run(hosted), 0);
  const config = (name: string) => rendered().find((entry) => entry.name === name)?.config;
  // Sandboxes accepts the catalog exactly as rendered: a profile per machine, the default first.
  process.env.MERV_SANDBOXES_URL = named.MERV_SANDBOXES_URL;
  t.after(() => delete process.env.MERV_SANDBOXES_URL);
  assert.deepEqual(
    new SandboxService(config('@merv/sandboxes') as never).runtimes?.profiles.map((p) => p.key),
    ['standard', 'large'],
  );
  assert.deepEqual(fleetConfig.parse(config('@merv/fleet')).projectLimits, { project_host: 50 });
  const pi = piConfig.parse(config('@merv/pi'));
  assert.throws(() => piConfig.parse({ ...pi, host: undefined }), /host project/);
  assert.equal(pi.runtimeKey, 'project');
  assert.deepEqual(pi.host, { projectId: 'project_host', credentialEnv: 'MERV_PI_HOST_KEY' });
  assert.deepEqual(
    pi.machines.map((machine) => [machine.key, machine.slots, machine.agent]),
    [
      ['standard', 3, false],
      ['large', 4, true],
    ],
  );
  assert.equal(pi.agentMoves, true);
  assert.notEqual(run({ ...hosted, MERV_PI_HOST_PROJECT_ID: 'project_one_other' }), 0);
});
