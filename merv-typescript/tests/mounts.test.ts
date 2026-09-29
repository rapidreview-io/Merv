import { createService, MervError } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Context, ValidationError, type Plugin } from 'cordis';
import { z } from 'zod';

import { ProjectScope } from '@merv/scope';
import { Bindings } from '../packages/mounts/src/credentials.js';
import { ToolRegistry } from '@merv/api';
import type { CredentialBinding } from '@merv/mounts/types';
import type { MountConfig, Mounts } from '@merv/mounts/types';
import { mountsPlugin } from '../packages/mounts/src/index.js';
import { MountRuntime } from '../packages/mounts/src/runtime.js';
import { mountsUiPlugin } from '../packages/mounts/src/ui.js';
import { UiRegistry } from '@merv/ui';
import {
  RemoteFixture,
  representativeTools,
  representativeResult,
} from './fixtures/remote-server.js';
import { CredentialServer } from './fixtures/credential-server.js';
import { openState } from './fixtures/state.js';

async function until(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  milliseconds = 4000,
): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!(await predicate())) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function local(t: TestContext, mountIds = ['fixture']) {
  const state = await openState(':memory:');
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
  return { state, scope, caller, access, registry, bindings, env };
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
/** Loads the mounts entry without waiting for discovery. */
function loaded(
  t: TestContext,
  services: Awaited<ReturnType<typeof local>>,
  mounts: MountConfig[],
) {
  const ctx = new Context();
  ctx.provide('tools', services.registry);
  ctx.provide('scope', services.scope);
  const fiber = ctx.plugin(mountsPlugin, { mounts, bindings: services.bindings });
  t.after(() => ctx.fiber.dispose());
  return { ctx, fiber };
}
async function mounted(
  t: TestContext,
  services: Awaited<ReturnType<typeof local>>,
  mounts: MountConfig[],
) {
  const { ctx, fiber } = loaded(t, services, mounts);
  await fiber.await();
  assert.equal(ctx.get('credentials'), undefined, 'Credentials is internal to Mounts');
  await settled(ctx.mounts);
  return { ctx, fiber, mounts: ctx.mounts };
}
/** apply does not wait for discovery: wait until every mount has finished its first round. */
const settled = (mounts: Mounts) =>
  until(
    () => mounts.status().every((mount) => mount.state !== 'connecting'),
    'A mount did not finish its first round',
  );
const names = async (registry: ToolRegistry) =>
  (await registry.describe()).map((tool) => tool.name);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
/** Counts replace() calls on the next catalog; the first `reject` nonempty ones fail to compile. */
function replacements(t: TestContext, registry: ToolRegistry, reject = 0) {
  const counts = { all: 0, nonempty: 0 };
  const create = registry.createCatalog.bind(registry);
  t.mock.method(registry, 'createCatalog', (mountId: string) => {
    const catalog = create(mountId);
    const replace = catalog.replace.bind(catalog);
    catalog.replace = async (definitions) => {
      counts.all++;
      if (definitions.length > 0 && counts.nonempty++ < reject)
        throw new MervError('invalid_schema', 'Synthetic schema failure', 400);
      await replace(definitions);
    };
    return catalog;
  });
  return counts;
}

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
    const { mounts } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], reconnectMs: 60000 },
    ]);
    assert.deepEqual(mounts.status(), [
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
    const { mounts } = await mounted(t, services, [
      { id: 'good', url: healthy.url, tools: ['media'], reconnectMs: 60000 },
      {
        id: 'bad',
        url: `${unavailableUrl}?opaque=do-not-return-this-value`,
        tools: ['media'],
        timeoutMs: 100,
        reconnectMs: 60000,
      },
    ]);
    assert.equal(mounts.status().find((mount) => mount.id === 'good')?.state, 'ready');
    assert.ok(
      ['failed', 'disconnected'].includes(
        mounts.status().find((mount) => mount.id === 'bad')!.state,
      ),
    );
    assert.ok(!JSON.stringify(mounts.status()).includes('do-not-return-this-value'));
    assert.deepEqual(await names(services.registry), ['_good.media', 'native']);
    assert.equal(await services.registry.call('native', services.caller, {}), 'native-alive');
  },
);

