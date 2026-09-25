import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from './fixtures/app.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import type { RemoteToolDefinition } from '../packages/api/src/types.js';

test('remote discovery and direct calls enforce exact current grants over HTTP and MCP', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-grants-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const a = await app.ctx.scope.bootstrap({ projectName: 'A', actorName: 'A operator' });
  const b = await app.ctx.scope.bootstrap({ projectName: 'B', actorName: 'B operator' });
  const callerA = { actorId: a.actor.id, projectId: a.project.id };
  const reader = await app.ctx.scope.issueActor(callerA, { name: 'A reader', role: 'reader' });
  const producer = await app.ctx.scope.issueActor(callerA, {
    name: 'A producer',
    role: 'producer',
  });
  const grant = {
    actorId: reader.actor.id,
    projectId: a.project.id,
    mountId: 'bridge',
    tools: ['inspect'],
  };
  app.ctx.scope.toolPolicy.replace([
    grant,
    { ...grant, actorId: producer.actor.id, tools: ['write'] },
  ]);
  const admitted: string[] = [];
  const catalog = app.ctx.tools.createCatalog('bridge');
  const definitions: RemoteToolDefinition[] = ['inspect', 'write'].map((name) => ({
    kind: 'mcp',
    name,
    description: `Fixture ${name}`,
    inputSchema: { type: 'object', additionalProperties: false },
    // An upstream hint never grants a caller permission to invoke the tool.
    annotations: { readOnlyHint: true },
    handler: (caller) => {
      admitted.push(`${caller.actorId}:${name}`);
      return { content: [{ type: 'text', text: name }], structuredContent: { name } };
    },
  }));
  await catalog.replace(definitions);
  const httpList = async (token: string) => {
    const response = await fetch(`${app.ctx.api.url}/tools`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const httpCall = async (token: string, name: string, body: unknown = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const connect = async (token: string) => {
    const client = new Client({ name: 'permission-test', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const readerMcp = await connect(reader.token),
    otherMcp = await connect(b.token);
  assert.equal((await httpList(reader.token)).body.tools.length, 95);
  assert.equal((await readerMcp.listTools()).tools.length, 95);
  assert.equal(
    (await httpList(producer.token)).body.tools.filter((tool: { name: string }) =>
      tool.name.startsWith('_'),
    )[0].name,
    '_bridge.write',
  );
  assert.equal((await otherMcp.listTools()).tools.length, 94);
  assert.equal(
    (await httpList(a.token)).body.tools.length,
    94,
    'Operator role is not a remote grant',
  );
  assert.equal((await httpCall(reader.token, '_bridge.inspect')).status, 200);
  assert.equal(
    (await readerMcp.callTool({ name: '_bridge.inspect', arguments: {} })).isError,
    undefined,
  );
  const count = admitted.length;
  assert.equal((await httpCall(reader.token, '_bridge.write')).status, 403);
  assert.equal((await readerMcp.callTool({ name: '_bridge.write', arguments: {} })).isError, true);
  assert.equal((await otherMcp.callTool({ name: '_bridge.inspect', arguments: {} })).isError, true);
  const forged = await readerMcp.request(
    {
      method: 'tools/call',
      params: {
        name: '_bridge.inspect',
        arguments: {},
        _meta: { 'merv/projectId': b.project.id },
      },
    },
    CallToolResultSchema,
  );
  assert.equal(forged.isError, true);
  assert.equal(admitted.length, count, 'Denied calls must not reach the upstream handler');
  assert.equal(
    (
      await httpCall(reader.token, 'artifact.create', {
        title: 'Not allowed',
        content: 'Reader cannot write',
      })
    ).status,
    403,
  );
  app.ctx.scope.toolPolicy.replace([]);
  assert.equal((await readerMcp.listTools()).tools.length, 94);
  assert.equal((await httpList(reader.token)).body.tools.length, 94);
  assert.equal((await httpCall(reader.token, '_bridge.inspect')).status, 403);
  assert.equal(
    (await readerMcp.callTool({ name: '_bridge.inspect', arguments: {} })).isError,
    true,
  );
  assert.equal(admitted.length, count);
  app.ctx.scope.toolPolicy.replace([grant]);
  assert.equal((await readerMcp.listTools()).tools.length, 95);
  await app.ctx.scope.revokeActor(callerA, reader.actor.id);
  assert.equal((await httpList(reader.token)).status, 401);
  await assert.rejects(readerMcp.listTools());
  assert.equal((await httpCall(a.token, 'task.list')).status, 200);
});

test('a registry without an access provider defaults to denying remote calls and discovery', async () => {
  const caller = { actorId: 'actor', projectId: 'project' };
  const registry = new ToolRegistry({
    require: async () => ({
      id: caller.actorId,
      projectId: caller.projectId,
      name: 'Operator',
      role: 'operator',
      active: true,
    }),
  });
  try {
    registry.createCatalog('ungranted').replace([
      {
        kind: 'mcp',
        name: 'inspect',
        inputSchema: { type: 'object' },
        handler: async () => ({ content: [] }),
      },
    ]);
    assert.equal(
      (await registry.list()).length,
      1,
      'Embedded administration can inspect the installed catalog',
    );
    assert.deepEqual(await registry.list(caller), []);
    await assert.rejects(registry.call('_ungranted.inspect', caller, {}), {
      code: 'tool_forbidden',
      status: 403,
    });
  } finally {
    await registry.close();
  }
});
