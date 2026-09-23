import { mapAsync } from '@merv/contracts';
import { createService } from '@merv/contracts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ProjectScope } from '@merv/scope';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { ApiServer } from '../packages/api/src/http.js';
import { ScopedRemoteClients } from '../packages/mounts/src/credential-client.js';
import { createApp } from './fixtures/app.js';
import type { Caller } from '@merv/contracts';
import { openState } from './fixtures/state.js';

function identity(c: {
  actor: { id: string; projectId: string };
  credential: { id: string };
}): Caller {
  return { actorId: c.actor.id, projectId: c.actor.projectId, credentialId: c.credential.id };
}
const decode = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as { text: string }[])[0].text);

async function connect(url: string, token: string) {
  const client = new Client({ name: 'credential-lifecycle', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

test('HTTP/MCP rotation replaces authority while task and actor identity stay durable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-credential-auth-'));
  let app = await createApp({ directory, api: true, port: 0 });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const operator = await app.ctx.scope.bootstrap({
    projectName: 'Credentials',
    actorName: 'Operator',
  });
  const admin = identity(operator);
  const producer = await app.ctx.scope.issueActor(admin, { name: 'Producer', role: 'producer' });
  const task = await app.ctx.tasks.create(identity(producer), {
    title: 'Retain identity',
    goal: 'Keep work across rotation.',
    checks: ['Original actor attribution survives.'],
    requestId: 'create',
  });
  await app.ctx.workflows.begin(identity(producer), { instanceId: task.id, expectedRevision: 0 });
  const adminClient = await connect(app.ctx.api.url!, operator.token);
  clients.push(adminClient);
  const metadata = decode(
    await adminClient.callTool({
      name: 'actor.credentials',
      arguments: { actorId: producer.actor.id },
    }),
  );
  assert.equal(metadata[0].id, producer.credential.id);
  assert.equal(metadata[0].kind, 'actor');
  assert.ok(!JSON.stringify(metadata).includes(producer.token));
  const rotationResult = await adminClient.callTool({
    name: 'actor.rotate_token',
    arguments: { credentialId: producer.credential.id },
  });
  assert.equal(rotationResult.isError, undefined);
  const successor = decode(rotationResult);
  assert.equal(successor.actor.id, producer.actor.id);
  assert.equal(successor.credential.previousId, producer.credential.id);
  assert.notEqual(successor.token, producer.token);
  assert.notEqual(successor.credential.id, producer.credential.id);
  const http = async (token: string, tool: string, input: object = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${tool}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await http(producer.token, 'task.get', { taskId: task.id })).status, 401);
  const fresh = await connect(app.ctx.api.url!, successor.token);
  clients.push(fresh);
  assert.equal(
    decode(await fresh.callTool({ name: 'actor.whoami', arguments: {} })).id,
    producer.actor.id,
  );
  const read = await http(successor.token, 'task.get', { taskId: task.id });
  assert.equal(read.status, 200);
  assert.equal(read.body.result.producerId, producer.actor.id);
  assert.equal(read.body.result.workStarts[0].actorId, producer.actor.id);
  assert.equal(
    (await http(successor.token, 'actor.rotate_token', { credentialId: successor.credential.id }))
      .status,
    403,
  );
  assert.equal(
    (
      await http(successor.token, 'task.get', {
        taskId: task.id,
        credentialId: operator.credential.id,
      })
    ).status,
    400,
  );
  const replay = await http(operator.token, 'actor.rotate_token', {
    credentialId: producer.credential.id,
  });
  assert.equal(replay.status, 409);
  await Promise.allSettled(clients.map((client) => client.close()));
  await app.stop();
  app = await createApp({ directory, api: true, port: 0 });
  assert.equal((await http(successor.token, 'task.get', { taskId: task.id })).status, 200);
  const revoked = await http(operator.token, 'actor.revoke_token', {
    credentialId: successor.credential.id,
  });
  assert.equal(revoked.status, 200);
  assert.equal((await http(successor.token, 'task.get', { taskId: task.id })).status, 401);
  assert.equal(await app.ctx.scope.eligible(admin.projectId, producer.actor.id, 'write'), true);
  assert.equal((await app.ctx.tasks.get(admin, task.id)).producerId, producer.actor.id);
  assert.equal(
    (await app.ctx.state.events(admin.projectId)).filter(
      (event) => event.type === 'actor.revoked' && event.subjectId === producer.actor.id,
    ).length,
    0,
  );
});

