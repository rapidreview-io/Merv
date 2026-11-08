import { DiskBlobs, S3Blobs } from '@merv/blobs';
import { MervError } from '@merv/contracts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
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

test('S3 refuses corrupt reads and corrupt existing objects without overwriting them', async (t) => {
  const { blobs, server } = await fixture(t);
  const key = `evidence/v1/project_1/${hash}`;
  server.objects.set(key, Buffer.from('corrupted'));
  await assert.rejects(blobs.get('project_1', hash), code('blob_corrupt'));
  await assert.rejects(blobs.put('project_1', content), code('blob_corrupt'));
  assert.equal(server.objects.get(key)!.toString(), 'corrupted');
  // A same-size object with other bytes is just as corrupt.
  const sameSize = Buffer.alloc(content.byteLength, 1);
  server.objects.set(key, sameSize);
  await assert.rejects(blobs.put('project_1', content), code('blob_corrupt'));
  assert.deepEqual(server.objects.get(key), sameSize);
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

test('S3 timeout covers both waiting for headers and a stalled response body', async (t) => {
  const { blobs, server } = await fixture(t, { timeoutMs: 80 });
  const held = server.holdNext('PUT');
  await assert.rejects(blobs.put('project_1', content), code('blob_unavailable'));
  held.release();
  server.overrideRead({ body: content, stall: true });
  await assert.rejects(blobs.get('project_1', hash), code('blob_unavailable'));
  await blobs.close();
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
  await writeFile(path, Buffer.alloc(content.byteLength, 1));
  await assert.rejects(blobs.put('project_1', content), code('blob_corrupt'));
  await blobs.close();
  await assert.rejects(blobs.get('project_1', hash), code('blobs_closed'));
});
