import { fixtureAccess } from './fixtures/access.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { MervError, type Caller, type Scope } from '@merv/contracts';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { collectRemoteCatalog } from '../packages/mounts/src/remote-catalog.js';
import { fault } from '../packages/mounts/src/upstream.js';
import {
  callable,
  RemoteFixture,
  representativeTools,
  representativeResult,
  type RemoteFixtureOptions,
} from './fixtures/remote-server.js';

const caller: Caller = { actorId: 'local-actor', projectId: 'local-project' };
const scope: Pick<Scope, 'require'> = {
  async require(value) {
    if (value.actorId !== caller.actorId || value.projectId !== caller.projectId)
      throw new MervError('forbidden', 'Wrong project', 403);
    return {
      id: caller.actorId,
      projectId: caller.projectId,
      name: 'Local actor',
      role: 'producer',
      active: true,
    };
  },
};
const code = (expected: string) => (error: unknown) =>
  error instanceof MervError && error.code === expected;
const simple = (name: string): Tool => ({
  name,
  inputSchema: { type: 'object', additionalProperties: false },
  annotations: { readOnlyHint: true },
});
const everyName = new Set([...representativeTools.map((tool) => tool.name), 'fresh']);
/** The selected upstream descriptions in upstream order. */
const collect = async (client: Client, wanted: ReadonlySet<string> = everyName, timeout = 5000) => [
  ...(await collectRemoteCatalog(client, wanted, { timeout })).values(),
];
const names = async (registry: ToolRegistry) => (await registry.list()).map((tool) => tool.name);
async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function setup(t: TestContext, options: RemoteFixtureOptions = {}) {
  const fixture = new RemoteFixture(options),
    client = new Client({ name: 'merv-catalog-test', version: '1' }),
    registry = new ToolRegistry(scope, fixtureAccess);
  t.after(async () => {
    await fixture.close();
    await client.close();
    await registry.close();
  });
  await fixture.start();
  await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url)));
  const catalog = registry.createCatalog('fixture');
  return {
    fixture,
    client,
    registry,
    /** Collects the selected upstream catalog, then swaps it in as one generation. */
    refresh: async () => catalog.replace(callable(client, await collect(client))),
  };
}

test(
  'independent paginated MCP catalog retains schemas, metadata, remote arguments and every content block',
  { timeout: 10000 },
  async (t) => {
    const { fixture, client, registry, refresh } = await setup(t, { pageSize: 1 });
    assert.deepEqual(await collect(client), representativeTools);
    assert.deepEqual(
      fixture.requests
        .filter((request) => request.method === 'tools/list')
        .map((request) => request.cursor),
      [undefined, '1', '2'],
    );
    await refresh();
    assert.deepEqual(await names(registry), [
      '_fixture.failure',
      '_fixture.inspect',
      '_fixture.media',
    ]);
    const inspected = await registry.invoke('_fixture.inspect', caller, {
      projectId: 'ordinary-remote-project',
      options: { label: 'nested', limit: 2 },
    });
    assert.deepEqual(inspected, {
      format: 'mcp',
      value: {
        ...representativeResult,
        structuredContent: { ok: true, projectId: 'ordinary-remote-project' },
      },
    });
    assert.deepEqual(fixture.requests.filter((request) => request.method === 'tools/call')[0], {
      method: 'tools/call',
      name: 'inspect',
      argumentKeys: ['options', 'projectId'],
    });
    const before = fixture.requests.length;
    await assert.rejects(
      registry.call('_fixture.inspect', caller, {
        projectId: 'remote',
        options: { label: 'nested', limit: 99 },
      }),
      code('invalid_input'),
    );
    assert.equal(
      fixture.requests.length,
      before,
      'Input schema rejection must occur before upstream invocation',
    );
    const extended = {
      ...structuredClone(representativeResult),
      extension: { top: true },
      content: representativeResult.content.map((content) => ({
        ...content,
        _meta: { ...content._meta, extension: { nested: true } },
      })),
    } as CallToolResult;
    fixture.setResult('media', extended);
    assert.deepEqual(await registry.call('_fixture.media', caller, {}), extended);
    assert.deepEqual(await registry.call('_fixture.failure', caller, {}), {
      content: [{ type: 'text', text: 'Remote operation declined.' }],
      isError: true,
      _meta: { 'fixture/error': 'retained' },
    });
    fixture.setResult('inspect', { content: [], structuredContent: { ok: 'wrong-type' } });
    await assert.rejects(
      registry.call('_fixture.inspect', caller, {
        projectId: 'remote',
        options: { label: 'nested' },
      }),
      code('invalid_remote_result'),
    );
  },
);

