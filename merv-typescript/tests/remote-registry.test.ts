import { fixtureAccess } from './fixtures/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MervError, type Caller } from '@merv/contracts';
import Ajv2020 from 'ajv/dist/2020.js';
import type { RemoteToolDefinition, ToolDefinition } from '@merv/api/types';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { ExactToolPolicy } from '@merv/scope/tool-policy';

const caller = { actorId: 'alice', projectId: 'local-project' };
const scope = {
  async require(value: Caller) {
    if (value.actorId !== caller.actorId || value.projectId !== caller.projectId)
      throw new MervError('forbidden', 'Access denied', 403);
    return {
      id: value.actorId,
      projectId: value.projectId,
      name: 'Alice',
      role: 'operator' as const,
      active: true,
    };
  },
};
function remote(
  name = 'echo',
  overrides: Partial<RemoteToolDefinition> = {},
): RemoteToolDefinition {
  return {
    kind: 'mcp',
    name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...overrides,
  };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const phase of ['authentication', 'parsing'] as const) {
  test(`tool disposal drains pending ${phase} and revocation still prevents handler dispatch`, async () => {
    const entered = latch(),
      release = latch();
    let allowed = true,
      first = true,
      calls = 0,
      disposed = false;
    const registry = new ToolRegistry({
      async require(value) {
        if (phase === 'authentication' && first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        if (!allowed) throw new MervError('forbidden', 'Access was revoked', 403);
        return await scope.require(value);
      },
    });
    const remove = registry.register({
      name: 'awaited',
      description: 'Asynchronous admission fixture',
      inputSchema: z
        .object({})
        .strict()
        .transform(async (value) => {
          if (phase === 'parsing') {
            entered.resolve();
            await release.promise;
          }
          return value;
        }),
      handler: () => {
        calls++;
        return 'unreachable';
      },
    });
    try {
      const pending = registry.call('awaited', caller, {});
      const rejected = assert.rejects(pending, { code: 'forbidden' });
      await entered.promise;
      const draining = remove().then(() => {
        disposed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(disposed, false);
      assert.deepEqual(await registry.list(), []);
      await assert.rejects(registry.call('awaited', caller, {}), { code: 'unknown_tool' });
      allowed = false;
      release.resolve();
      await rejected;
      await draining;
      assert.equal(calls, 0);
      assert.equal(disposed, true);
    } finally {
      release.resolve();
      await registry.close();
    }
  });
}

test('native invocation remains JSON even when its value resembles MCP, while remote results retain all content and metadata', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess);
  const result = {
    content: [
      {
        type: 'text' as const,
        text: 'computed',
        annotations: { audience: ['user' as const], priority: 0.7 },
        _meta: { source: 'remote' },
      },
      { type: 'image' as const, data: 'AA==', mimeType: 'image/png' },
      { type: 'audio' as const, data: 'AA==', mimeType: 'audio/wav' },
      {
        type: 'resource' as const,
        resource: {
          uri: 'memory://result',
          text: 'body',
          mimeType: 'text/plain',
          _meta: { version: 2 },
        },
      },
      {
        type: 'resource_link' as const,
        name: 'Download',
        uri: 'https://example.com/result',
        mimeType: 'text/plain',
      },
    ],
    structuredContent: { answer: 42 },
    isError: false,
    _meta: { trace: 'opaque' },
  };
  registry.register({
    name: 'native',
    description: 'Native',
    inputSchema: z.object({ value: z.string().default('default') }),
    handler: (_caller, input) => ({ ...result, nativeInput: input }),
  });
  assert.deepEqual(await registry.invoke('native', caller, {}), {
    format: 'json',
    value: { ...result, nativeInput: { value: 'default' } },
  });
  const tool = remote('rich', {
    description: 'Rich result',
    title: 'Rich title',
    icons: [{ src: 'https://example.com/icon.svg', mimeType: 'image/svg+xml', theme: 'dark' }],
    annotations: {
      title: 'Hint title',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execution: { taskSupport: 'forbidden' },
    _meta: { arbitrary: { retained: true } },
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
      additionalProperties: false,
    },
    handler: () => result,
  });
  await registry.createCatalog('remote').replace([tool]);
  const { kind: _kind, handler: _handler, ...metadata } = tool;
  assert.deepEqual(
    (await registry.describe()).find((item) => item.name === '_remote.rich'),
    { ...metadata, name: '_remote.rich' },
  );
  assert.deepEqual(await registry.invoke('_remote.rich', caller, {}), {
    format: 'mcp',
    value: result,
  });
  assert.deepEqual(await registry.call('_remote.rich', caller, {}), result);
});

test('remote JSON Schema validates without coercion, defaults, argument stripping, or consuming remote projectId', async () => {
  // A remote call's read decision is its grant check, so this policy authorizes through Scope.
  const access = new ExactToolPolicy(scope, [
    { ...caller, mountId: 'schema', tools: ['validate', 'tuple'] },
  ]);
  const registry = new ToolRegistry(scope, access);
  let seen: unknown;
  const catalog = registry.createCatalog('schema');
  await catalog.replace([
    remote('validate', {
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: { count: { type: 'integer', minimum: 2 } },
        properties: {
          projectId: { type: 'string' },
          count: { $ref: '#/$defs/count' },
          email: { type: 'string', format: 'email' },
          optional: { type: 'integer', default: 7 },
        },
        required: ['projectId', 'count', 'email'],
        additionalProperties: false,
      },
      handler: (actor, input) => {
        assert.deepEqual(actor, caller);
        seen = input;
        return { content: [{ type: 'text', text: 'valid' }] };
      },
    }),
  ]);
  const args = { projectId: 'upstream-project', count: 3, email: 'a@example.com' };
  await registry.call('_schema.validate', caller, args);
  assert.deepEqual(seen, args);
  assert.deepEqual(args, { projectId: 'upstream-project', count: 3, email: 'a@example.com' });
  for (const invalid of [
    { ...args, count: '3' },
    { ...args, count: 1 },
    { ...args, email: 'invalid' },
    { ...args, extra: true },
    { count: 3 },
  ]) {
    await assert.rejects(registry.call('_schema.validate', caller, invalid), {
      code: 'invalid_input',
    });
  }
  await assert.rejects(
    registry.call('_schema.validate', { ...caller, projectId: 'foreign' }, args),
    { code: 'forbidden' },
  );
  await catalog.replace([
    remote('tuple', {
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          pair: {
            type: 'array',
            items: [{ type: 'string' }, { type: 'number' }],
            minItems: 2,
            maxItems: 2,
          },
        },
        required: ['pair'],
        additionalProperties: false,
      },
    }),
  ]);
  await registry.call('_schema.tuple', caller, { pair: ['x', 2] });
  await assert.rejects(registry.call('_schema.tuple', caller, { pair: [2, 'x'] }), {
    code: 'invalid_input',
  });
});

