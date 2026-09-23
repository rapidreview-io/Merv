import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SandboxService, type SandboxRuntimeHandle } from '@merv/sandboxes';

const urlEnv = 'MERV_RUNTIME_TEST_URL';
const tokenEnv = 'MERV_RUNTIME_TEST_TOKEN';
const releaseId = `rt1_${'a'.repeat(64)}`;
const profile = {
  provider: 'thunder_compute',
  offerId: 'a6000_x1:thunder',
  releaseId,
  leaseSeconds: 1800,
  ttlSeconds: 300,
};
const connection = { projectId: 'project_a', namespace: 'fleet_a', tokenEnv };
const base = 'https://sandbox.invalid';

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
  namespace: string | null;
}

function record(state: string, revision = 1) {
  return {
    id: 'sbx_1',
    namespace: connection.namespace,
    provider: profile.provider,
    state,
    revision,
    request: {
      provider: profile.provider,
      offer_id: profile.offerId,
      protected_runtime: true,
    },
    lease_expires_at: '2099-01-01T00:00:00Z',
    access_mode: 'inbound',
    endpoint: { host: 'sandbox.invalid', port: 22 },
  };
}

function launchReceipt(state = 'pending', deliveryState = 'launched') {
  return {
    namespace: connection.namespace,
    sandbox_id: 'sbx_1',
    launch_id: 'rln_1',
    operation_key: 'run_1',
    release_id: releaseId,
    job_id: 'rtj_1',
    state,
    delivery_state: deliveryState,
    created_at: '2026-09-22T00:00:00Z',
    expires_at: '2026-09-22T00:05:00Z',
    bootstrap: 'server-should-not-return-this',
    token: 'server-should-not-return-this',
  };
}

function fixture(
  t: TestContext,
  reply: (call: Call) => Response,
  runtime: typeof profile | null = profile,
) {
  const oldUrl = process.env[urlEnv];
  const oldToken = process.env[tokenEnv];
  process.env[urlEnv] = base;
  process.env[tokenEnv] = 'sbxt_runtime_fixture';
  t.after(() => {
    if (oldUrl === undefined) delete process.env[urlEnv];
    else process.env[urlEnv] = oldUrl;
    if (oldToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = oldToken;
  });
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      authorization: headers.get('authorization'),
      namespace: headers.get('x-sandbox-namespace'),
    };
    calls.push(call);
    if (call.path === '/v1/auth/me')
      return Response.json({ role: 'consumer', namespace: connection.namespace });
    return reply(call);
  });
  return {
    calls,
    service: new SandboxService({
      urlEnv,
      connections: [connection],
      ...(runtime ? { runtime } : {}),
    }),
  };
}

test('runtime admission is absent when no profile is configured', async (t) => {
  const disabled = fixture(t, () => Response.json({}), null).service;
  assert.equal(disabled.runtimes, undefined);
  await disabled.close();
});

test('provision and launch use one fixed profile and return metadata without bootstrap', async (t) => {
  const { calls, service } = fixture(t, (call) => {
    if (call.path === '/v1/sandboxes' && call.method === 'POST')
      return Response.json(record('provisioning'), { status: 202 });
    if (call.path === '/v1/sandboxes/sbx_1') return Response.json(record('ready'));
    if (call.path === '/v1/sandboxes/sbx_1/runtime') return Response.json(launchReceipt());
    if (call.path === '/v1/runtime/launches/rln_1') return Response.json(launchReceipt());
    throw new Error(`unexpected route ${call.method} ${call.path}`);
  });
  const runtimes = service.runtimes!;
  assert.match(runtimes.profileId, /^srp_[0-9a-f]{64}$/);
  const first = await runtimes.provision(connection.projectId, 'fleet-operation-1');
  const second = await runtimes.provision(connection.projectId, 'fleet-operation-1');
  assert.equal(first.state, 'provisioning');
  assert.equal(first.ready, false);
  assert.equal(first.deleted, false);
  const creates = calls.filter((call) => call.path === '/v1/sandboxes');
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].body, creates[1].body);
  assert.deepEqual(Object.keys(creates[0].body!).sort(), [
    'idempotency_key',
    'lease_seconds',
    'offer_id',
    'protected_runtime',
    'provider',
  ]);
  assert.equal(creates[0].body!.protected_runtime, true);
  assert.equal(creates[0].body!.offer_id, profile.offerId);
  assert.equal(creates[0].body!.lease_seconds, profile.leaseSeconds);
  assert.match(String(creates[0].body!.idempotency_key), /^runtime:[0-9a-f]{64}$/);
  assert.ok(
    calls.every(
      (call) =>
        call.authorization === 'Bearer sbxt_runtime_fixture' &&
        call.namespace === connection.namespace,
    ),
  );

  const ready = await runtimes.inspect(connection.projectId, second);
  assert.equal(ready.ready, true);
  const launched = await runtimes.launch(connection.projectId, ready, 'run_1', 'one-use-secret');
  assert.equal(launched.launch?.deliveryState, 'launched');
  assert.equal(launched.launch?.launchId, 'rln_1');
  assert.ok(!JSON.stringify(launched).includes('one-use-secret'));
  assert.ok(!JSON.stringify(launched).includes('server-should-not-return-this'));
  const post = calls.find((call) => call.path.endsWith('/runtime') && call.method === 'POST')!;
  assert.deepEqual(post.body, {
    operation_key: 'run_1',
    release_id: releaseId,
    bootstrap: 'one-use-secret',
    ttl_seconds: profile.ttlSeconds,
  });
  await service.close();
});