test(
  'collection reads only until every selected name is found and ignores unselected tools',
  { timeout: 10000 },
  async (t) => {
    const { fixture, client } = await setup(t, { pageSize: 1 });
    assert.deepEqual(await collect(client, new Set(['inspect'])), [representativeTools[0]]);
    assert.equal(fixture.requests.filter((request) => request.method === 'tools/list').length, 1);
    const unselected = await setup(t, {
      page: (cursor) => ({
        tools: [simple('same'), simple(cursor === undefined ? 'wanted' : 'late')],
        ...(cursor === undefined ? { nextCursor: 'second' } : {}),
      }),
    });
    assert.deepEqual(
      (await collect(unselected.client, new Set(['wanted', 'late']))).map((tool) => tool.name),
      ['wanted', 'late'],
      'An unselected name may repeat',
    );
  },
);

test(
  'collection ends a repeating cursor at the page limit and refuses a repeated selected name',
  { timeout: 10000 },
  async (t) => {
    const repeated = await setup(t, { page: () => ({ tools: [], nextCursor: 'loop' }) });
    await assert.rejects(collect(repeated.client), code('remote_catalog_limit'));
    assert.equal(
      repeated.fixture.requests.filter((request) => request.method === 'tools/list').length,
      20,
    );
    const duplicate = await setup(t, {
      page: (cursor) => ({
        tools: [simple('same')],
        ...(cursor === undefined ? { nextCursor: 'second' } : {}),
      }),
    });
    await assert.rejects(
      collect(duplicate.client, new Set(['same', 'other'])),
      code('remote_catalog_duplicate'),
    );
  },
);

test('a held upstream page times out as a request timeout', { timeout: 10000 }, async (t) => {
  const { fixture, client } = await setup(t);
  const held = fixture.holdNextList();
  const started = performance.now();
  const collection = collect(client, everyName, 80);
  const rejection = assert.rejects(collection, (error: unknown) => {
    assert.ok(error instanceof McpError && error.code === ErrorCode.RequestTimeout);
    assert.equal(fault(error).code, 'remote_timeout');
    return true;
  });
  await held.entered;
  try {
    await rejection;
    assert.ok(performance.now() - started < 1000);
  } finally {
    held.release();
  }
});

test(
  'atomic refresh withdraws removed tools while draining an already admitted remote call',
  { timeout: 10000 },
  async (t) => {
    const { fixture, registry, refresh } = await setup(t);
    await refresh();
    const held = fixture.holdNextCall('media');
    const admitted = registry.call('_fixture.media', caller, {});
    await held.entered;
    fixture.setTools([simple('fresh')]);
    fixture.setResult('fresh', { content: [{ type: 'text', text: 'New generation.' }] });
    let settled = false;
    const replacement = refresh().then(() => {
      settled = true;
    });
    try {
      await until(
        async () => (await names(registry)).includes('_fixture.fresh'),
        'Replacement catalog was not published',
      );
      assert.deepEqual(await names(registry), ['_fixture.fresh']);
      assert.equal(settled, false);
      await assert.rejects(registry.call('_fixture.media', caller, {}), code('unknown_tool'));
      assert.deepEqual(await registry.call('_fixture.fresh', caller, {}), {
        content: [{ type: 'text', text: 'New generation.' }],
      });
    } finally {
      held.release();
    }
    assert.deepEqual(await admitted, representativeResult);
    await replacement;
  },
);
