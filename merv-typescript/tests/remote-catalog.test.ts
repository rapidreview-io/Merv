import { mapAsync } from '@merv/contracts';
import { fixtureAccess } from './fixtures/access.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { MervError, type Caller, type Scope } from '@merv/contracts';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { collectRemoteCatalog, RemoteCatalog } from '../packages/mounts/src/remote-catalog.js';
import {
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
  const controllers: RemoteCatalog[] = [];
  t.after(async () => {
    await fixture.close();
    await client.close();
    await Promise.allSettled(controllers.map(async (controller) => controller.close()));
    await registry.close();
  });
  await fixture.start();
  await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url)));
  return {
    fixture,
    client,
    registry,
    controller: (
      mount = 'fixture',
      options: ConstructorParameters<typeof RemoteCatalog>[2] = {},
    ) => {
      const controller = new RemoteCatalog(client, registry.createCatalog(mount), options);
      controllers.push(controller);
      return controller;
    },
  };
}

test(
  'independent paginated MCP catalog retains schemas, metadata, remote arguments and every content block',
  { timeout: 10000 },
  async (t) => {
    const { fixture, client, registry } = await setup(t, { pageSize: 1 });
    const definitions = await collectRemoteCatalog(client);
    assert.deepEqual(
      definitions.map(({ kind: _kind, handler: _handler, ...description }) => description),
      representativeTools,
    );
    assert.deepEqual(
      fixture.requests
        .filter((request) => request.method === 'tools/list')
        .map((request) => request.cursor),
      [undefined, '1', '2'],
    );
    await registry.createCatalog('fixture').replace(definitions);
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
  'one controller owns a client notification handler until it closes',
  { timeout: 10000 },
  async (t) => {
    const { fixture, registry, controller } = await setup(t);
    let firstRefreshes = 0;
    const first = controller('first', {
      onRefresh: () => {
        firstRefreshes++;
      },
    });
    await first.refresh();
    assert.throws(() => controller('duplicate'), code('remote_catalog_client_owned'));
    await fixture.notifyToolsChanged();
    await until(
      () => firstRefreshes === 2,
      'Rejected duplicate must not replace the first handler',
    );
    await first.close();
    let secondRefreshes = 0;
    const second = controller('second', {
      onRefresh: () => {
        secondRefreshes++;
      },
    });
    await second.refresh();
    await first.close();
    fixture.setTools([simple('fresh')]);
    await fixture.notifyToolsChanged();
    await until(() => secondRefreshes === 2, 'Repeated old close must not remove the new handler');
    assert.deepEqual(await names(registry), ['_second.fresh']);
  },
);

test(
  'catalog collection rejects repeated cursors and explicit page/tool limit overruns',
  { timeout: 10000 },
  async (t) => {
    const repeated = await setup(t, { page: () => ({ tools: [], nextCursor: 'loop' }) });
    await assert.rejects(collectRemoteCatalog(repeated.client), code('remote_catalog_cursor'));
    assert.equal(
      repeated.fixture.requests.filter((request) => request.method === 'tools/list').length,
      2,
    );
    const normal = await setup(t, { pageSize: 1 });
    await assert.rejects(
      collectRemoteCatalog(normal.client, { maxPages: 1 }),
      code('remote_catalog_limit'),
    );
    await assert.rejects(
      collectRemoteCatalog(normal.client, { maxTools: 1 }),
      code('remote_catalog_limit'),
    );
    const duplicate = await setup(t, {
      page: (cursor) => ({
        tools: [simple('same')],
        ...(cursor === undefined ? { nextCursor: 'second' } : {}),
      }),
    });
    await assert.rejects(collectRemoteCatalog(duplicate.client), code('remote_catalog_duplicate'));
  },
);

test(
  'a held upstream page times out within the collection budget',
  { timeout: 10000 },
  async (t) => {
    const { fixture, client } = await setup(t);
    const held = fixture.holdNextList();
    const collection = collectRemoteCatalog(client, { timeoutMs: 80 });
    const rejection = assert.rejects(collection, code('remote_catalog_timeout'));
    await held.entered;
    try {
      await rejection;
    } finally {
      held.release();
    }
  },
);

test(
  'refresh validates the entire new catalog before replacing any old tool',
  { timeout: 10000 },
  async (t) => {
    const { fixture, registry, controller } = await setup(t);
    registry.register({
      name: 'native',
      description: 'Independent native operation',
      inputSchema: z.object({}).strict(),
      handler: () => 'native-alive',
    });
    const remote = controller();
    await remote.refresh();
    const original = await names(registry);
    fixture.setTools([
      simple('fresh'),
      {
        name: 'bad',
        inputSchema: {
          type: 'object',
          properties: { value: { $ref: 'https://invalid.example/schema' } },
        },
      },
    ]);
    await assert.rejects(remote.refresh(), /schema|reference|\$ref/i);
    assert.ok(remote.lastError);
    assert.deepEqual(await names(registry), original);
    assert.equal(await registry.call('native', caller, {}), 'native-alive');
    assert.deepEqual(await registry.call('_fixture.media', caller, {}), representativeResult);
  },
);

test(
  'atomic refresh withdraws removed tools while draining an already admitted remote call',
  { timeout: 10000 },
  async (t) => {
    const { fixture, registry, controller } = await setup(t);
    const remote = controller();
    await remote.refresh();
    const held = fixture.holdNextCall('media');
    const admitted = registry.call('_fixture.media', caller, {});
    await held.entered;
    fixture.setTools([simple('fresh')]);
    fixture.setResult('fresh', { content: [{ type: 'text', text: 'New generation.' }] });
    let settled = false;
    const replacement = remote.refresh().then(() => {
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

test(
  'tools/list_changed serializes refreshes and reports invalid updates without losing live tools',
  { timeout: 10000 },
  async (t) => {
    const { fixture, client, registry, controller } = await setup(t);
    let notified!: () => void;
    const received = new Promise<void>((resolve) => {
      notified = resolve;
    });
    const install = client.setNotificationHandler.bind(client);
    const observe: Client['setNotificationHandler'] = (schema, handler) =>
      install(schema, (notification) => {
        notified();
        return handler(notification);
      });
    t.mock.method(client, 'setNotificationHandler', observe);
    let completed = 0;
    const failures: unknown[] = [];
    const remote = controller('fixture', {
      onRefresh: () => {
        completed++;
      },
      onError: (error) => {
        failures.push(error);
      },
    });
    await remote.refresh();
    await fixture.waitForNotificationStream();
    const held = fixture.holdNextList();
    fixture.setTools([simple('fresh')]);
    fixture.setResult('fresh', { content: [] });
    const active = remote.refresh();
    await held.entered;
    const listsBeforeNotification = fixture.requests.filter(
      (request) => request.method === 'tools/list',
    ).length;
    await fixture.notifyToolsChanged();
    await received;
    assert.equal(
      fixture.requests.filter((request) => request.method === 'tools/list').length,
      listsBeforeNotification,
      'Notification refresh must queue behind the held collection',
    );
    held.release();
    await active;
    await remote.whenIdle();
    assert.equal(completed, 3);
    assert.deepEqual(await names(registry), ['_fixture.fresh']);
    fixture.setTools([
      {
        name: 'bad',
        inputSchema: {
          type: 'object',
          properties: { value: { $ref: 'https://invalid.example/schema' } },
        },
      },
    ]);
    await fixture.notifyToolsChanged();
    await until(() => failures.length > 0, 'Invalid notification refresh was not reported');
    assert.deepEqual(await names(registry), ['_fixture.fresh']);
    assert.equal(remote.lastError, failures[0]);
  },
);

test(
  'closing withdraws tools immediately and cancels an unfinished catalog collection',
  { timeout: 10000 },
  async (t) => {
    const { fixture, registry, controller } = await setup(t);
    const remote = controller();
    await remote.refresh();
    const held = fixture.holdNextList();
    const pending = remote.refresh();
    const rejected = assert.rejects(pending, code('remote_catalog_closed'));
    await held.entered;
    const closing = remote.close();
    assert.deepEqual(await names(registry), []);
    await assert.rejects(registry.call('_fixture.media', caller, {}), code('unknown_tool'));
    await rejected;
    await closing;
    held.release();
    await assert.rejects(remote.refresh(), code('remote_catalog_closed'));
  },
);
