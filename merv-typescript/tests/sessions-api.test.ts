import test, { type TestContext } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller, Data, WorkflowExecutionPolicy } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { sessionsUiPlugin } from '@merv/sessions/ui';
import { uiPlugin } from '@merv/ui';
import { CredentialStore } from '@merv/identity/credentials';
import { Bindings } from '../packages/mounts/src/credentials.js';
import { Invocations } from '../packages/mounts/src/upstream.js';
import { createApp } from './fixtures/app.js';
import { RunnerClient } from '../packages/runner/src/client.js';
import { CredentialServer } from './fixtures/credential-server.js';

async function fixture(
  t: TestContext,
  policy?: WorkflowExecutionPolicy,
  packetText?: string,
  role: 'producer' | 'reviewer' = 'producer',
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-session-api-'));
  const app = await createApp({ directory, api: true, port: 0 });
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
    return { session: response.body.session as Session, secret, input };
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

test('an offer cannot name an agent, and the agent administration and continuing-agent routes are gone', async (t) => {
  const f = await fixture(t);
  const { session, secret, input } = await f.offer();
  const named = await f.http('/sessions/offer', f.boot.token, {
    ...input,
    requestId: 'named',
    agentId: session.threadId,
  });
  assert.deepEqual([named.status, named.body.error.code], [400, 'invalid_session_offer']);
  const agentRoute = `/sessions/agents/${session.threadId}`;
  for (const [path, method] of [
    ['/sessions/agents', 'GET'],
    [agentRoute, 'GET'],
    [agentRoute, 'DELETE'],
  ] as const)
    assert.equal((await f.http(path, f.boot.token, undefined, undefined, method)).status, 404);
  assert.equal((await f.http(`${agentRoute}/observation`, f.boot.token)).status, 404);
  for (const [path, body] of [
    ['/sessions/agents', { name: 'Agent', runnerId: 'r', requestId: 'r', secret }],
    [`${agentRoute}/rotate`, {}],
    ['/sessions/self', undefined],
    ['/sessions/self/assignment', {}],
  ] as const)
    assert.equal((await f.http(path, f.boot.token, body)).status, 404, path);
  // An ms_ bearer, an old continuing agent's included, carries only POST /mcp.
  const old = await f.http('/sessions/self', `ms_${randomBytes(32).toString('base64url')}`);
  assert.deepEqual([old.status, old.body.error.code], [403, 'session_transport_forbidden']);
});
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
      sessionId: issued.session.id,
      body: 'Start T at the global mean before k additions.',
      requestId: 'correction-1',
    })
  ).value as any;
  assert.equal(sent.acknowledgedAt, null);
  assert.equal(sent.instanceId, f.instance.id);
  // A session addresses its thread: the one message address.
  assert.deepEqual([sent.threadId, sent.sessionId], [issued.session.threadId, null]);
  const retry = (
    await f.app.ctx.tools.invoke('session.message', f.source, {
      sessionId: issued.session.id,
      body: 'Start T at the global mean before k additions.',
      requestId: 'correction-1',
    })
  ).value as any;
  assert.equal(retry.id, sent.id);
  await assert.rejects(
    f.app.ctx.tools.invoke('session.message', f.source, {
      sessionId: issued.session.id,
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
  const messages = JSON.parse((read.content as { text: string }[])[0].text) as any[];
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
  const acknowledged = (
    await f.app.ctx.tools.invoke('session.messages', f.source, { sessionId: issued.session.id })
  ).value as any[];
  assert.equal(acknowledged[0].reply, 'I will correct the plan before submission.');
  assert.ok(acknowledged[0].acknowledgedAt);
  assert.equal((await client.callTool({ name: 'checked.echo', arguments: {} })).isError, undefined);
  assert.equal(writes, 1);

  await f.program.transition(f.source, {
    instanceId: f.instance.id,
    expectedRevision: f.instance.revision,
    action: 'finish',
    requestId: 'finish-after-message',
  });
  await assert.rejects(
    f.app.ctx.tools.invoke('session.message', f.source, {
      sessionId: issued.session.id,
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

test('a message queued after tool admission fences the transaction that submits work', async (t) => {
  const f = await fixture(t);
  let writes = 0;
  let entered!: () => void;
  let release!: () => void;
  const inHandler = new Promise<void>((resolve) => (entered = resolve));
  const continueHandler = new Promise<void>((resolve) => (release = resolve));
  f.app.ctx.tools.register({
    name: 'checked.echo',
    description: 'A delayed domain submission',
    inputSchema: z.object({ tenant: z.string() }).strict(),
    handler: async (caller) => {
      entered();
      await continueHandler;
      await f.app.ctx.state.transaction(async (tx) => {
        await f.app.ctx.scope.require(caller, 'write', tx);
        writes++;
      });
      return { writes };
    },
  });
  const issued = await f.offer();
  const client = await f.connect(issued.secret);
  const submitting = client.callTool({ name: 'checked.echo', arguments: {} });
  await inHandler;
  const sent = (
    await f.app.ctx.tools.invoke('session.message', f.source, {
      sessionId: issued.session.id,
      body: 'Correction arrived after admission.',
      requestId: 'race-1',
    })
  ).value as any;
  release();
  assert.equal(errorCode(await submitting), 'session_message_pending');
  assert.equal(writes, 0);
  assert.equal(
    (
      await client.callTool({
        name: 'session.message.ack',
        arguments: { messageId: sent.id, requestId: 'race-ack', reply: 'Received.' },
      })
    ).isError,
    undefined,
  );
  assert.equal((await client.callTool({ name: 'checked.echo', arguments: {} })).isError, undefined);
  assert.equal(writes, 1);
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
    sessionId: issued.session.id,
    body: 'Bounded instruction',
    requestId: 'auth-1',
  };
  await assert.rejects(f.app.ctx.sessions.messaging.message(readerCaller, message), {
    code: 'forbidden',
  });
  await assert.rejects(f.app.ctx.sessions.messaging.message(outsiderCaller, message), {
    code: 'session_not_found',
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

test('a read-only reviewer can acknowledge a message before its verdict write', async (t) => {
  const f = await fixture(
    t,
    {
      readOnly: true,
      tools: [{ name: 'checked.echo', alternatives: [{}] }],
    },
    undefined,
    'reviewer',
  );
  let verdicts = 0;
  f.app.ctx.tools.register({
    name: 'checked.echo',
    description: 'Review verdict surrogate',
    inputSchema: z.object({}).strict(),
    handler: async (caller) => {
      await f.app.ctx.state.transaction(async (tx) => {
        await f.app.ctx.scope.require(caller, 'review', tx);
        verdicts++;
      });
      return { verdicts };
    },
  });
  const issued = await f.offer();
  const client = await f.connect(issued.secret);
  const sent = (
    await f.app.ctx.tools.invoke('session.message', f.source, {
      sessionId: issued.session.id,
      body: 'Check the paper-specific initialization.',
      requestId: 'review-note',
    })
  ).value as any;
  assert.equal(
    errorCode(await client.callTool({ name: 'checked.echo', arguments: {} })),
    'session_message_pending',
  );
  assert.equal(verdicts, 0);
  assert.equal(
    (await client.callTool({ name: 'session.messages', arguments: {} })).isError,
    undefined,
  );
  assert.equal(
    (
      await client.callTool({
        name: 'session.message.ack',
        arguments: {
          messageId: sent.id,
          reply: 'I will verify that against the pinned source.',
          requestId: 'review-ack',
        },
      })
    ).isError,
    undefined,
  );
  assert.equal((await client.callTool({ name: 'checked.echo', arguments: {} })).isError, undefined);
  assert.equal(verdicts, 1);
});

test('real HTTP offers expose no secret; MCP sessions share a fixed catalog and native binding checks', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.app.ctx.tools.register({
    name: 'checked.echo',
    description: 'Bound echo',
    inputSchema: z.object({ tenant: z.string() }).strict(),
    handler: (caller, input) => {
      calls++;
      return { actorId: caller.actorId, input };
    },
  });
  f.app.ctx.tools.register({
    name: 'checked.transform',
    description: 'A transform cannot change admitted authority',
    inputSchema: z.object({ tenant: z.string().transform(() => 'escaped') }).strict(),
    handler: () => {
      calls++;
      return null;
    },
  });
  f.app.ctx.tools.register({
    name: 'checked.default',
    description: 'Unbound schema defaults and stripping remain supported',
    inputSchema: z.object({ tenant: z.string(), note: z.string().default('DEFAULT') }).strip(),
    handler: (_caller, input) => input,
  });
  const issued = await f.offer();
  assert.equal(JSON.stringify(issued.session).includes(issued.secret), false);
  assert.equal((await f.http(`/sessions/${issued.session.id}`)).body.session.id, issued.session.id);
  assert.equal(
    (
      await f.http(`/sessions/${issued.session.id}/attach`, f.boot.token, {
        runnerId: 'runner',
        hostRef: 'local:worker',
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.http(`/sessions/${issued.session.id}/heartbeat`, f.boot.token, { runnerId: 'runner' }))
      .status,
    409,
    'Offers cannot heartbeat before MCP activation',
  );
  assert.equal(
    (
      await f.http(`/sessions/${issued.session.id}/attach`, f.boot.token, {
        runnerId: 'wrong',
        hostRef: 'local:escape',
      })
    ).status,
    403,
  );
  for (const path of ['/tools', '/account', '/account/keys', '/projects', '/sessions']) {
    const denied = await f.http(path, issued.secret);
    assert.equal(denied.status, 403, path);
    assert.equal(denied.body.error.code, 'session_transport_forbidden');
  }
  const client = await f.connect(issued.secret);
  assert.equal(
    (await f.http(`/sessions/${issued.session.id}/heartbeat`, f.boot.token, { runnerId: 'runner' }))
      .status,
    200,
  );
  // The policy's own tools, and every native tool that only reads: a session reads
  // whatever its project holds.
  const listed = (await client.listTools()).tools;
  assert.deepEqual(
    listed.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => tool.name),
    [
      'checked.default',
      'checked.echo',
      'checked.transform',
      'session.ask_owner',
      'session.message.ack',
    ],
  );
  assert.ok(listed.some((tool) => tool.name === 'artifact.list'));
  // A read the policy never named runs as given; a write it never named does not.
  const browsed = await client.callTool({ name: 'artifact.list', arguments: {} });
  assert.equal(browsed.isError, undefined, JSON.stringify(browsed));
  assert.equal(
    errorCode(
      await client.callTool({
        name: 'artifact.create',
        arguments: { title: 'x', content: 'x', mediaType: 'text/plain' },
      }),
    ),
    'execution_tool_forbidden',
  );
  const defaulted = await client.callTool({
    name: 'checked.default',
    arguments: { extra: 'strip' },
  });
  assert.equal(defaulted.isError, undefined, JSON.stringify(defaulted));
  assert.deepEqual(JSON.parse((defaulted.content as { text: string }[])[0].text), {
    tenant: 'fixed',
    note: 'DEFAULT',
  });
  const accepted = await client.callTool({ name: 'checked.echo', arguments: {} });
  assert.equal(accepted.isError, undefined);
  assert.deepEqual(JSON.parse((accepted.content as { text: string }[])[0].text), {
    actorId: issued.session.actorId,
    input: { tenant: 'fixed' },
  });
  assert.equal(
    errorCode(await client.callTool({ name: 'checked.echo', arguments: { tenant: 'other' } })),
    'execution_arguments_forbidden',
  );
  assert.ok(
    ['execution_arguments_forbidden', 'session_invocation'].includes(
      errorCode(await client.callTool({ name: 'checked.transform', arguments: {} })),
    ),
  );
  assert.equal(
    errorCode(await client.callTool({ name: 'checked.echo', arguments: { projectId: 'foreign' } })),
    'invalid_input',
  );
  assert.equal(
    errorCode(
      await client.callTool({
        name: 'actor.create',
        arguments: { name: 'escape', role: 'operator' },
      }),
    ),
    'execution_tool_forbidden',
  );
  assert.equal(calls, 1, 'Rejected bindings and schema transforms never reach handlers');
  await assert.rejects(
    f.connect(issued.secret, 'foreign'),
    'Even MCP initialization rejects a conflicting project header',
  );
  const selected = await f.connect(issued.secret, f.boot.project.id);
  assert.equal(
    errorCode(
      await selected.callTool({
        name: 'checked.echo',
        arguments: { projectId: 'foreign' },
        _meta: { 'merv/projectId': f.boot.project.id },
      }),
    ),
    'invalid_input',
  );
  await assert.rejects(selected.listTools({ _meta: { 'merv/projectId': 'foreign' } }));
});

test('a session tool call admits its lease a fixed number of times', async (t) => {
  const f = await fixture(t);
  f.app.ctx.tools.register({
    name: 'checked.echo',
    description: 'Bound echo',
    inputSchema: z.object({ tenant: z.string() }).strict(),
    handler: (_caller, input) => input,
  });
  const issued = await f.offer();
  const client = await f.connect(issued.secret);
  const workflows = f.app.ctx.workflows;
  const check = workflows.checkLease.bind(workflows);
  const leaseChecks = t.mock.method(
    workflows,
    'checkLease',
    async (...args: Parameters<typeof check>) => await check(...args),
  );
  // An admission is the lease check that carries the frozen execution.
  const admissions = () => leaseChecks.mock.calls.filter((call) => call.arguments[3]).length;
  // The session's liveness is its read decision; the transport does not also read it alone.
  const described = t.mock.method(f.app.ctx.sessions, 'session');
  // Preparation, the check after parsing, and the check after the observation is stored;
  // a read is admitted once more after its handler releases the read snapshot. Each extra
  // layer that re-admits would show here.
  for (const [name, expected] of [
    ['checked.echo', 3],
    ['artifact.list', 4],
  ] as const) {
    leaseChecks.mock.resetCalls();
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(admissions(), expected, name);
  }
  await client.listTools();
  assert.equal(described.mock.calls.filter((call) => !call.arguments[1]).length, 0);
});

test('session route and credential namespaces stay reserved when the Sessions provider is unloaded', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.app.ctx.api.mount('/sessions', () => {}), { code: 'mount_conflict' });
  const issued = await f.offer();
  const api = f.app.ctx.api;
  await f.app.setEnabled('sessions', false);
  assert.equal(f.app.ctx.api, api, 'API stays active without Sessions');
  const denied = await f.http('/mcp', issued.secret, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'reserved', version: '1' },
    },
  });
  assert.equal(denied.status, 503);
  assert.equal(denied.body.error.code, 'credential_unavailable');
  const malformed = await f.http('/mcp', 'ms_bad.jwt.token', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  assert.equal(
    malformed.body.error.code,
    'credential_unavailable',
    'Malformed session namespace never falls through to JWT verification',
  );
  assert.equal((await f.http('/account')).status, 200, 'Ordinary source credential remains usable');
  const withdrawn = await f.http('/sessions');
  assert.deepEqual([withdrawn.status, withdrawn.body.error.code], [503, 'unavailable']);
  // Seed a real valid legacy-format credential to make the otherwise rare prefix collision deterministic.
  const collision = `ms_${'a'.repeat(40)}`;
  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at) VALUES(?,?,?,?,?,?)',
      'legacy-prefix-collision',
      f.source.actorId,
      f.source.projectId,
      'actor',
      createHash('sha256').update(collision).digest('hex'),
      new Date().toISOString(),
    );
    await new CredentialStore(f.app.ctx.state).adopt(
      {
        owner: 'scope',
        subject: 'legacy-prefix-collision',
        kind: 'actor',
        tokenHash: createHash('sha256').update(collision).digest('hex'),
        expiresAt: null,
      },
      tx,
    );
  });
  assert.equal((await f.http('/account', collision)).body.actor.id, f.source.actorId);
  const env = `MERV_SESSION_BIND_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = issued.secret;
  try {
    const bindings = new Bindings(f.app.ctx.scope, [
      {
        id: 'must-stay-local',
        actorId: f.source.actorId,
        projectId: f.source.projectId,
        mountId: 'remote',
        secretRef: `env:${env}`,
      },
    ]);
    await assert.rejects(
      async () => await bindings.headers(await bindings.select(f.source, 'remote')),
      { code: 'credential_unavailable' },
    );
  } finally {
    delete process.env[env];
  }
  await f.app.setEnabled('sessions', true);
  assert.equal(f.app.ctx.api, api, 'Restoring Sessions keeps the same API');
  assert.equal((await f.http('/sessions')).status, 200);
  await f.app.setEnabled('api', false);
  await f.app.setEnabled('api', true);
  assert.notEqual(f.app.ctx.api, api, 'API restarts with a new server');
  assert.equal((await f.http('/sessions')).status, 200, 'Existing Sessions binds to the new API');
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
    ['session.ask_owner', 'session.message.ack'],
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

test('project observers see real MCP call metadata and failures, without worker capabilities or payloads', async (t) => {
  const f = await fixture(t);
  await f.app.ctx.plugin(uiPlugin);
  const sessionsUi = await f.app.ctx.plugin(sessionsUiPlugin);
  f.app.ctx.tools.register({
    name: 'checked.echo',
    description: 'Observed echo',
    inputSchema: z.object({ tenant: z.string(), value: z.string() }).strict(),
    handler: (_caller, input) => {
      if (input.value === 'fail') throw new Error('private-failure-detail');
      return { answer: 'private-output-content' };
    },
  });
  const offer = await f.offer();
  const client = await f.connect(offer.secret);
  await client.callTool({ name: 'checked.echo', arguments: { value: 'private-input-content' } });
  await client.callTool({ name: 'checked.echo', arguments: { value: 'fail' } });
  // Invalid input never enters execution and must not look like a dispatched tool call.
  await client.callTool({ name: 'checked.echo', arguments: { value: 42 } });
  const reader = await f.app.ctx.scope.credentials.issueActor(f.source, {
    name: 'Observer',
    role: 'reader',
  });
  const path = `/sessions/threads/${offer.session.threadId}/calls`;
  const response = await f.http(path, reader.token);
  assert.equal(response.status, 200);
  assert.equal(response.body.threadId, offer.session.threadId);
  assert.deepEqual(
    response.body.calls.map((call: any) => [call.sessionId, call.status]),
    [
      [offer.session.id, 'failed'],
      [offer.session.id, 'succeeded'],
    ],
  );
  assert.equal(response.body.totals.calls, 2);
  assert.ok(response.body.totals.outputTokens > 0);
  // The project's threads, for the same reader: the live one first, named by its work.
  const listed = await f.http('/sessions/threads', reader.token);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.threads[0].id, offer.session.threadId);
  assert.equal(listed.body.threads[0].status, 'live');
  assert.equal(listed.body.next, null);
  // The calls read works without the Sessions tools adapter.
  await f.app.setEnabled('sessions-tools', false);
  assert.equal(
    (await f.app.ctx.tools.list()).some((tool) => tool.name === 'session.observe'),
    false,
  );
  assert.equal((await f.http(path, reader.token)).status, 200);
  const json = JSON.stringify(response.body) + JSON.stringify(listed.body);
  for (const privateValue of [
    offer.secret,
    'private-input-content',
    'private-output-content',
    'private-failure-detail',
    'owner_hash',
    'token_hash',
  ])
    assert.equal(json.includes(privateValue), false);
  assert.equal((await f.http(path, offer.secret)).status, 403);
  assert.equal((await f.http('/sessions/threads', offer.secret)).status, 403);
  const other = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Other',
  });
  assert.equal((await f.http(path, other.token)).status, 404);
  assert.deepEqual((await f.http('/sessions/threads', other.token)).body.threads, []);
  assert.equal((await f.http(`${path}?unknown=true`, reader.token)).status, 400);
  assert.equal((await f.http('/sessions/threads?unknown=1', reader.token)).status, 400);
  assert.equal((await f.http(path, reader.token, {}, undefined, 'POST')).status, 404);
  await f.app.ctx.scope.credentials.revokeActor(f.source, reader.actor.id);
  assert.notEqual((await f.http(path, reader.token)).status, 200);
  const status = (token: string) => f.http('/tools/ui.read', token, { rowId: 'sessions' });
  assert.equal((await status(f.boot.token)).status, 200);
  await sessionsUi.dispose();
  assert.equal((await status(f.boot.token)).body.error.code, 'row_unreadable');
});

test('mounted tool errors and invalid output envelopes are recorded as failed calls', async (t) => {
  const f = await fixture(t, {
    readOnly: true,
    tools: [{ name: '_remote.inspect', alternatives: [{}] }],
  });
  let malformed = false;
  await f.app.ctx.tools.createCatalog('remote').replace([
    {
      kind: 'mcp',
      name: 'inspect',
      description: 'Remote observation test',
      inputSchema: { type: 'object', properties: {} },
      handler: () =>
        malformed
          ? ({ content: 'invalid-envelope' } as any)
          : { isError: true, content: [{ type: 'text', text: 'private upstream failure' }] },
    },
  ]);
  f.app.ctx.scope.toolPolicy.replace([
    {
      actorId: f.source.actorId,
      projectId: f.source.projectId,
      mountId: 'remote',
      tools: ['inspect'],
    },
  ]);
  const offered = await f.offer();
  const client = await f.connect(offered.secret);
  assert.equal((await client.callTool({ name: '_remote.inspect', arguments: {} })).isError, true);
  malformed = true;
  assert.equal((await client.callTool({ name: '_remote.inspect', arguments: {} })).isError, true);
  const result = await f.app.ctx.sessions.observations.calls(f.source, offered.session.threadId);
  assert.deepEqual(
    result.calls.map((call) => call.status),
    ['failed', 'failed'],
  );
  assert.equal(result.calls[0]!.outputTokens, null);
  assert.ok(result.calls[1]!.outputTokens! > 0);
  assert.equal(JSON.stringify(result).includes('private upstream failure'), false);
});

test('the runner can read a server-admitted session whose combined frozen packets exceed one MiB', async (t) => {
  const packetText = '研'.repeat(160_000);
  const f = await fixture(t, undefined, packetText);
  const { session, secret } = await f.offer();
  for (const packet of [
    session.assignment,
    session.execution.policy,
    session.execution.references,
    session.lease.receipt,
  ])
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 524_288);
  assert.ok(Buffer.byteLength(JSON.stringify({ session })) > 1024 * 1024);
  const runner = new RunnerClient(f.app.ctx.api.url!, f.boot.project.id, f.boot.token);
  const observed = await runner.get(session.id, 'runner');
  assert.equal(observed.assignment.brief, packetText);
  assert.equal(observed.execution.references.evidence, packetText);
  assert.equal(observed.lease.receipt.evidence, packetText);
  await f.app.ctx.sessions.authenticate(secret);
  const renewed = await runner.heartbeat(session.id, 'runner');
  assert.equal(renewed.status, 'active');
  assert.equal(renewed.assignment.brief, packetText);
});

test('private native launch endpoint is owner-controlled, no-store and does not enrich public sessions', async (t) => {
  const f = await fixture(t);
  const native = {
    name: 'sandboxes',
    url: 'https://sandbox.example/mcp',
    bearer: 'sbxt_' + 'PrivateNative'.repeat(4),
  };
  f.cleanup.push(f.app.ctx.sessions.registerLaunchConnections(async () => [native]));
  const issued = await f.offer();
  const id = issued.session.id;
  const attached = await f.http(`/sessions/${id}/attach`, f.boot.token, {
    runnerId: 'runner',
    hostRef: 'host',
  });
  assert.equal(attached.status, 200);
  assert.equal(attached.body.launchConnections, true);
  assert.ok(!JSON.stringify(attached.body).includes(native.bearer));
  const endpoint = `/sessions/${id}/launch-connections`;
  const response = await fetch(`${f.app.ctx.api.url}${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.boot.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runnerId: 'runner', hostRef: 'host' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { connections: [native] });
  assert.equal(
    (await f.http(endpoint, issued.secret, { runnerId: 'runner', hostRef: 'host' })).status,
    403,
  );
  assert.equal(
    (await f.http(endpoint, f.boot.token, { sessionId: id, runnerId: 'runner', hostRef: 'host' }))
      .status,
    400,
  );
  assert.equal(
    (await f.http(endpoint, f.boot.token, { runnerId: 'runner', hostRef: 'wrong' })).status,
    409,
  );
  assert.ok(!JSON.stringify((await f.http(`/sessions/${id}`)).body).includes(native.bearer));
});
