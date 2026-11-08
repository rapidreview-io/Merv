import type { Caller, Data, WorkflowExecutionPolicy } from '@merv/contracts';

import type { WorkSession } from '@merv/sessions/types';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { Bindings } from '../packages/mounts/src/credentials.js';
import { Invocations } from '../packages/mounts/src/upstream.js';
import { createApp, quietApiConfig } from './fixtures/app.js';
import { CredentialServer } from './fixtures/credential-server.js';

async function fixture(
  t: TestContext,
  policy?: WorkflowExecutionPolicy,
  packetText?: string,
  role: 'producer' | 'reviewer' = 'producer',
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-session-api-'));
  const app = await createApp({ directory, config: quietApiConfig(), port: 0 });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Session transport',
    actorName: 'Source',
  });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const clients = new Set<Client>();
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => {
    await Promise.allSettled([...clients].map((client) => client.close()));
    for (const close of cleanup) await close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const workflowName = `session-transport-${randomUUID()}`;
  const program = await app.ctx.workflows.register(
    {
      name: workflowName,
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    },
    {
      actions: [
        {
          name: 'finish',
          states: ['working'],
          transitions: ['finish'],
          tool: 'checked.echo',
          instruction: 'Finish',
          check: () => {},
        },
      ],
      assignments: [
        {
          state: 'working',
          check: async ({ caller, tx }) => {
            await app.ctx.scope.require(caller, role === 'reviewer' ? 'review' : 'write', tx);
          },
          build: () => ({
            role,
            label: 'Transport test',
            brief: packetText ?? 'Verify the bounded transport.',
            references: [],
            handoff: { instruction: 'Finish', tools: ['checked.echo'] },
            execution: { readOnly: false, tools: [] },
            context: null,
          }),
          execution: policy ?? {
            readOnly: false,
            tools: [
              {
                name: 'checked.echo',
                alternatives: [{ tenant: { kind: 'literal', value: 'fixed' } }],
              },
              {
                name: 'checked.transform',
                alternatives: [{ tenant: { kind: 'literal', value: 'fixed' } }],
              },
              {
                name: 'checked.default',
                alternatives: [{ tenant: { kind: 'literal', value: 'fixed' } }],
              },
            ],
          },
          references: (): Record<string, string> => (packetText ? { evidence: packetText } : {}),
          lease: {
            role: () => role,
            acquire: (): Data => (packetText ? { evidence: packetText } : {}),
            check: () => {},
            release: () => {},
          },
        },
      ],
    },
  );
  const instance = await program.start(source, { workflow: workflowName, requestId: 'start' });
  async function http(
    path: string,
    token = boot.token,
    body?: unknown,
    projectId?: string,
    method?: string,
  ) {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(projectId === undefined ? {} : { 'x-merv-project-id': projectId }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  async function offer(secret = `ms_${randomBytes(32).toString('base64url')}`) {
    const input = {
      instanceId: instance.id,
      expectedRevision: instance.revision,
      runnerId: 'runner',
      requestId: randomUUID(),
      secret,
    };
    const response = await http('/sessions/offer', boot.token, input);
    assert.equal(response.status, 200, JSON.stringify(response));
    return { session: response.body.session as WorkSession, secret, input };
  }
  async function connect(secret: string, projectId?: string) {
    const client = new Client({ name: 'session-api-test', version: '1' });
    clients.add(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: {
          headers: {
            authorization: `Bearer ${secret}`,
            ...(projectId === undefined ? {} : { 'x-merv-project-id': projectId }),
          },
        },
      }),
    );
    return client;
  }
  return { app, boot, source, instance, program, http, offer, connect, cleanup };
}

