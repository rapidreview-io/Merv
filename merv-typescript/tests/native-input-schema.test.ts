import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { SessionToolPolicy } from '@merv/contracts';
import type { ToolDefinition } from '@merv/api/types';
import { describeTool, ToolRegistry } from '../packages/api/src/registry.js';
import { compileSchema } from '../packages/api/src/schema.js';

const caller = { actorId: 'a', projectId: 'p' };
const scope = {
  require: async () => ({
    id: 'a',
    projectId: 'p',
    name: 'A',
    role: 'operator' as const,
    active: true,
  }),
};

function definition(): ToolDefinition {
  return {
    name: 'example',
    description: 'Two actions with different arguments',
    inputSchema: z
      .object({
        action: z.enum(['list', 'get']).default('list'),
        id: z.coerce.number().int().optional(),
        request: z.object({ value: z.string() }).strict().optional(),
      })
      .strict()
      .superRefine((input, ctx) => {
        if (input.action === 'get' && input.id === undefined)
          ctx.addIssue({ code: 'custom', path: ['id'], message: 'Required' });
      }),
    inputJsonSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get'], default: 'list' },
        id: { type: ['integer', 'null'] },
        request: { $ref: '#/$defs/request' },
      },
      additionalProperties: false,
      anyOf: [
        {
          properties: { action: { const: 'list' }, request: {} },
          additionalProperties: { type: 'null' },
        },
        {
          properties: { action: { const: 'get' }, id: { type: 'integer' } },
          required: ['action', 'id'],
          additionalProperties: { type: 'null' },
        },
      ],
      $defs: {
        request: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    },
    handler: (_caller, input) => input,
  };
}

test('native JSON Schema preserves action constraints and admits project selection only at the argument level', () => {
  const tool = definition();
  const original = structuredClone(tool.inputJsonSchema);
  const schema = describeTool(tool).inputSchema;
  const validate = compileSchema(schema);
  for (const input of [
    {},
    { projectId: 'p' },
    { action: 'get', id: 1, projectId: 'p' },
    { request: { value: 'v' } },
  ])
    assert.equal(validate(input), true, JSON.stringify(input));
  for (const input of [
    { action: 'get' },
    { action: 'get', id: null },
    { action: 'get', id: 1, projectId: 2 },
    { extra: null },
    { request: { value: 'v', projectId: 'p' } },
  ])
    assert.equal(validate(input), false, JSON.stringify(input));
  assert.deepEqual(tool.inputJsonSchema, original);
});

test('native JSON Schema publication does not replace Zod defaults or coercion and is a registration snapshot', async (t) => {
  const tools = new ToolRegistry(scope);
  t.after(() => tools.close());
  const tool = definition();
  tools.register(tool);
  const expected = await tools.describe(caller);
  assert.deepEqual(await tools.call('example', caller, {}), { action: 'list' });
  assert.deepEqual(await tools.call('example', caller, { action: 'get', id: '3' }), {
    action: 'get',
    id: 3,
  });
  await assert.rejects(tools.call('example', caller, { action: 'get' }), { code: 'invalid_input' });
  tool.inputJsonSchema!.properties!.action = {};
  (await tools.describe(caller))[0]!.inputSchema.properties!.action = {};
  assert.deepEqual(await tools.describe(caller), expected);
});

test('session descriptions remove project selection from every action branch', async (t) => {
  const tools = new ToolRegistry(scope);
  t.after(() => tools.close());
  tools.register(definition());
  tools.registerSessionPolicy({ allowsTool: async () => true } as unknown as SessionToolPolicy);
  const [tool] = await tools.describe({ ...caller, session: { id: 's' } });
  assert.equal(JSON.stringify(tool!.inputSchema).includes('projectId'), false);
  const validate = compileSchema(tool!.inputSchema);
  assert.equal(validate({ action: 'get', id: 1 }), true);
  assert.equal(validate({ action: 'get', id: 1, projectId: 'p' }), false);
});

test('legacy aliases retain their captured flat schema without inheriting action conditions', async (t) => {
  const tools = new ToolRegistry(scope);
  t.after(() => tools.close());
  const tool = definition();
  tools.register(tool);
  tools.alias((name) =>
    name === 'old_get' ? { tool: 'example', action: 'get', args: { old_id: 'id' } } : undefined,
  );
  tool.inputSchema = z.object({ changed: z.string() });
  const alias = (await tools.describe(caller, false, { names: ['old_get'] })).find(
    (tool) => tool.name === 'old_get',
  );
  assert.deepEqual(Object.keys(alias!.inputSchema.properties!), ['old_id', 'projectId']);
  assert.equal(alias!.inputSchema.anyOf, undefined);
  assert.equal(compileSchema(alias!.inputSchema)({ old_id: 3, projectId: 'p' }), true);
  assert.deepEqual(await tools.call('old_get', caller, { old_id: '3' }), { action: 'get', id: 3 });
});

test('native schema overrides reject invalid roots, unresolved references and reserved project fields', () => {
  for (const schema of [
    null,
    { type: 'string' },
    { type: 'object', properties: { projectId: {} } },
    { type: 'object', anyOf: [{ properties: { projectId: {} } }] },
    { type: 'object', properties: { value: { $ref: 'https://example.invalid/schema' } } },
    { type: 'object', $ref: '#/$defs/args', $defs: { args: { type: 'object' } } },
  ]) {
    assert.throws(() =>
      describeTool({
        ...definition(),
        inputJsonSchema: schema as ToolDefinition['inputJsonSchema'],
      }),
    );
  }
});

test('native tools without an override retain their Zod publication', () => {
  const { inputJsonSchema: _, ...tool } = definition();
  const schema = describeTool(tool).inputSchema;
  assert.equal(schema.anyOf, undefined);
  assert.deepEqual(schema.required, undefined);
  assert.equal(compileSchema(schema)({ action: 'get' }), true);
});

test('native overrides refuse constraints that cannot safely admit the project envelope', () => {
  for (const constraint of [
    { required: ['projectId'] },
    { propertyNames: { pattern: '^id$' } },
    { patternProperties: { '^project': { type: 'number' } } },
    { minProperties: 1 },
    { maxProperties: 1 },
    { dependentRequired: { projectId: ['id'] } },
    { dependentSchemas: { projectId: { required: ['id'] } } },
    { const: { action: 'list' } },
    { enum: [{ action: 'list' }] },
  ]) {
    for (const schema of [
      { type: 'object', ...constraint },
      { type: 'object', anyOf: [constraint] },
    ])
      assert.throws(() =>
        new ToolRegistry(scope).register({
          ...definition(),
          inputJsonSchema: schema as ToolDefinition['inputJsonSchema'],
        }),
      );
  }
});

test('an explicit object schema can publish a native Zod union without invoking its fallback', async (t) => {
  const tools = new ToolRegistry(scope);
  t.after(() => tools.close());
  const tool = definition();
  tool.inputSchema = z.union([
    z.object({ action: z.literal('list') }).strict(),
    z.object({ action: z.literal('get'), id: z.number() }).strict(),
  ]);
  tools.register(tool);
  assert.equal(
    compileSchema((await tools.describe(caller))[0]!.inputSchema)({
      action: 'get',
      id: 1,
      projectId: 'p',
    }),
    true,
  );
  assert.deepEqual(await tools.call(tool.name, caller, { action: 'get', id: 1 }), {
    action: 'get',
    id: 1,
  });
});
