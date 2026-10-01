import test from 'node:test';
import assert from 'node:assert/strict';
import { MervError } from '@merv/contracts';
import { SandboxComputeAdapter } from '../packages/sandboxes/src/compute.js';
import { computeOutputsSchema } from '../packages/sandboxes/src/compute-outputs.js';

test('capture precedes release, retains partial evidence, and refreshes scoped downloads', async (t) => {
  const original = globalThis.fetch;
  const tokenEnv = 'MERV_SANDBOXES_CAPTURE_TEST_GRANT';
  process.env[tokenEnv] = 'sbxt_test_capture_grant';
  t.after(() => {
    globalThis.fetch = original;
    delete process.env[tokenEnv];
  });
  const record = {
    id: 'obj_model',
    name: 'model.tar.gz',
    kind: 'file',
    state: 'available',
    producer_pipeline_id: 'pipe_capture',
    sha256: 'a'.repeat(64),
    size_bytes: 1234,
    expires_at: null,
  };
  let workflow: any = {
    state: 'completed',
    nodes: {
      run: { state: 'completed', result: { job_id: 'job_capture' } },
      capture: {
        state: 'completed',
        result: { outputs: { 'model.tar.gz': 'obj_model' }, output_state: 'committed' },
      },
      release: { state: 'completed' },
    },
  };
  let graph: any;
  let downloadUrl = 'https://bucket.example/model?signature=first';
  let downloadRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    assert.equal(new Headers(init?.headers).get('x-sandbox-subject'), 'project_capture');
    if (url.endsWith('/v1/auth/me')) return json({ role: 'consumer', namespace: 'merv-ml' });
    if (url.endsWith('/v1/workflows') && init?.method === 'POST') {
      graph = JSON.parse(String(init.body));
      return json({ id: 'pipe_capture' }, 202);
    }
    if (url.endsWith('/v1/workflows/pipe_capture')) return json(workflow);
    if (url.endsWith('/v1/storage/objects/obj_model')) return json(record);
    if (url.endsWith('/v1/storage/objects/obj_model/download')) {
      downloadRequests++;
      return json({ object: record, url: downloadUrl });
    }
    if (url.endsWith('/v1/jobs/job_capture'))
      return json({ result: { exit: 0, bytes: 2, head64: 'b2s=', tail64: 'b2s=' } });
    throw new Error(`Unexpected capture test route: ${url}`);
  };
  const adapter = new SandboxComputeAdapter('https://sandbox.example', 1000, 60_000, {
    namespace: 'merv-ml',
    tokenEnv,
    since: '2026-09-25T00:00:00Z',
    storageOrigins: ['https://bucket.example'],
  });
  await adapter.submit('project_capture', {
    experimentId: 'exp_capture',
    idempotencyKey: 'capture-key',
    provider: 'test',
    offerId: 'gpu',
    command: 'train-and-archive',
    minutes: 60,
    maxUsd: 2,
    outputs: { files: [{ name: 'model.tar.gz', path: '/tmp/model.tar.gz' }], maxBytes: 2000 },
  });
  const capture = graph.nodes.find((node: any) => node.id === 'capture');
  assert.deepEqual(capture, {
    id: 'capture',
    kind: 'capture',
    vm: 'provision',
    job: 'run',
    depends_on: ['run'],
    when: 'always',
    outputs: [{ name: 'model.tar.gz', path: '/tmp/model.tar.gz', kind: 'file', required: true }],
    output_bytes: 2000,
  });
  assert.deepEqual(graph.nodes.at(-1), {
    id: 'release',
    kind: 'release',
    vm: 'provision',
    depends_on: ['capture'],
    when: 'always',
  });
  assert.equal(graph.capture_grace_seconds, 600);
  const completed = await adapter.get('project_capture', 'pipe_capture');
  assert.equal(completed.state, 'completed');
  assert.equal(completed.outputState, 'committed');
  assert.deepEqual(completed.outputs, [
    {
      name: 'model.tar.gz',
      objectId: 'obj_model',
      sizeBytes: 1234,
      sha256: 'a'.repeat(64),
      expiresAt: null,
    },
  ]);
  assert.equal(downloadRequests, 0, 'polling must not mint or persist bearer URLs');
  assert.deepEqual(await adapter.download('project_capture', 'obj_model'), { url: downloadUrl });
  downloadUrl = 'https://bucket.example/model?signature=refreshed';
  assert.deepEqual(await adapter.download('project_capture', 'obj_model'), { url: downloadUrl });
  assert.equal(downloadRequests, 2);
  downloadUrl =
    'https://bucket.example/model?X-Amz-Date=20260930T180000Z&X-Amz-Expires=3600&X-Amz-Signature=test';
  assert.deepEqual(await adapter.download('project_capture', 'obj_model'), {
    url: downloadUrl,
    expiresAt: '2026-09-30T19:00:00.000Z',
  });

  workflow.state = 'failed';
  workflow.nodes.capture.state = 'failed';
  workflow.nodes.capture.error = {
    code: 'capture_failed',
    message: 'Required metrics file was missing',
  };
  workflow.nodes.capture.result.output_state = 'partial';
  const partial = await adapter.get('project_capture', 'pipe_capture');
  assert.equal(partial.state, 'failed');
  assert.equal(partial.failureStage, 'capture');
  assert.equal(partial.reason, 'Required metrics file was missing');
  assert.equal(partial.outputState, 'partial');
  assert.equal(
    partial.outputs?.length,
    1,
    'a failed sibling must not hide the retained checkpoint',
  );
  record.producer_pipeline_id = 'another_pipeline';
  await assert.rejects(
    adapter.get('project_capture', 'pipe_capture'),
    (error: unknown) => error instanceof MervError && error.code === 'sandbox_unavailable',
  );
  record.producer_pipeline_id = 'pipe_capture';
  downloadUrl = 'https://other.example/model';
  await assert.rejects(
    adapter.download('project_capture', 'obj_model'),
    (error: unknown) => error instanceof MervError && error.code === 'sandbox_unavailable',
  );
  record.state = 'expired';
  await assert.rejects(adapter.download('project_capture', 'obj_model'), /no longer available/);

  workflow = {
    state: 'failed',
    nodes: {},
    error: { code: 'workflow_failed', message: 'workflow full lease cost exceeds max_cost' },
  };
  const refused = await adapter.get('project_capture', 'pipe_capture');
  assert.equal(refused.reason, 'workflow full lease cost exceeds max_cost');
  assert.equal(refused.outputs, undefined);
});

