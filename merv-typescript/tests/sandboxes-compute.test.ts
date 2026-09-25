import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxComputeAdapter } from '../packages/sandboxes/src/compute.js';
import { SandboxService } from '../packages/sandboxes/src/index.js';

test('ML workflow uses the project subject, stages only approved source, and reads its own result', async (t) => {
  const original = globalThis.fetch;
  const tokenEnv = 'MERV_SANDBOXES_ML_TEST_GRANT';
  process.env[tokenEnv] = 'sbxt_test_consumer_grant';
  const seen: {
    url: string;
    method: string;
    subject?: string;
    authorization?: string;
    body?: any;
  }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    seen.push({
      url,
      method,
      subject: headers.get('x-sandbox-subject') ?? undefined,
      authorization: headers.get('authorization') ?? undefined,
      body,
    });
    const json = (value: object, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/v1/auth/me')) return json({ role: 'consumer', namespace: 'merv-ml' });
    if (url.endsWith('/v1/options'))
      return json({
        offers: [
          { provider: 'lambda', offer_id: 'gpu', resources: { gpu_count: 1 } },
          { provider: 'lambda', offer_id: 'cpu', resources: { gpu_count: 0 } },
        ],
      });
    if (url.endsWith('/v1/spend'))
      return json({
        month_to_date: [{ currency: 'USD', amount: '1' }],
        cap: { monthly_cap: { currency: 'USD', amount: '50' } },
      });
    if (url.endsWith('/v1/storage/objects'))
      return json({
        object: { id: 'obj_one', state: 'uploading' },
        part_size: 3,
        part_count: 1,
        completed_parts: [],
        parts: [{ part_number: 1, size_bytes: 3, url: 'https://bucket.example/part', headers: {} }],
      });
    if (url === 'https://bucket.example/part') return new Response(null, { status: 200 });
    if (url.endsWith('/v1/storage/objects/obj_one/complete')) return json({ id: 'obj_one' });
    if (url.endsWith('/v1/workflows') && method === 'POST') return json({ id: 'wf_one' }, 202);
    if (url.endsWith('/v1/workflows/wf_one') && method === 'GET')
      return json({
        id: 'wf_one',
        state: 'completed',
        reserved_cost: { currency: 'USD', amount: '1.25' },
        nodes: { run: { result: { job_id: 'job_one' } }, provision: {} },
      });
    if (url.endsWith('/v1/workflows/wf_refused') && method === 'GET')
      return json({
        id: 'wf_refused',
        state: 'failed',
        nodes: {
          provision: {
            error: { code: 'budget_refused', details: { reason: 'budget_exceeded' } },
          },
        },
      });
    if (url.endsWith('/v1/jobs/job_one'))
      return json({
        result: {
          exit: 0,
          bytes: 4,
          head64: Buffer.from('head').toString('base64'),
          tail64: Buffer.from('tail').toString('base64'),
        },
      });
    if (url.endsWith('/v1/workflows/wf_one/cancel'))
      return json({ error: { code: 'not_found' } }, 404);
    throw new Error(`unexpected ${method} ${url}`);
  };
  t.after(() => {
    globalThis.fetch = original;
    delete process.env[tokenEnv];
  });
  const config = {
    namespace: 'merv-ml',
    tokenEnv,
    since: '2026-09-25T00:00:00Z',
    storageOrigins: ['https://bucket.example'],
  };
  const compute = new SandboxComputeAdapter('https://sandbox.example', 1000, 60_000, config);
  assert.equal(((await compute.offers('project_a')) as { offers: unknown[] }).offers.length, 1);
  assert.deepEqual(await compute.allowance('project_a'), {
    month_to_date: [{ currency: 'USD', amount: '1' }],
    cap: { currency: 'USD', amount: '50' },
  });
  const spec = {
    experimentId: 'exp_one',
    idempotencyKey: 'same-key',
    provider: 'lambda',
    offerId: 'gpu',
    command: 'echo ok',
    minutes: 10,
    maxUsd: 2,
  };
  assert.equal(await compute.submit('project_a', spec), 'wf_one');
  const plain = seen.find(
    (row) => row.url.endsWith('/v1/workflows') && row.method === 'POST',
  )!.body;
  assert.deepEqual(
    plain.nodes.map((node: { id: string }) => node.id),
    ['provision', 'run', 'release'],
  );
  assert.equal(plain.timeout_seconds, 1200);
  assert.equal(plain.capture_grace_seconds, 60);
  assert.equal(plain.max_cost, 2);
  await compute.submit('project_b', {
    ...spec,
    source: { bytes: new Uint8Array([1, 2, 3]), sha256: 'a'.repeat(64) },
  });
  const staged = seen
    .filter((row) => row.url.endsWith('/v1/workflows') && row.method === 'POST')
    .at(-1)!.body;
  assert.deepEqual(
    staged.nodes.map((node: { id: string }) => node.id),
    ['provision', 'stage', 'run', 'release'],
  );
  assert.equal(staged.nodes[1].inputs[0].object_id, 'obj_one');
  assert.equal(
    seen.find((row) => row.url === 'https://bucket.example/part')?.authorization,
    undefined,
  );
  assert.deepEqual(await compute.get('project_a', 'wf_one'), {
    id: 'wf_one',
    state: 'completed',
    reason: null,
    cost: { currency: 'USD', amount: '1.25' },
    result: { exit: 0, bytes: 4, head: 'head', tail: 'tail' },
  });
  assert.equal((await compute.get('project_a', 'wf_refused')).reason, 'budget_exceeded');
  await compute.cancel('project_a', 'wf_one');
  assert.ok(
    seen
      .filter((row) => row.url.startsWith('https://sandbox.example'))
      .every((row) => row.subject && row.authorization),
  );
  assert.ok(seen.some((row) => row.subject === 'project_b'));
});

test('ML configuration leaves ordinary connections and checks independent', () => {
  const tokenEnv = 'MERV_SANDBOXES_ML_TEST_GRANT';
  const urlEnv = 'MERV_SANDBOXES_ML_TEST_URL';
  process.env[tokenEnv] = 'sbxt_test_consumer_grant';
  process.env[urlEnv] = 'https://sandbox.example';
  const ordinary = new SandboxService({
    urlEnv,
    connections: [{ projectId: 'project_one', namespace: 'ordinary', tokenEnv }],
  });
  assert.equal(ordinary.compute, undefined);
  assert.equal(ordinary.checks, undefined);
  assert.equal(ordinary.runtimes?.connected('project_two'), undefined);
  void ordinary.close();
  delete process.env[tokenEnv];
  delete process.env[urlEnv];
});
