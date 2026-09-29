import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MervError, type Actor, type Caller, type Scope, type ToolPolicy } from '@merv/contracts';
import { ToolRegistry } from '@merv/api';
import { Bindings } from '../packages/mounts/src/credentials.js';
import { createApp } from './fixtures/app.js';
import { connectUpstream, endUpstream, Invocations } from '../packages/mounts/src/upstream.js';
import { CredentialServer } from './fixtures/credential-server.js';
import { deferred } from './fixtures/deferred.js';
import { fixtureAccess } from './fixtures/access.js';
import { RemoteFixture, representativeResult } from './fixtures/remote-server.js';

function data(result: CallToolResult) {
  return result.structuredContent as {
    identity: string;
    namespace: string;
    subject: string;
    connectionId: number;
  };
}

async function until(predicate: () => boolean, message: string, milliseconds = 4000) {
  const end = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Records every SDK client the pool creates, in order, with its local close() count. */
function recordClients(t: TestContext) {
  const clients: { client: Client; closeCalls: number }[] = [];
  const connect = Client.prototype.connect;
  const close = Client.prototype.close;
  t.mock.method(
    Client.prototype,
    'connect',
    function (this: Client, ...args: Parameters<Client['connect']>) {
      clients.push({ client: this, closeCalls: 0 });
      return connect.apply(this, args);
    },
  );
  t.mock.method(Client.prototype, 'close', async function (this: Client) {
    const record = clients.find((record) => record.client === this);
    if (record) record.closeCalls++;
    await close.call(this);
  });
  return clients;
}

/**
 * A pool whose handlers are published in their own registry, so every call is admitted as in
 * production: the pool re-checks only after a wait.
 */
async function mount(
  t: TestContext,
  services: { scope: Scope; access: ToolPolicy; bindings: Bindings },
  url: string,
  options: { timeoutMs?: number; idleMs?: number } = {},
) {
  const registry = new ToolRegistry(services.scope, services.access);
  const pool = new Invocations(
    { id: 'sandbox', url, timeoutMs: options.timeoutMs ?? 1500 },
    services.bindings,
    services.access,
    registry,
    options,
  );
  await registry.createCatalog('sandbox').replace(
    ['inspect', 'mutate'].map((name) => ({
      kind: 'mcp' as const,
      name,
      inputSchema: { type: 'object' as const },
      handler: pool.handler(name),
    })),
  );
  t.after(async () => {
    await registry.close();
    await pool.close();
  });
  const call = async (caller: Caller, name = 'inspect') =>
    (await registry.call(`_sandbox.${name}`, caller, {})) as CallToolResult;
  return { pool, registry, call };
}

async function fixture(t: TestContext, timeoutMs = 1500) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-mount-upstream-'));
  const app = await createApp({ directory, components: ['state', 'scope'] });
  const first = await app.ctx.scope.bootstrap({ projectName: 'Project A', actorName: 'Actor A' });
  const second = await app.ctx.scope.bootstrap({ projectName: 'Project B', actorName: 'Actor B' });
  const a = { actorId: first.actor.id, projectId: first.project.id };
  const b = { actorId: second.actor.id, projectId: second.project.id };
  const another = await app.ctx.scope.issueActor(a, { name: 'Another A actor', role: 'producer' });
  const a2 = { actorId: another.actor.id, projectId: first.project.id };
  const tokens = { a: 'synthetic-upstream-a', b: 'synthetic-upstream-b' };
  const upstream = new CredentialServer([
    { id: 'upstream-a', token: tokens.a, namespace: 'namespace-a', subject: 'subject-a' },
    { id: 'upstream-b', token: tokens.b, namespace: 'namespace-b', subject: 'subject-b' },
  ]);
  await upstream.start();
  const suffix = randomUUID().replaceAll('-', '_');
  const envA = `MERV_CLIENT_A_${suffix}`,
    envB = `MERV_CLIENT_B_${suffix}`;
  process.env[envA] = tokens.a;
  process.env[envB] = tokens.b;
  // a and a2 share one secret and one set of selectors, and still get separate connections.
  const configured = [a, a2, b].map((caller, index) => ({
    id: `binding-${index}`,
    ...caller,
    mountId: 'sandbox',
    secretRef: `env:${index === 2 ? envB : envA}`,
    headers: {
      'x-sandbox-namespace': index === 2 ? 'namespace-b' : 'namespace-a',
      'x-sandbox-subject': index === 2 ? 'subject-b' : 'subject-a',
    },
  }));
  const grants = [a, a2, b].map((caller) => ({
    ...caller,
    mountId: 'sandbox',
    tools: ['inspect', 'mutate'],
  }));
  const scope = app.ctx.scope;
  const bindings = new Bindings(scope, configured);
  const access = scope.toolPolicy;
  access.replace(grants);
  const clients = recordClients(t);
  t.after(async () => {
    await upstream.close();
    await app.stop();
    delete process.env[envA];
    delete process.env[envB];
    rmSync(directory, { recursive: true, force: true });
  });
  const { pool, call } = await mount(t, { scope, access, bindings }, upstream.url, { timeoutMs });
  return {
    pool,
    call,
    upstream,
    a,
    a2,
    b,
    bindings,
    configured,
    access,
    grants,
    tokens,
    clients,
    scope,
    state: app.ctx.state,
  };
}

