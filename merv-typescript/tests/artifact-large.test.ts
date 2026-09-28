import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_OBJECT_BYTES,
  sha256Hex,
  type Artifact,
  type ArtifactUploadStatus,
  type Caller,
} from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { stateConfig } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';
import { s3Blobs, send } from './fixtures/s3-blobs.js';

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
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Research', actorName: 'Owner' });
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

test('a file over the inline limit stays in blobs and downloads through a signed URL', async (t) => {
  const f = await largeApp(t);
  const large = file(Buffer.alloc(2_000_001, 'L'));
  const plan = await f.app.ctx.artifacts.uploadBegin(f.owner, large.input);
  assert.equal((await send(plan, large.bytes)).status, 200);
  const artifact = await f.app.ctx.artifacts.uploadComplete(f.owner, plan.uploadId);
  assert.equal(
    (
      await f.app.ctx.state.read((sql) =>
        sql.get<{ content: Buffer | null }>(
          'SELECT content FROM artifacts WHERE id=?',
          artifact.id,
        ),
      )
    )?.content,
    null,
  );
  assert.equal(
    (
      (await f.app.ctx.tools.call('artifact.get', f.owner, { artifactId: artifact.id })) as {
        downloadAvailable: boolean;
      }
    ).downloadAvailable,
    true,
  );
  // The tool, not the service, says how to go on.
  await assert.rejects(f.app.ctx.artifacts.read(f.owner, artifact.id), {
    code: 'artifact_size',
    message: 'Artifact exceeds the 2,000,000-byte inline limit',
    details: { artifactId: artifact.id, size: large.bytes.length },
  });
  await assert.rejects(
    f.app.ctx.tools.call('artifact.read', f.owner, { artifactId: artifact.id }),
    { code: 'artifact_size', message: /; use artifact\.read with mode download$/ },
  );
  const reader = await f.app.ctx.scope.issueActor(f.owner, { name: 'Reviewer', role: 'reader' });
  const review: Caller = { actorId: reader.actor.id, projectId: f.owner.projectId };
  const { download } = (await f.app.ctx.tools.call('artifact.read', review, {
    artifactId: artifact.id,
    mode: 'download',
  })) as { download: { url: string } };
  const response = await fetch(download.url);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), large.bytes);
  // Saved under the artifact's title.
  assert.match(response.headers.get('content-disposition')!, /^attachment; filename="Rows\.csv";/);
  await assert.rejects(
    f.app.ctx.tools.call('artifact.upload_begin', review, { ...large.input, requestId: 'r' }),
    { code: 'forbidden' },
  );
});

test('a stored file of another size than declared is a 409 mismatch from begin and complete', async (t) => {
  const f = await largeApp(t);
  const real = file(Buffer.from('twelve bytes'));
  const wrong = { ...real.input, size: real.bytes.length + 1, requestId: 'wrong' };
  // Declared before the file is stored: the plan signs the declared size.
  const pending = await f.app.ctx.artifacts.uploadBegin(f.owner, wrong);
  assert.equal(pending.parts[0]!.size, wrong.size);
  const right = await f.app.ctx.artifacts.uploadBegin(f.owner, real.input);
  assert.equal((await send(right, real.bytes)).status, 200);
  for (const call of [
    () => f.app.ctx.artifacts.uploadComplete(f.owner, pending.uploadId),
    () => f.app.ctx.artifacts.uploadBegin(f.owner, wrong),
    () => f.app.ctx.artifacts.uploadResume(f.owner, pending.uploadId),
  ])
    await assert.rejects(call(), {
      code: 'upload_mismatch',
      status: 409,
      message: 'A stored file with this SHA-256 has a different size',
    });
  assert.equal(await f.count('artifacts'), 0);
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
  const issued = await f.app.ctx.scope.issueActor(f.owner, { name: 'Producer', role: 'producer' });
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
  await f.app.ctx.scope.revokeActor(f.owner, producer.actorId);
  const signed = f.server.requests.length;
  for (const call of [
    () => f.app.ctx.artifacts.uploadResume(producer, theirs.uploadId),
    () => f.app.ctx.artifacts.uploadBegin(producer, { ...rows.input, requestId: 'late' }),
  ])
    await assert.rejects(call(), { code: 'forbidden' });
  assert.equal(f.server.requests.length, signed);
});

test('blobs that cannot sign uploads refuse them before any row', async (t) => {
  const f = await largeApp(t, true);
  assert.deepEqual(await f.app.ctx.tools.call('artifact.storage_status', f.owner, {}), {
    available: false,
  });
  await assert.rejects(
    f.app.ctx.tools.call('artifact.upload_begin', f.owner, file(Buffer.from('x')).input),
    { code: 'storage_unavailable', status: 503 },
  );
  assert.equal(await f.count('artifact_uploads'), 0);
  const note = await f.app.ctx.artifacts.create(f.owner, { title: 'Note', content: 'still here' });
  assert.equal((await f.app.ctx.artifacts.read(f.owner, note.id)).content, 'still here');
  assert.equal(
    (
      (await f.app.ctx.tools.call('artifact.get', f.owner, { artifactId: note.id })) as {
        downloadAvailable: boolean;
      }
    ).downloadAvailable,
    false,
  );
});

