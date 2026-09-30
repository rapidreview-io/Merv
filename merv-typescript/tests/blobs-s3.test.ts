import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    // Callers only read hashes they stored: an oversized stored object is corruption.
    await assert.rejects(blobs.get('project_1', hash), code('blob_corrupt'));
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
  server.fail(undefined);
  const misconfigured = new S3Blobs({
    bucket: 'missing-bucket',
    endpoint: server.endpoint,
    ...credentials,
    allowHttpLoopbackForTests: true,
    maxAttempts: 1,
  });
  t.after(() => misconfigured.close());
  await assert.rejects(
    misconfigured.get('project_1', hash),
    code('blob_unavailable'),
    'A missing bucket is misconfiguration, not a missing blob',
  );
  server.fail(409);
  const conflict = server.requests.length;
  await assert.rejects(blobs.put('project_1', content), code('blob_unavailable'));
  assert.equal(server.requests.length - conflict, 2, 'A conditional-write conflict is retried');
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

test('Disk reports I/O failures as unavailable storage without leaking paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'merv-disk-failures-'));
  const blobs = new DiskBlobs(root);
  t.after(async () => {
    await blobs.close();
    await chmod(join(root, 'project_1'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(blobs.get('project_1', hash), code('blob_not_found'));
  await blobs.put('project_1', content);
  // A blob path that is a directory fails to read with EISDIR, not ENOENT.
  const other = createHash('sha256').update('other').digest('hex');
  await mkdir(join(root, 'project_1', other.slice(0, 2), other), { recursive: true });
  const unavailable = (error: unknown) => {
    assert.ok(error instanceof MervError);
    assert.equal(error.code, 'blob_unavailable');
    assert.equal(error.status, 503);
    assert.doesNotMatch(String(error), new RegExp(root));
    return true;
  };
  await assert.rejects(blobs.get('project_1', other), unavailable);
  if (process.getuid?.() !== 0) {
    await chmod(join(root, 'project_1'), 0o500);
    await assert.rejects(blobs.put('project_1', Buffer.from('new bytes')), unavailable);
  }
});

test('S3 large downloads sign one immutable key for sixty minutes with attachment and no-store', async (t) => {
  const { blobs, server } = await fixture(t);
  const bytes = Buffer.alloc(2_000_001, 97);
  const keyHash = createHash('sha256').update(bytes).digest('hex');
  server.objects.set(`evidence/v1/project_1/${keyHash}`, bytes);
  await assert.rejects(blobs.get('project_1', keyHash), code('blob_corrupt'));
  const before = Date.now();
  const link = await blobs.download('project_1', keyHash, bytes.length);
  const url = new URL(link.url);
  assert.equal(url.pathname, `/merv-artifacts/evidence/v1/project_1/${keyHash}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
  assert.ok(
    Date.parse(link.expiresAt) >= before + 3_599_000 &&
      Date.parse(link.expiresAt) <= Date.now() + 3_600_000,
  );
  assert.equal(server.requests.at(-1)!.method, 'HEAD');
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-disposition'),
    `attachment; filename="${keyHash}"; filename*=UTF-8''${keyHash}`,
  );
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
  await assert.rejects(
    blobs.download('../other', keyHash, bytes.length),
    code('invalid_namespace'),
  );
  await assert.rejects(
    blobs.download('project_1', 'f'.repeat(64), bytes.length),
    code('blob_not_found'),
    'A missing object is not a storage outage',
  );
});

test('S3 downloads are saved under the name asked for, with an ASCII fallback', async (t) => {
  const { blobs, server } = await fixture(t);
  server.objects.set(`evidence/v1/project_1/${hash}`, content);
  const link = await blobs.download('project_1', hash, content.length, 'Résumé "v2" (100%)*.pdf');
  assert.equal(
    (await fetch(link.url)).headers.get('content-disposition'),
    `attachment; filename="R_sum_ _v2_ (100_)*.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22v2%22%20%28100%25%29%2A.pdf`,
  );
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

test('S3 signs one write-once PUT for exactly the declared bytes, and stored reads their size', async (t) => {
  const { blobs, server } = await fixture(t);
  const bytes = Buffer.alloc(2_000_001, 98);
  const bytesHash = createHash('sha256').update(bytes).digest('hex');
  const key = `evidence/v1/project_1/${bytesHash}`;
  assert.equal(await blobs.stored('project_1', bytesHash), null);
  const before = Date.now();
  const count = server.requests.length;
  const signed = await blobs.upload('project_1', bytesHash, bytes.length);
  assert.equal(server.requests.length, count, 'signing is local');
  const url = new URL(signed.url);
  assert.equal(url.pathname, `/merv-artifacts/${key}`);
  assert.equal(
    url.searchParams.get('X-Amz-SignedHeaders'),
    'content-length;host;if-none-match;x-amz-checksum-sha256',
  );
  assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
  assert.ok(
    Date.parse(signed.expiresAt) >= before + 3_599_000 &&
      Date.parse(signed.expiresAt) <= Date.now() + 3_600_000,
  );
  const checksum = createHash('sha256').update(bytes).digest('base64');
  assert.deepEqual(signed.headers, { 'x-amz-checksum-sha256': checksum, 'if-none-match': '*' });
  assert.ok(![...url.searchParams.keys()].some((name) => /checksum/i.test(name)));
  const put = (body: Buffer, headers: Record<string, string> = signed.headers) =>
    fetch(signed.url, { method: 'PUT', body: new Uint8Array(body), headers });
  // Every signed header is required, and the store checks the body against the checksum.
  assert.equal((await put(bytes, { 'x-amz-checksum-sha256': checksum })).status, 403);
  assert.equal((await put(bytes, { 'if-none-match': '*' })).status, 403);
  assert.equal((await put(Buffer.alloc(bytes.length, 99))).status, 400);
  assert.equal((await put(bytes.subarray(1))).status, 403, 'another length breaks the signature');
  assert.equal(server.objects.has(key), false);
  assert.equal((await put(bytes)).status, 200);
  assert.deepEqual(server.objects.get(key), bytes);
  assert.equal(await blobs.stored('project_1', bytesHash), bytes.length);
  assert.equal((await put(bytes)).status, 412, 'a stored object is never overwritten');
  // Another size at the key is reported as it is, for the caller to judge.
  server.objects.set(key, Buffer.from('short'));
  assert.equal(await blobs.stored('project_1', bytesHash), 5);
  await assert.rejects(
    blobs.upload('project_1', bytesHash, 512 * 1024 * 1024 + 1),
    code('blob_size'),
  );
  await assert.rejects(blobs.upload('project_1', '../hash', 1), code('invalid_hash'));
  await assert.rejects(blobs.stored('../other', bytesHash), code('invalid_namespace'));
  server.fail(503);
  await assert.rejects(blobs.stored('project_1', bytesHash), code('blob_unavailable'));
  server.fail(undefined);
  await blobs.close();
  await assert.rejects(blobs.upload('project_1', bytesHash, bytes.length), code('blobs_closed'));
  await assert.rejects(blobs.stored('project_1', bytesHash), code('blobs_closed'));
});

test('S3 downloads serve the stored bytes unencoded whatever encoding they were uploaded with', async (t) => {
  const { blobs, server } = await fixture(t);
  const signed = await blobs.upload('project_1', hash, content.length);
  const uploaded = await fetch(signed.url, {
    method: 'PUT',
    body: new Uint8Array(content),
    headers: { ...signed.headers, 'content-encoding': 'gzip' },
  });
  assert.equal(uploaded.status, 200, 'an unsigned header is not refused');
  const link = new URL((await blobs.download('project_1', hash, content.length)).url);
  assert.equal(link.searchParams.get('response-content-encoding'), 'identity');
  const response = await fetch(link);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'identity');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  assert.equal(server.requests.at(-1)!.query['response-content-encoding'], 'identity');
});