test('stop reports pending deletion until the provider confirms stopped', async (t) => {
  let state = 'ready';
  const { calls, service } = fixture(t, (call) => {
    if (call.path === '/v1/sandboxes/sbx_1' && call.method === 'GET')
      return Response.json(record(state));
    if (call.path === '/v1/runtime/launches/rln_1' && call.method === 'GET')
      return Response.json(launchReceipt());
    if (call.path === '/v1/runtime/launches/rln_1' && call.method === 'DELETE') {
      state = 'deleting';
      return Response.json(record(state), { status: 202 });
    }
    throw new Error(`unexpected route ${call.method} ${call.path}`);
  });
  const current: SandboxRuntimeHandle = {
    sandboxId: 'sbx_1',
    state: 'ready',
    ready: true,
    deleted: false,
    leaseExpiresAt: '2099-01-01T00:00:00Z',
    revision: 1,
    launch: {
      sandboxId: 'sbx_1',
      launchId: 'rln_1',
      operationKey: 'run_1',
      releaseId,
      jobId: 'rtj_1',
      state: 'pending',
      deliveryState: 'launched',
      expiresAt: '2026-09-22T00:05:00Z',
    },
  };
  const pending = await service.runtimes!.stop(connection.projectId, current);
  assert.equal(pending.state, 'deleting');
  assert.equal(pending.deleted, false);
  state = 'stopped';
  const done = await service.runtimes!.inspect(connection.projectId, pending);
  assert.equal(done.deleted, true);
  await service.runtimes!.stop(connection.projectId, done);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  await service.close();
});

test('remote launch errors cannot echo the bootstrap into Fleet', async (t) => {
  const secret = 'highly-sensitive-bootstrap';
  const { service } = fixture(t, (call) => {
    if (call.path === '/v1/sandboxes/sbx_1' && call.method === 'GET')
      return Response.json(record('ready'));
    if (call.path === '/v1/sandboxes/sbx_1/runtime')
      return Response.json(
        { error: { code: 'validation_error', message: secret } },
        { status: 400 },
      );
    throw new Error(`unexpected route ${call.method} ${call.path}`);
  });
  const current: SandboxRuntimeHandle = {
    sandboxId: 'sbx_1',
    state: 'ready',
    ready: true,
    deleted: false,
    leaseExpiresAt: null,
    revision: 1,
    launch: null,
  };
  await assert.rejects(
    service.runtimes!.launch(connection.projectId, current, 'run_1', secret),
    (error: unknown) => error instanceof Error && !error.message.includes(secret),
  );
  await service.close();
});

test('an old protected sandbox remains inspectable and stoppable after profile change', async (t) => {
  let state = 'ready';
  const { service } = fixture(
    t,
    (call) => {
      if (call.path === '/v1/sandboxes/sbx_1' && call.method === 'GET')
        return Response.json(record(state));
      if (call.path === '/v1/sandboxes/sbx_1' && call.method === 'DELETE') {
        state = 'deleting';
        return Response.json(record(state), { status: 202 });
      }
      throw new Error(`unexpected route ${call.method} ${call.path}`);
    },
    { ...profile, provider: 'other_provider', offerId: 'different_offer' },
  );
  const old: SandboxRuntimeHandle = {
    sandboxId: 'sbx_1',
    state: 'ready',
    ready: true,
    deleted: false,
    leaseExpiresAt: null,
    revision: 1,
    launch: null,
  };
  assert.equal((await service.runtimes!.inspect(connection.projectId, old)).state, 'ready');
  assert.equal((await service.runtimes!.stop(connection.projectId, old)).state, 'deleting');
  await assert.rejects(service.runtimes!.launch(connection.projectId, old, 'run_1', 'secret'), {
    code: 'sandbox_runtime_unavailable',
  });
  await service.close();
});
