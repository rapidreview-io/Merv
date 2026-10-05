import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createService, type Json } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { NativeConnections } from '../packages/sandboxes/src/native-connections.js';
import {
  NativeMachineReader,
  nativeMachinesRow,
} from '../packages/sandboxes/src/native-machines.js';
import { nativeMigrations } from '../packages/sandboxes/src/native-schema.js';
import { machineNodes, machinePanel } from '../packages/sandboxes/src/running.js';
import { openState } from './fixtures/state.js';

const record = (id = 'sbx_one', namespace = 'ns_old') => ({
  id,
  namespace,
  name: 'Training',
  state: 'ready',
  plugin: 'vast',
  offer: { resources: { gpu: 'H100', gpu_count: 2, cpu: 32, memory_mb: 131072 }, region: 'us' },
  hourly_price: { amount: '3.5', currency: 'USD' },
  cost_so_far: { amount: '7', currency: 'USD' },
  lease_expires_at: new Date(Date.now() + 300000).toISOString(),
  activity: { verdict: 'running' },
  request: { env: { SECRET: 'must-not-escape' } },
  endpoint: { private_key: 'must-not-escape' },
  token: 'must-not-escape',
});
async function foundation(t: TestContext) {
  const state = await openState();
  await state.migrate('sandboxes-native', nativeMigrations);
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const calls: { path: string; auth: string | null; after: string | null }[] = [];
  const control = {
    malformed: false,
    repeat: false,
    refuse: false,
    onRequest: undefined as ((url: URL) => Promise<void>) | undefined,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ path: url.pathname, auth, after: url.searchParams.get('after') });
    await control.onRequest?.(url);
    if (control.refuse) return Response.json({}, { status: 403 });
    const old = url.pathname.includes('/grant_old/');
    assert.equal(
      auth,
      old ? 'Bearer sbxt_old_secret_for_tests' : 'Bearer sbxt_new_secret_for_tests',
    );
    const namespace = control.malformed ? 'foreign' : old ? 'ns_old' : 'ns_new';
    if (/\/machines\/[^/]+$/.test(url.pathname))
      return (url.pathname.endsWith('/sbx_one') && old) ||
        (url.pathname.endsWith('/sbx_three') && !old)
        ? Response.json(record(old ? 'sbx_one' : 'sbx_three', namespace))
        : Response.json({}, { status: 404 });
    if (old)
      return Response.json({
        namespace,
        sandboxes: [record(url.searchParams.has('after') ? 'sbx_two' : 'sbx_one', namespace)],
        next: !url.searchParams.has('after') || control.repeat ? 'sbx_one' : null,
      });
    return Response.json({ namespace, sandboxes: [record('sbx_three', namespace)], next: null });
  };
  const connections = new NativeConnections(
    state,
    scope,
    {
      applicationId: 'test',
      applicationSecretEnv: 'APP',
      encryptionKeyEnv: 'KEY',
      publicOrigin: 'https://merv.example',
    },
    'https://sandbox.example',
    { KEY: Buffer.alloc(32, 4).toString('base64url'), APP: 'synthetic-application-secret' },
    fetcher,
  );
  await state.transaction(async (tx) => {
    for (const suffix of ['old', 'new']) {
      await tx.run(
        'INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at) VALUES(?,?,?,?,?,?,?)',
        `conn_${suffix}`,
        'project_test',
        `root_${suffix}`,
        `account_${suffix}`,
        `member_${suffix}`,
        connections.credentials.seal(
          { bearer: `sbxt_${suffix}_secret_for_tests` },
          `connection:conn_${suffix}`,
        ),
        new Date().toISOString(),
      );
      await tx.run(
        'INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace) VALUES(?,?,?,?,?,?)',
        'project_test',
        'task',
        `work_${suffix}`,
        `conn_${suffix}`,
        `grant_${suffix}`,
        `ns_${suffix}`,
      );
    }
    await tx.run(
      'INSERT INTO sandbox_native_projects(project_id,connection_id) VALUES(?,?)',
      'project_test',
      'conn_new',
    );
  });
  return {
    state,
    connections,
    reader: new NativeMachineReader(state, connections),
    calls,
    control,
  };
}

test('native machine reads aggregate all pinned payers and pages without copying secret fields', async (t) => {
  const f = await foundation(t);
  const rows = await f.reader.list('project_test');
  assert.equal(rows.length, 3);
  assert.deepEqual(
    new Set(f.calls.map((c) => c.auth)),
    new Set(['Bearer sbxt_old_secret_for_tests', 'Bearer sbxt_new_secret_for_tests']),
  );
  assert.ok(f.calls.some((c) => c.after === 'sbx_one'));
  assert.doesNotMatch(JSON.stringify(rows), /must-not-escape|private_key|request|token/);
  const one = rows.find((r) => (r as { id: string }).id === 'sbx_one') as Record<string, Json>;
  assert.equal(one.native_console_url, 'https://sandbox.example/ui');
  assert.deepEqual((one.offer as { resources: unknown }).resources, record().offer.resources);
  const before = f.calls.length;
  assert.deepEqual(await f.reader.list('foreign_project'), []);
  assert.equal(await f.reader.record('foreign_project', 'sbx_one'), null);
  assert.equal(f.calls.length, before);
  assert.equal(
    ((await f.reader.record('project_test', 'sbx_one')) as { id: string }).id,
    'sbx_one',
  );
  assert.equal(await f.reader.record('project_test', 'missing'), null);
  // Closed work whose cleanup settled holds only stopped machines and is no longer read.
  await f.state.transaction((tx) =>
    tx.run("UPDATE sandbox_native_work SET closed_at='2026-01-01' WHERE work_id='work_old'"),
  );
  assert.deepEqual(
    (await f.reader.list('project_test')).map((row) => (row as { id: string }).id),
    ['sbx_three'],
  );
});