test(
  'a missing selected tool is withdrawn and polling restores it when it returns',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const { mounts } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 500, reconnectMs: 50 },
    ]);
    upstream.setTools([]);
    await upstream.notifyToolsChanged();
    await until(
      () => mounts.status()[0].toolCount === 0,
      'Missing selected tool did not withdraw the catalog',
    );
    assert.equal(mounts.status()[0].state, 'ready');
    assert.equal(mounts.status()[0].errorCode, 'mount_missing_tool');
    assert.deepEqual(await names(services.registry), ['native']);
    upstream.setTools(representativeTools);
    await until(
      () => mounts.status()[0].toolCount === 1,
      'Polling did not restore the selected tool',
    );
    assert.equal(mounts.status()[0].errorCode, undefined);
    assert.deepEqual(await names(services.registry), ['_fixture.media', 'native']);
    assert.deepEqual(
      await services.registry.call('_fixture.media', services.caller, {}),
      representativeResult,
    );
  },
);

test(
  'a stalled discovery refresh times out, withdraws its catalog, and a later round restores it',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const { mounts } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 100, reconnectMs: 200 },
    ]);
    const held = upstream.holdNextList();
    await upstream.notifyToolsChanged();
    await held.entered;
    try {
      await until(
        () => mounts.status()[0].errorCode === 'remote_timeout',
        'The stalled list did not time out',
      );
      assert.equal(mounts.status()[0].toolCount, 0);
      assert.deepEqual(await names(services.registry), ['native']);
      assert.equal(await services.registry.call('native', services.caller, {}), 'native-alive');
    } finally {
      held.release();
    }
    await until(() => mounts.status()[0].state === 'ready', 'A later round did not restore');
    assert.deepEqual(await names(services.registry), ['_fixture.media', 'native']);
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
    const { mounts, fiber } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 250, reconnectMs: 60000 },
    ]);
    assert.equal(mounts.status()[0].state, 'ready');
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
    assert.equal(mounts.status()[0].state, 'ready');
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
    const { mounts } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 100, reconnectMs: 25 },
    ]);
    assert.equal(mounts.status()[0].state, 'ready');
    await upstream.close();
    await until(
      () => mounts.status()[0].toolCount === 0,
      'Lost upstream connection remained discoverable',
    );
    assert.deepEqual(await names(services.registry), ['native']);
    assert.equal(await services.registry.call('native', services.caller, {}), 'native-alive');
    assert.ok(mounts.status()[0].errorCode);
  },
);

test(
  'Cordis unload withdraws every mount before either admitted call finishes',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t, ['first', 'second']);
    const upstream = await remote(t);
    const { ctx, fiber, mounts } = await mounted(
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
    // Admission reads run on separate connections, so two concurrent calls can reach the
    // upstream in either order. Each hold takes the next arrival, so the calls enter one by one.
    const firstHold = upstream.holdNextCall('media');
    const first = services.registry.call('_first.media', services.caller, {});
    await firstHold.entered;
    const secondHold = upstream.holdNextCall('media');
    const second = services.registry.call('_second.media', services.caller, {});
    await secondHold.entered;
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
    assert.ok(mounts.status().every((mount) => mount.state === 'stopped'));
  },
);

