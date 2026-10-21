import { createService } from '@merv/contracts';
import { Context, ValidationError, type Plugin } from 'cordis';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';

import { ToolRegistry } from '@merv/api';
import type { CredentialBinding, MountConfig, Mounts } from '@merv/mounts/types';
import { ProjectScope } from '@merv/scope';
import { mountsPlugin } from '../packages/mounts/src/index.js';
import { CredentialServer } from './fixtures/credential-server.js';
import {
  RemoteFixture,
  representativeResult,
  representativeTools,
} from './fixtures/remote-server.js';
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
  const admin = await scope.credentials.bootstrap({ projectName: 'Mounts', actorName: 'Operator' });
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
  'a stalled discovery list times out and keeps the published tools',
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
      assert.equal(mounts.status()[0].state, 'disconnected');
      assert.equal(mounts.status()[0].toolCount, 1);
      assert.deepEqual(await names(services.registry), ['_fixture.media', 'native']);
      assert.deepEqual(
        await services.registry.call('_fixture.media', services.caller, {}),
        representativeResult,
      );
    } finally {
      held.release();
    }
    await until(() => mounts.status()[0].state === 'ready', 'A later round did not recover');
    assert.equal(mounts.status()[0].errorCode, undefined);
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
      await services.scope.credentials.issueActor(services.caller, {
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
  const { actor } = await services.scope.credentials.issueActor(services.caller, {
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
  await services.scope.credentials.revokeActor(services.caller, discovery.actorId);
  await until(
    () => mounts.status()[0].errorCode === 'forbidden',
    'A removed discovery actor kept discovering',
  );
  await until(() => upstream.deletes === 1, 'The discovery session was not ended');
  assert.equal(upstream.sessionCount, 0);
  // The last catalog stays published, and callers are unaffected.
  assert.equal(mounts.status()[0].state, 'disconnected');
  assert.deepEqual(await names(services.registry), ['_fixture.media', 'native']);
  assert.deepEqual(
    await services.registry.call('_fixture.media', services.caller, {}),
    representativeResult,
  );
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
