import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from './history.mjs';
import { download, stageObjects } from './blobs.mjs';
test('selected object transfer downloads and hashes bytes, never overwrites or writes outside prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-objects-')),
    bytes = Buffer.from('immutable evidence'),
    digest = hash(bytes),
    store = new Map(),
    calls = [];
  const client = {
    send: async (command) => {
      calls.push(command);
      const x = command.input;
      if (command.constructor.name === 'GetObjectCommand') {
        if (!store.has(x.Key)) {
          const e = Error();
          e.name = 'NoSuchKey';
          throw e;
        }
        return { Body: { transformToByteArray: async () => store.get(x.Key) } };
      }
      assert.equal(command.constructor.name, 'PutObjectCommand');
      assert.equal(x.IfNoneMatch, '*');
      store.set(x.Key, x.Body);
      return {};
    },
  };
  try {
    writeFileSync(join(dir, digest), bytes);
    const file = {
      id: 'f',
      namespace: 'n',
      sha256: digest,
      size: bytes.length,
      objectKey: `staging-native/history/n/f/${digest}`,
    };
    const body = { files: [file] },
      bundle = { ...body, sha256: hash(body) };
    await stageObjects(client, 'isolated', bundle, dir);
    await stageObjects(client, 'isolated', bundle, dir);
    assert.equal(calls.filter((c) => c.constructor.name === 'PutObjectCommand').length, 1);
    store.set(file.objectKey, Buffer.from('corrupt'));
    await assert.rejects(stageObjects(client, 'isolated', bundle, dir), /digest/);
    const unsafe = { files: [{ ...file, objectKey: 'customer/data' }] };
    await assert.rejects(
      stageObjects(client, 'isolated', { ...unsafe, sha256: hash(unsafe) }, dir),
      /escaped/,
    );
    assert.equal(calls.filter((c) => c.constructor.name === 'PutObjectCommand').length, 1);
    await assert.rejects(
      download(
        {
          send: async () => {
            throw Object.assign(Error(), { name: 'AccessDenied' });
          },
        },
        'b',
        'k',
        file,
      ),
      { name: 'AccessDenied' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dedicated bucket credential boundary rejects broad keys and temporary target assumptions', async () => {
  const { verifyBucketBoundary } = await import('./blobs.mjs');
  const client = {
    send: async (command) => {
      if (command.input.Bucket === 'customer') throw { $metadata: { httpStatusCode: 403 } };
      return {};
    },
  };
  assert.deepEqual(await verifyBucketBoundary(client, 'staging-only', ['customer']), {
    bucket: 'staging-only',
    sourceBucketsDenied: ['customer'],
  });
  await assert.rejects(
    verifyBucketBoundary({ send: async () => ({}) }, 'staging-only', ['customer']),
    /can access/,
  );
  await assert.rejects(verifyBucketBoundary(client, 'customer', ['customer']), /dedicated/);
  await assert.rejects(
    verifyBucketBoundary(
      {
        send: async () => {
          throw { $metadata: { httpStatusCode: 404 } };
        },
      },
      'staging-only',
      ['customer'],
    ),
  );
});