test(
  'authenticated discovery is isolated from callers and needs no tool grants',
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
    const grants = [services.caller, discovery].map((caller) => ({
      ...caller,
      mountId: 'fixture',
      tools: ['inspect'],
    }));
    services.access.replace(grants);
    const configured = { ...services, bindings };
    const mount = {
      id: 'fixture',
      url: upstream.url,
      tools: ['inspect'],
      discovery,
      timeoutMs: 500,
      reconnectMs: 50,
    };
    const { mounts, fiber } = await mounted(t, configured, [mount]);
    assert.equal(mounts.status()[0].state, 'ready');
    const result = (await services.registry.call('_fixture.inspect', services.caller, {})) as {
      structuredContent: { identity: string };
    };
    assert.equal(result.structuredContent.identity, 'caller');
    assert.deepEqual(
      upstream.connections.map((connection) => connection.identity),
      ['discovery', 'caller'],
    );
    // The discovery connection never carries a call: even the discovery actor's own call opens
    // its own invocation connection.
    await services.registry.call('_fixture.inspect', discovery, {});
    assert.deepEqual(
      upstream.calls.map((call) => call.identity),
      ['caller', 'discovery'],
    );
    assert.deepEqual(
      upstream.connections.map((connection) => connection.identity),
      ['discovery', 'caller', 'discovery'],
    );
    // Discovery needs no tool grants: revoking them all leaves the mount ready, and callers
    // still need their own.
    services.access.replace([]);
    const lists = upstream.lists;
    await until(() => upstream.lists >= lists + 3, 'Discovery stopped polling');
    assert.equal(mounts.status()[0].state, 'ready');
    assert.deepEqual(await names(services.registry), ['_fixture.inspect', 'native']);
    await assert.rejects(services.registry.call('_fixture.inspect', services.caller, {}), {
      code: 'tool_forbidden',
    });
    services.access.replace(grants);
    // The discovery secret is read once per connection: the warm connection keeps listing, and
    // only the next discovery connection needs it.
    const discoveryToken = process.env[discoveryEnv]!;
    delete process.env[discoveryEnv];
    const before = upstream.lists;
    await until(() => upstream.lists >= before + 3, 'Discovery stopped polling');
    assert.equal(mounts.status()[0].state, 'ready');
    assert.equal(upstream.connections.length, 3);
    // Reloading the entry opens the next discovery connection.
    await fiber.dispose();
    const { mounts: reloaded } = await mounted(t, configured, [mount]);
    assert.equal(reloaded.status()[0].errorCode, 'credential_unavailable');
    assert.deepEqual(await names(services.registry), ['native']);
    process.env[discoveryEnv] = discoveryToken;
    await until(() => reloaded.status()[0].state === 'ready', 'Discovery did not recover');
    assert.deepEqual(await names(services.registry), ['_fixture.inspect', 'native']);
  },
);

/** A mount whose discovery actor is a separate reader of the fixture project. */
async function discovered(t: TestContext, tools = ['media']) {
  const services = await local(t);
  const { actor } = await services.scope.issueActor(services.caller, {
    name: 'Discovery',
    role: 'reader',
  });
  const discovery = { actorId: actor.id, projectId: actor.projectId };
  const bindings = [
    ...services.bindings,
    { id: 'discovery-binding', ...discovery, mountId: 'fixture', secretRef: `env:${services.env}` },
  ];
  const upstream = await remote(t);
  const mount = { id: 'fixture', url: upstream.url, tools, discovery, timeoutMs: 1000 };
  return { services: { ...services, bindings }, upstream, mount, discovery };
}

test('removing the discovery actor fails the next round and ends its session', async (t) => {
  const { services, upstream, mount, discovery } = await discovered(t);
  const { mounts } = await mounted(t, services, [{ ...mount, reconnectMs: 50 }]);
  assert.equal(mounts.status()[0].state, 'ready');
  assert.equal(upstream.sessionCount, 1);
  await services.scope.revokeActor(services.caller, discovery.actorId);
  await until(
    () => mounts.status()[0].errorCode === 'forbidden',
    'A removed discovery actor kept discovering',
  );
  await until(() => upstream.deletes === 1, 'The discovery session was not ended');
  assert.equal(upstream.sessionCount, 0);
  assert.deepEqual(await names(services.registry), ['native']);
});

