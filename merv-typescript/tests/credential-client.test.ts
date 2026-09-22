import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
import { createApp } from './fixtures/app.js';
import { ScopedRemoteClients } from '../packages/mounts/src/credential-client.js';
import { CredentialServer } from './fixtures/credential-server.js';

function data(result: CallToolResult) {
  return result.structuredContent as {
    identity: string;
    namespace: string;
    subject: string;
    connectionId: number;
  };
}

async function fixture(t: TestContext, timeoutMs = 1500, expectedCleanupFailure = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-credential-client-'));
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
  const clients: { client: Client; closeCalls: number }[] = [];
  const pool = new ScopedRemoteClients(credentials, access, {
    mountId: 'sandbox',
    url: upstream.url,
    timeoutMs,
    clientFactory: () => {
      const client = new Client({ name: 'scoped-client-test', version: '1' });
      const original = client.close.bind(client);
      const record = { client, closeCalls: 0 };
      client.close = async () => {
        record.closeCalls++;
        await original();
      };
      clients.push(record);
      return client;
    },
  });
  t.after(async () => {
    await upstream.close();
    try {
      if (expectedCleanupFailure)
        await assert.rejects(pool.close(), { code: 'remote_unavailable' });
      else await pool.close();
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

test('grant and credential revocation stop new calls and retire an idle privileged connection', async (t) => {
  const { pool, upstream, a, b, access, grants, bindings, clients, scope } = await fixture(t);
  await pool.call(a, 'sandbox', 'inspect', {});
  access.replace(grants.filter((grant) => grant.actorId !== a.actorId));
  await assert.rejects(pool.call(a, 'sandbox', 'inspect', {}), { code: 'tool_forbidden' });
  assert.equal(clients[0].closeCalls, 1);
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
  assert.equal(clients[0].closeCalls, 1);
  assert.equal(clients[1].closeCalls, 0);
});

test('a failed retired-client cleanup remains visible during later shutdown', async (t) => {
  const { pool, a, envA, tokens, clients } = await fixture(t, 1500, true);
  const first = await pool.call(a, 'sandbox', 'inspect', {});
  const originalClose = clients[0].client.close.bind(clients[0].client);
  let finishRetirement!: () => void;
  const retirementFinished = new Promise<void>((resolve) => {
    finishRetirement = resolve;
  });
  t.mock.method(clients[0].client, 'close', async () => {
    await originalClose();
    finishRetirement();
    throw new Error(`Retired cleanup contains ${tokens.a}`);
  });
  process.env[envA] = tokens.rotated;
  const replacement = await pool.call(a, 'sandbox', 'inspect', {});
  assert.notEqual(data(first).connectionId, data(replacement).connectionId);
  await retirementFinished;
  // Let the completed retirement leave the live-connection set before shutdown begins.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clients[0].closeCalls, 1);
  await assert.rejects(pool.close(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'remote_unavailable');
    assert.ok(!String(error).includes(tokens.a));
    assert.ok(!JSON.stringify(error).includes(tokens.a));
    return true;
  });
  assert.equal(
    clients[1].closeCalls,
    1,
    'Shutdown must also attempt the current connection cleanup',
  );
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
    // The connection opened with the superseded identity is retired, not reused.
    assert.ok(clients[0].closeCalls >= 1);
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
  assert.equal(clients[0].closeCalls, 1);
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
  assert.equal(clients[0].closeCalls, 1);
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
    assert.ok(clients[0].closeCalls >= 1);
    held.release();
  });
}
