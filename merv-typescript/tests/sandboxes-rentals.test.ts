import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxService } from '@merv/sandboxes';

test('public compute capability forwards scoped rentals, recovery, SSH and durable retention', async (t) => {
  const tokenEnv = 'MERV_RENTAL_TEST_GRANT',
    urlEnv = 'MERV_RENTAL_TEST_ORIGIN';
  process.env[tokenEnv] = 'sbxt_rental_test';
  process.env[urlEnv] = 'https://sandbox.example';
  t.after(() => {
    delete process.env[tokenEnv];
    delete process.env[urlEnv];
  });
  let protectedRuntime = false;
  const rental = () => ({
    id: 'sbx_shared',
    state: 'ready',
    lease_expires_at: '2026-10-01T00:00:00Z',
    hourly_price: { amount: '0.3', currency: 'USD' },
    request: { idempotency_key: 'stable-key', protected_runtime: protectedRuntime },
  });
  const calls: Array<{ path: string; method: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input)),
      headers = new Headers(init?.headers);
    assert.equal(headers.get('x-sandbox-subject'), 'project_test');
    assert.equal(headers.get('x-sandbox-namespace'), 'merv-ml');
    assert.equal(headers.get('authorization'), 'Bearer sbxt_rental_test');
    const method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    let result: unknown;
    if (url.pathname === '/v1/auth/me') result = { role: 'consumer', namespace: 'merv-ml' };
    else if (url.pathname === '/v1/sandboxes' && method === 'GET')
      result = { sandboxes: [rental()] };
    else if (url.pathname.startsWith('/v1/sandboxes'))
      result = { ...rental(), ...(method === 'DELETE' ? { state: 'stopping' } : {}) };
    else if (url.pathname === '/v1/access/certificates')
      result = {
        certificate: 'ssh-ed25519-cert-v01@openssh.com fake',
        expires_at: '2026-10-01T00:00:00Z',
        gateway: { host: 'ssh.example', port: 2222 },
      };
    else if (url.pathname === '/v1/storage/objects/obj_file/retention')
      result = { id: 'obj_file', state: 'available', expires_at: null };
    else throw Error(`Unexpected route ${url.pathname}`);
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const service = new SandboxService({
    urlEnv,
    connections: [{ projectId: 'project_test', namespace: 'merv-ml', tokenEnv }],
    ml: {
      namespace: 'merv-ml',
      tokenEnv,
      since: '2026-09-25T00:00:00Z',
      storageOrigins: ['https://bucket.example'],
    },
  });
  t.after(() => service.close());
  const compute = service.compute!;
  assert.equal(
    (
      await compute.rent!('project_test', {
        key: 'stable-key',
        provider: 'test',
        offerId: 'gpu',
        minutes: 20,
      })
    ).sandboxId,
    'sbx_shared',
  );
  assert.deepEqual(calls.find((c) => c.method === 'POST' && c.path === '/v1/sandboxes')?.body, {
    provider: 'test',
    offer_id: 'gpu',
    lease_seconds: 1200,
    idempotency_key: 'stable-key',
    name: 'merv-stable-key',
  });
  assert.equal((await compute.findRental!('project_test', 'stable-key'))?.sandboxId, 'sbx_shared');
  assert.ok(calls.some((c) => c.path === '/v1/sandboxes?include_stopped=true'));
  assert.equal(await compute.findRental!('project_test', 'unknown-key'), null);
  assert.equal((await compute.inspectRental!('project_test', 'sbx_shared')).state, 'ready');
  const access = (await compute.ssh!('project_test', 'sbx_shared', 'ssh-ed25519 AAAA test')) as any;
  assert.equal(access.username, 'sbx_shared');
  assert.deepEqual(calls.find((c) => c.path === '/v1/access/certificates')?.body, {
    sandbox_id: 'sbx_shared',
    public_key: 'ssh-ed25519 AAAA test',
    ttl_seconds: 300,
  });
  await compute.retain!('project_test', 'obj_file');
  assert.deepEqual(
    calls.find((c) => c.path.endsWith('/retention')),
    { path: '/v1/storage/objects/obj_file/retention', method: 'PATCH', body: { expires_at: null } },
  );
  assert.equal((await compute.releaseRental!('project_test', 'sbx_shared')).state, 'stopping');
  protectedRuntime = true;
  await assert.rejects(compute.inspectRental!('project_test', 'sbx_shared'), { code: 'forbidden' });
});

test('rental extension adds remaining time with CAS under the same consumer subject', async (t) => {
  const { SandboxComputeAdapter } = await import('../packages/sandboxes/src/compute.js');
  const tokenEnv = 'MERV_RENEW_TEST_GRANT';
  process.env[tokenEnv] = 'sbxt_renew_test';
  t.after(() => {
    delete process.env[tokenEnv];
  });
  const fixed = Date.now();
  t.mock.method(Date, 'now', () => fixed);
  let revision = 3,
    expires = fixed + 600_000,
    renews = 0;
  let deny = false;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    assert.equal(new Headers(init?.headers).get('x-sandbox-subject'), 'project_renew');
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/v1/auth/me') return json({ role: 'consumer', namespace: 'merv-ml' });
    if (path.endsWith('/renew')) {
      const body = JSON.parse(String(init?.body));
      if (deny) return json({ error: { code: 'budget_exceeded', message: 'Budget denied' } }, 403);
      if (body.expected_revision !== revision)
        return json({ error: { code: 'revision_conflict', message: 'Stale revision' } }, 409);
      assert.equal(body.lease_seconds, (expires - fixed) / 1000 + 300);
      revision++;
      renews++;
      expires = fixed + body.lease_seconds * 1000;
    }
    return json({
      id: 'sbx_shared',
      state: 'ready',
      revision,
      lease_expires_at: new Date(expires).toISOString(),
    });
  });
  const adapter = new SandboxComputeAdapter('https://sandbox.example', 1000, 60_000, {
    namespace: 'merv-ml',
    tokenEnv,
    since: '2000-01-01',
    storageOrigins: [],
  });
  const results = await Promise.allSettled([
    adapter.extendRental('project_renew', 'sbx_shared', 5),
    adapter.extendRental('project_renew', 'sbx_shared', 5),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(renews, 1);
  assert.equal(expires, fixed + 900_000);
  deny = true;
  await assert.rejects(adapter.extendRental('project_renew', 'sbx_shared', 5));
  assert.equal(expires, fixed + 900_000, 'budget refusal preserves the existing lease');
});