test('output requests require bounded named regular-file paths', () => {
  const valid = { files: [{ name: 'model.tar.gz', path: '/tmp/model.tar.gz' }], maxBytes: 1024 };
  assert.equal(computeOutputsSchema.safeParse(valid).success, true);
  for (const path of [
    'relative/file',
    '/',
    '/tmp/../secret',
    '/tmp/./model',
    '/tmp/model\nfile',
    '/tmp/model/',
  ]) {
    assert.equal(
      computeOutputsSchema.safeParse({ ...valid, files: [{ name: 'model', path }] }).success,
      false,
      path,
    );
  }
  for (const name of ['../model', 'subdir/model', '']) {
    assert.equal(
      computeOutputsSchema.safeParse({ ...valid, files: [{ name, path: '/tmp/model' }] }).success,
      false,
      name,
    );
  }
  assert.equal(
    computeOutputsSchema.safeParse({ ...valid, files: [...valid.files, ...valid.files] }).success,
    false,
  );
  assert.equal(computeOutputsSchema.safeParse({ ...valid, maxBytes: 0 }).success, false);
  assert.equal(
    computeOutputsSchema.safeParse({ ...valid, maxBytes: 2_147_483_649 }).success,
    false,
  );
});

test('borrowed durable jobs use_vm, preserve rental on cancel/failure, and isolate run workspaces', async (t) => {
  const tokenEnv = 'MERV_BORROW_TEST_GRANT';
  process.env[tokenEnv] = 'sbxt_borrow_test';
  t.after(() => {
    delete process.env[tokenEnv];
  });
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path !== '/part')
      assert.equal(new Headers(init?.headers).get('x-sandbox-subject'), 'project_borrow');
    let result: unknown;
    if (path === '/v1/storage/objects')
      result = {
        object: { id: 'obj_source', state: 'uploading' },
        part_size: 3,
        part_count: 1,
        completed_parts: [],
        parts: [{ part_number: 1, size_bytes: 3, url: 'https://bucket.example/part', headers: {} }],
      };
    else if (path === '/part') return new Response(null, { status: 200 });
    else if (path === '/v1/storage/objects/obj_source/complete') result = { id: 'obj_source' };
    else if (path === '/v1/auth/me') result = { role: 'consumer', namespace: 'merv-ml' };
    else if (path === '/v1/workflows') {
      requests.push(JSON.parse(String(init?.body)));
      result = { id: 'pipe_borrow' };
    } else if (path === '/v1/workflows/pipe_borrow/cancel') result = {};
    else throw Error(`Unexpected borrowed run request ${path}`);
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const adapter = new SandboxComputeAdapter('https://sandbox.example', 1000, 60_000, {
    namespace: 'merv-ml',
    tokenEnv,
    since: '2000-01-01',
    storageOrigins: ['https://bucket.example'],
  });
  for (const key of ['job-a', 'job-b'])
    await adapter.submit('project_borrow', {
      experimentId: 'experiment',
      idempotencyKey: key,
      rentalSandboxId: 'sbx_shared',
      command: 'exit 7',
      minutes: 5,
      maxUsd: 0,
      source: { bytes: new Uint8Array([1, 2, 3]), sha256: 'a'.repeat(64) },
      outputs: { files: [{ name: 'diagnostics', path: '/tmp/diagnostics' }], maxBytes: 1024 },
    });
  for (const request of requests) {
    assert.deepEqual(request.nodes[0], {
      id: 'provision',
      kind: 'use_vm',
      sandbox_id: 'sbx_shared',
    });
    assert.equal(
      request.nodes.some((node: any) => node.kind === 'release'),
      false,
    );
    assert.equal(request.nodes.find((node: any) => node.kind === 'capture').when, 'always');
  }
  assert.notEqual(requests[0].nodes[2].job.command, requests[1].nodes[2].job.command);
  assert.notEqual(requests[0].nodes[1].inputs[0].path, requests[1].nodes[1].inputs[0].path);
  for (const request of requests)
    assert.ok(request.nodes[2].job.command.includes(request.nodes[1].inputs[0].path));
  await adapter.cancel('project_borrow', 'pipe_borrow'); // No machine delete call.
});