/** Holds the first binding selection until released. */
function holdSelect(t: TestContext, bindings: Bindings) {
  const select = bindings.select.bind(bindings);
  const entered = deferred(),
    release = deferred();
  let first = true;
  t.mock.method(bindings, 'select', async (...args: Parameters<Bindings['select']>) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return await select(...args);
  });
  t.after(() => release.resolve());
  return { entered: entered.promise, release: () => release.resolve() };
}

test('same caller deduplicates concurrent connections; actors and projects receive independent upstream clients', async (t) => {
  const { call, upstream, a, a2, b, tokens } = await fixture(t);
  const held = upstream.holdNextInitialize();
  const first = call(a);
  const simultaneous = call(a);
  await held.entered;
  assert.equal(upstream.initializeAttempts, 1);
  held.release();
  const results = await Promise.all([first, simultaneous]);
  assert.equal(data(results[0]).connectionId, data(results[1]).connectionId);
  const sameProject = await call(a2);
  const otherProject = await call(b);
  // a2's binding has a's secret and selectors: a connection is never shared across actors.
  assert.equal(
    new Set([...results, sameProject, otherProject].map((result) => data(result).connectionId))
      .size,
    3,
  );
  assert.equal(data(sameProject).namespace, 'namespace-a');
  assert.equal(data(otherProject).namespace, 'namespace-b');
  assert.equal(upstream.rejected, 0);
  for (const token of Object.values(tokens))
    assert.ok(
      !JSON.stringify([
        ...results,
        sameProject,
        otherProject,
        upstream.connections,
        upstream.calls,
      ]).includes(token),
    );
  assert.deepEqual(results[0]._meta, { fixture: 'retained' });
  assert.deepEqual(results[0].content[0]._meta, { retained: true });
});

test('grant and binding revocation stop new calls without tearing down the idle connection', async (t) => {
  const { call, upstream, a, b, access, grants, configured, clients, scope } = await fixture(t);
  await call(a);
  access.replace(grants.filter((grant) => grant.actorId !== a.actorId));
  await assert.rejects(call(a), { code: 'tool_forbidden' });
  assert.equal(clients[0].closeCalls, 0, 'A refusal concerns the call, not the connection');
  access.replace(grants);
  // Binding changes apply by reloading Mounts, which builds new bindings and a new pool.
  const reloaded = new Bindings(
    scope,
    configured.filter((binding) => binding.actorId !== a.actorId),
  );
  const { call: callReloaded } = await mount(
    t,
    { scope, access, bindings: reloaded },
    upstream.url,
  );
  await assert.rejects(callReloaded(a), { code: 'credential_forbidden' });
  await assert.rejects(call({ ...a, projectId: b.projectId }), { code: 'forbidden' });
  assert.equal(upstream.callAttempts, 1);
  assert.equal(upstream.initializeAttempts, 1);
});

for (const change of ['grant', 'actor'] as const) {
  test(`a ${change} revoked during connection setup is rechecked before upstream dispatch`, async (t) => {
    const { call, upstream, a, a2, access, clients, scope } = await fixture(t);
    const held = upstream.holdNextInitialize();
    const operation = call(a2);
    void operation.catch(() => undefined);
    await held.entered;
    if (change === 'grant') access.replace([]);
    else await scope.revokeActor(a, a2.actorId);
    held.release();
    await assert.rejects(operation, { code: change === 'grant' ? 'tool_forbidden' : 'forbidden' });
    assert.equal(upstream.callAttempts, 0);
    // A refusal keeps the connection.
    assert.equal(clients[0].closeCalls, 0);
  });
}