test('native machines refuse cross-work provenance, looping pages, and unavailable roots', async (t) => {
  const f = await foundation(t);
  f.control.malformed = true;
  await assert.rejects(f.reader.list('project_test'), { code: 'sandbox_machines_invalid' });
  await assert.rejects(f.reader.record('project_test', 'sbx_one'), {
    code: 'sandbox_machines_invalid',
  });
  f.control.malformed = false;
  f.control.repeat = true;
  await assert.rejects(f.reader.list('project_test'), { code: 'sandbox_machines_invalid' });
  f.control.repeat = false;
  f.control.refuse = true;
  await assert.rejects(f.reader.list('project_test'), { code: 'sandbox_access_revoked' });
});

test('native hardware uses existing Running anatomy with console-only actions', async (t) => {
  const f = await foundation(t);
  const rows = await f.reader.list('project_test');
  const machines = { rows, observedAt: new Date().toISOString(), failed: false, freshForMs: 10000 };
  const board = machineNodes(machines, Date.now());
  assert.equal(board.nodes.length, 3);
  assert.equal(board.nodes[0]!.title, '2× H100');
  assert.equal(board.nodes[0]!.units?.busy, true);
  const panel = machinePanel({
    id: 'sbx_one',
    machines,
    record: null,
    allowed: true,
    route: '/sandboxes/sbx_one',
    now: Date.now(),
  })!;
  assert.deepEqual(panel.actions, []);
  assert.equal(panel.route, '/compute/sbx_one');
  assert.match(JSON.stringify(panel.sections), /Manage in Sandboxes/);
  assert.deepEqual(panel.header?.attention?.to, {
    href: 'https://sandbox.example/ui',
    text: 'Manage in Sandboxes',
  });
  assert.deepEqual((nativeMachinesRow.view.record as { act: unknown[] }).act, []);
});

test('unknown native hardware is not presented as a known CPU shape', () => {
  const rows = [
    {
      id: 'sbx_unknown',
      name: 'Unknown shape',
      state: 'ready',
      native_console_url: 'https://sandbox.example/ui',
      offer: { resources: { cpu: null, memory_mb: null, gpu: null, gpu_count: 0 } },
      activity: {},
    },
  ] as Json[];
  assert.equal(
    machineNodes({ rows, observedAt: null, failed: false, freshForMs: 1000 }, Date.now()).nodes[0]!
      .title,
    'Machine',
  );
});

test('existing cache merges native and legacy machines, routes records, and keeps stale rows on failure', async (t) => {
  const { SandboxService } = await import('../packages/sandboxes/src/index.js');
  const f = await foundation(t);
  const env = 'MERV_NATIVE_MACHINE_CACHE_URL',
    token = 'MERV_NATIVE_MACHINE_CACHE_TOKEN';
  const previous = process.env[env],
    previousToken = process.env[token];
  process.env[env] = 'https://sandbox.example';
  process.env[token] = 'sbxt_legacy_machine_test';
  t.after(() => {
    if (previous === undefined) delete process.env[env];
    else process.env[env] = previous;
    if (previousToken === undefined) delete process.env[token];
    else process.env[token] = previousToken;
  });
  const legacyPaths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    legacyPaths.push(path);
    return Response.json(
      path === '/v1/auth/me'
        ? { role: 'consumer', namespace: 'legacy' }
        : path === '/v1/sandboxes'
          ? { sandboxes: [record('sbx_legacy', 'legacy')] }
          : path === '/v1/sandboxes/sbx_legacy'
            ? record('sbx_legacy', 'legacy')
            : { version: 1, rows: [] },
    );
  });
  const service = new SandboxService({
    urlEnv: env,
    connections: [{ projectId: 'project_test', namespace: 'legacy', tokenEnv: token }],
  });
  service.bindNativeMachines(f.reader);
  t.after(() => service.close());
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  service.watch('project_test');
  t.mock.timers.tick(1000);
  const until = async (done: () => boolean) => {
    for (let i = 0; !done(); i++) {
      assert.ok(i < 400, 'cache did not settle');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await until(() => service.machines('project_test')?.rows.length === 4);
  service.watch('project_test', 'sbx_one');
  service.watch('project_test', 'sbx_legacy');
  t.mock.timers.tick(1000);
  await until(
    () =>
      !!service.machine('project_test', 'sbx_one') &&
      !!service.machine('project_test', 'sbx_legacy'),
  );
  assert.ok(f.calls.some((c) => c.path.endsWith('/machines/sbx_one')));
  assert.ok(!legacyPaths.includes('/v1/sandboxes/sbx_one'));
  assert.ok(legacyPaths.includes('/v1/sandboxes/sbx_legacy'));
  const rows = service.machines('project_test')!.rows;
  f.control.refuse = true;
  t.mock.timers.tick(5000);
  await until(() => !!service.machines('project_test')?.failed);
  assert.deepEqual(service.machines('project_test')!.rows, rows);
});

