import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MervError, type Caller, type LargeArtifactStorage } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { stateConfig } from './fixtures/state.js';
import { legacyArtifact } from './fixtures/legacy-artifact.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-bytes-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Bytes', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  return { app, caller, directory };
}

test('bytes gone from behind an existing row are a server fault, not a missing artifact', async (t) => {
  const { app, caller, directory } = await fixture(t);
  // A row from before bytes were kept in it: its bytes are in blobs.
  const artifact = await legacyArtifact(app.ctx.state, caller, Buffer.from('kept'), (bytes) =>
    app.ctx.blobs.put(caller.projectId, bytes),
  );
  await unlink(
    join(directory, 'blobs', caller.projectId, artifact.hash.slice(0, 2), artifact.hash),
  );
  assert.equal((await app.ctx.artifacts.get(caller, artifact.id)).id, artifact.id);
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'artifact_bytes_missing',
    status: 500,
  });
  await assert.rejects(app.ctx.artifacts.read(caller, 'art_unknown'), { code: 'not_found' });
});

test('large-storage bytes are read through the adapter, bounded and verified', async (t) => {
  const { app, caller } = await fixture(t);
  const bytes = Buffer.from('ten bytes!');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let served: () => Promise<Buffer> = async () => bytes;
  let signed: () => Promise<{ url: string; expiresAt: string }> = async () => ({
    url: 'https://bucket.example/object',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const asked: number[] = [];
  const storage: LargeArtifactStorage = {
    async begin() {
      return {
        objectId: 'obj_bytes',
        plan: { partSize: 10, partCount: 1, parts: [], completedParts: [1], nextPart: null },
      };
    },
    async resume() {
      throw new Error('unused');
    },
    async complete() {
      return { objectId: 'obj_bytes', size: bytes.length, sha256, state: 'available' };
    },
    async download() {
      return await signed();
    },
    async read(_projectId, _objectId, maxBytes) {
      asked.push(maxBytes);
      return await served();
    },
  };
  const unbind = app.ctx.artifacts.bindLarge(storage);
  t.after(unbind);
  const begun = await app.ctx.artifacts.uploadBegin(caller, {
    title: 'Object',
    size: bytes.length,
    sha256,
    mediaType: 'text/plain',
  });
  assert.equal(begun.uploadId.startsWith('aup_'), true);
  // An outage at completion leaves the bytes only in the object, so every read reaches it.
  served = async () => {
    throw new MervError('blob_unavailable', 'Stored object is unreachable', 503);
  };
  const artifact = await app.ctx.artifacts.uploadComplete(caller, begun.uploadId);
  served = async () => bytes;
  assert.equal((await app.ctx.artifacts.read(caller, artifact.id)).content, 'ten bytes!');
  // The adapter is asked for exactly the declared size, and returns at most one byte more.
  assert.deepEqual(asked, [bytes.length, bytes.length]);

  served = async () => Buffer.from('ten bytes!!');
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'blob_corrupt',
    status: 500,
  });
  served = async () => Buffer.from('ten bytes?');
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), { code: 'blob_corrupt' });
  served = async () => {
    throw new MervError('blob_not_found', 'Stored object not found', 404);
  };
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'artifact_bytes_missing',
    status: 500,
  });
  served = async () => {
    throw new MervError('blob_unavailable', 'Stored object is unreachable', 503);
  };
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'blob_unavailable',
    status: 503,
  });
  served = async () => {
    throw new MervError('sandbox_forbidden', 'Refused', 403);
  };
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), { code: 'sandbox_forbidden' });

  assert.equal(
    (await app.ctx.artifacts.download(caller, artifact.id)).download.url,
    'https://bucket.example/object',
  );
  signed = async () => {
    throw new MervError('blob_not_found', 'Stored object not found', 404);
  };
  await assert.rejects(app.ctx.artifacts.download(caller, artifact.id), {
    code: 'artifact_bytes_missing',
    status: 500,
  });

  unbind();
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'storage_unavailable',
    status: 503,
  });
});
