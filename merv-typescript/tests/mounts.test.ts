import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from 'cordis';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
import { ToolRegistry } from '@merv/api';
import type { CredentialBinding } from '@merv/mounts/types';
import type { MountConfig } from '@merv/mounts/types';
import { MountManager, mountsPlugin } from '../packages/mounts/src/index.js';
import {
  RemoteFixture,
  representativeTools,
  representativeResult,
} from './fixtures/remote-server.js';
import { CredentialServer } from './fixtures/credential-server.js';

async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const end = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function local(t: TestContext, mountIds = ['fixture']) {
  const state = new SqliteState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const admin = await scope.bootstrap({ projectName: 'Mounts', actorName: 'Operator' });
  const caller = { actorId: admin.actor.id, projectId: admin.project.id };
  const access = scope.toolPolicy;
  access.replace(
    mountIds.map((mountId) => ({ ...caller, mountId, tools: ['media', 'inspect', 'failure'] })),
  );
  const env = `MERV_MOUNT_TEST_${randomUUID().replaceAll('-', '_')}`;
  process.env[env] = 'synthetic-mount-caller-token';
  const bindings = mountIds.map((mountId) => ({
    id: `binding-${mountId}`,
    ...caller,
    mountId,
    secretRef: `env:${env}`,
  }));
  const credentials = new EnvironmentCredentials(scope, bindings);
  const registry = new ToolRegistry(scope, access);
  registry.register({
    name: 'native',
    description: 'Independent native operation',
    inputSchema: z.object({}).strict(),
    handler: () => 'native-alive',
  });
  t.after(async () => {
    await registry.close();
    await state.close();
    delete process.env[env];
  });
  return { state, scope, caller, access, credentials, registry, bindings, env };
}
async function remote(
  t: TestContext,
  options: ConstructorParameters<typeof RemoteFixture>[0] = {},
) {
  const fixture = new RemoteFixture(options);
  await fixture.start();
  t.after(() => fixture.close());
  return fixture;
}
async function mounted(
  t: TestContext,
  services: Awaited<ReturnType<typeof local>>,
  mounts: MountConfig[],
) {
  const ctx = new Context();
  ctx.provide('tools', services.registry);
  ctx.provide('scope', services.scope);
  const fiber = ctx.plugin(mountsPlugin, { mounts, bindings: services.bindings });
  t.after(() => ctx.fiber.dispose());
  await fiber.await();
  assert.equal(ctx.get('credentials'), undefined, 'Credentials is internal to Mounts');
  return { ctx, fiber, manager: ctx.mounts };
}
const names = async (registry: ToolRegistry) =>
  (await registry.describe()).map((tool) => tool.name);

test(
  'queued explicit reconnect retries discovery after the preceding refresh fails',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    let fail = false;
    const upstream = await remote(t, {
      page: () => {
        if (fail) {
          fail = false;
          throw new Error('Synthetic catalog failure');
        }
        return { tools: structuredClone(representativeTools) };
      },
    });
    const { manager } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 60000 },
    ]);
    const held = upstream.holdNextList();
    const refreshing = manager.reconnect('fixture');
    const failed = assert.rejects(refreshing);
    await held.entered;
    fail = true;
    const requested = manager.reconnect('fixture');
    try {
      held.release();
      await failed;
      await requested;
      assert.equal(manager.status()[0].state, 'ready');
      assert.deepEqual(await names(services.registry), ['_fixture.media', 'native']);
    } finally {
      held.release();
      await Promise.allSettled([refreshing, requested]);
    }
  },
);

test(
  'stopping while an explicit reconnect is queued rejects it without another connection',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t, { pageSize: 10 });
    const originalConnect = Client.prototype.connect;
    let connects = 0;
    t.mock.method(
      Client.prototype,
      'connect',
      function (this: Client, ...args: Parameters<Client['connect']>) {
        connects++;
        return originalConnect.apply(this, args);
      },
    );
    const { manager, fiber } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 60000 },
    ]);
    const held = upstream.holdNextList();
    const refreshing = manager.reconnect('fixture');
    const activeRejected = assert.rejects(refreshing);
    await held.entered;
    const before = connects;
    const requested = manager.reconnect('fixture');
    const queuedRejected = assert.rejects(requested, { code: 'mounts_stopped' });
    try {
      await fiber.dispose();
      await Promise.all([activeRejected, queuedRejected]);
      assert.equal(connects, before);
      assert.equal(manager.status()[0].state, 'stopped');
    } finally {
      held.release();
      await Promise.allSettled([refreshing, requested]);
    }
  },
);

