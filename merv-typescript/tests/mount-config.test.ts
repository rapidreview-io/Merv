import { createService } from '@merv/contracts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProjectScope } from '@merv/scope';
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
import { ToolRegistry } from '@merv/api';
import { MountManager, mountsPlugin } from '@merv/mounts';
import { Context } from 'cordis';
import { openState } from './fixtures/state.js';

test('failed multi-mount construction releases only namespaces acquired by that manager', async () => {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const access = scope.toolPolicy;
  const credentials = new EnvironmentCredentials(scope);
  const registry = new ToolRegistry(scope, access);
  try {
    const existing = registry.createCatalog('b');
    await existing.replace([
      {
        kind: 'mcp',
        name: 'inspect',
        inputSchema: { type: 'object' },
        handler: async () => ({ content: [{ type: 'text', text: 'Original owner' }] }),
      },
    ]);
    assert.throws(
      () =>
        new MountManager(registry, credentials, access, {
          mounts: ['a', 'b'].map((id) => ({
            id,
            url: 'http://127.0.0.1:1/mcp',
            tools: ['inspect'],
          })),
        }),
      { code: 'invalid_mount_config' },
    );

    // The failed constructor never starts network discovery. Its first namespace is reusable.
    const replacement = registry.createCatalog('a');
    await replacement.dispose();
    assert.deepEqual(
      (await registry.describe()).map(({ name }) => name),
      ['_b.inspect'],
    );
    assert.throws(() => registry.createCatalog('b'), { code: 'duplicate_mount' });
    await existing.dispose();
    const nextOwner = registry.createCatalog('b');
    await nextOwner.dispose();
  } finally {
    await registry.close();
    await state.close();
  }
});

// Reject binding mistakes before acquiring namespaces or opening upstream connections.
test('Mounts rejects invalid credential bindings before publishing its service or tools', async () => {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const registry = new ToolRegistry(scope, scope.toolPolicy);
  const ctx = new Context();
  ctx.provide('scope', scope);
  ctx.provide('tools', registry);
  const binding = {
    id: 'example',
    actorId: 'actor',
    projectId: 'project',
    mountId: 'bridge',
    secretRef: 'env:MERV_TEST_UPSTREAM',
  };
  try {
    for (const bindings of [
      [{ ...binding, secretRef: 'raw-secret-must-not-leak' }],
      [binding, binding],
      [{ ...binding, headers: { authorization: 'Bearer raw-secret-must-not-leak' } }],
    ]) {
      await assert.rejects(
        mountsPlugin.apply(ctx, {
          bindings,
          mounts: [{ id: 'bridge', url: 'http://127.0.0.1:1/mcp', tools: ['inspect'] }],
        }),
        (error: any) => {
          assert.equal(error.code, 'invalid_credential_config');
          assert.ok(!String(error).includes('raw-secret-must-not-leak'));
          return true;
        },
      );
      assert.equal(ctx.get('mounts'), undefined);
      assert.equal(ctx.get('credentials'), undefined);
      assert.deepEqual(await registry.describe(), []);
      await registry.createCatalog('bridge').dispose();
    }
  } finally {
    await ctx.fiber.dispose();
    await registry.close();
    await state.close();
  }
});
