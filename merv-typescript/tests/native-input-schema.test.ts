import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

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
