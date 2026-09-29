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
import { MervError } from '@merv/contracts';
import { ToolRegistry } from '@merv/api';
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
import { createApp } from './fixtures/app.js';
import {
  connectUpstream,
  endUpstream,
  ScopedRemoteClients,
} from '../packages/mounts/src/upstream.js';
import { CredentialServer } from './fixtures/credential-server.js';
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

async function fixture(t: TestContext, timeoutMs = 1500) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-mount-upstream-'));
  const app = await createApp({ directory, components: ['state', 'scope'] });
  const first = await app.ctx.scope.bootstrap({ projectName: 'Project A', actorName: 'Actor A' });
  const second = await app.ctx.scope.bootstrap({ projectName: 'Project B', actorName: 'Actor B' });
  const a = { actorId: first.actor.id, projectId: first.project.id };
  const b = { actorId: second.actor.id, projectId: second.project.id };
  const another = await app.ctx.scope.issueActor(a, { name: 'Another A actor', role: 'producer' });
  const a2 = { actorId: another.actor.id, projectId: first.project.id };
  const tokens = {
    a: 'synthetic-upstream-a',
    rotated: 'synthetic-upstream-a-rotated',
    b: 'synthetic-upstream-b',
  };
  const upstream = new CredentialServer([
    { id: 'upstream-a', token: tokens.a, namespace: 'namespace-a', subject: 'subject-a' },
    { id: 'upstream-a', token: tokens.rotated, namespace: 'namespace-a', subject: 'subject-a' },
    { id: 'upstream-b', token: tokens.b, namespace: 'namespace-b', subject: 'subject-b' },
  ]);
  await upstream.start();
  const suffix = randomUUID().replaceAll('-', '_');
  const envA = `MERV_CLIENT_A_${suffix}`,
    envB = `MERV_CLIENT_B_${suffix}`;
  process.env[envA] = tokens.a;
  process.env[envB] = tokens.b;
  const bindings = [a, a2, b].map((caller, index) => ({
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
  const credentials = new EnvironmentCredentials(app.ctx.scope, bindings);
  const access = app.ctx.scope.toolPolicy;
  access.replace(grants);
  const clients = recordClients(t);
  const pool = new ScopedRemoteClients(credentials, access, {
    mountId: 'sandbox',
    url: upstream.url,
    timeoutMs,
  });
  t.after(async () => {
    await upstream.close();
    try {
      await pool.close();
    } finally {
      await app.stop();
      delete process.env[envA];
      delete process.env[envB];
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    pool,
    upstream,
    a,
    a2,
    b,
    credentials,
    access,
    grants,
    bindings,
    envA,
    tokens,
    clients,
    scope: app.ctx.scope,
  };
}

test('same identity deduplicates concurrent connections; actors and projects receive independent upstream clients', async (t) => {
  const { pool, upstream, a, a2, b, tokens } = await fixture(t);
  const held = upstream.holdNextInitialize();
  const first = pool.call(a, 'sandbox', 'inspect', {});
  const simultaneous = pool.call(a, 'sandbox', 'inspect', {});
  await held.entered;
  assert.equal(upstream.initializeAttempts, 1);
  held.release();
  const results = await Promise.all([first, simultaneous]);
  assert.equal(data(results[0]).connectionId, data(results[1]).connectionId);
  const sameProject = await pool.call(a2, 'sandbox', 'inspect', {});
  const otherProject = await pool.call(b, 'sandbox', 'inspect', {});
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

test('grant and credential revocation stop new calls without tearing down the idle connection', async (t) => {
  const { pool, upstream, a, b, access, grants, bindings, clients, scope } = await fixture(t);
  await pool.call(a, 'sandbox', 'inspect', {});
  access.replace(grants.filter((grant) => grant.actorId !== a.actorId));
  await assert.rejects(pool.call(a, 'sandbox', 'inspect', {}), { code: 'tool_forbidden' });
  assert.equal(clients[0].closeCalls, 0, 'A refusal concerns the call, not the connection');
  access.replace(grants);
  // Binding changes apply by reloading Mounts, which builds a new provider and pool.
  const reloaded = new ScopedRemoteClients(
    new EnvironmentCredentials(
      scope,
      bindings.filter((binding) => binding.actorId !== a.actorId),
    ),
    access,
    { mountId: 'sandbox', url: upstream.url },
  );
  t.after(() => reloaded.close());
  await assert.rejects(reloaded.call(a, 'sandbox', 'inspect', {}), {
    code: 'credential_forbidden',
  });
  await assert.rejects(pool.call({ ...a, projectId: b.projectId }, 'sandbox', 'inspect', {}), {
    code: 'forbidden',
  });
  assert.equal(upstream.callAttempts, 1);
  assert.equal(upstream.initializeAttempts, 1);
});

test('credential rotation withdraws the old client but lets an admitted old-identity call drain', async (t) => {
  const { pool, upstream, a, envA, tokens, clients } = await fixture(t);
  const initial = await pool.call(a, 'sandbox', 'inspect', {});
  const held = upstream.holdNextCall();
  const admitted = pool.call(a, 'sandbox', 'inspect', {});
  await held.entered;
  process.env[envA] = tokens.rotated;
  const rotated = await pool.call(a, 'sandbox', 'inspect', {});
  assert.notEqual(data(rotated).connectionId, data(initial).connectionId);
  assert.equal(clients[0].closeCalls, 0);
  held.release();
  assert.equal(data(await admitted).connectionId, data(initial).connectionId);
  await until(() => clients[0].closeCalls >= 1, 'The retired client was not closed');
  assert.equal(clients[1].closeCalls, 0);
});

for (const change of ['grant', 'credential'] as const) {
  test(`${change} changes during connection setup are rechecked before upstream dispatch`, async (t) => {
    const { pool, upstream, a, access, envA, tokens, clients } = await fixture(t);
    const held = upstream.holdNextInitialize();
    const operation = pool.call(a, 'sandbox', 'inspect', {});
    void operation.catch(() => undefined);
    await held.entered;
    if (change === 'grant') access.replace([]);
    else process.env[envA] = tokens.rotated;
    held.release();
    await assert.rejects(operation, {
      code: change === 'grant' ? 'tool_forbidden' : 'credential_changed',
    });
    assert.equal(upstream.callAttempts, 0);
    // A refusal keeps the connection; one opened with a superseded identity is never reused.
    assert.equal(clients[0].closeCalls, 0);
    if (change === 'credential') {
      await pool.call(a, 'sandbox', 'inspect', {});
      assert.equal(upstream.initializeAttempts, 2);
      await until(() => clients[0].closeCalls === 1, 'The superseded client was not closed');
    }
  });
}

test('grant revocation during the final credential resolution prevents upstream dispatch', async (t) => {
  const { pool, upstream, a, access, credentials, clients } = await fixture(t);
  const resolve = credentials.resolve.bind(credentials);
  let calls = 0,
    enter!: () => void,
    release!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  t.mock.method(credentials, 'resolve', async (...args: Parameters<typeof resolve>) => {
    const result = await resolve(...args);
    if (++calls === 2) {
      enter();
      await held;
    }
    return result;
  });
  const pending = pool.call(a, 'sandbox', 'inspect', {});
  const rejected = assert.rejects(pending, { code: 'tool_forbidden' });
  try {
    await entered;
    access.replace([]);
  } finally {
    release();
  }
  await rejected;
  assert.equal(upstream.callAttempts, 0);
  assert.equal(clients[0].closeCalls, 0);
});

test('pool shutdown closes admission immediately and waits for the held call before closing its client', async (t) => {
  const { pool, upstream, a, clients } = await fixture(t);
  const held = upstream.holdNextCall();
  const admitted = pool.call(a, 'sandbox', 'inspect', {});
  await held.entered;
  let closed = false;
  const closing = pool.close().then(() => {
    closed = true;
  });
  await assert.rejects(pool.call(a, 'sandbox', 'inspect', {}), { code: 'remote_closed' });
  assert.equal(closed, false);
  assert.equal(clients[0].closeCalls, 0);
  held.release();
  assert.equal(data(await admitted).identity, 'upstream-a');
  await closing;
  assert.equal(clients[0].closeCalls, 1);
  assert.equal(upstream.callAttempts, 1);
});

for (const phase of ['grant', 'credential'] as const) {
  test(`pool shutdown also drains an invocation still resolving its ${phase}`, async (t) => {
    const { pool, upstream, a, clients, access, credentials } = await fixture(t);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const pause = async () => {
      if (!first) return;
      first = false;
      enter();
      await released;
    };
    if (phase === 'grant') {
      const requireGrant = access.require.bind(access);
      access.require = async (...args) => {
        await pause();
        await requireGrant(...args);
      };
    } else {
      const resolve = credentials.resolve.bind(credentials);
      credentials.resolve = async (...args) => {
        await pause();
        return await resolve(...args);
      };
    }
    const pending = pool.call(a, 'sandbox', 'inspect', {});
    try {
      await entered;
      let stopped = false;
      const stopping = pool.close().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(stopped, false, 'Shutdown must retain asynchronous admission');
      assert.equal(clients.length, 0);
      await assert.rejects(pool.call(a, 'sandbox', 'inspect', {}), { code: 'remote_closed' });
      release();
      assert.equal(data(await pending).identity, 'upstream-a');
      await stopping;
      assert.equal(upstream.callAttempts, 1);
      assert.equal(clients.length, 1);
      assert.equal(clients[0].closeCalls, 1);
    } finally {
      release();
      await pending.catch(() => undefined);
    }
  });
}

test('failed connections are closed, sanitized, and retried only on a new explicit call', async (t) => {
  const { pool, upstream, a, clients, tokens } = await fixture(t);
  upstream.failNextInitialize(`transport detail contains ${tokens.a}`);
  await assert.rejects(pool.call(a, 'sandbox', 'inspect', {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, 'remote_unavailable');
    assert.ok(!JSON.stringify(error).includes(tokens.a));
    assert.ok(!error.message.includes('transport detail'));
    return true;
  });
  // The SDK also closes itself when initialize fails; the pool must still ensure cleanup.
  assert.ok(clients[0].closeCalls >= 1);
  assert.equal(upstream.initializeAttempts, 1);
  await pool.call(a, 'sandbox', 'inspect', {});
  assert.equal(upstream.initializeAttempts, 2);
});

test('one failed call evicts a shared client without closing another admitted call or retrying the mutation', async (t) => {
  const { pool, upstream, a, clients, tokens } = await fixture(t);
  const first = await pool.call(a, 'sandbox', 'inspect', {});
  const held = upstream.holdNextCall();
  const admitted = pool.call(a, 'sandbox', 'inspect', {});
  await held.entered;
  upstream.failNextCall(`mutation response contains ${tokens.a}`);
  await assert.rejects(pool.call(a, 'sandbox', 'mutate', {}), { code: 'remote_unavailable' });
  assert.equal(upstream.callAttempts, 3);
  assert.equal(clients[0].closeCalls, 0);
  held.release();
  assert.equal(data(await admitted).connectionId, data(first).connectionId);
  await until(() => clients[0].closeCalls >= 1, 'The failed shared client was not closed');
  const replacement = await pool.call(a, 'sandbox', 'inspect', {});
  assert.notEqual(data(replacement).connectionId, data(first).connectionId);
});

for (const phase of ['connect', 'call'] as const) {
  test(`a stalled ${phase} is bounded and releases its SDK client`, async (t) => {
    const { pool, upstream, a, clients } = await fixture(t, 150);
    if (phase === 'call') await pool.call(a, 'sandbox', 'inspect', {});
    const held = phase === 'connect' ? upstream.holdNextInitialize() : upstream.holdNextCall();
    const operation = pool.call(a, 'sandbox', 'inspect', {});
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
  const pool = new ScopedRemoteClients(f.credentials, f.access, {
    mountId: 'sandbox',
    url: remote.url,
    timeoutMs: 1500,
    ...options,
  });
  t.after(async () => {
    await pool.close();
    await remote.close();
  });
  return { remote, pool };
}

test('an upstream JSON-RPC error keeps the connection and reports only its code', async (t) => {
  const f = await fixture(t);
  const { remote, pool } = await remotePool(t, f);
  remote.setResult('inspect', () => {
    throw new McpError(ErrorCode.InvalidParams, `upstream echo Bearer ${f.tokens.a}`);
  });
  for (let call = 0; call < 3; call++)
    await assert.rejects(pool.call(f.a, 'sandbox', 'inspect', {}), (error: unknown) => {
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
  const { remote, pool } = await remotePool(t, f);
  remote.setResult('inspect', () => {
    throw new McpError(ErrorCode.ConnectionClosed, 'Upstream closed');
  });
  await assert.rejects(pool.call(f.a, 'sandbox', 'inspect', {}), { code: 'remote_unavailable' });
  remote.setResult('inspect', representativeResult);
  assert.deepEqual(await pool.call(f.a, 'sandbox', 'inspect', {}), representativeResult);
  assert.equal(remote.opened, 2);
});

test('an upstream credential refusal retires the connection with a fixed code', async (t) => {
  const { pool, upstream, a, tokens } = await fixture(t);
  await pool.call(a, 'sandbox', 'inspect', {});
  upstream.failNextCall(`denied Bearer ${tokens.a}`, 403);
  await assert.rejects(pool.call(a, 'sandbox', 'inspect', {}), (error: unknown) => {
    assert.equal((error as MervError).code, 'remote_credential_rejected');
    for (const text of [JSON.stringify(error), String(error)])
      assert.ok(!text.includes(tokens.a) && !text.includes('denied'));
    return true;
  });
  await pool.call(a, 'sandbox', 'inspect', {});
  assert.equal(upstream.initializeAttempts, 2);
});

test('a refused admission between two calls keeps their connection', async (t) => {
  const { pool, upstream, a, access, grants, clients } = await fixture(t);
  const first = await pool.call(a, 'sandbox', 'inspect', {});
  access.replace(grants.filter((grant) => grant.actorId !== a.actorId));
  await assert.rejects(pool.call(a, 'sandbox', 'inspect', {}), { code: 'tool_forbidden' });
  access.replace(grants);
  const second = await pool.call(a, 'sandbox', 'inspect', {});
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
  const pool = new ScopedRemoteClients(f.credentials, f.access, {
    mountId: 'sandbox',
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
  });
  const registry = new ToolRegistry(f.scope, f.access);
  t.after(async () => {
    await registry.close();
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await registry.createCatalog('sandbox').replace([
    {
      kind: 'mcp',
      name: 'inspect',
      inputSchema: { type: 'object' },
      handler: (caller, input) => pool.call(caller, 'sandbox', 'inspect', input),
    },
  ]);
  for (let call = 0; call < 2; call++)
    await assert.rejects(registry.call('_sandbox.inspect', f.a, {}), {
      code: 'invalid_remote_result',
    });
  assert.equal(initializes, 1);
});

test('an idle invocation connection opens no notification stream', async (t) => {
  const f = await fixture(t);
  const { remote, pool } = await remotePool(t, f, { timeoutMs: 300 });
  await pool.call(f.a, 'sandbox', 'inspect', {});
  await sleep(1500);
  assert.equal(remote.gets, 0);
  assert.equal(remote.sessionCount, 1);
});

test('an idle connection ends with an MCP DELETE', async (t) => {
  const f = await fixture(t);
  const { remote, pool } = await remotePool(t, f, { idleMs: 200 });
  await pool.call(f.a, 'sandbox', 'inspect', {});
  assert.equal(remote.sessionCount, 1);
  await until(() => remote.sessionCount === 0, 'The idle connection stayed open', 400);
  assert.equal(remote.deletes, 1);
  await pool.call(f.a, 'sandbox', 'inspect', {});
  assert.equal(remote.opened, 2);
});

test('closing the pool ends every connection with an MCP DELETE', async (t) => {
  const f = await fixture(t);
  const { remote, pool } = await remotePool(t, f);
  for (const caller of [f.a, f.a2, f.b]) await pool.call(caller, 'sandbox', 'inspect', {});
  assert.equal(remote.sessionCount, 3);
  await pool.close();
  assert.equal(remote.sessionCount, 0);
  assert.equal(remote.deletes, remote.opened);
  assert.equal(remote.opened, 3);
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