test('catalog compilation is atomic and unsupported schemas or execution modes never replace a working catalog', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess),
    catalog = registry.createCatalog('atomic');
  await catalog.replace([remote('original')]);
  const unsupported = [
    { type: 'object', $schema: 'https://json-schema.org/draft/2019-09/schema' },
    { type: 'object', properties: { x: { $ref: 'https://example.com/schema.json' } } },
    {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { x: { $ref: 'http://example.com/schema.json' } },
    },
    { type: 'object', properties: { x: { $ref: '#/$defs/missing' } } },
    { type: 'object', $async: true },
    { type: 'object', properties: { x: { $async: true, type: 'string' } } },
    { type: 'object', properties: { x: { type: 'nonsense' } } },
  ];
  for (const inputSchema of unsupported) {
    await assert.rejects(
      catalog.replace([
        remote('first-valid'),
        remote('invalid', { inputSchema: inputSchema as RemoteToolDefinition['inputSchema'] }),
      ]),
      { code: 'invalid_schema' },
    );
    assert.deepEqual(
      (await registry.list()).map((tool) => tool.name),
      ['_atomic.original'],
    );
    assert.ok(await registry.call('_atomic.original', caller, {}));
  }
  await assert.rejects(catalog.replace([remote('dup'), remote('dup')]), { code: 'duplicate_tool' });
  for (const taskSupport of ['optional', 'required'] as const) {
    await assert.rejects(catalog.replace([remote('task', { execution: { taskSupport } })]), {
      code: 'unsupported_execution',
    });
  }
  assert.deepEqual(
    (await registry.list()).map((tool) => tool.name),
    ['_atomic.original'],
  );
});

