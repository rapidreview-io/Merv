import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
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

function record(state: string, revision = 1, { provider, offerId } = profile) {
  return {
    id: 'sbx_1',
    namespace: connection.namespace,
    provider,
    state,
    revision,
    request: {
      provider,
      offer_id: offerId,
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
  runtimes: (typeof profile & { key: string })[] | null = [{ key: 'standard', ...profile }],
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
      ...(runtimes ? { runtimes } : {}),
    }),
  };
}

test('runtime admission is absent when no profile is configured', async (t) => {
  const disabled = fixture(t, () => Response.json({}), null).service;
  assert.equal(disabled.runtimes, undefined);
  await disabled.close();
  const standard = { key: 'standard', ...profile };
  assert.throws(() => fixture(t, () => Response.json({}), [standard, standard]), {
    code: 'invalid_sandboxes_config',
  });
});

const large = {
  key: 'large',
  provider: 'cloudflare-fleet-large',
  offerId: 'standard-3:cloudflare',
  releaseId: `rt1_${'b'.repeat(64)}`,
  leaseSeconds: 3600,
  ttlSeconds: 120,
};

test('each profile rents, launches and renews its own machine; the default keeps its id', async (t) => {
  const { calls, service } = fixture(
    t,
    (call) => {
      const shape = call.body?.provider === profile.provider ? profile : large;
      if (call.path === '/v1/sandboxes') return Response.json(record('provisioning', 1, shape));
      if (call.path === '/v1/sandboxes/sbx_1') return Response.json(record('ready', 1, large));
      if (call.path === '/v1/sandboxes/sbx_1/runtime' || call.path === '/v1/runtime/launches/rln_1')
        return Response.json({ ...launchReceipt(), release_id: large.releaseId });
      if (call.path === '/v1/sandboxes/sbx_1/renew')
        return Response.json(record('ready', 2, large));
      throw new Error(`unexpected route ${call.method} ${call.path}`);
    },
    [{ key: 'standard', ...profile }, large],
  );
  const runtimes = service.runtimes!;
  // The id hashes the profile without its key, so the machines Fleet already holds stay current.
  const legacy = 'srp_48546695cae70da2b2420381a0880e6cad796d39a468bb596ea2d4f04ec4163c';
  const [standardRef, largeRef] = runtimes.profiles;
  assert.deepEqual(standardRef, { key: 'standard', id: legacy, leaseSeconds: 1800 });
  assert.deepEqual([largeRef.key, largeRef.leaseSeconds], ['large', 3600]);
  assert.match(largeRef.id, /^srp_[0-9a-f]{64}$/);
  await runtimes.provision(connection.projectId, 'standard-create');
  const created = await runtimes.provision(connection.projectId, 'large-create', largeRef.id);
  const launched = await runtimes.launch(connection.projectId, created, 'run_1', 'x', largeRef.id);
  await runtimes.renew(connection.projectId, launched, largeRef.id);
  const [standardCreate, largeCreate, largeLaunch, largeRenew] = calls
    .filter((call) => call.method === 'POST')
    .map((call) => call.body!);
  assert.deepEqual(
    [standardCreate.provider, standardCreate.offer_id, standardCreate.lease_seconds],
    [profile.provider, profile.offerId, 1800],
  );
  assert.deepEqual(
    [largeCreate.provider, largeCreate.offer_id, largeCreate.lease_seconds],
    [large.provider, large.offerId, 3600],
  );
  assert.deepEqual([largeLaunch.release_id, largeLaunch.ttl_seconds], [large.releaseId, 120]);
  assert.equal(largeRenew.lease_seconds, 3600);
  const count = calls.length;
  await assert.rejects(runtimes.provision(connection.projectId, 'gone', 'srp_gone'), {
    code: 'sandbox_runtime_profile_unknown',
  });
  assert.equal(calls.length, count);
  await service.close();
});

