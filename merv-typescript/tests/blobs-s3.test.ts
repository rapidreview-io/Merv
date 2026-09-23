import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskBlobs, S3Blobs, blobsPlugin } from '@merv/blobs';
import { MervError } from '@merv/contracts';
import { s3Server } from './fixtures/s3-server.js';

const content = Buffer.from('Retained immutable evidence.');
const hash = createHash('sha256').update(content).digest('hex');
const credentials = { accessKeyId: 'fixture-access-key', secretAccessKey: 'fixture-secret-key' };
const code = (expected: string) => (error: unknown) =>
  error instanceof MervError && error.code === expected;

async function fixture(t: TestContext, options: { timeoutMs?: number; maxAttempts?: number } = {}) {
  const server = await s3Server();
  const blobs = new S3Blobs({
    bucket: 'merv-artifacts',
    endpoint: server.endpoint,
    ...credentials,
    prefix: 'evidence/v1',
    allowHttpLoopbackForTests: true,
    timeoutMs: 2000,
    maxAttempts: 1,
    ...options,
  });
  t.after(async () => {
    await blobs.close();
    await server.close();
  });
  return { blobs, server };
}

test('S3 uses signed conditional writes, keeps legacy project/hash keys and verifies duplicate content', async (t) => {
  const { blobs, server } = await fixture(t);
  const first = await blobs.put('project_1', content);
  assert.deepEqual(first, { hash, size: content.byteLength });
  assert.deepEqual(await blobs.get('project_1', hash), content);
  assert.deepEqual(await blobs.put('project_1', content), first);
  assert.equal(server.objects.size, 1);
  assert.deepEqual(
    server.requests.map((r) => r.method),
    ['PUT', 'GET', 'PUT', 'GET'],
  );
  for (const request of server.requests) {
    assert.equal(request.key, `evidence/v1/project_1/${hash}`);
    assert.match(
      request.headers.authorization!,
      /^AWS4-HMAC-SHA256 Credential=fixture-access-key\/\d{8}\/auto\/s3\/aws4_request,/,
    );
    assert.doesNotMatch(JSON.stringify(request.headers), /fixture-secret-key/);
  }
  assert.equal(server.requests[0]!.headers['if-none-match'], '*');
  assert.equal(
    server.requests[0]!.headers['content-md5'],
    createHash('md5').update(content).digest('base64'),
  );
  assert.deepEqual(server.requests[0]!.body, content);
});

test('S3 refuses corrupt reads and corrupt existing objects without overwriting them', async (t) => {
  const { blobs, server } = await fixture(t);
  const key = `evidence/v1/project_1/${hash}`;
  server.objects.set(key, Buffer.from('corrupted'));
  await assert.rejects(blobs.get('project_1', hash), code('blob_corrupt'));
  await assert.rejects(blobs.put('project_1', content), code('blob_corrupt'));
  assert.equal(server.objects.get(key)!.toString(), 'corrupted');
});

test('S3 bounds declared and streamed reads and validates keys before networking', async (t) => {
  const { blobs, server } = await fixture(t);
  for (const chunked of [false, true]) {
    server.overrideRead({ body: Buffer.alloc(2_000_001), chunked });
    await assert.rejects(blobs.get('project_1', hash), code('blob_size'));
  }
  const count = server.requests.length;
  await assert.rejects(blobs.get('../other', hash), code('invalid_namespace'));
  await assert.rejects(blobs.get('project_1', '../hash'), code('invalid_hash'));
  await assert.rejects(blobs.put('project_1', Buffer.alloc(2_000_001)), code('blob_size'));
  assert.equal(server.requests.length, count);
});

test('S3 reports sanitized errors, missing objects and bounded retries', async (t) => {
  const { blobs, server } = await fixture(t, { timeoutMs: 5000, maxAttempts: 2 });
  await assert.rejects(blobs.get('project_1', hash), code('blob_not_found'));
  server.fail(503);
  const start = server.requests.length;
  await assert.rejects(blobs.put('project_1', content), (error: unknown) => {
    assert.ok(error instanceof MervError);
    assert.equal(error.code, 'blob_unavailable');
    assert.doesNotMatch(
      String(error),
      /provider-private-detail|fixture-secret-key|fixture-access-key/,
    );
    return true;
  });
  assert.equal(server.requests.length - start, 2);
  server.fail(403);
  await assert.rejects(blobs.get('project_1', hash), code('blob_unavailable'));
});

test('S3 teardown rejects new operations and drains an admitted write', async (t) => {
  const { blobs, server } = await fixture(t);
  const held = server.holdNext('PUT');
  const pending = blobs.put('project_1', content);
  await held.started;
  let closed = false;
  const closing = blobs.close().then(() => {
    closed = true;
  });
  await assert.rejects(blobs.get('project_1', hash), code('blobs_closed'));
  await assert.rejects(blobs.put('project_1', content), code('blobs_closed'));
  assert.equal(closed, false);
  held.release();
  assert.deepEqual(await pending, { hash, size: content.byteLength });
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(server.objects.get(`evidence/v1/project_1/${hash}`), content);
});

