import test, { type TestContext } from 'node:test';
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
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
import { ScopedRemoteClients } from '../packages/mounts/src/credential-client.js';
import { createApp } from './fixtures/app.js';
import { RunnerClient } from '../packages/runner/src/client.js';
import { CredentialServer } from './fixtures/credential-server.js';

async function fixture(t: TestContext, policy?: WorkflowExecutionPolicy, packetText?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-session-api-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const boot = await app.ctx.scope.bootstrap({
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
            await app.ctx.scope.require(caller, 'write', tx);
          },
          build: () => ({
            role: 'producer',
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
            role: () => 'producer',
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
  return { app, boot, source, instance, http, offer, connect, cleanup };
}

function errorCode(result: any): string {
  assert.equal(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text).error.code;
}

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
    ['checked.default', 'checked.echo', 'checked.transform'],
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
  const authorize = workflows.authorizeLeaseDispatch.bind(workflows);
  const admissions = t.mock.method(
    workflows,
    'authorizeLeaseDispatch',
    async (...args: Parameters<typeof authorize>) => await authorize(...args),
  );
  // Preparation, the check after parsing, and the check after the observation is stored;
  // a read is admitted once more after its handler releases the read snapshot. Each extra
  // layer that re-admits would show here.
  for (const [name, expected] of [
    ['checked.echo', 3],
    ['artifact.list', 4],
  ] as const) {
    admissions.mock.resetCalls();
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(admissions.mock.callCount(), expected, name);
  }
});

test('session route and credential namespaces stay reserved when Sessions and its HTTP routes are unloaded', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.app.ctx.api.mount('/sessions', () => {}), { code: 'invalid_mount' });
  const issued = await f.offer();
  // The HTTP routes are Sessions' own child; unloading Sessions withdraws them.
  await f.app.setEnabled('sessions', false);
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
  assert.equal(denied.body.error.code, 'session_unavailable');
  const malformed = await f.http('/mcp', 'ms_bad.jwt.token', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  assert.equal(
    malformed.body.error.code,
    'session_unavailable',
    'Malformed session namespace never falls through to JWT verification',
  );
  assert.equal((await f.http('/account')).status, 200, 'Ordinary source credential remains usable');
  // Seed a real valid legacy-format credential to make the otherwise rare prefix collision deterministic.
  const collision = `ms_${'a'.repeat(40)}`;
  await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.run(
        'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at) VALUES(?,?,?,?,?,?)',
        'legacy-prefix-collision',
        f.source.actorId,
        f.source.projectId,
        'actor',
        createHash('sha256').update(collision).digest('hex'),
        new Date().toISOString(),
      ),
  );
  assert.equal((await f.http('/account', collision)).body.actor.id, f.source.actorId);
  const env = `MERV_SESSION_BIND_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = issued.secret;
  try {
    const credentials = new EnvironmentCredentials(f.app.ctx.scope, [
      {
        id: 'must-stay-local',
        actorId: f.source.actorId,
        projectId: f.source.projectId,
        mountId: 'remote',
        secretRef: `env:${env}`,
      },
    ]);
    await assert.rejects(async () => await credentials.resolve(f.source, 'remote'), {
      code: 'credential_unavailable',
    });
  } finally {
    delete process.env[env];
  }
});

test('leased mounted calls require source grants and keep upstream project arguments; delayed dispatch rechecks arguments', async (t) => {
  const f = await fixture(t, {
    readOnly: true,
    tools: [
      { name: '_sandbox.inspect', alternatives: [{ projectId: { kind: 'literal', value: 73 } }] },
    ],
  });
  const upstream = new CredentialServer(
    ['synthetic-session-upstream', 'synthetic-session-upstream-rotated'].map((token) => ({
      id: 'upstream',
      token,
      namespace: 'ns',
      subject: 'subject',
    })),
  );
  await upstream.start();
  const env = `MERV_SESSION_REMOTE_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = 'synthetic-session-upstream';
  const credentials = new EnvironmentCredentials(f.app.ctx.scope, [
    {
      id: 'source-binding',
      actorId: f.source.actorId,
      projectId: f.source.projectId,
      mountId: 'sandbox',
      secretRef: `env:${env}`,
      headers: { 'x-sandbox-namespace': 'ns', 'x-sandbox-subject': 'subject' },
    },
  ]);
  const pool = new ScopedRemoteClients(
    credentials,
    f.app.ctx.scope.toolPolicy,
    { mountId: 'sandbox', url: upstream.url },
    f.app.ctx.tools,
  );
  f.cleanup.push(async () => {
    await upstream.close();
    await pool.close();
    delete process.env[env];
  });
  let mutable: Record<string, unknown> | undefined;
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
        return await pool.call(caller, 'sandbox', 'inspect', input);
      },
    },
  ]);
  const issued = await f.offer();
  const client = await f.connect(issued.secret);
  assert.deepEqual(
    (await client.listTools()).tools.filter((tool) => !tool.annotations?.readOnlyHint),
    [],
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

  process.env[env] = 'synthetic-session-upstream-rotated';
  const revokedGrant = upstream.holdNextInitialize();
  const withGrant = client.callTool({ name: '_sandbox.inspect', arguments: { projectId: 73 } });
  await revokedGrant.entered;
  f.app.ctx.scope.toolPolicy.replace([]);
  revokedGrant.release();
  assert.equal(errorCode(await withGrant), 'tool_forbidden');
  assert.equal(
    upstream.callAttempts,
    1,
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

  const rotatedCredential = upstream.holdNextInitialize();
  const withCredential = client.callTool({
    name: '_sandbox.inspect',
    arguments: { projectId: 73 },
  });
  await rotatedCredential.entered;
  process.env[env] = 'synthetic-session-upstream';
  rotatedCredential.release();
  assert.equal(errorCode(await withCredential), 'credential_changed');
  assert.equal(
    upstream.callAttempts,
    1,
    'Credential rotation is observed at the upstream boundary',
  );

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
    1,
    'A released lease cannot dispatch an already connected call',
  );
});