test(
  'explicit reconnect during a coalesced second refresh waits for its own new connection attempt',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t, { pageSize: 10 });
    const originalConnect = Client.prototype.connect;
    let connects = 0;
    t.mock.method(
      Client.prototype,
      'connect',
      function (this: Client, ...args: Parameters<Client['connect']>) {
        connects++;
        return originalConnect.apply(this, args);
      },
    );
    const install = Client.prototype.setNotificationHandler;
    let receive!: () => void;
    const notificationReceived = new Promise<void>((resolve) => {
      receive = resolve;
    });
    const observe: Client['setNotificationHandler'] = function (this: Client, schema, handler) {
      return install.call(this, schema, (notification) => {
        receive();
        return handler(notification);
      });
    };
    t.mock.method(Client.prototype, 'setNotificationHandler', observe);
    const { manager } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 60000 },
    ]);
    const firstHeld = upstream.holdNextList();
    const secondHeld = upstream.holdNextList();
    const ownAttemptHeld = upstream.holdNextList();
    const refreshing = manager.reconnect('fixture');
    await firstHeld.entered;
    await upstream.notifyToolsChanged();
    await notificationReceived;
    firstHeld.release();
    await secondHeld.entered;
    const before = connects;
    let settled = false;
    const requested = manager.reconnect('fixture').then(() => {
      settled = true;
    });
    try {
      secondHeld.release();
      await refreshing;
      await until(
        () => settled || connects > before,
        'Explicit reconnect did not start after the active refresh',
      );
      assert.equal(
        settled,
        false,
        'Reconnect cannot resolve before its own forced attempt finishes',
      );
      assert.equal(connects, before + 1, 'Reconnect must create a new discovery connection');
      await ownAttemptHeld.entered;
      assert.equal(settled, false);
      ownAttemptHeld.release();
      await requested;
      assert.equal(manager.status()[0].state, 'ready');
    } finally {
      firstHeld.release();
      secondHeld.release();
      ownAttemptHeld.release();
      await Promise.allSettled([refreshing, requested]);
    }
  },
);

test(
  'optional mounts select explicit tools before schema compilation and preserve native tools',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t, {
      tools: [
        ...representativeTools,
        {
          name: 'unsupported-unselected',
          inputSchema: { type: 'object', discriminator: { propertyName: 'kind' } },
        },
      ],
    });
    const { manager } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], reconnectMs: 60000 },
    ]);
    assert.deepEqual(manager.status(), [
      { id: 'fixture', origin: new URL(upstream.url).origin, state: 'ready', toolCount: 1 },
    ]);
    assert.deepEqual(await names(services.registry), ['_fixture.media', 'native']);
    assert.deepEqual(
      await services.registry.call('_fixture.media', services.caller, {}),
      representativeResult,
    );
    assert.equal(await services.registry.call('native', services.caller, {}), 'native-alive');
    services.access.replace([]);
    await assert.rejects(services.registry.call('_fixture.media', services.caller, {}), {
      code: 'tool_forbidden',
    });
    assert.equal(upstream.requests.filter((request) => request.method === 'tools/call').length, 1);
  },
);

