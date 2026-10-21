import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { TOOL_NAMES, toolDefinition } from '@sandboxes/http/mcp';
import { compactSchema } from '../packages/api/src/publication.js';
import { compileSchema } from '../packages/api/src/schema.js';
import { describeTool, ToolRegistry } from '../packages/api/src/registry.js';
import type { Caller, SessionToolPolicy } from '@merv/contracts';

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

test('outside noun summaries never change worker metadata or retired calls', async () => {
  const tools = new ToolRegistry({ require: async () => ({ role: 'operator' }) } as never);
  const input = z.object({ id: z.string().min(1), count: z.number().int().min(1).max(5) }).strict();
  const description = 'Original leased-worker description, retained exactly.';
  const handler = (_caller: Caller, args: unknown) => args;
  tools.noun('probe.read', {
    readOnly: true,
    description: 'Original noun overview.',
    summary: 'Read probes.',
    actions: { get: { input, description, summary: 'Get by id.', was: ['probe.get'], handler } },
  });
  tools.registerSessionPolicy({ allowsTool: async () => true } as unknown as SessionToolPolicy);
  const owner = { actorId: 'owner', projectId: 'project' };
  const worker = { ...owner, session: { id: 'session' } };
  const expected = describeTool({
    name: 'probe.get',
    description,
    inputSchema: input,
    readOnly: true,
    handler,
  });
  delete expected.inputSchema.properties!.projectId;
  assert.equal(JSON.stringify((await tools.describe(worker, true))[0]), JSON.stringify(expected));
  const external = (await tools.describe(owner, true))[0]!;
  assert.match(external.description!, /^Read probes\./);
  assert.equal(expanded(external.inputSchema).properties.get.description, 'Get by id.');
  assert.doesNotMatch(JSON.stringify(external), /Required when action/);
  assert.deepEqual(await tools.call('probe.get', owner, { id: 'x', count: 2 }), {
    id: 'x',
    count: 2,
  });
  await assert.rejects(tools.call('probe.get', owner, { id: 'x', count: 6 }), {
    code: 'invalid_input',
  });
  // A named alias is still described in its original form outside a lease too.
  assert.equal(
    (await tools.describe(owner, false, { names: ['probe.get'] }))[0]!.description,
    description,
  );
});

// Captured from origin/main with the measurement helper; optional production tools enabled.
test('the operator MCP listing stays at least 25% below the measured baseline', async () => {
  const baseline = JSON.parse(
    readFileSync(new URL('./fixtures/tool-list-sizes.json', import.meta.url), 'utf8'),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/tool-list-size.ts', '--metadata'],
    { timeout: 120_000 },
  );
  const metadata = /^METADATA\t(.+)$/m.exec(stdout);
  assert.ok(metadata, stdout);
  assert.deepEqual(
    JSON.parse(metadata[1]!),
    JSON.parse(readFileSync(new URL('./fixtures/tool-metadata.json', import.meta.url), 'utf8')),
    'original worker metadata, script declarations and validation constraints',
  );
  const total = /^TOTAL\t(\d+)\t(\d+) tools$/m.exec(stdout);
  assert.ok(total, stdout);
  assert.equal(Number(total[2]), Object.keys(baseline.tools).length);
  assert.ok(Number(total[1]) <= baseline.total * 0.75, `${total[1]} / ${baseline.total}`);
  const sizes = [...stdout.matchAll(/^([\w.]+)\t(\d+)\t\d+\t\d+$/gm)];
  assert.deepEqual(
    sizes.map((row) => row[1]),
    Object.keys(baseline.tools),
  );
  for (const [, name, size] of sizes) assert.ok(Number(size) <= baseline.tools[name!], name);
});
