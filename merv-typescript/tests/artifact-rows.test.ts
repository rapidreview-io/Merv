import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { createService, MervError, now, sha256Hex, type Blobs, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openState } from './fixtures/state.js';

/**
 * Artifacts over disk blobs whose put and get are counted and may be delayed or refused, and which
 * sign uploads and downloads: a test stores an upload's bytes itself, as the signed PUT would.
 */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-rows-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const disk = new DiskBlobs(join(directory, 'blobs'));
  const file = (namespace: string, hash: string) =>
    join(directory, 'blobs', namespace, hash.slice(0, 2), hash);
  const signed = (namespace: string, hash: string) => `https://storage.test/${namespace}/${hash}`;
  const blobs = { calls: [] as string[], before: async () => {} };
  const counted: Blobs = {
    async put(namespace, bytes) {
      blobs.calls.push('put');
      await blobs.before();
      return await disk.put(namespace, bytes);
    },
    async get(namespace, hash) {
      blobs.calls.push('get');
      await blobs.before();
      return await disk.get(namespace, hash);
    },
    stored: async (namespace, hash) =>
      (await stat(file(namespace, hash)).catch(() => undefined))?.size ?? null,
    upload: async (namespace, hash) => ({
      url: signed(namespace, hash),
      headers: {},
      expiresAt: now(),
    }),
    download: async (namespace, hash) => ({ url: signed(namespace, hash), expiresAt: now() }),
  };
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(new ArtifactStore(state, scope, counted));
  const boot = await scope.credentials.bootstrap({ projectName: 'Rows', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const content = async (id: string) =>
    (
      await state.read((sql) =>
        sql.get<{ content: Buffer | null }>('SELECT content FROM artifacts WHERE id=?', id),
      )
    )?.content;
  /** Begins an upload of `bytes` as `caller` and stores them where the signed PUT would. */
  const upload = async (bytes: Buffer, store = artifacts, as = caller) => {
    const sha256 = sha256Hex(bytes);
    const { uploadId } = await store.uploadBegin(as, {
      title: 'Object',
      size: bytes.length,
      sha256,
      mediaType: 'text/plain',
    });
    await mkdir(dirname(file(as.projectId, sha256)), { recursive: true });
    await writeFile(file(as.projectId, sha256), bytes);
    return uploadId;
  };
  return {
    directory,
    state,
    disk,
    blobs,
    counted,
    scope,
    artifacts,
    caller,
    content,
    file,
    upload,
  };
}

const outage = async () => {
  throw new MervError('blob_unavailable', 'Blob storage is down', 503);
};

test('a rolled-back create leaves no row and no bytes, and an ambient create joins its transaction', async (t) => {
  const f = await fixture(t);
  const rollback = new Error('rollback');
  let explicit = '';
  await assert.rejects(
    f.state.transaction(async (tx) => {
      explicit = (await f.artifacts.create(f.caller, { title: 'Undone', content: 'a' }, tx)).id;
      throw rollback;
    }),
    rollback,
  );
  let ambient = '';
  await assert.rejects(
    f.state.transaction(async () => {
      ambient = (await f.artifacts.create(f.caller, { title: 'Joined', content: 'b' })).id;
      // The caller's transaction sees its own uncommitted artifact.
      assert.equal((await f.artifacts.read(f.caller, ambient)).content, 'b');
      throw rollback;
    }),
    rollback,
  );
  for (const id of [explicit, ambient])
    await assert.rejects(f.artifacts.get(f.caller, id), { code: 'not_found' });
  assert.deepEqual(await f.artifacts.list(f.caller), []);
  assert.deepEqual(f.blobs.calls, []);
});

test('corrupt bytes or an outage at completion fail it and record no artifact; a retry completes', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('declared');
  const uploadId = await f.upload(bytes);
  const file = f.file(f.caller.projectId, sha256Hex(bytes));
  await writeFile(file, 'replaced');
  await assert.rejects(f.artifacts.uploadComplete(f.caller, uploadId), {
    code: 'blob_corrupt',
    status: 500,
  });
  await unlink(file);
  await assert.rejects(f.artifacts.uploadComplete(f.caller, uploadId), {
    code: 'upload_pending',
    status: 409,
  });
  await writeFile(file, bytes);
  f.blobs.before = outage;
  await assert.rejects(f.artifacts.uploadComplete(f.caller, uploadId), {
    code: 'blob_unavailable',
    status: 503,
  });
  assert.deepEqual(await f.artifacts.list(f.caller), []);
  f.blobs.before = async () => {};
  const artifact = await f.artifacts.uploadComplete(f.caller, uploadId);
  assert.equal((await f.content(artifact.id))?.toString(), 'declared');
});