test('mounted namespaces are unique and reserved, and catalog descriptions are defensive snapshots', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess);
  assert.throws(() => registry.register(remote('unprefixed')), { code: 'catalog_required' });
  for (const mount of ['Uppercase', 'has__separator', 'has.separator', '', 'x'.repeat(65)])
    assert.throws(() => registry.createCatalog(mount), { code: 'invalid_mount' });
  const one = registry.createCatalog('one'),
    two = registry.createCatalog('two');
  assert.throws(() => registry.createCatalog('one'), { code: 'duplicate_mount' });
  assert.throws(
    () =>
      registry.register({
        name: '_future.tool',
        description: '',
        inputSchema: z.object({}),
        handler: () => null,
      }),
    { code: 'reserved_namespace' },
  );
  const tool = remote('same', {
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 3 } },
      required: ['text'],
    },
    _meta: { mutable: true },
  });
  await one.replace([tool]);
  await two.replace([remote('same')]);
  (tool.inputSchema.properties!.text as { minLength: number }).minLength = 0;
  tool._meta!.mutable = false;
  const exposed = (await registry.list()).find(
    (item) => item.name === '_one.same',
  ) as RemoteToolDefinition;
  (exposed.inputSchema.properties!.text as { minLength: number }).minLength = 0;
  assert.equal(
    (await registry.describe()).find((item) => item.name === '_one.same')?._meta?.mutable,
    true,
  );
  await assert.rejects(registry.call('_one.same', caller, { text: 'x' }), {
    code: 'invalid_input',
  });
  await assert.rejects(one.replace([remote('x'.repeat(128))]), {
    code: 'invalid_tool',
    message: `Invalid tool name: _one.${'x'.repeat(128)}`,
  });
  assert.equal((await registry.list()).length, 2);
  // Only the registry's admission calls a remote handler.
  assert.ok((await registry.list()).every((tool) => !('handler' in tool)));
});

test('upstream schema extensions publish, validate what they declare, and fetch nothing', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess),
    catalog = registry.createCatalog('extended');
  const published = {
    extensions: {
      type: 'object',
      'x-upstream': { internal: true },
      discriminator: { propertyName: 'kind' },
      properties: {
        kind: { type: 'string', format: 'upstream-format' },
        nested: { properties: { count: { type: 'integer' } } },
      },
    },
    embedded: {
      $id: 'https://example.com/tool',
      type: 'object',
      $defs: { name: { $id: 'name', type: 'string', minLength: 2 } },
      properties: { name: { $ref: 'name' } },
    },
  };
  await catalog.replace(
    Object.entries(published).map(([name, inputSchema]) =>
      remote(name, { inputSchema: inputSchema as RemoteToolDefinition['inputSchema'] }),
    ),
  );
  assert.ok(
    await registry.call('_extended.extensions', caller, { kind: 'any', nested: { count: 2 } }),
  );
  await assert.rejects(
    registry.call('_extended.extensions', caller, { nested: { count: 'two' } }),
    { code: 'invalid_input' },
  );
  assert.ok(await registry.call('_extended.embedded', caller, { name: 'ok' }));
  await assert.rejects(registry.call('_extended.embedded', caller, { name: 'x' }), {
    code: 'invalid_input',
  });
});

