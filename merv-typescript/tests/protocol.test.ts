import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './fixtures/app.js';
import { supportedProtocolVersions } from '../packages/api/src/protocol.js';

test('the installed client refuses an incompatible upstream initialization before discovery', async (t) => {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    methods.push(request.method);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: 'incompatible-upstream-fixture', version: '1' },
        },
      }),
    );
  });
  const client = new Client({ name: 'compatibility-probe', version: '1' });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await assert.rejects(
    client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),
      ),
    ),
    /protocol version is not supported: 2026-07-28/i,
  );
  assert.deepEqual(methods, ['initialize']);
});

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-protocol-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const identity = await app.ctx.scope.bootstrap({
    projectName: 'Protocol test',
    actorName: 'Operator',
  });
  const request = async (body: unknown, version?: string) => {
    const response = await fetch(`${app.ctx.api.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(version ? { 'mcp-protocol-version': version } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { app, identity, request };
}

test('SDK-supported legacy versions negotiate and list/call the native stack', async (t) => {
  const { request, identity } = await fixture(t);
  for (const version of supportedProtocolVersions) {
    const initialized = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'compatibility-probe', version: '1' },
      },
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.result.protocolVersion, version);
    const listed = await request(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      version,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.tools.length, 83);
    const called = await request(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'project.get', arguments: {} },
      },
      version,
    );
    assert.equal(called.status, 200);
    assert.equal(JSON.parse(called.body.result.content[0].text).id, identity.project.id);
  }
  // Legacy initialize is an offer; a different mutually supported version may be selected.
  const offered = await request({
    jsonrpc: '2.0',
    id: 4,
    method: 'initialize',
    params: {
      protocolVersion: '2099-01-01',
      capabilities: {},
      clientInfo: { name: 'future-legacy-client', version: '1' },
    },
  });
  assert.equal(offered.status, 200);
  assert.equal(offered.body.result.protocolVersion, '2025-11-25');
});

test('unsupported or conflicting request versions are refused before dispatch', async (t) => {
  const { request } = await fixture(t);
  for (const [header, declared] of [
    ['2026-07-28', undefined],
    [undefined, '2026-07-28'],
    ['2025-11-25', '2026-07-28'],
    ['2025-11-25', '2025-06-18'],
    [undefined, 123],
  ] as const) {
    const result = await request(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/list',
        params: {
          ...(declared !== undefined
            ? { _meta: { 'io.modelcontextprotocol/protocolVersion': declared } }
            : {}),
        },
      },
      header,
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.id, 10);
    assert.equal(result.body.error.code, -32000);
    assert.deepEqual(result.body.error.data.supportedProtocolVersions, supportedProtocolVersions);
    assert.equal(result.body.result, undefined);
  }
  const batch = await request([
    { jsonrpc: '2.0', id: 20, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    },
  ]);
  assert.equal(batch.status, 400);
  assert.equal(batch.body.error.message, 'Unsupported MCP protocol version');
  const supportedMeta = await request(
    {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
      params: {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
      },
    },
    '2025-11-25',
  );
  assert.equal(supportedMeta.status, 200);
  assert.equal(supportedMeta.body.result.tools.length, 83);
  const discover = await request({ jsonrpc: '2.0', id: 12, method: 'server/discover' });
  assert.equal(discover.body.error.code, -32601);
});