test('an external agent explicitly changes assignments over HTTP and keeps its MCP identity and secret', async (t) => {
  const f = await fixture(t);
  f.app.ctx.tools.register({
    name: 'checked.echo',
    description: 'Identity probe',
    inputSchema: z.object({ tenant: z.string() }).strict(),
    handler: (caller) => ({
      actorId: caller.actorId,
      executionId: caller.session?.id,
      agentSessionId: caller.session?.agentSessionId,
    }),
  });
  const token = `ms_${randomBytes(32).toString('base64url')}`;
  const registered = await f.http('/sessions/agents', f.boot.token, {
    name: 'External agent',
    runnerId: 'external',
    requestId: 'register',
    secret: token,
  });
  assert.equal(registered.status, 200, JSON.stringify(registered));
  const agent = registered.body.agent;
  assert.equal((await f.http('/sessions/self', token)).body.agent.id, agent.id);
  assert.equal(
    (await f.http('/sessions/agents', token)).status,
    403,
    'Agent connection cannot administer agents',
  );
  const assigned = await f.http('/sessions/self/assignment', token, {
    instanceId: f.instance.id,
    expectedRevision: 0,
    requestId: 'one',
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned));
  const client = await f.connect(token);
  const call = () => client.callTool({ name: 'checked.echo', arguments: { tenant: 'fixed' } });
  const first = JSON.parse(((await call()) as { content: { text: string }[] }).content[0].text);
  assert.equal(first.actorId, agent.actorId);
  const released = await f.http('/sessions/self/release', token, {
    executionId: assigned.body.execution.id,
  });
  assert.equal(released.status, 200);
  assert.equal((await f.http('/sessions/self', token)).body.current, null);
  // Explicitly take another execution of the same still-open work, with fresh lease/context.
  const again = await f.http('/sessions/self/assignment', token, {
    instanceId: f.instance.id,
    expectedRevision: 0,
    requestId: 'two',
  });
  assert.equal(again.status, 200, JSON.stringify(again));
  const second = JSON.parse(((await call()) as { content: { text: string }[] }).content[0].text);
  assert.equal(second.actorId, first.actorId);
  assert.equal(second.agentSessionId, first.agentSessionId);
  assert.notEqual(second.executionId, first.executionId);
  assert.equal(
    (await f.http(`/sessions/agents/${agent.id}`, f.boot.token)).body.assignments.length,
    2,
  );
  assert.equal(
    (await f.http(`/sessions/agents/${agent.id}`, f.boot.token, undefined, undefined, 'DELETE'))
      .status,
    200,
  );
  assert.equal((await f.http('/sessions/self', token)).status, 401);
  assert.ok(!JSON.stringify([registered, assigned, again]).includes(token));
});

test('project observers see real MCP call metadata and failures, without worker capabilities or payloads', async (t) => {
  const f = await fixture(t);
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
  const reader = await f.app.ctx.scope.issueActor(f.source, { name: 'Observer', role: 'reader' });
  const path = `/sessions/agents/${offer.session.agentId}/observation`;
  const response = await f.http(path, reader.token);
  assert.equal(response.status, 200);
  assert.equal(response.body.agent.id, offer.session.agentId);
  assert.equal(response.body.agent.currentExecutionId, offer.session.id);
  assert.deepEqual(
    response.body.toolCalls.map((call: any) => call.status),
    ['failed', 'succeeded'],
  );
  assert.equal(response.body.tokenStats.totalCalls, 2);
  assert.ok(response.body.tokenStats.outputTokens > 0);
  const json = JSON.stringify(response.body);
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
  const other = await f.app.ctx.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  assert.equal((await f.http(path, other.token)).status, 404);
  assert.equal((await f.http(`${path}?unknown=true`, reader.token)).status, 400);
  assert.equal((await f.http(path, reader.token, {}, undefined, 'POST')).status, 404);
  await f.app.ctx.scope.revokeActor(f.source, reader.actor.id);
  assert.notEqual((await f.http(path, reader.token)).status, 200);
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
  const result = await f.app.ctx.sessions.agentObservation(f.source, offered.session.agentId!);
  assert.deepEqual(
    result.toolCalls.map((call) => call.status),
    ['failed', 'failed'],
  );
  assert.equal(result.toolCalls[0]!.outputTokens, null);
  assert.ok(result.toolCalls[1]!.outputTokens! > 0);
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