function errorCode(result: any): string {
  assert.equal(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text).error.code;
}
test('session messages reach the next tool boundary, fence writes, and retain a worker reply', async (t) => {
  const f = await fixture(t);
  let writes = 0;
  f.app.ctx.tools.register({
    name: 'checked.echo',
    description: 'A write reached only after message acknowledgement',
    inputSchema: z.object({ tenant: z.string() }).strict(),
    handler: async (caller) => {
      await f.app.ctx.state.transaction(async (tx) => {
        await f.app.ctx.scope.require(caller, 'write', tx);
        writes++;
      });
      return { writes };
    },
  });
  const issued = await f.offer();
  const client = await f.connect(issued.secret);
  const found = (
    await f.app.ctx.tools.invoke('session.find', f.source, { instanceId: f.instance.id })
  ).value as any;
  assert.equal(found.current.id, issued.session.id);
  assert.deepEqual(Object.keys(found.current).sort(), [
    'actorId',
    'closedAt',
    'createdAt',
    'expectedRevision',
    'id',
    'instanceId',
    'role',
    'status',
    'threadId',
  ]);
  const sent = (
    await f.app.ctx.tools.invoke('session.message', f.source, {
      threadId: issued.session.threadId,
      body: 'Start T at the global mean before k additions.',
      requestId: 'correction-1',
    })
  ).value as any;
  assert.equal(sent.acknowledgedAt, null);
  assert.equal(sent.instanceId, f.instance.id);
  // The thread is the one message address: a session no longer addresses one.
  await assert.rejects(
    f.app.ctx.tools.invoke('session.message', f.source, {
      sessionId: issued.session.id,
      body: 'By session',
      requestId: 'by-session',
    }),
    { code: 'invalid_input' },
  );
  const retry = (
    await f.app.ctx.tools.invoke('session.message', f.source, {
      threadId: issued.session.threadId,
      body: 'Start T at the global mean before k additions.',
      requestId: 'correction-1',
    })
  ).value as any;
  assert.equal(retry.id, sent.id);
  await assert.rejects(
    f.app.ctx.tools.invoke('session.message', f.source, {
      threadId: issued.session.threadId,
      body: 'Different instruction',
      requestId: 'correction-1',
    }),
    { code: 'request_conflict' },
  );

  assert.equal(
    errorCode(await client.callTool({ name: 'checked.echo', arguments: {} })),
    'session_message_pending',
  );
  assert.equal(writes, 0);
  const read = await client.callTool({ name: 'session.messages', arguments: {} });
  assert.equal(read.isError, undefined, JSON.stringify(read));
  const { messages } = JSON.parse((read.content as { text: string }[])[0].text) as {
    messages: any[];
  };
  assert.equal(messages[0].id, sent.id);
  const ack = await client.callTool({
    name: 'session.message.ack',
    arguments: {
      messageId: sent.id,
      reply: 'I will correct the plan before submission.',
      requestId: 'ack-1',
    },
  });
  assert.equal(ack.isError, undefined, JSON.stringify(ack));
  // The queue is the worker's own; a person reads the thread.
  await assert.rejects(
    f.app.ctx.tools.invoke('session.messages', f.source, { sessionId: issued.session.id }),
    { code: 'session_required' },
  );
  const acknowledged = (
    (await f.app.ctx.tools.invoke('session.thread_messages', f.source, {
      threadId: issued.session.threadId,
    })) as any
  ).value.messages as any[];
  assert.equal(acknowledged[0].reply, 'I will correct the plan before submission.');
  assert.ok(acknowledged[0].acknowledgedAt);
  assert.equal((await client.callTool({ name: 'checked.echo', arguments: {} })).isError, undefined);
  assert.equal(writes, 1);
  // Each thread says whether it takes a message now: on open work it does.
  const takes = async () =>
    (await f.http(`/sessions/threads?instanceId=${f.instance.id}`, f.boot.token)).body.threads.map(
      (thread: { takesMessage: boolean }) => thread.takesMessage,
    );
  assert.deepEqual(await takes(), [true]);

  await f.program.transition(f.source, {
    instanceId: f.instance.id,
    expectedRevision: f.instance.revision,
    action: 'finish',
    requestId: 'finish-after-message',
  });
  assert.deepEqual(await takes(), [false]);
  await assert.rejects(
    f.app.ctx.tools.invoke('session.message', f.source, {
      threadId: issued.session.threadId,
      body: 'Too late',
      requestId: 'correction-late',
    }),
    { code: 'thread_retired' },
  );
  const after = (
    await f.app.ctx.tools.invoke('session.find', f.source, { instanceId: f.instance.id })
  ).value as any;
  assert.equal(after.current, null);
});

