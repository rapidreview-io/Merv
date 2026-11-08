import { sha256Hex, type Artifact, type ArtifactUploadStatus, type Caller } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from './fixtures/app.js';
import { s3Blobs, send } from './fixtures/s3-blobs.js';
import { stateConfig } from './fixtures/state.js';

/** Artifacts and their tools over S3 blobs, or over disk blobs, which cannot sign uploads. */
async function largeApp(t: TestContext, disk = false) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-large-artifact-'));
  const s3 = await s3Blobs(t);
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        disk
          ? { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } }
          : s3.entry,
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
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Research',
    actorName: 'Owner',
  });
  const owner: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const count = async (table: string) =>
    (
      await app.ctx.state.read((sql) =>
        sql.get<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`),
      )
    )?.count;
  return { app, owner, boot, count, ...s3 };
}

/** A file and the upload input that declares it. */
const file = (bytes: Buffer, requestId?: string) => ({
  bytes,
  input: {
    title: 'Rows.csv',
    size: bytes.length,
    sha256: sha256Hex(bytes),
    mediaType: 'text/csv',
    ...(requestId ? { requestId } : {}),
  },
});

test('an upload is one signed PUT of exactly the declared bytes, and a stored file needs none', async (t) => {
  const f = await largeApp(t);
  // A file already on disk goes up this way, not pasted or base64-encoded into artifact.create.
  const write = (await f.app.ctx.tools.describe()).find((tool) => tool.name === 'artifact.write');
  assert.match(
    JSON.stringify(write!.inputSchema),
    /For a file already on disk, do not cat or base64 it into content: artifact\.write upload_begin stores it/,
  );
  assert.deepEqual(await f.app.ctx.tools.call('artifact.storage_status', f.owner, {}), {
    available: true,
  });
  const small = file(Buffer.from('id,value\n1,2\n'), 'small');
  const plan = (await f.app.ctx.tools.call(
    'artifact.upload_begin',
    f.owner,
    small.input,
  )) as ArtifactUploadStatus;
  const [part] = plan.parts;
  assert.match(
    part!.url,
    new RegExp(`/merv-artifacts/${f.key(f.owner.projectId, small.input.sha256)}\\?`),
  );
  assert.deepEqual(plan, {
    uploadId: plan.uploadId,
    partSize: small.bytes.length,
    partCount: 1,
    nextPart: null,
    parts: [
      {
        partNumber: 1,
        url: part!.url,
        size: small.bytes.length,
        headers: {
          'x-amz-checksum-sha256': Buffer.from(small.input.sha256, 'hex').toString('base64'),
          'if-none-match': '*',
        },
      },
    ],
    completedParts: [],
  });
  // The same requestId replays the upload; changed details are refused.
  assert.equal(
    ((await f.app.ctx.artifacts.uploadBegin(f.owner, small.input)) as ArtifactUploadStatus)
      .uploadId,
    plan.uploadId,
  );
  await assert.rejects(
    f.app.ctx.artifacts.uploadBegin(f.owner, { ...small.input, title: 'Other.csv' }),
    { code: 'upload_conflict', status: 409 },
  );
  // Completing before the PUT records nothing, and the tool says how to go on.
  await assert.rejects(
    f.app.ctx.tools.call('artifact.upload_complete', f.owner, { uploadId: plan.uploadId }),
    {
      code: 'upload_pending',
      status: 409,
      message:
        'The file has not been uploaded yet; PUT the file to the plan URL with its headers first; artifact.upload_resume signs a fresh URL',
    },
  );
  assert.equal(await f.count('artifacts'), 0);
  // The store refuses other bytes under the URL.
  assert.equal((await send(plan, Buffer.from('id,value\n1,3\n'))).status, 400);
  assert.equal(f.server.objects.size, 0);
  assert.equal((await send(plan, small.bytes)).status, 200);
  // A repeat PUT is refused: a stored object is never overwritten.
  assert.equal((await send(plan, small.bytes)).status, 412);
  const artifact = (await f.app.ctx.tools.call('artifact.upload_complete', f.owner, {
    uploadId: plan.uploadId,
  })) as Artifact;
  assert.deepEqual(Object.keys(artifact).sort(), [
    'createdAt',
    'createdBy',
    'hash',
    'id',
    'mediaType',
    'projectId',
    'size',
    'title',
  ]);
  // A file within the inline limit is kept in its row and reads locally.
  const reads = f.server.requests.length;
  assert.equal(
    (await f.app.ctx.artifacts.read(f.owner, artifact.id)).content,
    small.bytes.toString(),
  );
  assert.equal(f.server.requests.length, reads);
  // After completion, begin, resume and complete answer from the row with no storage call.
  const again = await f.app.ctx.artifacts.uploadBegin(f.owner, small.input);
  assert.deepEqual([again.artifactId, again.parts, again.nextPart], [artifact.id, [], null]);
  assert.equal(
    (await f.app.ctx.artifacts.uploadResume(f.owner, plan.uploadId)).artifactId,
    artifact.id,
  );
  assert.equal((await f.app.ctx.artifacts.uploadComplete(f.owner, plan.uploadId)).id, artifact.id);
  assert.equal(f.server.requests.length, reads);
  // Another upload of a stored file needs no PUT.
  const stored = await f.app.ctx.artifacts.uploadBegin(f.owner, {
    ...small.input,
    requestId: 'again',
  });
  assert.deepEqual(stored, {
    uploadId: stored.uploadId,
    partSize: small.bytes.length,
    partCount: 1,
    nextPart: null,
    parts: [],
    completedParts: [1],
  });
  assert.notEqual(
    (await f.app.ctx.artifacts.uploadComplete(f.owner, stored.uploadId)).id,
    artifact.id,
  );
});

test('concurrent completions record one artifact', async (t) => {
  const f = await largeApp(t);
  const one = file(Buffer.from('once'));
  const plan = await f.app.ctx.artifacts.uploadBegin(f.owner, one.input);
  await send(plan, one.bytes);
  const done = await Promise.all(
    [1, 2, 3].map(() => f.app.ctx.artifacts.uploadComplete(f.owner, plan.uploadId)),
  );
  assert.equal(new Set(done.map((artifact) => artifact.id)).size, 1);
  assert.equal(await f.count('artifacts'), 1);
});

test('uploads belong to their actor, and a revoked writer gets no URL', async (t) => {
  const f = await largeApp(t);
  const issued = await f.app.ctx.scope.credentials.issueActor(f.owner, {
    name: 'Producer',
    role: 'producer',
  });
  const producer: Caller = { actorId: issued.actor.id, projectId: f.owner.projectId };
  const rows = file(Buffer.from('rows'), 'rows');
  // One requestId, two actors: two uploads, and neither learns of the other's.
  const mine = await f.app.ctx.artifacts.uploadBegin(f.owner, rows.input);
  const theirs = await f.app.ctx.artifacts.uploadBegin(producer, {
    ...rows.input,
    title: 'Other rows',
  });
  assert.notEqual(theirs.uploadId, mine.uploadId);
  for (const call of [
    () => f.app.ctx.artifacts.uploadResume(producer, mine.uploadId),
    () => f.app.ctx.artifacts.uploadComplete(producer, mine.uploadId),
  ])
    await assert.rejects(call(), { code: 'not_found' });
  await f.app.ctx.scope.credentials.revokeActor(f.owner, producer.actorId);
  const signed = f.server.requests.length;
  for (const call of [
    () => f.app.ctx.artifacts.uploadResume(producer, theirs.uploadId),
    () => f.app.ctx.artifacts.uploadBegin(producer, { ...rows.input, requestId: 'late' }),
  ])
    await assert.rejects(call(), { code: 'forbidden' });
  assert.equal(f.server.requests.length, signed);
});
