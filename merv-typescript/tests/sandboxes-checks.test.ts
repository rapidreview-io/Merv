import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SandboxClient } from '../packages/sandboxes/src/client.js';
import { SandboxCheckRunner } from '../packages/sandboxes/src/checks.js';
import type { SandboxCheckSpec } from '@merv/sandboxes';

/**
 * The route sequence one project check walks, against a recorded transport. Nothing here
 * runs a command: this is what Merv says to the service and what it refuses to say.
 */

const tokenEnv = 'MERV_SANDBOXES_CHECK_TEST_TOKEN';
const connection = { projectId: 'project_checks', namespace: 'checks', tokenEnv };
const bucket = 'https://bucket.invalid';
const spec: SandboxCheckSpec = {
  provider: 'thunder_compute',
  offerId: 'a6000_x1:thunder',
  snapshotId: null,
  command: 'make test',
  timeoutSeconds: 600,
  leaseSeconds: 1500,
  source: { bytes: Buffer.from('a gzipped tree'), sha256: 'b'.repeat(64) },
  idempotencyKey: `chk:${'c'.repeat(64)}:1`,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

/** The service as this test writes it, plus the log of everything Merv sent. */
function transport(t: TestContext, answer: (call: Call) => Response, storageOrigins = [bucket]) {
  const previous = process.env[tokenEnv];
  process.env[tokenEnv] = 'sbxt_check_fixture';
  t.after(() => {
    if (previous === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = previous;
  });
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : ((init?.body ?? null) as unknown),
      authorization: headers.get('authorization'),
    };
    calls.push(call);
    if (url.pathname === '/v1/auth/me')
      return Response.json({ role: 'consumer', namespace: connection.namespace });
    return answer(call);
  });
  return {
    calls,
    runner: new SandboxCheckRunner(
      new SandboxClient('https://sandbox.invalid', 15_000, storageOrigins),
      () => connection,
    ),
  };
}

/** One page of parts covering the whole source, as the service answers a begin_upload. */
const upload = (parts: number, size: number) =>
  Response.json({
    object: { id: 'obj_1', state: 'uploading' },
    part_size: size,
    part_count: parts,
    parts: Array.from({ length: parts }, (_, index) => ({
      part_number: index + 1,
      url: `${bucket}/obj_1/${index + 1}?signature=abc`,
      size_bytes: size,
      headers: { 'Content-Length': String(size) },
    })),
  });