test('only a writer in the project can send, and only the addressed worker can acknowledge', async (t) => {
  const f = await fixture(t);
  const issued = await f.offer();
  const reader = await f.app.ctx.scope.credentials.issueActor(f.source, {
    name: 'Reader',
    role: 'reader',
  });
  const outsider = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Other',
  });
  const readerCaller = { actorId: reader.actor.id, projectId: f.source.projectId };
  const outsiderCaller = { actorId: outsider.actor.id, projectId: outsider.project.id };
  const message = {
    threadId: issued.session.threadId,
    body: 'Bounded instruction',
    requestId: 'auth-1',
  };
  await assert.rejects(f.app.ctx.sessions.messaging.message(readerCaller, message), {
    code: 'forbidden',
  });
  await assert.rejects(f.app.ctx.sessions.messaging.message(outsiderCaller, message), {
    code: 'thread_not_found',
  });
  await assert.rejects(
    f.app.ctx.sessions.messaging.message(
      { ...f.source, session: { id: issued.session.id } },
      message,
    ),
    { code: 'forbidden' },
  );
  const sent = await f.app.ctx.sessions.messaging.message(f.source, message);
  const otherWork = await f.program.start(f.source, {
    workflow: f.instance.workflow,
    requestId: 'other-work',
  });
  const otherSecret = `ms_${randomBytes(32).toString('base64url')}`;
  await f.app.ctx.sessions.offer(f.source, {
    instanceId: otherWork.id,
    expectedRevision: otherWork.revision,
    runnerId: 'runner',
    requestId: 'other-offer',
    secret: otherSecret,
  });
  const otherWorker = await f.connect(otherSecret);
  assert.equal(
    errorCode(
      await otherWorker.callTool({
        name: 'session.message.ack',
        arguments: { messageId: sent.id, requestId: 'wrong-worker-ack' },
      }),
    ),
    'session_message_not_found',
  );
  await assert.rejects(
    f.app.ctx.sessions.messaging.acknowledgeMessage(f.source, {
      messageId: sent.id,
      requestId: 'fake-ack',
    }),
    { code: 'session_required' },
  );
  await assert.rejects(
    f.app.ctx.sessions.messaging.acknowledgeMessage(
      { ...f.source, session: { id: 'another_session' } },
      { messageId: sent.id, requestId: 'fake-worker-ack' },
    ),
    { code: 'forbidden' },
  );
  const found = await f.app.ctx.sessions.findSession(readerCaller, f.instance.id);
  assert.equal(found.current?.id, issued.session.id);
  assert.equal('source' in found.current!, false);
  assert.equal('lease' in found.current!, false);
  assert.equal('assignment' in found.current!, false);
  assert.equal('execution' in found.current!, false);
  await assert.rejects(f.app.ctx.sessions.findSession(outsiderCaller, f.instance.id), {
    code: 'not_found',
  });
});

