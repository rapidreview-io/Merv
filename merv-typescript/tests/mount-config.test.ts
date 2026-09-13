import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { ExactAccessPolicy } from '@merv/access';
import { EnvironmentCredentials } from '@merv/credentials';
import { ToolRegistry } from '@merv/api';
import { MountManager } from '@merv/mounts';

test('failed multi-mount construction releases only namespaces acquired by that manager', async () => {
  const state = new SqliteState(':memory:');
  const scope = new ProjectScope(state);
  const access = new ExactAccessPolicy(scope);
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
      registry.describe().map(({ name }) => name),
      ['mount__b__inspect'],
    );
    assert.throws(() => registry.createCatalog('b'), { code: 'duplicate_mount' });
    await existing.dispose();
    const nextOwner = registry.createCatalog('b');
    await nextOwner.dispose();
  } finally {
    await registry.close();
    state.close();
  }
});