test('an upload begun in sandbox storage resumes and completes through blobs', async (t) => {
  const f = await largeApp(t);
  const legacy = file(Buffer.from('begun before the switch'));
  await f.app.ctx.state.transaction((tx) =>
    tx.run(
      'INSERT INTO artifact_uploads(upload_id,project_id,created_by,title,media_type,hash,size,object_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      'aup_legacy',
      f.owner.projectId,
      f.owner.actorId,
      legacy.input.title,
      legacy.input.mediaType,
      legacy.input.sha256,
      legacy.input.size,
      'obj_legacy',
      '2026-09-28T00:00:00Z',
    ),
  );
  await assert.rejects(f.app.ctx.artifacts.uploadComplete(f.owner, 'aup_legacy'), {
    code: 'upload_pending',
  });
  const plan = await f.app.ctx.artifacts.uploadResume(f.owner, 'aup_legacy');
  assert.equal((await send(plan, legacy.bytes)).status, 200);
  const artifact = await f.app.ctx.artifacts.uploadComplete(f.owner, 'aup_legacy');
  assert.equal(
    (await f.app.ctx.artifacts.read(f.owner, artifact.id)).content,
    legacy.bytes.toString(),
  );
});

test('a row whose bytes were in sandbox storage downloads through blobs', async (t) => {
  const f = await largeApp(t);
  const bytes = Buffer.alloc(3_000_000, 'M');
  const hash = sha256Hex(bytes);
  // The move script put its bytes at their content address; object_id is only a label now.
  f.server.objects.set(f.key(f.owner.projectId, hash), bytes);
  await f.app.ctx.state.transaction((tx) =>
    tx.run(
      'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,object_id) VALUES(?,?,?,?,?,?,?,?,?)',
      'art_moved',
      f.owner.projectId,
      f.owner.actorId,
      'Moved',
      'application/octet-stream',
      hash,
      bytes.length,
      '2026-09-20T00:00:00Z',
      'obj_moved',
    ),
  );
  assert.equal('objectId' in (await f.app.ctx.artifacts.get(f.owner, 'art_moved')), false);
  const { download } = await f.app.ctx.artifacts.download(f.owner, 'art_moved');
  assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), bytes);
});

test('resuming an upload waits for no writer, for an owner or a session caller', async (t) => {
  const f = await largeApp(t);
  const { app, owner } = f;
  const source = await app.ctx.scope.delegationSource({
    ...owner,
    credentialId: f.boot.credential.id,
  });
  const worker = await app.ctx.state.transaction((tx) =>
    app.ctx.scope.createSessionActor(
      source,
      { sessionId: 'session_uploads', name: 'Worker', role: 'producer' },
      tx,
    ),
  );
  const session: Caller = {
    actorId: worker.id,
    projectId: worker.projectId,
    session: { id: 'session_uploads' },
  };
  // The session provider vouches for the owner and records whether it was asked in a read scope.
  const handed: boolean[] = [];
  t.after(
    app.ctx.scope.registerSessionAuthority({
      require: async () => {
        handed.push(app.ctx.state.readScope);
        return source;
      },
    }),
  );
  const input = file(Buffer.from('ten bytes!')).input;
  const uploads = [
    [owner, (await app.ctx.artifacts.uploadBegin(owner, input)).uploadId],
    [session, (await app.ctx.artifacts.uploadBegin(session, input)).uploadId],
  ] as const;
  handed.length = 0;
  const entered = deferred();
  const release = deferred();
  const holding = app.ctx.state.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    for (const [caller, uploadId] of uploads) {
      const resumed = await Promise.race([
        app.ctx.artifacts.uploadResume(caller, uploadId),
        delay(3000).then(() => assert.fail('resume waited for the writer lock')),
      ]);
      assert.equal(resumed.uploadId, uploadId);
    }
  } finally {
    release.resolve();
    await holding;
  }
  assert.ok(
    handed.length > 0 && handed.every(Boolean),
    'every session decision ran in a read scope',
  );
});

test('an upload over the largest object is refused before any row or storage call', async (t) => {
  const f = await largeApp(t);
  const input = {
    title: 'Huge',
    size: MAX_OBJECT_BYTES + 1,
    sha256: 'a'.repeat(64),
    mediaType: 'application/octet-stream',
  };
  await assert.rejects(f.app.ctx.artifacts.uploadBegin(f.owner, input), {
    code: 'artifact_size',
    status: 400,
    message: 'Artifact size must be 1 byte to 512 MiB',
  });
  // The tool's schema refuses the size before the service sees it.
  await assert.rejects(f.app.ctx.tools.call('artifact.upload_begin', f.owner, input), {
    code: 'invalid_input',
    status: 400,
  });
  assert.deepEqual(f.server.requests, []);
  assert.equal(await f.count('artifact_uploads'), 0);
});