test('leased mounted calls require source grants and keep upstream project arguments; delayed dispatch rechecks arguments', async (t) => {
  const f = await fixture(t, {
    readOnly: true,
    tools: [
      { name: '_sandbox.inspect', alternatives: [{ projectId: { kind: 'literal', value: 73 } }] },
    ],
  });
  const upstream = new CredentialServer([
    { id: 'upstream', token: 'synthetic-session-upstream', namespace: 'ns', subject: 'subject' },
  ]);
  await upstream.start();
  const env = `MERV_SESSION_REMOTE_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = 'synthetic-session-upstream';
  const bindings = new Bindings(f.app.ctx.scope, [
    {
      id: 'source-binding',
      actorId: f.source.actorId,
      projectId: f.source.projectId,
      mountId: 'sandbox',
      secretRef: `env:${env}`,
      headers: { 'x-sandbox-namespace': 'ns', 'x-sandbox-subject': 'subject' },
    },
  ]);
  const pools: Invocations[] = [];
  // A warm lane re-checks nothing, so each held-connect case below opens a fresh pool.
  const openPool = () => {
    const pool = new Invocations(
      { id: 'sandbox', url: upstream.url, timeoutMs: 5000 },
      bindings,
      f.app.ctx.scope.toolPolicy,
      f.app.ctx.tools,
    );
    pools.push(pool);
    return pool;
  };
  let pool = openPool();
  f.cleanup.push(async () => {
    await upstream.close();
    await Promise.all(pools.map((pool) => pool.close()));
    delete process.env[env];
  });
  let mutable: Record<string, unknown> | undefined;
  // State access made by the pool's handler, i.e. what the pool adds to the registry's. Counted by
  // async context, so background work that lands during the upstream request does not count.
  const inHandler = new AsyncLocalStorage<true>();
  let handlerAccess = 0;
  const state = f.app.ctx.state;
  const read = state.read.bind(state),
    transaction = state.transaction.bind(state);
  t.mock.method(state, 'read', ((...args: Parameters<typeof read>) => {
    if (inHandler.getStore()) handlerAccess++;
    return read(...args);
  }) as typeof read);
  t.mock.method(state, 'transaction', ((...args: Parameters<typeof transaction>) => {
    if (inHandler.getStore()) handlerAccess++;
    return transaction(...args);
  }) as typeof transaction);
  const handlerReads: number[] = [];
  await f.app.ctx.tools.createCatalog('sandbox').replace([
    {
      kind: 'mcp',
      name: 'inspect',
      description: 'Upstream integer project',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'integer' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      _meta: { extension: { retained: true } },
      handler: async (caller, input) => {
        mutable = input;
        const before = handlerAccess;
        const result = await inHandler.run(true, () => pool.handler('inspect')(caller, input));
        handlerReads.push(handlerAccess - before);
        return result;
      },
    },
  ]);
  const issued = await f.offer();
  const client = await f.connect(issued.secret);
  assert.deepEqual(
    (await client.listTools()).tools
      .filter((tool) => !tool.annotations?.readOnlyHint)
      .map((tool) => tool.name),
    ['board.draw', 'session.ask_owner', 'session.message.ack'],
    'Lease manifest does not replace the exact source grant',
  );
  f.app.ctx.scope.toolPolicy.replace([
    {
      actorId: f.source.actorId,
      projectId: f.source.projectId,
      mountId: 'sandbox',
      tools: ['inspect'],
    },
  ]);
  const catalog = (await client.listTools()).tools;
  assert.deepEqual(catalog[0].inputSchema.properties!.projectId, { type: 'integer' });
  assert.deepEqual(catalog[0]._meta, { extension: { retained: true } });
  const held = upstream.holdNextInitialize();
  const pending = client.callTool({ name: '_sandbox.inspect', arguments: { projectId: 73 } });
  await held.entered;
  mutable!.projectId = 99;
  held.release();
  assert.equal(errorCode(await pending), 'session_invocation');
  assert.equal(
    upstream.callAttempts,
    0,
    'Argument mutation during connection setup cannot cross upstream',
  );
  const accepted = await client.callTool({
    name: '_sandbox.inspect',
    arguments: { projectId: 73 },
  });
  assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
  assert.equal(upstream.callAttempts, 1);
  assert.equal(
    mutable!.projectId,
    73,
    'Upstream projectId remains an argument, not the Merv project envelope',
  );
  assert.equal(
    errorCode(await client.callTool({ name: '_sandbox.inspect', arguments: { projectId: 99 } })),
    'execution_arguments_forbidden',
  );

  handlerReads.length = 0;
  const warm = await client.callTool({ name: '_sandbox.inspect', arguments: { projectId: 73 } });
  assert.equal(warm.isError, undefined, JSON.stringify(warm));
  assert.deepEqual(handlerReads, [0], 'A warm session call adds no State access');

  pool = openPool();
  const revokedGrant = upstream.holdNextInitialize();
  const withGrant = client.callTool({ name: '_sandbox.inspect', arguments: { projectId: 73 } });
  await revokedGrant.entered;
  f.app.ctx.scope.toolPolicy.replace([]);
  revokedGrant.release();
  assert.equal(errorCode(await withGrant), 'tool_forbidden');
  assert.equal(
    upstream.callAttempts,
    2,
    'A revoked source grant cannot cross a delayed connection',
  );
  f.app.ctx.scope.toolPolicy.replace([
    {
      actorId: f.source.actorId,
      projectId: f.source.projectId,
      mountId: 'sandbox',
      tools: ['inspect'],
    },
  ]);

  pool = openPool();
  const releasedLease = upstream.holdNextInitialize();
  const withLease = client.callTool({ name: '_sandbox.inspect', arguments: { projectId: 73 } });
  await releasedLease.entered;
  assert.equal(
    (await f.http(`/sessions/${issued.session.id}/release`, f.boot.token, { runnerId: 'runner' }))
      .status,
    200,
  );
  releasedLease.release();
  errorCode(await withLease);
  assert.equal(
    upstream.callAttempts,
    2,
    'A released lease cannot dispatch an already connected call',
  );
});