test('native-only Compute registers the existing collection renderer and reads only the caller project', async (t) => {
  const { Context } = await import('cordis');
  const { UiRegistry } = await import('@merv/ui');
  const { sandboxesUiPlugin } = await import('../packages/sandboxes/src/ui.js');
  const { SandboxService } = await import('../packages/sandboxes/src/index.js');
  const f = await foundation(t);
  const env = 'MERV_NATIVE_MACHINE_UI_URL',
    previous = process.env[env];
  process.env[env] = 'https://sandbox.example';
  t.after(() => {
    if (previous === undefined) delete process.env[env];
    else process.env[env] = previous;
  });
  const service = new SandboxService({
    urlEnv: env,
    connections: [],
    native: {
      applicationId: 'test',
      applicationSecretEnv: 'APP',
      encryptionKeyEnv: 'KEY',
      publicOrigin: 'https://merv.example',
    },
  });
  service.bindNativeMachines(f.reader);
  t.after(() => service.close());
  const ctx = new Context(),
    ui = new UiRegistry();
  ctx.provide('ui', ui);
  ctx.provide('sandboxes', service);
  ctx.provide('scope', { require: async () => {} } as never);
  const fiber = ctx.plugin(sandboxesUiPlugin);
  t.after(() => ctx.fiber.dispose());
  await fiber.await();
  assert.equal(ui.rows().find((row) => row.id === nativeMachinesRow.id)?.view.kind, 'collection');
  const caller = { projectId: 'project_test', actorId: 'actor_test' };
  assert.equal(
    ((await ui.read(caller, nativeMachinesRow.id)) as { sandboxes: unknown[] }).sandboxes.length,
    3,
  );
  assert.equal(
    ((await ui.read(caller, nativeMachinesRow.id, { id: 'sbx_one' })) as { id: string }).id,
    'sbx_one',
  );
  assert.deepEqual(
    await ui.read({ ...caller, projectId: 'foreign_project' }, nativeMachinesRow.id),
    { sandboxes: [] },
  );
  await assert.rejects(
    ui.read({ ...caller, projectId: 'foreign_project' }, nativeMachinesRow.id, { id: 'sbx_one' }),
    { code: 'not_found' },
  );
  await fiber.dispose();
  assert.equal(
    ui.rows().some((row) => row.id === nativeMachinesRow.id),
    false,
  );
});

for (const status of ['revoked_at', 'revoke_pending'] as const)
  test(`native machine reads omit ${status} roots while preserving live reconnected work`, async (t) => {
    const f = await foundation(t);
    await f.state.transaction((tx) =>
      tx.run(
        status === 'revoked_at'
          ? "UPDATE sandbox_native_connections SET revoked_at='2026-10-01' WHERE id='conn_old'"
          : "UPDATE sandbox_native_connections SET revoke_pending=TRUE WHERE id='conn_old'",
      ),
    );
    assert.deepEqual(
      (await f.reader.list('project_test')).map((row) => (row as { id: string }).id),
      ['sbx_three'],
    );
    assert.equal(await f.reader.record('project_test', 'sbx_one'), null);
    assert.equal(
      ((await f.reader.record('project_test', 'sbx_three')) as { id: string }).id,
      'sbx_three',
    );
    assert.ok(f.calls.every((call) => !call.path.includes('/grant_old/')));
  });

test('local revocation during native paging discards every page from that root', async (t) => {
  const f = await foundation(t);
  f.control.onRequest = async (url) => {
    if (url.pathname.includes('/grant_old/') && url.searchParams.has('after'))
      await f.state.transaction((tx) =>
        tx.run("UPDATE sandbox_native_connections SET revoke_pending=TRUE WHERE id='conn_old'"),
      );
  };
  assert.deepEqual(
    (await f.reader.list('project_test')).map((row) => (row as { id: string }).id),
    ['sbx_three'],
  );
  assert.ok(f.calls.some((call) => call.after === 'sbx_one'));
});

test('local revocation while reading a native machine withholds its record', async (t) => {
  const f = await foundation(t);
  f.control.onRequest = async (url) => {
    if (url.pathname.endsWith('/machines/sbx_one') && url.pathname.includes('/grant_old/'))
      await f.state.transaction((tx) =>
        tx.run("UPDATE sandbox_native_connections SET revoke_pending=TRUE WHERE id='conn_old'"),
      );
  };
  assert.equal(await f.reader.record('project_test', 'sbx_one'), null);
  assert.equal(
    ((await f.reader.record('project_test', 'sbx_three')) as { id: string }).id,
    'sbx_three',
  );
});