test('a warm discovery poll checks the actor once and resolves no credential or grant', async (t) => {
  const { services, upstream, mount } = await discovered(t, ['media', 'inspect', 'failure']);
  const { mounts } = await mounted(t, services, [{ ...mount, reconnectMs: 60000 }]);
  assert.equal(mounts.status()[0].state, 'ready');
  const require = t.mock.method(services.scope, 'require');
  const grants = t.mock.method(services.access, 'require');
  const select = t.mock.method(Bindings.prototype, 'select');
  const headers = t.mock.method(Bindings.prototype, 'headers');
  const lists = () => upstream.requests.filter((request) => request.method === 'tools/list');
  for (let poll = 1; poll <= 3; poll++) {
    const before = lists().length;
    await upstream.notifyToolsChanged();
    await until(() => lists().length > before, 'The notification did not start a poll');
    await until(() => require.mock.callCount() === poll, 'The poll did not check its actor');
  }
  await sleep(50);
  assert.equal(require.mock.callCount(), 3);
  assert.equal(grants.mock.callCount(), 0);
  assert.equal(select.mock.callCount(), 0);
  assert.equal(headers.mock.callCount(), 0);
  assert.equal(mounts.status()[0].state, 'ready');
});

test('invalid mount configuration fails the entry and acquires no catalog namespaces', async (t) => {
  const services = await local(t);
  for (const mounts of [
    [{ id: 'fixture', url: 'http://user:secret@localhost/mcp', tools: ['media'] }],
    [{ id: 'fixture', url: 'http://localhost/mcp', tools: [] }],
    [{ id: 'fixture', url: 'http://localhost/mcp', tools: ['media', 'media'] }],
    [
      { id: 'fixture', url: 'http://localhost/mcp', tools: ['media'] },
      { id: 'fixture', url: 'http://localhost/mcp', tools: ['media'] },
    ],
  ]) {
    const ctx = new Context();
    ctx.provide('tools', services.registry);
    ctx.provide('scope', services.scope);
    try {
      await assert.rejects(ctx.plugin(mountsPlugin as Plugin, { mounts }).await(), ValidationError);
      assert.equal(ctx.get('mounts'), undefined);
    } finally {
      await ctx.fiber.dispose();
    }
  }
  assert.deepEqual(await names(services.registry), ['native']);
  const catalog = services.registry.createCatalog('fixture');
  void catalog.dispose();
});

test(
  'an unchanged upstream catalog is published once across polls',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const counts = replacements(t, services.registry);
    const upstream = await remote(t);
    const { mounts } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 50 },
    ]);
    await sleep(500);
    assert.ok(upstream.requests.filter((request) => request.method === 'tools/list').length > 3);
    assert.equal(counts.all, 1, 'Unchanged polls must not replace the catalog');
    assert.equal(mounts.status()[0].state, 'ready');
  },
);

test('a failed round retries after the flat interval', async (t) => {
  const services = await local(t);
  const attempts: number[] = [];
  const server = createServer((request, response) => {
    attempts.push(performance.now());
    request.resume();
    response.writeHead(500).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const R = 150;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const { mounts } = await mounted(t, services, [
    { id: 'fixture', url, tools: ['media'], timeoutMs: 1000, reconnectMs: R },
  ]);
  assert.equal(mounts.status()[0].state, 'failed');
  await until(() => attempts.length >= 2, 'Discovery did not retry');
  const gap = attempts[1] - attempts[0];
  assert.ok(gap >= R && gap < 2 * R, `The first retry came after ${gap} ms`);
  await until(() => attempts.length >= 3, 'Discovery did not retry again');
  const next = attempts[2] - attempts[1];
  assert.ok(next < 2 * R, `A second failure backed off to ${next} ms`);
});

test(
  'a held call does not stall discovery: a removed tool withdraws within three polls',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const R = 100;
    await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: R },
    ]);
    const held = upstream.holdNextCall('media');
    const call = services.registry.call('_fixture.media', services.caller, {});
    try {
      await held.entered;
      await sleep(2 * R); // unchanged polls run while the call is held
      upstream.setTools(representativeTools.filter((tool) => tool.name !== 'media'));
      await until(
        async () => !(await names(services.registry)).includes('_fixture.media'),
        'A removed tool stayed published behind a held call',
        3 * R,
      );
    } finally {
      held.release();
    }
    assert.deepEqual(await call, representativeResult);
  },
);

