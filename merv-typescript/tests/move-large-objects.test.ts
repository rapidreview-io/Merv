/** Temporary, with scripts/move-large-objects.ts: deleted once the sandbox copies are retired. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { S3Blobs } from '@merv/blobs';
import type { LargeArtifactStorage } from '@merv/contracts';
import { copy, probe } from '../scripts/move-large-objects.js';
import { s3Server } from './fixtures/s3-server.js';

async function fixture(t: TestContext) {
  const server = await s3Server();
  const blobs = new S3Blobs({
    bucket: 'merv-artifacts',
    endpoint: server.endpoint,
    accessKeyId: 'fixture-access-key',
    secretAccessKey: 'fixture-secret-key',
    prefix: 'merv-ts',
    allowHttpLoopbackForTests: true,
    maxAttempts: 1,
  });
  const lines: Record<string, unknown>[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(JSON.parse(line));
  t.after(async () => {
    console.log = log;
    await blobs.close();
    await server.close();
  });
  return { server, blobs, lines };
}

test('the probe passes on a store that enforces signed uploads', async (t) => {
  const { server, blobs, lines } = await fixture(t);
  assert.equal(await probe(blobs), true);
  assert.deepEqual(
    lines.map((line) => [line.probe, line.passed ?? line.status]),
    [
      ['P1 other bytes', true],
      ['P2 no checksum', true],
      ['P3 no if-none-match', true],
      ['P4 other length', true],
      ['P5 unsigned encoding', true],
      ['P6 identity', true],
      ['P7 write once', true],
      ['P8 no overwrite', true],
      ['unsigned storage class', 200],
    ],
  );
  assert.ok([...server.objects.keys()].every((key) => key.startsWith('merv-ts/_probe/')));
});

test('a check that fails or throws is reported and the probe carries on', async (t) => {
  const { blobs, lines } = await fixture(t);
  // A store that refuses an unsigned Content-Encoding; one download then fails outright.
  const real = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === 'PUT' && headers.has('content-encoding'))
      return new Response(null, { status: 403 });
    if (init?.method !== 'PUT' && String(input).includes('_probe') && ++downloads === 1)
      throw new Error('connection reset');
    return real(input, init);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  assert.equal(await probe(blobs), false);
  assert.deepEqual(
    lines.map((line) => [line.probe, line.passed ?? line.status, line.error]),
    [
      ['P1 other bytes', true, undefined],
      ['P2 no checksum', true, undefined],
      ['P3 no if-none-match', true, undefined],
      ['P4 other length', true, undefined],
      ['P5 unsigned encoding', false, undefined],
      ['P6 identity', false, 'Error: connection reset'],
      ['P7 write once', true, undefined],
      ['P8 no overwrite', true, undefined],
      ['unsigned storage class', 200, undefined],
    ],
  );
});

test('copy stores a row, skips a stored one and reports a corrupt read as a failure', async (t) => {
  const { server, blobs, lines } = await fixture(t);
  const bytes = (fill: number) => Buffer.alloc(2_000_001, fill);
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const [fresh, stored, corrupt] = [bytes(1), bytes(2), bytes(3)];
  server.objects.set(`merv-ts/project_1/${hash(stored)}`, stored);
  const objects: Record<string, Buffer> = {
    obj_fresh: fresh,
    obj_stored: stored,
    obj_corrupt: Buffer.from(corrupt).fill(4, 0, 1),
  };
  const reads: string[] = [];
  const storage: Pick<LargeArtifactStorage, 'read'> = {
    async read(_projectId, objectId) {
      reads.push(objectId);
      return objects[objectId]!;
    },
  };
  const row = (objectId: string, value: Buffer) => ({
    project_id: 'project_1',
    object_id: objectId,
    hash: hash(value),
    size: String(value.length),
  });
  const rows = [row('obj_fresh', fresh), row('obj_stored', stored), row('obj_corrupt', corrupt)];
  assert.equal(await copy(blobs, () => storage, rows), false);
  assert.deepEqual(
    lines.map((line) => [line.objectId, line.result]),
    [
      ['obj_fresh', 'copied'],
      ['obj_stored', 'skipped'],
      ['obj_corrupt', 'failed'],
    ],
  );
  assert.deepEqual(reads, ['obj_fresh', 'obj_corrupt']);
  assert.deepEqual(server.objects.get(`merv-ts/project_1/${hash(fresh)}`), fresh);
  assert.equal(server.objects.has(`merv-ts/project_1/${hash(corrupt)}`), false);
  // A second run finds the copied row stored and reads nothing again.
  lines.length = 0;
  assert.equal(await copy(blobs, () => storage, rows.slice(0, 2)), true);
  assert.deepEqual(
    lines.map((line) => line.result),
    ['skipped', 'skipped'],
  );
  assert.deepEqual(reads, ['obj_fresh', 'obj_corrupt']);
});