test('an unchanged catalog refresh compiles nothing, and a changed schema compiles once', async (t) => {
  const registry = new ToolRegistry(scope, fixtureAccess),
    catalog = registry.createCatalog('refresh');
  const compile = t.mock.method(Ajv2020.prototype, 'compile');
  const tools = () => [
    remote('one'),
    remote('two'),
    remote('three', {
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    }),
  ];
  await catalog.replace(tools());
  // one and two share a schema.
  assert.equal(compile.mock.callCount(), 3);
  await catalog.replace(tools());
  assert.equal(compile.mock.callCount(), 3);
  await catalog.replace([
    ...tools(),
    remote('four', { inputSchema: { type: 'object', required: ['x'] } }),
  ]);
  assert.equal(compile.mock.callCount(), 4);
  // A refused refresh keeps the published generation's validators.
  await assert.rejects(
    catalog.replace([remote('bad', { inputSchema: { type: 'object', $async: true } })]),
    { code: 'invalid_schema' },
  );
  await catalog.replace(tools());
  assert.equal(compile.mock.callCount(), 5);
  // Another catalog compiles its own.
  await registry.createCatalog('other').replace([remote('one')]);
  assert.equal(compile.mock.callCount(), 6);
});

test('a native tool cannot declare projectId, which selects the project', () => {
  const registry = new ToolRegistry(scope, fixtureAccess);
  assert.throws(
    () =>
      registry.register({
        name: 'project.shadow',
        description: 'Declares the reserved selection field',
        inputSchema: z.object({ projectId: z.string() }).strict(),
        handler: () => null,
      }),
    { code: 'invalid_tool', message: 'projectId is reserved for project selection' },
  );
});

test('conversation policy is the registration’s: mutating the definition changes nothing', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess);
  const definition: ToolDefinition = {
    name: 'pages.only',
    description: 'Only Merv’s own pages run this',
    inputSchema: z.object({}).strict(),
    readOnly: true,
    conversation: 'never',
    handler: () => null,
  };
  registry.register(definition);
  definition.conversation = undefined;
  assert.deepEqual(await registry.describe(caller, true), []);
  await assert.rejects(registry.invoke('pages.only', caller, {}, true), { code: 'tool_forbidden' });
});

test('compact mounted names preserve raw tool identities for grants and do not retain old aliases', async () => {
  const rawName = 'qa.ask_more__detail';
  const checks: [string, string][] = [];
  const registry = new ToolRegistry(scope, {
    granted: async () => (mountId, toolName) => mountId === 'nisa' && toolName === rawName,
    require: async (_caller, mountId, toolName) => {
      checks.push([mountId, toolName]);
      if (mountId !== 'nisa' || toolName !== rawName)
        throw new MervError('tool_forbidden', 'Tool is not granted', 403);
    },
  });
  try {
    await registry.createCatalog('nisa').replace([remote(rawName), remote('qa.cancel')]);
    await registry.createCatalog('another-plugin').replace([remote(rawName)]);
    assert.deepEqual(
      (await registry.describe(caller)).map((tool) => tool.name),
      [`_nisa.${rawName}`],
    );
    assert.deepEqual(await registry.call(`_nisa.${rawName}`, caller, {}), {
      content: [{ type: 'text', text: 'ok' }],
    });
    // Authority is checked at admission and again before queued remote dispatch.
    assert.deepEqual(checks, [
      ['nisa', rawName],
      ['nisa', rawName],
    ]);
    await assert.rejects(registry.call('_nisa.qa.cancel', caller, {}), { code: 'tool_forbidden' });
    await assert.rejects(registry.call(`_another-plugin.${rawName}`, caller, {}), {
      code: 'tool_forbidden',
    });
    await assert.rejects(registry.call(`mount__nisa__${rawName}`, caller, {}), {
      code: 'unknown_tool',
    });
    await assert.rejects(registry.call(rawName, caller, {}), { code: 'unknown_tool' });
  } finally {
    await registry.close();
  }
});