test(
  'an unchanged catalog is published again after a failed round',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const upstream = await remote(t);
    const { mounts } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 200, reconnectMs: 50 },
    ]);
    upstream.holdNextList();
    await until(() => mounts.status()[0].toolCount === 0, 'A stalled list did not fail the round');
    assert.deepEqual(await names(services.registry), ['native']);
    await until(
      async () => (await names(services.registry)).includes('_fixture.media'),
      'The unchanged catalog was not republished after the failure',
    );
    assert.equal(mounts.status()[0].state, 'ready');
  },
);

test(
  'a rejected catalog replacement is retried on the next round',
  { timeout: 10000 },
  async (t) => {
    const services = await local(t);
    const counts = replacements(t, services.registry, 1);
    const upstream = await remote(t);
    const { mounts } = await mounted(t, services, [
      { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 50 },
    ]);
    assert.equal(mounts.status()[0].errorCode, 'invalid_schema');
    await until(() => mounts.status()[0].state === 'ready', 'The rejected catalog was not retried');
    assert.deepEqual(await names(services.registry), ['_fixture.media', 'native']);
    assert.equal(counts.nonempty, 2);
  },
);

test('a failed round and stop each end the discovery session with a DELETE', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  const { mounts, fiber } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 200, reconnectMs: 100 },
  ]);
  assert.equal(upstream.sessionCount, 1);
  const held = upstream.holdNextList();
  await upstream.notifyToolsChanged();
  await until(() => upstream.deletes === 1, 'A failed round did not DELETE its session');
  assert.equal(mounts.status()[0].errorCode, 'remote_timeout');
  assert.equal(upstream.sessionCount, 0);
  held.release();
  await until(() => mounts.status()[0].state === 'ready', 'The next round did not reconnect');
  assert.equal(upstream.sessionCount, 1);
  await fiber.dispose();
  assert.equal(upstream.deletes, 2);
  assert.equal(upstream.sessionCount, 0);
});

test('stop against an upstream that stopped answering takes about one second', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  const { mounts, fiber } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 5000, reconnectMs: 60000 },
  ]);
  assert.equal(mounts.status()[0].state, 'ready');
  upstream.stall();
  const started = performance.now();
  await fiber.dispose();
  assert.ok(performance.now() - started < 1500, 'The DELETE is capped at one second');
});

test('stop after a completed round sends no notifications/cancelled', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  const { fiber } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 5000, reconnectMs: 60000 },
  ]);
  await fiber.dispose();
  await sleep(100);
  assert.deepEqual(
    upstream.notifications.filter((method) => method === 'notifications/cancelled'),
    [],
  );
  assert.equal(upstream.deletes, 1);
});

test('a stalled discovery connect reports a timeout', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  upstream.stall();
  const started = performance.now();
  const { mounts } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 150, reconnectMs: 60000 },
  ]);
  assert.ok(performance.now() - started < 1000, 'The SDK timeout bounds initialize');
  assert.equal(mounts.status()[0].state, 'failed');
  assert.equal(mounts.status()[0].errorCode, 'remote_timeout');
});

