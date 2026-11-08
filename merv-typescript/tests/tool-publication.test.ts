import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_NAMES, toolDefinition } from '@sandboxes/http/mcp';
import { compactSchema } from '../packages/api/src/publication.js';
import { compileSchema } from '../packages/api/src/schema.js';

import { expanded, constraints } from './fixtures/tool-schema.js';

test('Sandboxes publication preserves every validation constraint without touching vendor metadata', () => {
  for (const name of TOOL_NAMES) {
    const schema = toolDefinition(name)!.inputSchema;
    const original = JSON.stringify(schema);
    const compact = compactSchema(schema);
    assert.equal(JSON.stringify(schema), original, `${name}: immutable source`);
    assert.deepEqual(constraints(expanded(compact)), constraints(expanded(schema)), name);
    compileSchema(compact);
    assert.ok(JSON.stringify(compact).length <= original.length, name);
  }
});

test('compaction preserves literal data, intersection types, URI bases, and enum validation', () => {
  const repeated = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z]+$' };
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      a: { ...repeated, description: 'First value.' },
      b: { ...repeated, description: 'Second value.' },
      c: repeated,
      d: repeated,
      nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      intersection: { type: 'string', anyOf: [{ type: 'string' }, { type: 'null' }] },
      choice: { type: 'integer', enum: [1, 'bad'] },
      literal: { default: { description: 'Keep', title: 'Keep', anyOf: [{ type: 'null' }] } },
    },
    required: ['a'],
  };
  const compact = compactSchema(schema);
  assert.deepEqual(expanded(compact).properties.literal, schema.properties.literal);
  const before = compileSchema(schema),
    after = compileSchema(compact);
  for (const a of ['ok', '', 'A', 'a'.repeat(81), 1, null])
    for (const choice of [1, 'bad', 2, undefined])
      for (const intersection of [null, 'yes', 1, undefined]) {
        const input = { a, choice, intersection };
        assert.equal(after(input), before(input), JSON.stringify(input));
      }
  const evaluated = {
    type: 'object',
    unevaluatedProperties: false,
    allOf: [{ type: 'object', additionalProperties: true }],
  };
  assert.equal(compileSchema(compactSchema(evaluated))({ extra: 1 }), true);
  assert.equal(compileSchema(evaluated)({ extra: 1 }), true);
  const anchored = { ...schema, $id: 'https://example.test/input' };
  assert.equal(compactSchema(anchored).$defs, undefined, 'do not relocate URI scopes');
});
