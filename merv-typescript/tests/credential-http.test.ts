import { mapAsync } from '@merv/contracts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
import { ScopedRemoteClients } from '../packages/mounts/src/credential-client.js';
import { CredentialServer } from './fixtures/credential-server.js';
import type { CredentialBinding } from '@merv/mounts/types';

test('two projects use separate upstream credentials and connections through real HTTP/MCP', async (t) => {
  const envNames = ['MERV_HTTP_CREDENTIAL_A', 'MERV_HTTP_CREDENTIAL_B'] as const;
  const previous = envNames.map((name) => process.env[name]);
  const secrets = [
    'upstream-fixture-a-secret-123456789',
    'upstream-fixture-b-secret-123456789',
    'upstream-fixture-a-rotated-123456789',
  ];
  process.env[envNames[0]] = secrets[0];
  process.env[envNames[1]] = secrets[1];
  const directory = mkdtempSync(join(tmpdir(), 'merv-credential-http-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const upstream = new CredentialServer([
    { id: 'upstream-a', token: secrets[0], namespace: 'namespace-a', subject: 'subject-a' },
    { id: 'upstream-b', token: secrets[1], namespace: 'namespace-b', subject: 'subject-b' },
    { id: 'upstream-a-rotated', token: secrets[2], namespace: 'namespace-a', subject: 'subject-a' },
  ]);
  await upstream.start();
  const credentials = new EnvironmentCredentials(app.ctx.scope);
  const pool = new ScopedRemoteClients(credentials, app.ctx.scope.toolPolicy, {
    mounts: { bridge: { url: upstream.url } },
    timeoutMs: 2000,
  });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await pool.close();
    await upstream.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
    envNames.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  });
  const a = await app.ctx.scope.bootstrap({ projectName: 'A', actorName: 'A operator' });
  const b = await app.ctx.scope.bootstrap({ projectName: 'B', actorName: 'B operator' });
  const ac = { actorId: a.actor.id, projectId: a.project.id },
    bc = { actorId: b.actor.id, projectId: b.project.id };
  const readerA = await app.ctx.scope.issueActor(ac, { name: 'Reader A', role: 'reader' });
  const readerB = await app.ctx.scope.issueActor(bc, { name: 'Reader B', role: 'reader' });
  const ca = { actorId: readerA.actor.id, projectId: a.project.id },
    cb = { actorId: readerB.actor.id, projectId: b.project.id };
  const grants = [ca, cb].map((caller) => ({ ...caller, mountId: 'bridge', tools: ['inspect'] }));
  app.ctx.scope.toolPolicy.replace(grants);
  const bindings: CredentialBinding[] = [ca, cb].map((caller, i) => ({
    ...caller,
    id: `binding-${i}`,
    mountId: 'bridge',
    secretRef: `env:${envNames[i]}`,
    headers: {
      'x-sandbox-namespace': `namespace-${i === 0 ? 'a' : 'b'}`,
      'x-sandbox-subject': `subject-${i === 0 ? 'a' : 'b'}`,
    },
  }));
  credentials.replace(bindings);
  app.ctx.tools.createCatalog('bridge').replace([
    {
      kind: 'mcp',
      name: 'inspect',
      inputSchema: { type: 'object', additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: async (caller, input) => pool.call(caller, 'bridge', 'inspect', input),
    },
  ]);
  const connect = async (token: string) => {
    const client = new Client({ name: 'credential-integration', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const mcpA = await connect(readerA.token),
    mcpB = await connect(readerB.token);
  const mcpCall = (client: Client) =>
    client.request(
      { method: 'tools/call', params: { name: '_bridge.inspect', arguments: {} } },
      CallToolResultSchema,
    );
  const httpCall = async (token: string, projectId?: string) => {
    const response = await fetch(`${app.ctx.api.url}/tools/_bridge.inspect`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(projectId === undefined ? {} : { 'x-merv-project-id': projectId }),
      },
      body: '{}',
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const [firstA, firstB] = await Promise.all([await mcpCall(mcpA), await mcpCall(mcpB)]);
  assert.equal(firstA.structuredContent?.identity, 'upstream-a');
  assert.equal(firstB.structuredContent?.identity, 'upstream-b');
  assert.equal(firstA.structuredContent?.namespace, 'namespace-a');
  assert.equal(firstB.structuredContent?.subject, 'subject-b');
  assert.notEqual(firstA.structuredContent?.connectionId, firstB.structuredContent?.connectionId);
  const repeatedA = await httpCall(readerA.token);
  assert.equal(repeatedA.status, 200);
  assert.deepEqual(repeatedA.body.result.structuredContent, firstA.structuredContent);
  const count = upstream.calls.length;
  assert.equal((await httpCall(readerA.token, b.project.id)).status, 403);
  app.ctx.scope.toolPolicy.replace([grants[0]]);
  assert.equal((await httpCall(readerB.token)).status, 403);
  assert.equal((await mcpCall(mcpB)).isError, true);
  assert.equal(upstream.calls.length, count);
  app.ctx.scope.toolPolicy.replace(grants);
  credentials.replace([bindings[0]]);
  assert.equal((await httpCall(readerB.token)).status, 403);
  assert.equal((await mcpCall(mcpB)).isError, true);
  assert.equal(upstream.calls.length, count, 'Revoked bindings must not reuse the cached client');
  credentials.replace(bindings);
  process.env[envNames[0]] = secrets[2];
  const rotated = await mcpCall(mcpA);
  assert.equal(rotated.structuredContent?.identity, 'upstream-a-rotated');
  assert.notEqual(rotated.structuredContent?.connectionId, firstA.structuredContent?.connectionId);
  await app.ctx.scope.revokeActor(ac, readerA.actor.id);
  assert.equal((await httpCall(readerA.token)).status, 401);
  const visible = JSON.stringify({
    firstA,
    firstB,
    repeatedA,
    rotated,
    calls: upstream.calls,
    status: app.status(),
    credential: await credentials.resolve(cb, 'bridge'),
  });
  for (const secret of [...secrets, a.token, b.token, readerA.token, readerB.token]) {
    assert.equal(visible.includes(secret), false);
    assert.equal(inspect(await credentials.resolve(cb, 'bridge')).includes(secret), false);
  }
});
