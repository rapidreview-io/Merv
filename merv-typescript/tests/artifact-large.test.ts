import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Artifact, LargeArtifactStorage } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { stateConfig } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

async function largeApp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-large-artifact-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
        { id: 'tools', name: '@merv/api/tools-plugin' },
        { id: 'artifact-tools', name: '@merv/artifacts/tools' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return app;
}

test('large artifact upload, replay, download and absent storage keep inline artifacts working', async (t) => {
  const app = await largeApp(t);
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Research', actorName: 'Owner' });
  const owner = { actorId: boot.actor.id, projectId: boot.project.id };
  const small = await app.ctx.artifacts.create(owner, { title: 'Note', content: 'still here' });
  assert.equal((await app.ctx.artifacts.read(owner, small.id)).content, 'still here');
  assert.deepEqual(await app.ctx.tools.call('artifact.storage_status', owner, {}), {
    available: false,
  });
  const input = {
    title: 'Rows.csv',
    size: 8_000_000,
    sha256: 'a'.repeat(64),
    mediaType: 'text/csv',
    requestId: 'rows-one',
  };
  await assert.rejects(app.ctx.tools.call('artifact.upload_begin', owner, input), {
    code: 'storage_unavailable',
  });
  // Unbound storage is refused before any row or lock.
  assert.equal(
    (
      await app.ctx.state.read((sql) =>
        sql.get<{ count: number }>('SELECT count(*)::int AS count FROM artifact_uploads'),
      )
    )?.count,
    0,
  );

  const calls: string[] = [];
  let digest = input.sha256;
  const storage: LargeArtifactStorage = {
    async begin(projectId) {
      calls.push(`begin:${projectId}`);
      return {
        objectId: 'obj_rows',
        plan: {
          partSize: 8_000_000,
          partCount: 1,
          parts: [
            { partNumber: 1, size: 8_000_000, url: 'https://bucket.example/part', headers: {} },
          ],
          completedParts: [],
          nextPart: null,
          // A stray key from an adapter never replaces the upload ID artifacts chose.
          ...({ uploadId: 'aup_adapter' } as object),
        },
      };
    },
    async resume(_projectId, _objectId, startPart) {
      calls.push(`resume:${startPart}`);
      return {
        partSize: 8_000_000,
        partCount: 1,
        parts: [],
        completedParts: [1],
        nextPart: null,
        ...({ uploadId: 'aup_adapter' } as object),
      };
    },
    async complete() {
      calls.push('complete');
      return { objectId: 'obj_rows', size: input.size, sha256: digest, state: 'available' };
    },
    async download() {
      calls.push('download');
      return {
        url: 'https://bucket.example/file',
        expiresAt: new Date(Date.now() + 50_000).toISOString(),
      };
    },
    async read() {
      throw new Error('an object over the inline limit is never read inline');
    },
  };
  const unbind = app.ctx.artifacts.bindLarge(storage);
  t.after(unbind);
  assert.deepEqual(await app.ctx.tools.call('artifact.storage_status', owner, {}), {
    available: true,
  });
  assert.equal(
    (
      (await app.ctx.tools.call('artifact.get', owner, { artifactId: small.id })) as {
        downloadAvailable: boolean;
      }
    ).downloadAvailable,
    false,
  );
  const begin = (await app.ctx.tools.call('artifact.upload_begin', owner, input)) as {
    uploadId: string;
  };
  assert.notEqual(begin.uploadId, 'aup_adapter');
  assert.equal(
    ((await app.ctx.tools.call('artifact.upload_begin', owner, input)) as { uploadId: string })
      .uploadId,
    begin.uploadId,
  );
  const resumed = (await app.ctx.tools.call('artifact.upload_resume', owner, {
    uploadId: begin.uploadId,
  })) as { uploadId: string; completedParts: number[] };
  assert.equal(resumed.uploadId, begin.uploadId);
  assert.deepEqual(resumed.completedParts, [1]);
  digest = 'b'.repeat(64);
  await assert.rejects(
    app.ctx.tools.call('artifact.upload_complete', owner, { uploadId: begin.uploadId }),
    { code: 'upload_mismatch' },
  );
  digest = input.sha256;
  const artifact = (await app.ctx.tools.call('artifact.upload_complete', owner, {
    uploadId: begin.uploadId,
  })) as Artifact;
  assert.equal(artifact.objectId, 'obj_rows');
  assert.equal(artifact.hash, input.sha256);
  assert.equal(
    (
      (await app.ctx.tools.call('artifact.get', owner, { artifactId: artifact.id })) as {
        downloadAvailable: boolean;
      }
    ).downloadAvailable,
    true,
  );
  assert.equal(
    (
      (await app.ctx.tools.call('artifact.upload_complete', owner, {
        uploadId: begin.uploadId,
      })) as Artifact
    ).id,
    artifact.id,
  );
  assert.equal(calls.filter((entry) => entry === 'complete').length, 2);
  // After completion, begin and resume answer from the row with no storage call.
  const before = calls.length;
  const again = (await app.ctx.tools.call('artifact.upload_begin', owner, input)) as {
    uploadId: string;
    artifactId?: string;
    parts: unknown[];
    nextPart: number | null;
  };
  assert.deepEqual(
    [again.uploadId, again.artifactId, again.parts, again.nextPart],
    [begin.uploadId, artifact.id, [], null],
  );
  assert.equal(
    (
      (await app.ctx.tools.call('artifact.upload_resume', owner, {
        uploadId: begin.uploadId,
      })) as { artifactId?: string }
    ).artifactId,
    artifact.id,
  );
  assert.equal(calls.length, before);
  assert.equal(
    (await app.ctx.artifacts.list(owner)).filter((entry) => entry.id === artifact.id).length,
    1,
  );
  await assert.rejects(app.ctx.artifacts.read(owner, artifact.id), {
    code: 'artifact_size',
    message: 'Artifact exceeds the 2,000,000-byte inline limit',
    details: { artifactId: artifact.id, size: input.size },
  });
  // The tool, not the service, says how to go on.
  await assert.rejects(app.ctx.tools.call('artifact.read', owner, { artifactId: artifact.id }), {
    code: 'artifact_size',
    message: /; use artifact\.read with mode download$/,
  });
  const reader = await app.ctx.scope.issueActor(owner, { name: 'Reviewer', role: 'reader' });
  const review = { actorId: reader.actor.id, projectId: owner.projectId };
  assert.equal(
    (
      (await app.ctx.tools.call('artifact.read', review, {
        artifactId: artifact.id,
        mode: 'download',
      })) as { download: { url: string } }
    ).download.url,
    'https://bucket.example/file',
  );
  await assert.rejects(
    app.ctx.tools.call('artifact.upload_begin', review, { ...input, requestId: 'review' }),
    { code: 'forbidden' },
  );
  unbind();
  assert.deepEqual(await app.ctx.tools.call('artifact.storage_status', owner, {}), {
    available: false,
  });
  await assert.rejects(
    app.ctx.tools.call('artifact.read', owner, { artifactId: artifact.id, mode: 'download' }),
    { code: 'storage_unavailable' },
  );
  // Without a way to download it, the refusal offers none.
  await assert.rejects(app.ctx.tools.call('artifact.read', owner, { artifactId: artifact.id }), {
    code: 'artifact_size',
    message: 'Artifact exceeds the 2,000,000-byte inline limit',
  });
  assert.equal((await app.ctx.artifacts.read(owner, small.id)).content, 'still here');
});

