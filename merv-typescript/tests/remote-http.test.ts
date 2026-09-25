import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from './fixtures/app.js';
import { collectRemoteCatalog } from '../packages/mounts/src/remote-catalog.js';
import {
  callable,
  RemoteFixture,
  representativeTools,
  representativeResult,
} from './fixtures/remote-server.js';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-remote-http-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const upstream = new RemoteFixture({ pageSize: 1 });
  await upstream.start();
  const remote = new Client({ name: 'merv-remote-transport', version: '1' });
  const downstream = new Client({ name: 'merv-downstream-test', version: '1' });
  const catalog = app.ctx.tools.createCatalog('fixture');
  t.after(async () => {
    // Fixture close releases any test barriers even after a failed assertion.
    await upstream.close();
    await catalog.dispose();
    await remote.close();
    await downstream.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await remote.connect(new StreamableHTTPClientTransport(new URL(upstream.url)));
  await catalog.replace(callable(remote, await collectRemoteCatalog(remote)));
  const identity = await app.ctx.scope.bootstrap({
    projectName: 'Transport test',
    actorName: 'Operator',
  });
  app.ctx.scope.toolPolicy.replace([
    {
      actorId: identity.actor.id,
      projectId: identity.project.id,
      mountId: 'fixture',
      tools: representativeTools.map((tool) => tool.name),
    },
  ]);
  await downstream.connect(
    new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${identity.token}` } },
    }),
  );
  const http = async (name: string, input: unknown, projectId?: string) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
        ...(projectId === undefined ? {} : { 'x-merv-project-id': projectId }),
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { app, upstream, remote, downstream, catalog, identity, http };
}

test('independent MCP results and catalog metadata survive both Merv transports', async (t) => {
  const { downstream, http, upstream } = await fixture(t);
  const listed = await downstream.listTools();
  assert.equal(listed.tools.length, 86);
  for (const description of representativeTools) {
    assert.deepEqual(
      listed.tools.find((tool) => tool.name === `_fixture.${description.name}`),
      {
        ...description,
        name: `_fixture.${description.name}`,
      },
    );
  }
  assert.deepEqual(
    upstream.requests
      .filter((request) => request.method === 'tools/list')
      .map((request) => request.cursor),
    [undefined, '1', '2'],
  );
  const result = await downstream.callTool({ name: '_fixture.media', arguments: {} });
  assert.deepEqual(result, representativeResult);
  assert.ok(listed.tools.every((tool) => !tool.name.startsWith('mount__')));
  assert.equal((await http('mount__fixture__media', {})).status, 404);
  assert.equal(
    (await downstream.callTool({ name: 'mount__fixture__media', arguments: {} })).isError,
    true,
  );
  assert.deepEqual(await http('_fixture.media', {}), {
    status: 200,
    body: { result: representativeResult },
  });
  const failure = await downstream.callTool({ name: '_fixture.failure', arguments: {} });
  assert.deepEqual(failure, {
    content: [{ type: 'text', text: 'Remote operation declined.' }],
    isError: true,
    _meta: { 'fixture/error': 'retained' },
  });
  const native = await downstream.callTool({ name: 'project.get', arguments: {} });
  assert.equal(native.isError, undefined);
  assert.equal(JSON.parse((native.content as { text: string }[])[0]!.text).name, 'Transport test');
});

test('remote projectId stays an upstream argument and local project selection is separately enforced', async (t) => {
  const { downstream, identity, http, upstream } = await fixture(t);
  const args = { projectId: 'remote-project', options: { label: 'nested reference', limit: 2 } };
  const success = await downstream.request(
    {
      method: 'tools/call',
      params: {
        name: '_fixture.inspect',
        arguments: args,
        _meta: { 'merv/projectId': identity.project.id },
      },
    },
    CallToolResultSchema,
  );
  assert.deepEqual(success.structuredContent, { ok: true, projectId: 'remote-project' });
  assert.equal((await http('_fixture.inspect', args, identity.project.id)).status, 200);
  const calls = upstream.requests.filter((request) => request.method === 'tools/call').length;
  assert.equal((await http('_fixture.inspect', args, 'foreign-merv-project')).status, 403);
  const denied = await downstream.request(
    {
      method: 'tools/call',
      params: {
        name: '_fixture.inspect',
        arguments: args,
        _meta: { 'merv/projectId': 'foreign-merv-project' },
      },
    },
    CallToolResultSchema,
  );
  assert.equal(denied.isError, true);
  assert.equal(
    (await http('_fixture.inspect', { ...args, options: { label: '', limit: 0 } })).status,
    400,
  );
  assert.equal(
    upstream.requests.filter((request) => request.method === 'tools/call').length,
    calls,
  );
  // Native argument selection remains supported and conflicts are refused.
  assert.equal((await http('project.get', { projectId: identity.project.id })).status, 200);
  assert.equal(
    (await http('project.get', { projectId: 'foreign' }, identity.project.id)).status,
    400,
  );
});

test('catalog withdrawal stops all new remote HTTP/MCP calls while an admitted call drains', async (t) => {
  const { downstream, upstream, catalog, http } = await fixture(t);
  const held = upstream.holdNextCall('media');
  const operation = downstream.callTool({ name: '_fixture.media', arguments: {} });
  await held.entered;
  let done = false;
  const disposing = catalog.dispose().then(() => {
    done = true;
  });
  try {
    assert.equal((await downstream.listTools()).tools.length, 83);
    assert.equal(done, false);
    for (const { name } of representativeTools) {
      // A withdrawn remote tool's projectId still belongs to the upstream tool.
      assert.equal((await http(`_fixture.${name}`, { projectId: 'remote-project' })).status, 404);
      assert.equal(
        (
          await downstream.callTool({
            name: `_fixture.${name}`,
            arguments: { projectId: 'remote-project' },
          })
        ).isError,
        true,
      );
    }
    assert.equal((await http('task.list', {})).status, 200);
  } finally {
    held.release();
  }
  assert.deepEqual(await operation, representativeResult);
  await disposing;
  assert.equal(done, true);
});
