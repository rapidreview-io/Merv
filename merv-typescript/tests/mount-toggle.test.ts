import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from 'cordis';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { ProjectScope } from '@merv/scope';
import { ToolRegistry } from '@merv/api';
import { MountManager, mountsPlugin } from '@merv/mounts';
import { CredentialServer } from './fixtures/credential-server.js';
import { openState } from './fixtures/state.js';

function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture barrier timed out')), 5000);
      timer.unref();
      void promise.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
    }),
  ]);
}

async function setup(t: TestContext) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const admin = await scope.bootstrap({ projectName: 'Mount toggles', actorName: 'Operator' });
  const caller = { actorId: admin.actor.id, projectId: admin.project.id };
  const ids = ['nisa', 'sandbox'];
  const access = scope.toolPolicy;
  access.replace(ids.map((mountId) => ({ ...caller, mountId, tools: ['inspect'] })));
  const environments = ids.map(() => `MERV_TOGGLE_${randomUUID().replaceAll('-', '_')}`);
  const servers = ids.map((id, index) => {
    const token = `synthetic-toggle-${id}`;
    process.env[environments[index]] = token;
    return new CredentialServer([{ id, token, namespace: id, subject: 'fixture' }]);
  });
  const bindings = ids.map((mountId, index) => ({
    id: `binding-${mountId}`,
    ...caller,
    mountId,
    secretRef: `env:${environments[index]}`,
    headers: { 'x-sandbox-namespace': mountId, 'x-sandbox-subject': 'fixture' },
  }));
  const registry = new ToolRegistry(scope, access);
  registry.register({
    name: 'native',
    description: 'Independent native tool',
    inputSchema: z.object({}).strict(),
    handler: () => 'native-alive',
  });
  const ctx = new Context();
  ctx.provide('tools', registry);
  ctx.provide('scope', scope);
  t.after(async () => {
    // Test failure cleanup releases fixture barriers before a potentially held drain.
    await Promise.allSettled(servers.map((server) => server.close()));
    await ctx.fiber.dispose().catch(() => undefined);
    await registry.close();
    await state.close();
    for (const environment of environments) delete process.env[environment];
  });
  await Promise.all(servers.map((server) => server.start()));
  const fiber = ctx.plugin(mountsPlugin, {
    bindings,
    mounts: ids.map((id, index) => ({
      id,
      url: servers[index].url,
      tools: ['inspect'],
      discovery: caller,
      timeoutMs: 3000,
      reconnectMs: 60000,
    })),
  });
  await fiber.await();
  const manager = ctx.mounts as MountManager;
  const names = async () => (await registry.describe()).map((tool) => tool.name);
  const inspect = (id: string) =>
    registry.call(`_${id}.inspect`, caller, {}) as Promise<{
      structuredContent: { connectionId: number };
    }>;
  return { manager, registry, caller, names, inspect, nisa: servers[0], sandbox: servers[1] };
}

test(
  'one mount withdraws before its held call drains and restores without changing the sandbox session',
  { timeout: 15000 },
  async (t) => {
    const { manager, registry, caller, names, inspect, nisa, sandbox } = await setup(t);
    const firstSandbox = await inspect('sandbox');
    const held = nisa.holdNextCall();
    const admitted = inspect('nisa');
    await bounded(held.entered);
    let drained = false;
    const disabling = manager.setEnabled('nisa', false).then(() => {
      drained = true;
    });
    try {
      assert.deepEqual(await names(), ['_sandbox.inspect', 'native'], 'Withdrawal is synchronous');
      assert.equal(drained, false);
      assert.deepEqual(
        manager.status().find((mount) => mount.id === 'nisa'),
        {
          id: 'nisa',
          origin: new URL(nisa.url).origin,
          state: 'stopped',
          toolCount: 0,
        },
      );
      await assert.rejects(inspect('nisa'), { code: 'unknown_tool' });
      await assert.rejects(manager.reconnect('nisa'), { code: 'mount_disabled' });
      assert.equal(await registry.call('native', caller, {}), 'native-alive');
      const during = await inspect('sandbox');
      assert.equal(
        during.structuredContent.connectionId,
        firstSandbox.structuredContent.connectionId,
      );
      assert.equal(
        sandbox.connections.length,
        2,
        'Existing discovery and caller connections are retained',
      );
    } finally {
      held.release();
    }
    const firstNisa = await admitted;
    await disabling;
    await manager.setEnabled('nisa', true);
    assert.deepEqual(await names(), ['_nisa.inspect', '_sandbox.inspect', 'native']);
    const restored = await inspect('nisa');
    assert.notEqual(
      restored.structuredContent.connectionId,
      firstNisa.structuredContent.connectionId,
    );
    assert.equal(
      nisa.connections.length,
      4,
      'Restoration owns fresh discovery and caller sessions',
    );
    assert.equal(
      (await inspect('sandbox')).structuredContent.connectionId,
      firstSandbox.structuredContent.connectionId,
    );
    assert.equal(sandbox.connections.length, 2);
  },
);