test(
  'an unavailable optional connection leaves other mounts and native tools active with sanitized status',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t, ['good', 'bad']);
    const healthy = await remote(t);
    const unavailable = await remote(t);
    const unavailableUrl = unavailable.url;
    await unavailable.close();
    const { manager } = await mounted(t, services, [
      { id: 'good', url: healthy.url, tools: ['media'], reconnectMs: 60000 },
      {
        id: 'bad',
        url: `${unavailableUrl}?opaque=do-not-return-this-value`,
        tools: ['media'],
        timeoutMs: 100,
        reconnectMs: 60000,
      },
    ]);
    assert.equal(manager.status().find((mount) => mount.id === 'good')?.state, 'ready');
    assert.ok(
      ['failed', 'disconnected'].includes(
        manager.status().find((mount) => mount.id === 'bad')!.state,
      ),
    );
    assert.ok(!JSON.stringify(manager.status()).includes('do-not-return-this-value'));
    assert.deepEqual(await names(services.registry), ['_good.media', 'native']);
    assert.equal(await services.registry.call('native', services.caller, {}), 'native-alive');
    await assert.rejects(manager.reconnect('missing'), { code: 'mount_not_found' });
  },
);

test(
  'catalog loss withdraws tools and bounded automatic reconnect restores a complete selected catalog',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const { manager } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 500, reconnectMs: 50 },
    ]);
    upstream.setTools([]);
    await upstream.notifyToolsChanged();
    await until(
      () => manager.status()[0].toolCount === 0,
      'Missing selected tool did not withdraw the catalog',
    );
    assert.equal(manager.status()[0].errorCode, 'mount_missing_tool');
    assert.deepEqual(await names(services.registry), ['native']);
    upstream.setTools(representativeTools);
    await until(
      () => manager.status()[0].state === 'ready',
      'Automatic reconnect did not restore selected tools',
    );
    assert.deepEqual(await names(services.registry), ['_fixture.media', 'native']);
    assert.deepEqual(
      await services.registry.call('_fixture.media', services.caller, {}),
      representativeResult,
    );
  },
);

test(
  'a stalled discovery refresh times out, withdraws its catalog, and can reconnect explicitly',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const { manager } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 100, reconnectMs: 60000 },
    ]);
    const held = upstream.holdNextList();
    const refresh = manager.reconnect('fixture');
    const rejected = assert.rejects(refresh);
    await held.entered;
    try {
      await rejected;
      assert.equal(manager.status()[0].toolCount, 0);
      assert.deepEqual(await names(services.registry), ['native']);
      assert.equal(await services.registry.call('native', services.caller, {}), 'native-alive');
    } finally {
      held.release();
    }
    await manager.reconnect('fixture');
    assert.equal(manager.status()[0].state, 'ready');
  },
);

test(
  'notification streams remain live beyond the ordinary request timeout',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const actualFetch = globalThis.fetch;
    const streamSignals: AbortSignal[] = [];
    t.mock.method(globalThis, 'fetch', (address: RequestInfo | URL, init?: RequestInit) => {
      if (String(address) === upstream.url && init?.method === 'GET' && init.signal)
        streamSignals.push(init.signal);
      return actualFetch(address, init);
    });
    const { manager, fiber } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 250, reconnectMs: 60000 },
    ]);
    assert.equal(manager.status()[0].state, 'ready');
    await upstream.waitForNotificationStream();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(streamSignals.length, 1);
    assert.equal(
      streamSignals[0].aborted,
      false,
      'Established SSE stream must outlive request timeout',
    );
    const before = upstream.requests.filter((request) => request.method === 'tools/list').length;
    const changed = structuredClone(representativeTools);
    changed.find((tool) => tool.name === 'media')!.description =
      'Catalog changed after request timeout';
    upstream.setTools(changed);
    await upstream.notifyToolsChanged();
    await until(
      async () =>
        (await services.registry.describe()).find((tool) => tool.name === '_fixture.media')
          ?.description === 'Catalog changed after request timeout',
      'Notification was lost after the request timeout while the long poll interval had not elapsed',
    );
    assert.ok(
      upstream.requests.filter((request) => request.method === 'tools/list').length > before,
    );
    assert.equal(manager.status()[0].state, 'ready');
    await fiber.dispose();
    assert.ok(
      streamSignals.every((signal) => signal.aborted),
      'Stopping the mount must abort its SSE stream',
    );
  },
);