test('a machine is described from the service options, read once a refresh period', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-24T00:00:00Z') });
  const standard = { ...large, key: 'standard', offerId: 'standard-1:cloudflare' };
  const shape = (offerId: string, cpu: number, memory: number, disk: number, usd: string) => ({
    provider: large.provider,
    plugin: 'cloudflare',
    offer_id: offerId,
    instance_type: offerId.split(':')[0],
    region: 'cloudflare',
    // Cloudflare lists a fractional share as its whole-core ceiling and says the share here.
    resources: { cpu: Math.ceil(cpu), memory_mb: memory, disk_gb: disk, gpu_count: 0 },
    hourly_price: { currency: 'USD', amount: usd },
    available: true,
    description: `${cpu.toFixed(1)} vCPU, ${memory} MiB memory, ${disk} GB disk`,
  });
  let offers: unknown[] | null = [
    shape('standard-1:cloudflare', 0.5, 4096, 8, '0.074016'),
    shape('standard-3:cloudflare', 2, 8192, 16, '0.220032'),
  ];
  const { calls, service } = fixture(
    t,
    (call) => {
      if (call.path === '/v1/options')
        return offers ? Response.json({ offers }) : new Response(null, { status: 503 });
      throw new Error(`unexpected route ${call.method} ${call.path}`);
    },
    [standard, large],
  );
  const describe = (key: string) => service.runtimes!.describe(connection.projectId, key);
  const reads = () => calls.filter((call) => call.path === '/v1/options').length;
  assert.deepEqual(await Promise.all(['standard', 'large', 'huge'].map(describe)), [
    { key: 'standard', vcpu: 0.5, memoryGiB: 4, diskGB: 8, maxHourlyUsd: 0.074016 },
    { key: 'large', vcpu: 2, memoryGiB: 8, diskGB: 16, maxHourlyUsd: 0.220032 },
    null,
  ]);
  assert.equal(reads(), 1);
  // The service stops listing Large: once the period passes, the last answer is served at once
  // while a new read runs, and Large is hidden when it lands.
  offers = offers.slice(0, 1);
  t.mock.timers.tick(299_000);
  assert.notEqual(await describe('large'), null);
  t.mock.timers.tick(1000);
  assert.notEqual(await describe('large'), null);
  assert.equal(reads(), 2);
  await setImmediate();
  assert.equal(await describe('large'), null);
  assert.equal((await describe('standard'))?.vcpu, 0.5);
  assert.equal(reads(), 2);
  // An unreachable service keeps the last answer, and the next look reads again.
  offers = null;
  t.mock.timers.tick(300_000);
  assert.equal((await describe('standard'))?.memoryGiB, 4);
  await setImmediate();
  assert.equal((await describe('standard'))?.memoryGiB, 4);
  assert.equal(reads(), 4);
  await service.close();
});

test('a project is connected only while its grant is configured', async (t) => {
  const { service } = fixture(t, () => Response.json({}));
  const runtimes = service.runtimes!;
  assert.equal(runtimes.profiles[0].leaseSeconds, profile.leaseSeconds);
  assert.equal(runtimes.connected(connection.projectId), true);
  assert.equal(runtimes.connected('project_other'), false);
  delete process.env[tokenEnv];
  assert.equal(runtimes.connected(connection.projectId), false);
  await service.close();
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
  assert.match(runtimes.profiles[0].id, /^srp_[0-9a-f]{64}$/);
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

test('acknowledge sends only the bound job and rejects changed or unlaunched receipts', async (t) => {
  let reply = launchReceipt('consumed');
  const { calls, service } = fixture(t, (call) => {
    if (call.path === '/v1/runtime/launches/rln_1/exchange') return Response.json(reply);
    throw new Error(`unexpected route ${call.method} ${call.path}`);
  });
  const current: SandboxRuntimeHandle = {
    sandboxId: 'sbx_1',
    state: 'ready',
    ready: true,
    deleted: false,
    leaseExpiresAt: null,
    revision: 1,
    launch: {
      sandboxId: 'sbx_1',
      launchId: 'rln_1',
      jobId: 'rtj_1',
      operationKey: 'run_1',
      releaseId,
      state: 'pending',
      deliveryState: 'launched',
      expiresAt: '2026-09-22T00:05:00Z',
    },
  };
  const exchanged = await service.runtimes!.acknowledge(connection.projectId, current);
  assert.equal(exchanged.launch?.state, 'consumed');
  await service.runtimes!.acknowledge(connection.projectId, exchanged);
  assert.equal(calls.filter((call) => call.path.endsWith('/exchange')).length, 2);
  assert.deepEqual(calls.at(-1)?.body, { job_id: 'rtj_1' });
  assert.ok(calls.every((call) => call.authorization === 'Bearer sbxt_runtime_fixture'));
  reply = { ...reply, job_id: 'rtj_other' };
  await assert.rejects(service.runtimes!.acknowledge(connection.projectId, current), {
    code: 'sandbox_runtime_unavailable',
  });
  const count = calls.length;
  await assert.rejects(
    service.runtimes!.acknowledge(connection.projectId, {
      ...current,
      launch: { ...current.launch!, deliveryState: 'uncertain' },
    }),
    { code: 'sandbox_runtime_unavailable' },
  );
  assert.equal(calls.length, count);
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

test('a launch refused while the new container boots reaches Fleet as sandbox_provider_unavailable 503', async (t) => {
  const { service } = fixture(t, (call) => {
    if (call.method === 'GET') return Response.json(record('ready'));
    // Sandboxes' own answer until Cloudflare's inventory shows the container running.
    return Response.json(
      {
        error: {
          code: 'provider_unavailable',
          message: 'Cloudflare runtime version is not running',
          retryable: true,
          details: {},
        },
      },
      { status: 503 },
    );
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
  await assert.rejects(service.runtimes!.launch(connection.projectId, current, 'run_1', 'boot'), {
    code: 'sandbox_provider_unavailable',
    status: 503,
  });
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
    [{ key: 'standard', ...profile, provider: 'other_provider', offerId: 'different_offer' }],
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