test('an upstream with more than 1,000 tools mounts its selected tool', async (t) => {
  const services = await local(t);
  const tools = Array.from({ length: 1001 }, (_, index) => ({
    name: `tool-${index}`,
    inputSchema: { type: 'object' as const, additionalProperties: false },
  }));
  const upstream = await remote(t, { tools, pageSize: 1000 });
  const { mounts } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['tool-1000'], reconnectMs: 60000 },
  ]);
  assert.equal(mounts.status()[0].state, 'ready');
  assert.deepEqual(await names(services.registry), ['_fixture.tool-1000', 'native']);
});

test('a successful round leaves no notifications/cancelled behind', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  const { mounts } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 200, reconnectMs: 60000 },
  ]);
  assert.equal(mounts.status()[0].state, 'ready');
  await sleep(500);
  assert.deepEqual(
    upstream.notifications.filter((method) => method === 'notifications/cancelled'),
    [],
  );
});

test('a black-holed upstream does not hold up loading the entry', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  upstream.stall();
  const ctx = new Context();
  ctx.provide('tools', services.registry);
  ctx.provide('scope', services.scope);
  t.after(() => ctx.fiber.dispose());
  const started = performance.now();
  await ctx.plugin(mountsPlugin, {
    mounts: [{ id: 'fixture', url: upstream.url, tools: ['media'], reconnectMs: 60000 }],
    bindings: services.bindings,
  });
  assert.ok(performance.now() - started < 200, 'apply does not wait for discovery');
  assert.equal(ctx.mounts.status()[0].state, 'connecting');
});

test('200 list_changed notifications during a round rerun it only once', async (t) => {
  const services = await local(t);
  const upstream = await remote(t, { pageSize: 10 });
  const { mounts } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 60000 },
  ]);
  const rounds = () =>
    upstream.requests.filter((request) => request.method === 'tools/list' && !request.cursor)
      .length;
  const before = rounds();
  const held = upstream.holdNextList();
  await upstream.notifyToolsChanged();
  await held.entered;
  for (let notification = 1; notification < 200; notification++)
    await upstream.notifyToolsChanged();
  await sleep(100);
  held.release();
  await until(() => rounds() === before + 2, 'The notifications did not rerun the round');
  await sleep(200);
  assert.equal(rounds(), before + 2);
  assert.equal(mounts.status()[0].state, 'ready');
});

test('stop during a black-holed discovery connect resolves at once', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  upstream.stall();
  const { fiber } = loaded(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 5000, reconnectMs: 60000 },
  ]);
  await fiber.await();
  await sleep(50);
  const started = performance.now();
  await fiber.dispose();
  assert.ok(performance.now() - started < 200, 'stop aborts the round it interrupts');
  assert.equal(upstream.opened, 0);
  assert.equal(upstream.sessionCount, 0);
});

test('a discovery connect that completes during stop still ends with a DELETE', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  const actualFetch = globalThis.fetch;
  let entered!: () => void;
  const initializing = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  // Hold the connect after initialize: the notification that completes it takes no stop signal.
  t.mock.method(globalThis, 'fetch', async (address: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string' && init.body.includes('notifications/initialized')) {
      entered();
      await released;
    }
    return actualFetch(address, init);
  });
  const { ctx, fiber } = loaded(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 60000 },
  ]);
  await fiber.await();
  const mounts = ctx.mounts;
  await initializing;
  assert.equal(upstream.sessionCount, 1);
  const stopping = fiber.dispose();
  await sleep(20);
  release();
  await stopping;
  assert.equal(upstream.deletes, 1);
  assert.equal(upstream.sessionCount, 0);
  assert.equal(mounts.status()[0].state, 'stopped');
});

test("a failed round's DELETE completes before stop resolves", async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (address: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') await sleep(300); // within the DELETE deadline
    return actualFetch(address, init);
  });
  const { mounts, fiber } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 500, reconnectMs: 60000 },
  ]);
  upstream.holdNextList();
  await upstream.notifyToolsChanged();
  await until(() => mounts.status()[0].errorCode === 'remote_timeout', 'The round did not fail');
  assert.equal(upstream.deletes, 0);
  await fiber.dispose();
  assert.equal(upstream.deletes, 1);
});