test(
  'upstream connection loss is detected by bounded polling and withdraws mounted names',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const { manager } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 100, reconnectMs: 25 },
    ]);
    assert.equal(manager.status()[0].state, 'ready');
    await upstream.close();
    await until(
      () => manager.status()[0].toolCount === 0,
      'Lost upstream connection remained discoverable',
    );
    assert.deepEqual(await names(services.registry), ['native']);
    assert.equal(await services.registry.call('native', services.caller, {}), 'native-alive');
    await assert.rejects(manager.reconnect('fixture'));
    assert.ok(manager.status()[0].errorCode);
  },
);

test(
  'Cordis unload withdraws every mount before either admitted call finishes',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t, ['first', 'second']);
    const upstream = await remote(t);
    const { ctx, fiber, manager } = await mounted(
      t,
      services,
      ['first', 'second'].map((id) => ({
        id,
        url: upstream.url,
        tools: ['media'],
        timeoutMs: 1500,
        reconnectMs: 60000,
      })),
    );
    let releaseConsumer!: () => void;
    const consumerHeld = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const consumer = ctx.plugin({
      name: 'held-mount-status-consumer',
      inject: ['mounts'],
      apply(ctx: Context) {
        ctx.effect(() => () => consumerHeld);
      },
    });
    await consumer.await();
    const firstHold = upstream.holdNextCall('media'),
      secondHold = upstream.holdNextCall('media');
    const first = services.registry.call('_first.media', services.caller, {});
    const second = services.registry.call('_second.media', services.caller, {});
    await Promise.all([firstHold.entered, secondHold.entered]);
    let disposed = false;
    const disposal = fiber.dispose().then(() => {
      disposed = true;
    });
    try {
      await until(
        async () => (await names(services.registry)).length === 1,
        'All mount names must withdraw before draining any call',
      );
      assert.equal(disposed, false);
      assert.equal(ctx.get('mounts'), undefined);
      for (const id of ['first', 'second'])
        await assert.rejects(services.registry.call(`_${id}.media`, services.caller, {}), {
          code: 'unknown_tool',
        });
      assert.equal(await services.registry.call('native', services.caller, {}), 'native-alive');
      firstHold.release();
      assert.deepEqual(await first, representativeResult);
      assert.equal(disposed, false, 'The second mount still has an admitted call');
    } finally {
      firstHold.release();
      secondHold.release();
      releaseConsumer();
    }
    assert.deepEqual(await second, representativeResult);
    await disposal;
    assert.ok(manager.status().every((mount) => mount.state === 'stopped'));
    await assert.rejects(manager.reconnect('first'), { code: 'mounts_stopped' });
  },
);

test(
  'shutdown attempts every client cleanup and reports failures without credential details',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const manager = new MountManager(services.registry, services.credentials, services.access, {
      mounts: [
        { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 500, reconnectMs: 60000 },
      ],
    });
    t.after(() => manager.close().catch(() => undefined));
    await manager.start();
    await services.registry.call('_fixture.media', services.caller, {});
    const original = Client.prototype.close;
    let closes = 0;
    t.mock.method(Client.prototype, 'close', async function (this: Client) {
      closes++;
      await original.call(this);
      throw new Error('secret-from-sdk-cleanup');
    });
    await assert.rejects(manager.close(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'mount_cleanup_failed');
      assert.ok(!String(error).includes('secret-from-sdk-cleanup'));
      return true;
    });
    assert.equal(closes, 2, 'Caller and discovery clients must both be closed');
    assert.deepEqual(await names(services.registry), ['native']);
    assert.equal(manager.status()[0].errorCode, 'mount_cleanup_failed');
  },
);