test('a call that waited in binding selection is rechecked although its lane warmed meanwhile', async (t) => {
  const { call, upstream, a, access, bindings } = await fixture(t);
  const held = holdSelect(t, bindings);
  const waited = call(a);
  const refused = assert.rejects(waited, { code: 'tool_forbidden' });
  await held.entered;
  await call(a);
  access.replace([]);
  held.release();
  await refused;
  assert.equal(upstream.callAttempts, 1);
});

test('the registry re-authorizes a warm call at dispatch, which the pool relies on', async (t) => {
  const { pool, upstream, a, access, scope } = await fixture(t);
  // Admission's require passes, and the grant is withdrawn before dispatch. If api ever drops its
  // dispatch access.require, this fails, and the pool's warm path must add one.
  let revoke = false;
  const policy: ToolPolicy = {
    allows: access.allows.bind(access),
    replace: access.replace.bind(access),
    async require(...args) {
      await access.require(...args);
      if (revoke) {
        revoke = false;
        access.replace([]);
      }
    },
  };
  const registry = new ToolRegistry(scope, policy);
  t.after(() => registry.close());
  await registry.createCatalog('sandbox').replace([
    {
      kind: 'mcp',
      name: 'inspect',
      inputSchema: { type: 'object' },
      handler: pool.handler('inspect'),
    },
  ]);
  await registry.call('_sandbox.inspect', a, {});
  assert.equal(upstream.callAttempts, 1);
  revoke = true;
  await assert.rejects(registry.call('_sandbox.inspect', a, {}), { code: 'tool_forbidden' });
  assert.equal(upstream.callAttempts, 1, 'A warm lane must not cross after dispatch refuses');
});

test('a warm call adds no State access and no authorization', async (t) => {
  const { pool, call, a, access, scope, state } = await fixture(t);
  await call(a);
  const reads = t.mock.method(state, 'read');
  const transactions = t.mock.method(state, 'transaction');
  const grants = t.mock.method(access, 'require');
  const authority = t.mock.method(scope, 'require');
  assert.equal(data(await pool.handler('inspect')(a, {})).identity, 'upstream-a');
  for (const counter of [reads, transactions, grants, authority])
    assert.equal(counter.mock.callCount(), 0);
});

test('a lane reads and checks its secret once per connection', async (t) => {
  const { call, a, scope } = await fixture(t);
  const recognizes = t.mock.method(scope, 'recognizesCredential');
  for (let count = 0; count < 3; count++) await call(a);
  assert.equal(recognizes.mock.callCount(), 1);
});

test('a failed credential check refuses the call, and the next call opens a new connection', async (t) => {
  const { call, upstream, a, scope, tokens } = await fixture(t);
  const recognizes = scope.recognizesCredential.bind(scope);
  let fail = true;
  t.mock.method(scope, 'recognizesCredential', async (token: string) => {
    if (fail) throw new Error(`Database error: ${token}`);
    return await recognizes(token);
  });
  await assert.rejects(call(a), (error: unknown) => {
    assert.equal((error as MervError).code, 'credential_unavailable');
    assert.ok(!JSON.stringify(error).includes(tokens.a) && !String(error).includes(tokens.a));
    return true;
  });
  assert.equal(upstream.initializeAttempts, 0);
  fail = false;
  assert.equal(data(await call(a)).identity, 'upstream-a');
  assert.equal(upstream.initializeAttempts, 1);
});

test('two sessions acting for one owner get separate connections with the same headers', async (t) => {
  const { upstream, a, configured } = await fixture(t);
  const owner = { id: a.actorId, projectId: a.projectId } as Actor;
  const bindings = new Bindings(
    { authorityActor: async () => owner, recognizesCredential: async () => false },
    configured,
  );
  const pool = new Invocations(
    { id: 'sandbox', url: upstream.url, timeoutMs: 1500 },
    bindings,
    fixtureAccess,
    { validateSession: async () => {} },
  );
  t.after(() => pool.close());
  const results: CallToolResult[] = [];
  for (const id of ['session-one', 'session-two'])
    results.push(
      await pool.handler('inspect')(
        { actorId: `actor-${id}`, projectId: a.projectId, session: { id } },
        {},
      ),
    );
  assert.notEqual(data(results[0]).connectionId, data(results[1]).connectionId);
  // The fixture accepts a session only when the token and both selectors match its identity.
  assert.deepEqual(
    results.map((result) => data(result).identity),
    ['upstream-a', 'upstream-a'],
  );
  assert.equal(upstream.rejected, 0);
});