test('a round that finishes after stop leaves the mount stopped', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  const { mounts, fiber } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 60000 },
  ]);
  const held = upstream.holdNextCall('media');
  const call = services.registry.call('_fixture.media', services.caller, {});
  let stopping: Promise<void> | undefined;
  try {
    await held.entered;
    // The next round's replace() waits for the held call to drain from the old generation.
    const changed = structuredClone(representativeTools);
    changed.find((tool) => tool.name === 'media')!.description = 'Changed while a call is held';
    upstream.setTools(changed);
    await upstream.notifyToolsChanged();
    await until(
      async () =>
        (await services.registry.describe()).find((tool) => tool.name === '_fixture.media')
          ?.description === 'Changed while a call is held',
      'The changed catalog was not published',
    );
    stopping = fiber.dispose();
    await sleep(20);
    assert.equal(mounts.status()[0].state, 'stopped');
  } finally {
    held.release();
  }
  assert.deepEqual(await call, representativeResult);
  await stopping;
  assert.equal(mounts.status()[0].state, 'stopped');
});

test('twelve failed rounds and stop send no notifications/cancelled', async (t) => {
  const services = await local(t);
  const upstream = await remote(t, {
    page: () => {
      throw new Error('Synthetic catalog failure');
    },
  });
  const runtime = new MountRuntime(
    services.registry,
    new Bindings(services.scope, services.bindings),
    services.scope,
    { id: 'fixture', url: upstream.url, tools: ['media'], timeoutMs: 1000, reconnectMs: 60000 },
  );
  // A failed round's DELETE starts after the round ends, so each refresh starts a new round.
  for (let round = 1; round <= 12; round++) {
    runtime.refresh();
    await until(() => upstream.deletes === round, 'A failed round did not end its session');
  }
  assert.equal(runtime.status().errorCode, 'remote_error');
  assert.equal(upstream.opened, 12);
  await runtime.stop();
  await sleep(100);
  assert.equal(runtime.status().state, 'stopped');
  assert.deepEqual(
    upstream.notifications.filter((method) => method === 'notifications/cancelled'),
    [],
  );
});

test('a missing selected tool is withdrawn alone and degrades the Connections row', async (t) => {
  const services = await local(t);
  const upstream = await remote(t);
  const { mounts } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media', 'inspect'], reconnectMs: 60000 },
  ]);
  const ui = new UiRegistry();
  mountsUiPlugin.apply({ mounts, ui, effect: (fn: () => unknown) => fn() } as never);
  assert.deepEqual((await ui.describe(services.caller))[0].status, { state: 'ready' });
  upstream.setTools(representativeTools.filter((tool) => tool.name !== 'media'));
  await upstream.notifyToolsChanged();
  await until(() => mounts.status()[0].toolCount === 1, 'The missing tool was not withdrawn');
  assert.equal(mounts.status()[0].state, 'ready');
  assert.equal(mounts.status()[0].errorCode, 'mount_missing_tool');
  assert.deepEqual(await names(services.registry), ['_fixture.inspect', 'native']);
  assert.deepEqual((await ui.describe(services.caller))[0].status, {
    state: 'degraded',
    detail: '1 of 1 not ready',
  });
});

test('a mount whose selected tools are all missing is ready with none published', async (t) => {
  const services = await local(t);
  const upstream = await remote(t, { tools: [] });
  const { mounts } = await mounted(t, services, [
    { id: 'fixture', url: upstream.url, tools: ['media'], reconnectMs: 60000 },
  ]);
  assert.deepEqual(mounts.status(), [
    {
      id: 'fixture',
      origin: new URL(upstream.url).origin,
      state: 'ready',
      toolCount: 0,
      errorCode: 'mount_missing_tool',
    },
  ]);
  assert.deepEqual(await names(services.registry), ['native']);
});