test(
  'authenticated discovery authority is isolated from callers and revoked discovery withdraws the catalog',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const actor = (
      await services.scope.issueActor(services.caller, {
        name: 'Discovery',
        role: 'reader',
      })
    ).actor;
    const discovery = { actorId: actor.id, projectId: actor.projectId };
    const discoveryEnv = `MERV_DISCOVERY_${randomUUID().replaceAll('-', '_')}`;
    process.env[discoveryEnv] = 'synthetic-discovery-token';
    t.after(() => {
      delete process.env[discoveryEnv];
    });
    const upstream = new CredentialServer([
      {
        id: 'discovery',
        token: process.env[discoveryEnv]!,
        namespace: 'public',
        subject: 'discovery',
      },
      { id: 'caller', token: process.env[services.env]!, namespace: 'private', subject: 'caller' },
    ]);
    await upstream.start();
    t.after(() => upstream.close());
    const bindings: CredentialBinding[] = [
      {
        ...services.bindings[0],
        headers: { 'x-sandbox-namespace': 'private', 'x-sandbox-subject': 'caller' },
      },
      {
        id: 'discovery-binding',
        ...discovery,
        mountId: 'fixture',
        secretRef: `env:${discoveryEnv}`,
        headers: { 'x-sandbox-namespace': 'public', 'x-sandbox-subject': 'discovery' },
      },
    ];
    services.credentials.replace(bindings);
    services.access.replace(
      [services.caller, discovery].map((caller) => ({
        ...caller,
        mountId: 'fixture',
        tools: ['inspect'],
      })),
    );
    const manager = new MountManager(services.registry, services.credentials, services.access, {
      mounts: [
        {
          id: 'fixture',
          url: upstream.url,
          tools: ['inspect'],
          discovery,
          timeoutMs: 500,
          reconnectMs: 50,
        },
      ],
    });
    t.after(async () => manager.close());
    await manager.start();
    assert.equal(manager.status()[0].state, 'ready');
    const result = (await services.registry.call('_fixture.inspect', services.caller, {})) as {
      structuredContent: { identity: string };
    };
    assert.equal(result.structuredContent.identity, 'caller');
    assert.deepEqual(
      upstream.connections.map((connection) => connection.identity),
      ['discovery', 'caller'],
    );
    services.credentials.replace([bindings[0]]);
    await until(
      () => manager.status()[0].toolCount === 0,
      'Revoked discovery credential remained active',
    );
    assert.deepEqual(await names(services.registry), ['native']);
    assert.equal(manager.status()[0].errorCode, 'credential_forbidden');
    services.credentials.replace(bindings);
    await manager.reconnect('fixture');
    assert.equal(manager.status()[0].state, 'ready');
  },
);

test('invalid mount configuration acquires no catalog namespaces', async (t) => {
  const services = await local(t);
  for (const mounts of [
    [{ id: 'fixture', url: 'http://user:secret@localhost/mcp', tools: ['media'] }],
    [{ id: 'fixture', url: 'http://localhost/mcp', tools: [] }],
    [{ id: 'fixture', url: 'http://localhost/mcp', tools: ['media', 'media'] }],
    [
      { id: 'fixture', url: 'http://localhost/mcp', tools: ['media'] },
      { id: 'fixture', url: 'http://localhost/mcp', tools: ['media'] },
    ],
  ])
    assert.throws(
      () => new MountManager(services.registry, services.credentials, services.access, { mounts }),
      { code: 'invalid_mount_config' },
    );
  assert.deepEqual(await names(services.registry), ['native']);
  const catalog = services.registry.createCatalog('fixture');
  void catalog.dispose();
});

test(
  'discovery disconnect during final credential resolution cannot republish a stale catalog',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    let discovery: Client | undefined;
    const connect = Client.prototype.connect;
    t.mock.method(
      Client.prototype,
      'connect',
      function (this: Client, ...args: Parameters<Client['connect']>) {
        discovery = this;
        return connect.apply(this, args);
      },
    );
    const resolve = services.credentials.resolve.bind(services.credentials);
    let resolutions = 0;
    t.mock.method(services.credentials, 'resolve', async (...args: Parameters<typeof resolve>) => {
      const credential = await resolve(...args);
      if (++resolutions === 3) await discovery!.close();
      return credential;
    });
    const manager = new MountManager(services.registry, services.credentials, services.access, {
      mounts: [
        {
          id: 'fixture',
          url: upstream.url,
          tools: ['media'],
          discovery: services.caller,
          timeoutMs: 1000,
          reconnectMs: 60000,
        },
      ],
    });
    t.after(() => manager.close());
    await manager.start();
    assert.equal(resolutions, 3);
    assert.equal(manager.status()[0].toolCount, 0);
    assert.equal(manager.status()[0].errorCode, 'mount_disconnected');
    assert.deepEqual(await names(services.registry), ['native']);
  },
);