test('expiry rejects HTTP and MCP discovery/calls, including a credential invalidated after authentication', async (t) => {
  let time = Date.parse('2026-09-15T00:00:00.000Z');
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state, () => time));
  const tools = new ToolRegistry(scope);
  tools.register({
    name: 'probe',
    description: 'Read authorized caller.',
    inputSchema: z.object({}).strict(),
    readOnly: true,
    handler: (caller) => caller,
  });
  const api = new ApiServer(scope, tools);
  await api.start();
  const admin = await scope.bootstrap({ projectName: 'Expiry', actorName: 'Operator' });
  const issued = await scope.issueActor(identity(admin), {
    name: 'Expiring',
    role: 'reader',
    expiresAt: new Date(time + 1000).toISOString(),
  });
  const client = await connect(api.url!, issued.token);
  t.after(async () => {
    await client.close();
    await api.stop();
    await tools.close();
    await state.close();
  });
  const probe = decode(await client.callTool({ name: 'probe', arguments: {} }));
  assert.equal(probe.credentialId, issued.credential.id);
  const auth = scope.authenticate.bind(scope);
  scope.authenticate = async (token) => {
    const result = await auth(token);
    if (token === issued.token) time += 1000;
    return result;
  };
  const afterAuth = await client.callTool({ name: 'probe', arguments: {} });
  assert.equal(afterAuth.isError, true);
  assert.equal(decode(afterAuth).error.code, 'forbidden');
  const expired = await fetch(`${api.url}/tools`, {
    headers: { authorization: `Bearer ${issued.token}` },
  });
  assert.equal(expired.status, 401);
  await assert.rejects(client.listTools());
  scope.authenticate = auth;
});

test('registry rechecks credential and remote grants between initial admission and handler dispatch', async (t) => {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const operator = await scope.bootstrap({ projectName: 'Dispatch', actorName: 'Operator' });
  const issued = await scope.issueActor(identity(operator), { name: 'Worker', role: 'producer' });
  const access = scope.toolPolicy;
  access.replace([
    {
      projectId: issued.actor.projectId,
      actorId: issued.actor.id,
      mountId: 'remote',
      tools: ['probe'],
    },
  ]);
  const tools = new ToolRegistry(scope, access);
  t.after(async () => {
    await tools.close();
    await state.close();
  });
  let admitted = 0;
  // Both calls must pass initial admission before the rotation lands, and neither may dispatch
  // before it commits. Reads do not queue behind the rotation's writer on PostgreSQL, so timing
  // alone cannot place it between the two checks; each call waits at a gate after admission.
  let gated = 0;
  let open!: () => void;
  const bothAdmitted = new Promise<void>((resolve) => {
    open = resolve;
  });
  const rotated = bothAdmitted.then(() =>
    scope.rotateCredential(identity(operator), { credentialId: issued.credential.id }),
  );
  const gate = async () => {
    if (++gated === 2) open();
    await rotated;
  };
  const grant = access.require.bind(access);
  let remoteAdmitted = false;
  t.mock.method(access, 'require', async (...args: Parameters<typeof grant>) => {
    await grant(...args);
    if (!remoteAdmitted) {
      remoteAdmitted = true;
      await gate();
    }
  });
  tools.register({
    name: 'probe',
    description: 'Probe.',
    inputSchema: z
      .object({})
      .strict()
      .superRefine(async () => await gate()),
    handler: () => {
      admitted++;
      return {};
    },
  });
  const catalog = tools.createCatalog('remote');
  catalog.replace([
    {
      kind: 'mcp',
      name: 'probe',
      description: 'Probe.',
      inputSchema: { type: 'object', additionalProperties: false },
      handler: async () => {
        admitted++;
        return { content: [] };
      },
    },
  ]);
  await Promise.all([
    assert.rejects(tools.call('probe', identity(issued), {}), { code: 'forbidden' }),
    assert.rejects(tools.call('_remote.probe', identity(issued), {}), { code: 'forbidden' }),
  ]);
  await rotated;
  assert.equal(gated, 2, 'both calls passed initial admission before the rotation');
  assert.equal(admitted, 0);
});

