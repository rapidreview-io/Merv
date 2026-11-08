import { createService } from '@merv/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { currentTask } from './fixtures/current-work.js';

import type { Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';

import { ToolRegistry } from '../packages/api/src/registry.js';

import { createApp } from './fixtures/app.js';
import { openState } from './fixtures/state.js';

function identity(c: {
  actor: { id: string; projectId: string };
  credential: { id: string };
}): Caller {
  return { actorId: c.actor.id, projectId: c.actor.projectId, credentialId: c.credential.id };
}
const decode = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0].text);

async function connect(url: string, token: string) {
  const client = new Client({ name: 'credential-lifecycle', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
/** Credentials are managed from Merv's own pages (POST /tools): a person's agent over MCP is not
 *  offered them. Answers in the shape an MCP call returns, for decode. */
function page(url: string, token: string) {
  return {
    callTool: async ({ name, arguments: input }: { name: string; arguments: object }) => {
      const response = await fetch(`${url}/tools/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as { result?: unknown; error?: unknown };
      return response.ok
        ? { isError: undefined, content: [{ type: 'text', text: JSON.stringify(body.result) }] }
        : {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: body.error }) }],
          };
    },
  };
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
  const operator = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Credentials',
    actorName: 'Operator',
  });
  const admin = identity(operator);
  const producer = await app.ctx.scope.credentials.issueActor(admin, {
    name: 'Producer',
    role: 'producer',
  });
  const task = await currentTask(app.ctx, identity(producer), {
    title: 'Retain identity',
    goal: 'Keep work across rotation.',
    checks: ['Original actor attribution survives.'],
    requestId: 'create',
  });
  await app.ctx.workflows.begin(identity(producer), { instanceId: task.id, expectedRevision: 0 });
  const adminClient = await connect(app.ctx.api.url!, operator.token);
  clients.push(adminClient);
  const refused = await adminClient.callTool({
    name: 'actor.credentials',
    arguments: { actorId: producer.actor.id },
  });
  assert.equal(refused.isError, true);
  assert.equal(decode(refused).error.code, 'tool_forbidden');
  const adminPage = page(app.ctx.api.url!, operator.token);
  const metadata = decode(
    await adminPage.callTool({
      name: 'actor.credentials',
      arguments: { actorId: producer.actor.id },
    }),
  );
  assert.equal(metadata[0].id, producer.credential.id);
  assert.equal(metadata[0].kind, 'actor');
  assert.ok(!JSON.stringify(metadata).includes(producer.token));
  const rotationResult = await adminPage.callTool({
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
  const read = await http(successor.token, 'task.get', { taskId: task.id, full: true });
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

test('registry decides credential and remote grants at handler dispatch, after every wait', async (t) => {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const operator = await scope.credentials.bootstrap({
    projectName: 'Dispatch',
    actorName: 'Operator',
  });
  const issued = await scope.credentials.issueActor(identity(operator), {
    name: 'Worker',
    role: 'producer',
  });
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
  // Both calls wait at a gate until the rotation commits: a native call after parsing, a remote
  // one right before its grant check. Reads do not queue behind the rotation's writer on
  // PostgreSQL, so timing alone cannot place it before the decision.
  let gated = 0;
  let open!: () => void;
  const bothAdmitted = new Promise<void>((resolve) => {
    open = resolve;
  });
  const rotated = bothAdmitted.then(() =>
    scope.credentials.rotateCredential(identity(operator), { credentialId: issued.credential.id }),
  );
  const gate = async () => {
    if (++gated === 2) open();
    await rotated;
  };
  const grant = access.require.bind(access);
  let remoteAdmitted = false;
  t.mock.method(access, 'require', async (...args: Parameters<typeof grant>) => {
    if (!remoteAdmitted) {
      remoteAdmitted = true;
      await gate();
    }
    await grant(...args);
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
  assert.equal(gated, 2, 'both calls waited for the rotation');
  assert.equal(admitted, 0);
});