test('a call held across close() completes, then its connection ends; later calls are refused', async (t) => {
  const { pool, call, upstream, a, a2, bindings, clients } = await fixture(t);
  const held = upstream.holdNextCall();
  const admitted = call(a);
  await held.entered;
  await pool.close();
  await assert.rejects(call(a), { code: 'remote_unavailable' });
  // A caller with no lane yet is refused the same way, before any binding selection.
  const select = t.mock.method(bindings, 'select');
  await assert.rejects(call(a2), { code: 'remote_unavailable' });
  assert.equal(select.mock.callCount(), 0);
  assert.equal(clients[0].closeCalls, 0);
  held.release();
  assert.equal(data(await admitted).identity, 'upstream-a');
  await until(() => clients[0].closeCalls === 1, 'The connection did not end after its call');
  assert.equal(upstream.callAttempts, 1);
  assert.equal(clients.length, 1);
});

test('a call still selecting its binding when the pool closes is refused and opens nothing', async (t) => {
  const { pool, call, upstream, a, bindings, clients } = await fixture(t);
  const held = holdSelect(t, bindings);
  const pending = call(a);
  await held.entered;
  await pool.close();
  held.release();
  await assert.rejects(pending, { code: 'remote_unavailable' });
  assert.equal(clients.length, 0);
  assert.equal(upstream.initializeAttempts, 0);
});

test('failed connections are closed, sanitized, and retried only on a new explicit call', async (t) => {
  const { call, upstream, a, clients, tokens } = await fixture(t);
  upstream.failNextInitialize(`transport detail contains ${tokens.a}`);
  await assert.rejects(call(a), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, 'remote_unavailable');
    assert.ok(!JSON.stringify(error).includes(tokens.a));
    assert.ok(!error.message.includes('transport detail'));
    return true;
  });
  // The SDK also closes itself when initialize fails; the pool must still ensure cleanup.
  assert.ok(clients[0].closeCalls >= 1);
  assert.equal(upstream.initializeAttempts, 1);
  await call(a);
  assert.equal(upstream.initializeAttempts, 2);
});

test('one failed call evicts a shared client without closing another admitted call or retrying the mutation', async (t) => {
  const { call, upstream, a, clients, tokens } = await fixture(t);
  const first = await call(a);
  const held = upstream.holdNextCall();
  const admitted = call(a);
  await held.entered;
  upstream.failNextCall(`mutation response contains ${tokens.a}`);
  await assert.rejects(call(a, 'mutate'), { code: 'remote_unavailable' });
  assert.equal(upstream.callAttempts, 3);
  assert.equal(clients[0].closeCalls, 0);
  held.release();
  assert.equal(data(await admitted).connectionId, data(first).connectionId);
  await until(() => clients[0].closeCalls >= 1, 'The failed shared client was not closed');
  const replacement = await call(a);
  assert.notEqual(data(replacement).connectionId, data(first).connectionId);
});

for (const phase of ['connect', 'call'] as const) {
  test(`a stalled ${phase} is bounded and releases its SDK client`, async (t) => {
    const { call, upstream, a, clients } = await fixture(t, 150);
    if (phase === 'call') await call(a);
    const held = phase === 'connect' ? upstream.holdNextInitialize() : upstream.holdNextCall();
    const operation = call(a);
    void operation.catch(() => undefined);
    await held.entered;
    await assert.rejects(operation, { code: 'remote_timeout' });
    await until(() => clients[0].closeCalls >= 1, 'The stalled client was not closed');
    held.release();
  });
}

async function remotePool(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  options: { timeoutMs?: number; idleMs?: number } = {},
) {
  const remote = new RemoteFixture();
  await remote.start();
  t.after(() => remote.close());
  return { remote, ...(await mount(t, f, remote.url, options)) };
}

test('an upstream JSON-RPC error keeps the connection and reports only its code', async (t) => {
  const f = await fixture(t);
  const { remote, call } = await remotePool(t, f);
  remote.setResult('inspect', () => {
    throw new McpError(ErrorCode.InvalidParams, `upstream echo Bearer ${f.tokens.a}`);
  });
  for (let count = 0; count < 3; count++)
    await assert.rejects(call(f.a), (error: unknown) => {
      assert.ok(error instanceof MervError);
      assert.equal(error.code, 'remote_error');
      assert.equal(error.message, `Remote tool refused the request (${ErrorCode.InvalidParams})`);
      for (const text of [JSON.stringify(error), String(error)])
        assert.ok(!text.includes(f.tokens.a) && !text.includes('upstream echo'));
      return true;
    });
  assert.equal(remote.opened, 1);
});