test('replacement publishes immediately, drains old calls, and disposal tracks both generations', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess),
    catalog = registry.createCatalog('generations');
  const oldEntered = latch(),
    oldRelease = latch(),
    nextEntered = latch(),
    nextRelease = latch();
  const old = remote('work', {
    handler: async () => {
      oldEntered.resolve();
      await oldRelease.promise;
      return { content: [{ type: 'text', text: 'old' }] };
    },
  });
  const next = remote('work', {
    handler: async () => {
      nextEntered.resolve();
      await nextRelease.promise;
      return { content: [{ type: 'text', text: 'new' }] };
    },
  });
  try {
    await catalog.replace([old]);
    const first = registry.call('_generations.work', caller, {});
    await oldEntered.promise;
    let replaced = false;
    const replacement = catalog.replace([next]).then(() => {
      replaced = true;
    });
    const second = registry.call('_generations.work', caller, {});
    await nextEntered.promise;
    assert.equal(replaced, false);
    let disposed = false;
    const disposal = catalog.dispose().then(() => {
      disposed = true;
    });
    assert.deepEqual(await registry.list(), []);
    await assert.rejects(registry.call('_generations.work', caller, {}), {
      code: 'unknown_tool',
    });
    oldRelease.resolve();
    assert.deepEqual(await first, { content: [{ type: 'text', text: 'old' }] });
    await replacement;
    assert.equal(disposed, false, 'New generation is also owned and must finish');
    nextRelease.resolve();
    assert.deepEqual(await second, { content: [{ type: 'text', text: 'new' }] });
    await disposal;
    await assert.rejects(catalog.replace([remote()]), { code: 'catalog_closed' });
  } finally {
    oldRelease.resolve();
    nextRelease.resolve();
    await registry.close();
  }
});

test('a stale catalog disposer cannot delete a replacement mount while its original call drains', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess),
    entered = latch(),
    release = latch();
  const old = registry.createCatalog('reused');
  try {
    await old.replace([
      remote('echo', {
        handler: async () => {
          entered.resolve();
          await release.promise;
          return { content: [{ type: 'text', text: 'old' }] };
        },
      }),
    ]);
    const pending = registry.call('_reused.echo', caller, {});
    await entered.promise;
    const disposed = old.dispose();
    const replacement = registry.createCatalog('reused');
    await replacement.replace([remote()]);
    release.resolve();
    await pending;
    await disposed;
    await old.dispose();
    assert.deepEqual(await registry.call('_reused.echo', caller, {}), {
      content: [{ type: 'text', text: 'ok' }],
    });
    await replacement.replace([]);
    assert.deepEqual(await registry.list(), []);
  } finally {
    release.resolve();
    await registry.close();
  }
});

test('remote error results stay MCP errors and successful structured results honor their declared schema', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess),
    catalog = registry.createCatalog('results');
  const outputSchema = {
    type: 'object' as const,
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  };
  const error = {
    content: [{ type: 'text' as const, text: 'upstream refused' }],
    isError: true,
    _meta: { failure: 'retained' },
  };
  await catalog.replace([
    remote('error', { outputSchema, handler: () => error }),
    remote('missing', { outputSchema }),
    remote('wrong', {
      outputSchema,
      handler: () => ({ content: [], structuredContent: { value: 1 } }),
    }),
  ]);
  assert.deepEqual(await registry.invoke('_results.error', caller, {}), {
    format: 'mcp',
    value: error,
  });
  await assert.rejects(registry.call('_results.missing', caller, {}), {
    code: 'invalid_remote_result',
  });
  await assert.rejects(registry.call('_results.wrong', caller, {}), {
    code: 'invalid_remote_result',
  });
});

test('registry close withdraws admission and drains retired catalog calls', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess),
    catalog = registry.createCatalog('closing'),
    entered = latch(),
    release = latch();
  try {
    await catalog.replace([
      remote('slow', {
        handler: async () => {
          entered.resolve();
          await release.promise;
          return { content: [] };
        },
      }),
    ]);
    const pending = registry.call('_closing.slow', caller, {});
    await entered.promise;
    const replacement = catalog.replace([remote('new')]);
    let closed = false;
    const closing = registry.close().then(() => {
      closed = true;
    });
    assert.deepEqual(await registry.list(), []);
    await assert.rejects(registry.invoke('_closing.new', caller, {}), {
      code: 'unavailable',
    });
    assert.equal(closed, false);
    release.resolve();
    await pending;
    await replacement;
    await closing;
    await assert.rejects(catalog.replace([]), { code: 'unavailable' });
  } finally {
    release.resolve();
    await registry.close();
  }
});
