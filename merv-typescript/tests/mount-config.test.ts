import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { ProjectScope } from '@merv/scope';
import { ToolRegistry } from '@merv/api';
import { mountsPlugin } from '@merv/mounts';
import { Context, ValidationError, type Plugin } from 'cordis';
import { openState } from './fixtures/state.js';

async function services(t: TestContext) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const registry = new ToolRegistry(scope, scope.toolPolicy);
  t.after(async () => {
    await registry.close();
    await state.close();
  });
  /** Loads one mounts entry in a fresh context; the test disposes it. */
  const load = (config: unknown) => {
    const ctx = new Context();
    ctx.provide('scope', scope);
    ctx.provide('tools', registry);
    t.after(() => ctx.fiber.dispose());
    return { ctx, fiber: ctx.plugin(mountsPlugin as Plugin, config) };
  };
  return { registry, load };
}

const binding = {
  id: 'example',
  actorId: 'actor',
  projectId: 'project',
  mountId: 'bridge',
  secretRef: 'env:MERV_TEST_UPSTREAM',
};
const mounts = [{ id: 'bridge', url: 'http://127.0.0.1:1/mcp', tools: ['inspect'] }];

test('a mount whose namespace is taken fails the entry and releases the namespaces it acquired', async (t) => {
  const { registry, load } = await services(t);
  const existing = registry.createCatalog('b');
  await existing.replace([
    {
      kind: 'mcp',
      name: 'inspect',
      inputSchema: { type: 'object' },
      handler: async () => ({ content: [{ type: 'text', text: 'Original owner' }] }),
    },
  ]);
  const { ctx, fiber } = load({
    mounts: ['a', 'b'].map((id) => ({ id, url: 'http://127.0.0.1:1/mcp', tools: ['inspect'] })),
  });
  await assert.rejects(fiber.await(), { code: 'duplicate_mount' });
  assert.equal(ctx.get('mounts'), undefined);
  // The failed entry's first namespace is reusable, and the original owner keeps its own.
  await registry.createCatalog('a').dispose();
  assert.deepEqual(
    (await registry.describe()).map(({ name }) => name),
    ['_b.inspect'],
  );
  assert.throws(() => registry.createCatalog('b'), { code: 'duplicate_mount' });
  await existing.dispose();
});

test('Config refuses invalid binding sets whole, before the service or any catalog exists', async (t) => {
  const { registry, load } = await services(t);
  const secret = 'raw-secret-must-not-leak';
  const reader = { ...binding, id: 'reader', actorId: 'reader' };
  for (const bindings of [
    [{ ...binding, secretRef: secret }],
    [reader, { ...binding, secretRef: secret }],
    [binding, binding],
    [binding, { ...binding, id: 'another-id' }],
    [binding, { ...reader, id: binding.id }],
    [{ ...binding, headers: { authorization: `Bearer ${secret}` } }],
  ]) {
    const { ctx, fiber } = load({ bindings, mounts });
    await assert.rejects(fiber.await(), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(!`${String(error)} ${inspect(error)}`.includes(secret));
      return true;
    });
    const parsed = mountsPlugin.Config.safeParse({ bindings, mounts });
    assert.equal(parsed.success, false);
    assert.ok(!JSON.stringify(parsed.error?.issues).includes(secret));
    assert.equal(ctx.get('mounts'), undefined);
    assert.equal(ctx.get('credentials'), undefined);
    assert.deepEqual(await registry.describe(), []);
    await registry.createCatalog('bridge').dispose();
  }
});

test('Config rejects inline authentication, protocol headers, wildcards and unsafe selectors without echoing values', () => {
  const sentinel = 'SHOULD-NOT-APPEAR-IN-ERROR';
  const invalid: unknown[] = [
    null,
    { ...binding, authorization: sentinel },
    { ...binding, secretRef: sentinel },
    { ...binding, secretRef: 'file:/tmp/secret' },
    { ...binding, secretRef: 'env:INVALID-NAME' },
    { ...binding, actorId: '*' },
    { ...binding, projectId: '*' },
    { ...binding, mountId: '*' },
    { ...binding, headers: { 'X-Subject': sentinel, 'x-subject': sentinel } },
    { ...binding, headers: { 'x-subject': `Bearer ${sentinel}` } },
    { ...binding, headers: { 'x-subject': `Basic ${sentinel}` } },
    { ...binding, headers: { 'x-subject': `env:${sentinel}` } },
    { ...binding, headers: { 'x-subject': `${sentinel}\r\nInjected: value` } },
  ];
  for (const name of [
    'Authorization',
    'Cookie',
    'Host',
    'MCP-Protocol-Version',
    'Mcp-Session-Id',
    'Content-Type',
    'Proxy-Authorization',
    'X-Api-Key',
    'X-Auth-Token',
    'X-Session-Id',
    'X-Forwarded-Host',
    'X-Secret',
    'X-Credentials',
    'X-Password',
    'X-Bearer',
    'X-Signature',
    'X-Jwt-Assertion',
  ])
    invalid.push({ ...binding, headers: { [name]: sentinel } });
  for (const value of invalid) {
    const parsed = mountsPlugin.Config.safeParse({ bindings: [value] });
    assert.equal(parsed.success, false, inspect(value));
    const error = new ValidationError(parsed.error!.issues);
    for (const rendered of [String(error), inspect(error), JSON.stringify(parsed.error!.issues)])
      assert.ok(!rendered.includes(sentinel));
  }
});

test('Config lower-cases selector names and copies the configuration', () => {
  const configured = {
    ...binding,
    headers: { 'X-Namespace': 'project-a', 'x-subject': 'subject-a' },
  };
  const parsed = mountsPlugin.Config.parse({ bindings: [configured] });
  configured.headers['X-Namespace'] = 'mutated';
  assert.deepEqual(parsed.bindings[0].headers, {
    'x-namespace': 'project-a',
    'x-subject': 'subject-a',
  });
  assert.deepEqual(mountsPlugin.Config.parse({ bindings: [binding] }).bindings[0], binding);
});