test('upstream code -32000 counts as a closed connection: it retires with remote_unavailable', async (t) => {
  const f = await fixture(t);
  const { remote, call } = await remotePool(t, f);
  remote.setResult('inspect', () => {
    throw new McpError(ErrorCode.ConnectionClosed, 'Upstream closed');
  });
  await assert.rejects(call(f.a), { code: 'remote_unavailable' });
  remote.setResult('inspect', representativeResult);
  assert.deepEqual(await call(f.a), representativeResult);
  assert.equal(remote.opened, 2);
});

test('an upstream credential refusal retires the connection with a fixed code', async (t) => {
  const { call, upstream, a, tokens } = await fixture(t);
  await call(a);
  upstream.failNextCall(`denied Bearer ${tokens.a}`, 403);
  await assert.rejects(call(a), (error: unknown) => {
    assert.equal((error as MervError).code, 'remote_credential_rejected');
    for (const text of [JSON.stringify(error), String(error)])
      assert.ok(!text.includes(tokens.a) && !text.includes('denied'));
    return true;
  });
  await call(a);
  assert.equal(upstream.initializeAttempts, 2);
});

test('a refused admission between two calls keeps their connection', async (t) => {
  const { call, upstream, a, access, grants, clients } = await fixture(t);
  const first = await call(a);
  access.replace(grants.filter((grant) => grant.actorId !== a.actorId));
  await assert.rejects(call(a), { code: 'tool_forbidden' });
  access.replace(grants);
  const second = await call(a);
  assert.equal(data(second).connectionId, data(first).connectionId);
  assert.equal(upstream.initializeAttempts, 1);
  assert.equal(clients[0].closeCalls, 0);
});

test('the registry refuses an invalid MCP result and the connection stays', async (t) => {
  const f = await fixture(t);
  let initializes = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST') return void response.writeHead(405).end();
      let text = '';
      for await (const part of request) text += String(part);
      const message = JSON.parse(text) as { id?: number; method: string };
      if (message.id === undefined) return void response.writeHead(202).end();
      if (message.method === 'initialize') initializes++;
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : { content: 'not-an-array' };
      response
        .writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { call } = await mount(
    t,
    f,
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
  );
  for (let count = 0; count < 2; count++)
    await assert.rejects(call(f.a), { code: 'invalid_remote_result' });
  assert.equal(initializes, 1);
});

test('an idle invocation connection opens no notification stream', async (t) => {
  const f = await fixture(t);
  const { remote, call } = await remotePool(t, f, { timeoutMs: 300 });
  await call(f.a);
  await sleep(1500);
  assert.equal(remote.gets, 0);
  assert.equal(remote.sessionCount, 1);
});

test('an idle connection ends with an MCP DELETE', async (t) => {
  const f = await fixture(t);
  const { remote, call } = await remotePool(t, f, { idleMs: 200 });
  await call(f.a);
  assert.equal(remote.sessionCount, 1);
  await until(() => remote.sessionCount === 0, 'The idle connection stayed open', 400);
  assert.equal(remote.deletes, 1);
  await call(f.a);
  assert.equal(remote.opened, 2);
});

test('closing the pool ends every connection with an MCP DELETE and refuses later calls', async (t) => {
  const f = await fixture(t);
  const { remote, pool, call } = await remotePool(t, f);
  for (const caller of [f.a, f.a2, f.b]) await call(caller);
  assert.equal(remote.sessionCount, 3);
  await pool.close();
  assert.equal(remote.sessionCount, 0);
  assert.equal(remote.deletes, remote.opened);
  assert.equal(remote.opened, 3);
  await assert.rejects(call(f.a), { code: 'remote_unavailable' });
  assert.equal(remote.opened, 3, 'A closed pool opens nothing');
});

test(
  'a DELETE to an upstream that stopped answering ends in about one second under GC',
  { timeout: 5000 },
  async (t) => {
    // Collecting garbage while the DELETE waits: a timeout signal held only by AbortSignal.any()
    // is then lost and the DELETE waits for the socket.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const remote = new RemoteFixture();
    await remote.start();
    t.after(() => remote.close());
    const client = await connectUpstream(remote.url, undefined, 5000);
    remote.stall();
    const collect = setInterval(gc, 10);
    t.after(() => clearInterval(collect));
    const started = performance.now();
    await endUpstream(client);
    assert.ok(performance.now() - started < 1500, 'The DELETE is capped at one second');
  },
);