test('a check ships its source, rents the named machine and submits one wrapped job', async (t) => {
  const { calls, runner } = transport(t, (call) => {
    if (call.url.startsWith(bucket)) return new Response(null, { status: 200 });
    if (call.url.endsWith('/v1/storage/objects')) return upload(1, spec.source.bytes.byteLength);
    if (call.url.endsWith('/complete')) return Response.json({ id: 'obj_1', state: 'available' });
    if (call.url.endsWith('/v1/sandboxes')) return Response.json({ id: 'sbx_1' });
    if (call.url.endsWith('/v1/sandboxes/sbx_1'))
      return Response.json({
        id: 'sbx_1',
        state: 'ready',
        plugin: 'thunder_compute',
        offer: { instance_type: 'a6000_x1:thunder' },
      });
    if (call.url.endsWith('/download'))
      return Response.json({ url: `${bucket}/obj_1?download=1`, object: { id: 'obj_1' } });
    if (call.url.endsWith('/jobs')) return Response.json({ id: 'job_1' });
    return Response.json({
      id: 'job_1',
      state: 'succeeded',
      exit_code: 0,
      result: { exit: 0, bytes: 3, head64: Buffer.from('out').toString('base64'), tail64: '' },
      started_at: '2026-09-22T00:00:00Z',
      finished_at: '2026-09-22T00:01:00Z',
      cost: { amount: '0.006', currency: 'USD' },
    });
  });
  let handle = await runner.start(connection.projectId, spec);
  assert.deepEqual(
    { objectId: handle.objectId, sandboxId: handle.sandboxId, ready: handle.ready },
    { objectId: 'obj_1', sandboxId: 'sbx_1', ready: false },
  );
  assert.equal(handle.sha256, spec.source.sha256);
  assert.deepEqual(
    { ...handle.isolation, facts: undefined },
    { network: 'on', sourceReadOnly: false, imagePinned: 'offer', facts: undefined },
    'the ruling’s three facts travel with every handle',
  );
  const put = calls.find((call) => call.method === 'PUT')!;
  assert.ok(put.url.startsWith(bucket));
  assert.equal(put.authorization, null, 'no Merv credential reaches the bucket');
  const begun = calls.find((call) => call.url.endsWith('/v1/storage/objects'))!.body as {
    expires_in_seconds: number;
    idempotency_key: string;
  };
  assert.equal(begun.expires_in_seconds, spec.leaseSeconds);
  assert.equal(begun.idempotency_key, spec.idempotencyKey);
  const create = calls.find((call) => call.url.endsWith('/v1/sandboxes'))!.body as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(create).sort(), [
    'idempotency_key',
    'lease_seconds',
    'name',
    'offer_id',
    'provider',
  ]);
  assert.ok(
    !('job' in create) && !('snapshot_id' in create) && !('release_when_done' in create),
    'no compound create: this deployment must not need a workflow coordinator',
  );

  handle = await runner.step(connection.projectId, spec, handle);
  assert.equal(handle.ready, true);
  assert.deepEqual(handle.environment, {
    provider: 'thunder_compute',
    offerId: 'a6000_x1:thunder',
    snapshotId: null,
  });
  handle = await runner.step(connection.projectId, spec, handle);
  assert.equal(handle.jobId, 'job_1');
  const job = calls.find((call) => call.url.endsWith('/jobs'))!.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(job).sort(), [
    'command',
    'idempotency_key',
    'name',
    'timeout_seconds',
  ]);
  assert.match(String(job.command), /make test/);
  assert.match(String(job.command), /obj_1\?download=1/);
  assert.ok(!('env' in job) && !('outputs' in job) && !('cwd' in job));

  const verdict = await runner.follow(connection.projectId, handle);
  assert.equal(verdict.state, 'succeeded');
  assert.deepEqual(verdict.result, { exit: 0, bytes: 3, head: 'out', tail: '' });
  assert.deepEqual(verdict.usage, { amount: '0.006', currency: 'USD' });

  await runner.release(connection.projectId, handle);
  const after = calls.slice(-3).map((call) => `${call.method} ${new URL(call.url).pathname}`);
  assert.deepEqual(after, [
    'POST /v1/jobs/job_1/cancel',
    'DELETE /v1/sandboxes/sbx_1',
    'DELETE /v1/storage/objects/obj_1',
  ]);
});

test('a terminal job that wrote no result reports the setup step rather than a verdict', async (t) => {
  const { runner } = transport(t, () =>
    Response.json({ id: 'job_1', state: 'failed', exit_code: 123, result: null }),
  );
  const verdict = await runner.follow(connection.projectId, {
    sandboxId: 'sbx_1',
    jobId: 'job_1',
    objectId: 'obj_1',
    restoreJobId: null,
    sha256: null,
    ready: true,
    environment: null,
    isolation: { network: 'on', sourceReadOnly: false, imagePinned: 'offer', facts: [] },
  });
  assert.equal(verdict.result, null);
  assert.match(verdict.setup!, /digest/);
});