test('S3 timeout covers both waiting for headers and a stalled response body', async (t) => {
  const { blobs, server } = await fixture(t, { timeoutMs: 80 });
  const held = server.holdNext('PUT');
  await assert.rejects(blobs.put('project_1', content), code('blob_unavailable'));
  held.release();
  server.overrideRead({ body: content, stall: true });
  await assert.rejects(blobs.get('project_1', hash), code('blob_unavailable'));
  await blobs.close();
});

test('S3 timeout interrupts retry backoff before another request', async (t) => {
  const { blobs, server } = await fixture(t, { timeoutMs: 80, maxAttempts: 5 });
  server.fail(503);
  await assert.rejects(blobs.put('project_1', content), code('blob_unavailable'));
  assert.equal(server.requests.length, 1);
  await blobs.close();
});

test('S3 configuration keeps credentials in named environment variables and requires HTTPS', () => {
  const config = blobsPlugin.Config.parse({ backend: 's3' });
  assert.equal(config.backend, 's3');
  if (config.backend !== 's3') assert.fail('wrong config');
  assert.equal(config.accessKeyIdEnv, 'MERV_BLOB_ACCESS_KEY_ID');
  assert.equal(config.secretAccessKeyEnv, 'MERV_BLOB_SECRET_ACCESS_KEY');
  assert.equal(
    blobsPlugin.Config.safeParse({ backend: 's3', secretAccessKey: 'unsafe' }).success,
    false,
  );
  assert.equal(
    blobsPlugin.Config.safeParse({ backend: 's3', allowHttpLoopbackForTests: true }).success,
    false,
  );
  assert.deepEqual(blobsPlugin.Config.parse({ root: '/tmp/blobs' }), { root: '/tmp/blobs' });
  for (const endpoint of [
    'http://127.0.0.1',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com?secret=value',
  ])
    assert.throws(
      () => new S3Blobs({ bucket: 'merv-artifacts', endpoint, ...credentials }),
      code('invalid_blob_config'),
    );
  assert.throws(
    () =>
      new S3Blobs({
        bucket: 'merv-artifacts',
        endpoint: 'http://example.com',
        ...credentials,
        allowHttpLoopbackForTests: true,
      }),
    code('invalid_blob_config'),
  );
  assert.throws(
    () =>
      new S3Blobs({
        bucket: 'merv-artifacts',
        endpoint: 'https://example.com',
        ...credentials,
        prefix: '../unsafe',
      }),
    code('invalid_blob_config'),
  );
});

test('async Disk preserves atomic immutable writes, integrity and clean temporary files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'merv-async-blobs-'));
  const blobs = new DiskBlobs(root);
  t.after(async () => {
    await blobs.close();
    await rm(root, { recursive: true, force: true });
  });
  const writes = await Promise.all(
    Array.from({ length: 4 }, () => blobs.put('project_1', content)),
  );
  for (const stored of writes) assert.deepEqual(stored, { hash, size: content.byteLength });
  assert.deepEqual(await blobs.get('project_1', hash), content);
  const path = join(root, 'project_1', hash.slice(0, 2), hash);
  assert.deepEqual(await readFile(path), content);
  assert.deepEqual(await readdir(join(root, 'project_1', hash.slice(0, 2))), [hash]);
  await writeFile(path, 'corrupt');
  await assert.rejects(blobs.get('project_1', hash), code('blob_corrupt'));
  await assert.rejects(blobs.put('project_1', content), code('blob_corrupt'));
  await blobs.close();
  await assert.rejects(blobs.get('project_1', hash), code('blobs_closed'));
});

test('S3 large downloads sign one immutable key for sixty seconds with attachment and no-store', async (t) => {
  const { blobs, server } = await fixture(t);
  const bytes = Buffer.alloc(2_000_001, 97);
  const keyHash = createHash('sha256').update(bytes).digest('hex');
  server.objects.set(`evidence/v1/project_1/${keyHash}`, bytes);
  await assert.rejects(blobs.get('project_1', keyHash), code('blob_size'));
  const before = Date.now();
  const link = await blobs.download('project_1', keyHash, bytes.length);
  const url = new URL(link.url);
  assert.equal(url.pathname, `/merv-artifacts/evidence/v1/project_1/${keyHash}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
  assert.ok(
    Date.parse(link.expiresAt) >= before + 59_000 &&
      Date.parse(link.expiresAt) <= Date.now() + 60_000,
  );
  assert.equal(server.requests.at(-1)!.method, 'HEAD');
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${keyHash}"`);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  url.pathname = url.pathname.replace('/project_1/', '/project_2/');
  assert.equal(
    (await fetch(url)).status,
    403,
    'The signature cannot be reused for another project',
  );
  await assert.rejects(
    blobs.download('project_1', keyHash, bytes.length - 1),
    code('blob_corrupt'),
  );
  assert.throws(() => blobs.download('../other', keyHash, bytes.length), code('invalid_namespace'));
});

test('S3 downloads a retained zero-byte object after checking its exact HEAD length', async (t) => {
  const { blobs, server } = await fixture(t);
  const empty = Buffer.alloc(0);
  const emptyHash = createHash('sha256').update(empty).digest('hex');
  server.objects.set(`evidence/v1/project_1/${emptyHash}`, empty);
  const link = await blobs.download('project_1', emptyHash, 0);
  const response = await fetch(link.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '0');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  await assert.rejects(blobs.download('project_1', emptyHash, 1), code('blob_corrupt'));
});