test('mount connection setup retains the original credential fence before upstream dispatch', async (t) => {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const operator = await scope.bootstrap({ projectName: 'Mount fence', actorName: 'Operator' });
  const issued = await scope.issueActor(identity(operator), { name: 'Worker', role: 'producer' });
  const access = scope.toolPolicy;
  access.replace([
    {
      projectId: issued.actor.projectId,
      actorId: issued.actor.id,
      mountId: 'bridge',
      tools: ['probe'],
    },
  ]);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const remote = new ScopedRemoteClients(
    {
      replace() {},
      async resolve(caller) {
        await scope.require(caller, 'read');
        return {
          identityKey: 'fixture-upstream',
          headers: () => ({ authorization: 'Bearer fixture-upstream' }),
        };
      },
    },
    access,
    {
      mounts: { bridge: { url: 'http://127.0.0.1:1/mcp' } },
      clientFactory: () =>
        ({
          connect: () => ready,
          callTool: async () => {
            calls++;
            return { content: [] };
          },
          close: async () => {},
        }) as unknown as Client,
    },
  );
  t.after(async () => {
    release();
    await remote.close();
    await state.close();
  });
  const pending = remote.call(identity(issued), 'bridge', 'probe', {});
  await scope.revokeCredential(identity(operator), issued.credential.id);
  release();
  await assert.rejects(pending, { code: 'forbidden' });
  assert.equal(calls, 0);
});

test('operator self-rotation stages a replacement before invalidating the authenticating token', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-credential-self-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const bootstrap = await app.ctx.scope.bootstrap({
    projectName: 'Staged rotation',
    actorName: 'Owner',
  });
  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  const operator = await app.ctx.scope.issueActor(identity(bootstrap), {
    name: 'Expiring operator',
    role: 'operator',
    expiresAt: deadline,
  });
  const client = await connect(app.ctx.api.url!, operator.token);
  clients.push(client);
  const unsafe = await client.callTool({
    name: 'actor.rotate_token',
    arguments: { credentialId: operator.credential.id },
  });
  assert.equal(unsafe.isError, true);
  assert.equal(decode(unsafe).error.code, 'self_rotation');
  for (const expiresAt of [null, new Date(Date.parse(deadline) + 1000).toISOString()]) {
    const extended = await client.callTool({
      name: 'actor.issue_token',
      arguments: { actorId: operator.actor.id, expiresAt },
    });
    assert.equal(extended.isError, true);
  }
  const issued = await client.callTool({
    name: 'actor.issue_token',
    arguments: { actorId: operator.actor.id },
  });
  assert.equal(issued.isError, undefined);
  const replacement = decode(issued);
  assert.equal(replacement.credential.expiresAt, deadline);
  assert.equal(replacement.actor.id, operator.actor.id);
  assert.equal(replacement.credential.previousId, null);
  assert.equal(
    decode(await client.callTool({ name: 'actor.whoami', arguments: {} })).id,
    operator.actor.id,
    'A lost issuance response leaves the original token usable',
  );
  const next = await connect(app.ctx.api.url!, replacement.token);
  clients.push(next);
  assert.equal(
    decode(await next.callTool({ name: 'actor.whoami', arguments: {} })).id,
    operator.actor.id,
  );
  assert.equal(
    (
      await next.callTool({
        name: 'actor.revoke_token',
        arguments: { credentialId: operator.credential.id },
      })
    ).isError,
    undefined,
  );
  await assert.rejects(client.listTools());
  assert.equal(
    decode(await next.callTool({ name: 'actor.whoami', arguments: {} })).id,
    operator.actor.id,
  );
  const selfRevoke = await next.callTool({
    name: 'actor.revoke_token',
    arguments: { credentialId: replacement.credential.id },
  });
  assert.equal(selfRevoke.isError, true);
  assert.equal(decode(selfRevoke).error.code, 'self_revoke');
});