test('a source is uploaded only to an origin the deployment named, over HTTPS', async (t) => {
  const elsewhere = transport(
    t,
    (call) =>
      call.url.endsWith('/v1/storage/objects')
        ? Response.json({
            object: { id: 'obj_1', state: 'uploading' },
            part_size: spec.source.bytes.byteLength,
            part_count: 1,
            parts: [
              {
                part_number: 1,
                url: 'https://attacker.invalid/obj_1',
                size_bytes: spec.source.bytes.byteLength,
                headers: {},
              },
            ],
          })
        : Response.json({}),
    [bucket],
  );
  await assert.rejects(elsewhere.runner.start(connection.projectId, spec), {
    code: 'sandbox_origin_refused',
  });
  assert.equal(
    elsewhere.calls.filter((call) => call.method === 'PUT').length,
    0,
    'nothing is sent anywhere the operator did not name',
  );
  // A deployment that named no storage origin can upload nowhere at all, and plain HTTP is
  // refused even when the origin is named: the signature in the URL is the whole authority.
  await assert.rejects(
    new SandboxClient('https://sandbox.invalid', 15_000, []).upload(
      `${bucket}/o`,
      {},
      new Uint8Array(1),
    ),
    { code: 'sandbox_origin_refused' },
  );
  await assert.rejects(
    new SandboxClient('https://sandbox.invalid', 15_000, ['http://bucket.invalid']).upload(
      'http://bucket.invalid/o',
      {},
      new Uint8Array(1),
    ),
    { code: 'sandbox_origin_refused' },
  );
});

test('a part list that does not cover the source in one page is refused, never paginated', async (t) => {
  // The service says it wants three parts, offered one page that covers none of them, and
  // has none stored; paging for the rest needs a query string the route allowlist refuses.
  const { calls, runner } = transport(t, (call) =>
    call.url.endsWith('/v1/storage/objects')
      ? Response.json({
          object: { id: 'obj_1', state: 'uploading' },
          part_size: 4,
          part_count: 3,
          parts: [],
        })
      : new Response(null, { status: 200 }),
  );
  await assert.rejects(runner.start(connection.projectId, spec), { code: 'sandbox_unavailable' });
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
});

test('a part that runs past the end of the source is refused before anything is sent', async (t) => {
  const { calls, runner } = transport(t, (call) =>
    call.url.endsWith('/v1/storage/objects')
      ? upload(1, spec.source.bytes.byteLength + 1)
      : new Response(null, { status: 200 }),
  );
  await assert.rejects(runner.start(connection.projectId, spec), { code: 'sandbox_unavailable' });
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
});

test('a replay of a finished upload sends no bytes again and keeps the same object', async (t) => {
  // The crash this whole step is idempotent for: the object was uploaded and completed, the
  // handle was never written, and the next pass posts the same key. The service answers
  // about the object it already has — no parts at all — and that has to be a resume.
  const { calls, runner } = transport(t, (call) => {
    if (call.url.endsWith('/v1/storage/objects'))
      return Response.json({
        object: { id: 'obj_1', state: 'available' },
        part_size: spec.source.bytes.byteLength,
        part_count: 1,
        parts: [],
      });
    if (call.url.endsWith('/complete')) return Response.json({ id: 'obj_1', state: 'available' });
    return Response.json({ id: 'sbx_1' });
  });
  const handle = await runner.start(connection.projectId, spec);
  assert.equal(handle.objectId, 'obj_1');
  assert.equal(handle.sandboxId, 'sbx_1');
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, 'nothing is re-sent');
});

test('a resumed upload sends only the parts still owed, sliced by their own part number', async (t) => {
  const bytes = Buffer.from('0123456789abcdef');
  const partial: SandboxCheckSpec = { ...spec, source: { bytes, sha256: spec.source.sha256 } };
  const { calls, runner } = transport(t, (call) => {
    if (call.url.startsWith(bucket)) return new Response(null, { status: 200 });
    if (call.url.endsWith('/v1/storage/objects'))
      return Response.json({
        object: { id: 'obj_1', state: 'uploading' },
        part_size: 8,
        part_count: 2,
        completed_parts: [1],
        parts: [
          {
            part_number: 2,
            url: `${bucket}/obj_1/2?signature=abc`,
            size_bytes: 8,
            headers: { 'Content-Length': '8' },
          },
        ],
      });
    if (call.url.endsWith('/complete')) return Response.json({ id: 'obj_1', state: 'available' });
    return Response.json({ id: 'sbx_1' });
  });
  await runner.start(connection.projectId, partial);
  const puts = calls.filter((call) => call.method === 'PUT');
  assert.equal(puts.length, 1, 'the stored part is not sent again');
  assert.equal(
    await (puts[0].body as Blob).text(),
    '89abcdef',
    'and the part offered carries its own slice, not the head of the source',
  );
});
