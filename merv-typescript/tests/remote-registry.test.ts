import { fixtureAccess } from './fixtures/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MervError, type Caller } from '@merv/contracts';
import type { RemoteToolDefinition } from '@merv/api/types';
import { ToolRegistry } from '../packages/api/src/registry.js';

const caller = { actorId: 'alice', projectId: 'local-project' };
const scope = {
  require(value: Caller) {
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
    handler: () => ({ content: [{ type: 'text', text: 'ok' }] }),
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
    registry.describe().find((item) => item.name === 'mount__remote__rich'),
    { ...metadata, name: 'mount__remote__rich' },
  );
  assert.deepEqual(await registry.invoke('mount__remote__rich', caller, {}), {
    format: 'mcp',
    value: result,
  });
  assert.deepEqual(await registry.call('mount__remote__rich', caller, {}), result);
});

test('remote JSON Schema validates without coercion, defaults, argument stripping, or consuming remote projectId', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess);
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
  await registry.call('mount__schema__validate', caller, args);
  assert.deepEqual(seen, args);
  assert.deepEqual(args, { projectId: 'upstream-project', count: 3, email: 'a@example.com' });
  for (const invalid of [
    { ...args, count: '3' },
    { ...args, count: 1 },
    { ...args, email: 'invalid' },
    { ...args, extra: true },
    { count: 3 },
  ]) {
    await assert.rejects(registry.call('mount__schema__validate', caller, invalid), {
      code: 'invalid_input',
    });
  }
  await assert.rejects(
    registry.call('mount__schema__validate', { ...caller, projectId: 'foreign' }, args),
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
  await registry.call('mount__schema__tuple', caller, { pair: ['x', 2] });
  await assert.rejects(registry.call('mount__schema__tuple', caller, { pair: [2, 'x'] }), {
    code: 'invalid_input',
  });
});

test('catalog compilation is atomic and unsupported schemas or execution modes never replace a working catalog', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess),
    catalog = registry.createCatalog('atomic');
  await catalog.replace([remote('original')]);
  const unsupported = [
    { type: 'object', unknownKeyword: true },
    { type: 'object', properties: { x: { type: 'string', format: 'unknown-format' } } },
    { type: 'object', $schema: 'https://json-schema.org/draft/2019-09/schema' },
    { type: 'object', properties: { x: { $ref: 'https://example.com/schema.json' } } },
    { type: 'object', properties: { x: { $ref: '#/$defs/missing' } } },
    { type: 'object', $async: true },
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
      registry.list().map((tool) => tool.name),
      ['mount__atomic__original'],
    );
    assert.ok(await registry.call('mount__atomic__original', caller, {}));
  }
  await assert.rejects(catalog.replace([remote('dup'), remote('dup')]), { code: 'duplicate_tool' });
  for (const taskSupport of ['optional', 'required'] as const) {
    await assert.rejects(catalog.replace([remote('task', { execution: { taskSupport } })]), {
      code: 'unsupported_execution',
    });
  }
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ['mount__atomic__original'],
  );
});

test('mounted namespaces are unique and reserved, and catalog descriptions are defensive snapshots', async () => {
  const registry = new ToolRegistry(scope, fixtureAccess);
  assert.throws(() => registry.register(remote('unprefixed')), { code: 'catalog_required' });
  for (const mount of ['Uppercase', 'has__separator', '', 'x'.repeat(65)])
    assert.throws(() => registry.createCatalog(mount), { code: 'invalid_mount' });
  const one = registry.createCatalog('one'),
    two = registry.createCatalog('two');
  assert.throws(() => registry.createCatalog('one'), { code: 'duplicate_mount' });
  assert.throws(
    () =>
      registry.register({
        name: 'mount__future__tool',
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
  const exposed = registry
    .list()
    .find((item) => item.name === 'mount__one__same') as RemoteToolDefinition;
  (exposed.inputSchema.properties!.text as { minLength: number }).minLength = 0;
  assert.equal(
    registry.describe().find((item) => item.name === 'mount__one__same')?._meta?.mutable,
    true,
  );
  await assert.rejects(registry.call('mount__one__same', caller, { text: 'x' }), {
    code: 'invalid_input',
  });
  await assert.rejects(one.replace([remote('x'.repeat(128))]), { code: 'invalid_tool' });
  assert.equal(registry.list().length, 2);
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
    const first = registry.call('mount__generations__work', caller, {});
    await oldEntered.promise;
    let replaced = false;
    const replacement = catalog.replace([next]).then(() => {
      replaced = true;
    });
    const second = registry.call('mount__generations__work', caller, {});
    await nextEntered.promise;
    assert.equal(replaced, false);
    let disposed = false;
    const disposal = catalog.dispose().then(() => {
      disposed = true;
    });
    assert.deepEqual(registry.list(), []);
    await assert.rejects(registry.call('mount__generations__work', caller, {}), {
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
    const pending = registry.call('mount__reused__echo', caller, {});
    await entered.promise;
    const disposed = old.dispose();
    const replacement = registry.createCatalog('reused');
    await replacement.replace([remote()]);
    release.resolve();
    await pending;
    await disposed;
    await old.dispose();
    assert.deepEqual(await registry.call('mount__reused__echo', caller, {}), {
      content: [{ type: 'text', text: 'ok' }],
    });
    await replacement.replace([]);
    assert.deepEqual(registry.list(), []);
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
  assert.deepEqual(await registry.invoke('mount__results__error', caller, {}), {
    format: 'mcp',
    value: error,
  });
  await assert.rejects(registry.call('mount__results__missing', caller, {}), {
    code: 'invalid_remote_result',
  });
  await assert.rejects(registry.call('mount__results__wrong', caller, {}), {
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
    const pending = registry.call('mount__closing__slow', caller, {});
    await entered.promise;
    const replacement = catalog.replace([remote('new')]);
    let closed = false;
    const closing = registry.close().then(() => {
      closed = true;
    });
    assert.deepEqual(registry.list(), []);
    await assert.rejects(registry.invoke('mount__closing__new', caller, {}), {
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