test(
  'toggles serialize for one mount and preserve the final requested state',
  { timeout: 15000 },
  async (t) => {
    const { manager, names, inspect, nisa } = await setup(t);
    const held = nisa.holdNextCall();
    const admitted = inspect('nisa');
    await bounded(held.entered);
    const disabled = manager.setEnabled('nisa', false);
    const enabled = manager.setEnabled('nisa', true);
    const disabledAgain = manager.setEnabled('nisa', false);
    const before = nisa.initializeAttempts;
    try {
      assert.deepEqual(await names(), ['_sandbox.inspect', 'native']);
      await Promise.resolve();
      assert.equal(nisa.initializeAttempts, before, 'Reactivation waits for the admitted call');
    } finally {
      held.release();
    }
    await admitted;
    await Promise.all([disabled, enabled, disabledAgain]);
    assert.equal(nisa.initializeAttempts, before + 1);
    assert.deepEqual(await names(), ['_sandbox.inspect', 'native']);
    assert.equal(manager.status().find((mount) => mount.id === 'nisa')?.state, 'stopped');
  },
);

test(
  'whole-manager close withdraws all mounts immediately and prevents queued reactivation',
  { timeout: 15000 },
  async (t) => {
    const { manager, names, inspect, nisa, sandbox } = await setup(t);
    const nisaHeld = nisa.holdNextCall();
    const sandboxHeld = sandbox.holdNextCall();
    const admitted = [inspect('nisa'), inspect('sandbox')];
    await bounded(Promise.all([nisaHeld.entered, sandboxHeld.entered]));
    const disabled = manager.setEnabled('nisa', false);
    const enabled = manager.setEnabled('nisa', true);
    const rejected = assert.rejects(enabled, { code: 'mounts_stopped' });
    const before = nisa.initializeAttempts;
    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
    });
    try {
      assert.deepEqual(await names(), ['native']);
      assert.equal(closed, false);
      await assert.rejects(manager.setEnabled('sandbox', true), { code: 'mounts_stopped' });
      nisaHeld.release();
      await admitted[0];
      await disabled;
      await rejected;
      assert.equal(closed, false, 'The sandbox admitted call still drains');
      assert.equal(nisa.initializeAttempts, before);
    } finally {
      nisaHeld.release();
      sandboxHeld.release();
    }
    await Promise.all(admitted);
    await closing;
    assert.ok(manager.status().every((mount) => mount.state === 'stopped'));
  },
);

test(
  'close during a new discovery attempt prevents publication and subsequent reactivation',
  { timeout: 15000 },
  async (t) => {
    const { manager, names, nisa } = await setup(t);
    await manager.setEnabled('nisa', false);
    const held = nisa.holdNextInitialize();
    const enabling = manager.setEnabled('nisa', true);
    const rejected = assert.rejects(enabling);
    try {
      await bounded(held.entered);
      const closing = manager.close();
      assert.deepEqual(await names(), ['native']);
      await bounded(closing);
      await rejected;
      assert.deepEqual(await names(), ['native']);
      await assert.rejects(manager.setEnabled('nisa', true), { code: 'mounts_stopped' });
    } finally {
      held.release();
    }
  },
);

test(
  'unchanged toggles are idempotent and failed cleanup cannot be hidden by reactivation',
  { timeout: 15000 },
  async (t) => {
    const { manager, names, nisa } = await setup(t);
    const before = nisa.initializeAttempts;
    await manager.setEnabled('nisa', true);
    assert.equal(nisa.initializeAttempts, before);
    await assert.rejects(manager.setEnabled('missing', false), { code: 'mount_not_found' });
    await assert.rejects(manager.setEnabled('nisa', 'false' as unknown as boolean), {
      code: 'invalid_mount_config',
    });
    const close = Client.prototype.close;
    t.mock.method(Client.prototype, 'close', async function (this: Client) {
      await close.call(this);
      throw new Error('synthetic-cleanup-detail');
    });
    await assert.rejects(manager.setEnabled('nisa', false), { code: 'mount_cleanup_failed' });
    assert.deepEqual(await names(), ['_sandbox.inspect', 'native']);
    await assert.rejects(manager.setEnabled('nisa', false), { code: 'mount_cleanup_failed' });
    await assert.rejects(manager.setEnabled('nisa', true), { code: 'mount_cleanup_failed' });
    assert.equal(nisa.initializeAttempts, before);
    await assert.rejects(manager.close(), { code: 'mount_cleanup_failed' });
  },
);