test('uploads belong to their actor, and resumed part URLs are withheld after a revocation', async (t) => {
  const app = await largeApp(t);
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Research', actorName: 'Owner' });
  const owner = { actorId: boot.actor.id, projectId: boot.project.id };
  const issued = await app.ctx.scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  const producer = { actorId: issued.actor.id, projectId: owner.projectId };
  const keys: string[] = [];
  let failBegin = false;
  const entered = deferred();
  const release = deferred();
  t.after(
    app.ctx.artifacts.bindLarge({
      async begin(_projectId, key) {
        if (failBegin) throw new Error('storage failed');
        keys.push(key);
        return {
          objectId: `obj_${key}`,
          plan: { partSize: 10, partCount: 1, parts: [], completedParts: [], nextPart: 1 },
        };
      },
      async resume() {
        entered.resolve();
        await release.promise;
        return {
          partSize: 10,
          partCount: 1,
          parts: [{ partNumber: 1, size: 10, url: 'https://bucket.example/part', headers: {} }],
          completedParts: [],
          nextPart: 1,
        };
      },
      async complete() {
        throw new Error('unused');
      },
      async download() {
        throw new Error('unused');
      },
      async read() {
        throw new Error('unused');
      },
    }),
  );
  const input = { title: 'Rows', size: 10, sha256: 'a'.repeat(64), mediaType: 'text/csv' };
  // One requestId, two actors: two uploads, and neither learns of the other's.
  const mine = await app.ctx.artifacts.uploadBegin(owner, { ...input, requestId: 'rows' });
  const theirs = await app.ctx.artifacts.uploadBegin(producer, {
    ...input,
    title: 'Other rows',
    requestId: 'rows',
  });
  assert.notEqual(theirs.uploadId, mine.uploadId);
  assert.deepEqual(keys, [mine.uploadId, theirs.uploadId]);
  await assert.rejects(app.ctx.artifacts.uploadResume(producer, mine.uploadId), {
    code: 'not_found',
  });
  // An upload whose storage object was never created: the tool adds how to recover it.
  failBegin = true;
  await assert.rejects(
    app.ctx.artifacts.uploadBegin(owner, { ...input, requestId: 'no-object' }),
    /storage failed/,
  );
  const stuck = await app.ctx.state.read((sql) =>
    sql.get<{ upload_id: string }>(
      'SELECT upload_id FROM artifact_uploads WHERE object_id IS NULL',
    ),
  );
  await assert.rejects(app.ctx.artifacts.uploadComplete(owner, stuck!.upload_id), {
    code: 'upload_pending',
    message: 'Upload has no storage object yet',
  });
  for (const tool of ['artifact.upload_resume', 'artifact.upload_complete'])
    await assert.rejects(app.ctx.tools.call(tool, owner, { uploadId: stuck!.upload_id }), {
      code: 'upload_pending',
      message:
        'Upload has no storage object yet; retry artifact.upload_begin with the same requestId',
    });
  // A revocation while part URLs are signed withholds them.
  const pending = app.ctx.tools.call('artifact.upload_resume', producer, {
    uploadId: theirs.uploadId,
  });
  const rejected = assert.rejects(pending, { code: 'forbidden' });
  await entered.promise;
  await app.ctx.scope.revokeActor(owner, producer.actorId);
  release.resolve();
  await rejected;
});
