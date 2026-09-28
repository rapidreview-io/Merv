import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createService,
  MervError,
  now,
  sha256Hex,
  type Blobs,
  type Caller,
  type LargeArtifactStorage,
  type Scope,
} from '@merv/contracts';
import { DiskBlobs } from '@merv/blobs';
import { ProjectScope } from '@merv/scope';
import { ArtifactStore } from '@merv/artifacts';
import { postgresMigrations } from '@merv/artifacts/index.postgres';
import { deferred } from './fixtures/deferred.js';
import { legacyArtifact } from './fixtures/legacy-artifact.js';
import { openState } from './fixtures/state.js';

/** Artifacts over disk blobs whose every call is counted and may be delayed or refused. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-rows-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const disk = new DiskBlobs(join(directory, 'blobs'));
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
  };
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(new ArtifactStore(state, scope, counted));
  const boot = await scope.bootstrap({ projectName: 'Rows', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const content = async (id: string) =>
    (
      await state.read((sql) =>
        sql.get<{ content: Buffer | null }>('SELECT content FROM artifacts WHERE id=?', id),
      )
    )?.content;
  return { directory, state, disk, blobs, counted, scope, artifacts, caller, content };
}

const outage = async () => {
  throw new MervError('blob_unavailable', 'Blob storage is down', 503);
};

test('create and reads keep bytes in the row, inside a transaction, with no blob call', async (t) => {
  const f = await fixture(t);
  f.blobs.before = outage;
  const text = 'x'.repeat(10_000);
  const artifact = await f.state.transaction(async (tx) => {
    const artifact = await f.artifacts.create(f.caller, { title: 'Row', content: text }, tx);
    assert.equal((await f.artifacts.read(f.caller, artifact.id, undefined, tx)).content, text);
    const { bytes } = await f.artifacts.bytes(f.caller, artifact.id, tx);
    assert.equal(bytes.toString(), text);
    return artifact;
  });
  assert.equal(artifact.hash, sha256Hex(Buffer.from(text)));
  assert.equal((await f.artifacts.read(f.caller, artifact.id)).content, text);
  assert.deepEqual((await f.artifacts.bytes(f.caller, artifact.id)).artifact, artifact);
  assert.equal((await f.content(artifact.id))?.toString(), text);
  assert.deepEqual(f.blobs.calls, []);
});

test('a create and read in one transaction hold the writer lock only for their database work', async (t) => {
  const f = await fixture(t);
  // Were storage reached under the lock, an unrelated writer would wait this long.
  f.blobs.before = () => delay(1500);
  const entered = deferred();
  const release = deferred();
  const working = f.state.transaction(async (tx) => {
    entered.resolve();
    await release.promise;
    const artifact = await f.artifacts.create(f.caller, { title: 'Row', content: 'held' }, tx);
    await f.artifacts.read(f.caller, artifact.id, undefined, tx);
  });
  await entered.promise;
  const started = performance.now();
  const writing = f.state.transaction((tx) => tx.run('SELECT 1'));
  release.resolve();
  await Promise.all([working, writing]);
  assert.ok(performance.now() - started < 1000, 'the unrelated writer waited for storage');
  assert.deepEqual(f.blobs.calls, []);
});

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

test('the database refuses row bytes that do not match their size and hash', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('bytes');
  const insert = (id: string, size: number, hash: string) =>
    f.state.transaction((tx) =>
      tx.run(
        'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,content) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        f.caller.projectId,
        f.caller.actorId,
        'Raw',
        'text/plain',
        hash,
        size,
        now(),
        bytes,
      ),
    );
  const refused = (error: unknown) =>
    error instanceof MervError &&
    error.code === 'state_constraint' &&
    (error.cause as { constraint?: string }).constraint === 'artifacts_content_verified';
  await assert.rejects(insert('art_hash', bytes.length, sha256Hex(Buffer.from('other'))), refused);
  await assert.rejects(insert('art_size', bytes.length + 1, sha256Hex(bytes)), refused);
  await insert('art_good', bytes.length, sha256Hex(bytes));
  assert.equal((await f.artifacts.read(f.caller, 'art_good')).content, 'bytes');
});

test('a session create records its session, and metadata answers carry no bytes', async (t) => {
  const f = await fixture(t);
  // The worker's authority is Sessions'; here a stub grants it to exercise what artifacts stores.
  const scope = { require: async () => ({ sessionId: 'ses_worker' }) } as unknown as Scope;
  const store = await createService(new ArtifactStore(f.state, scope, f.counted));
  const worker: Caller = { ...f.caller, session: { id: 'ses_worker' } };
  const artifact = await store.create(worker, { title: 'Output', content: 'worker bytes' });
  const plain = await store.create(f.caller, { title: 'Plain', content: 'plain bytes' });
  const sessions = await f.state.read((sql) =>
    sql.all<{ id: string; session_id: string | null }>(
      'SELECT id,session_id FROM artifacts ORDER BY created_at,id',
    ),
  );
  assert.deepEqual(sessions, [
    { id: artifact.id, session_id: 'ses_worker' },
    { id: plain.id, session_id: null },
  ]);
  const keys = Object.keys(artifact).sort();
  assert.deepEqual(keys, [
    'createdAt',
    'createdBy',
    'hash',
    'id',
    'mediaType',
    'projectId',
    'size',
    'title',
  ]);
  assert.deepEqual(Object.keys(await store.get(worker, artifact.id)).sort(), keys);
  for (const listed of await store.list(worker)) assert.deepEqual(Object.keys(listed).sort(), keys);
  const authored = await store.authored(worker);
  assert.deepEqual(authored, [artifact]);
  assert.deepEqual(Object.keys(authored[0]).sort(), keys);
});

test('the content migration fills session provenance, then the guard and CHECK hold', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-migration-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  await state.migrate('artifacts', [
    { version: 1, sql: postgresMigrations[1] },
    { version: 2, sql: postgresMigrations[2] },
  ]);
  const created = async (id: string, source: Record<string, string> | undefined) =>
    await state.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        'project',
        'actor',
        'Before',
        'text/plain',
        sha256Hex(Buffer.from(id)),
        id.length,
        now(),
      );
      await state.appendEvent(tx, {
        projectId: 'project',
        actorId: 'actor',
        type: 'artifact.created',
        subjectId: id,
        data: { hash: sha256Hex(Buffer.from(id)), size: id.length, ...(source ? { source } : {}) },
      });
    });
  await created('art_session', { kind: 'session', sessionId: 'ses_before' });
  await created('art_key', { kind: 'user-key', keyId: 'key', membershipId: 'member' });
  await created('art_none', undefined);
  await createService(new ArtifactStore(state, {} as Scope, {} as Blobs));
  assert.deepEqual(
    await state.read((sql) => sql.all('SELECT id,session_id,content FROM artifacts ORDER BY id')),
    [
      { id: 'art_key', session_id: null, content: null },
      { id: 'art_none', session_id: null, content: null },
      { id: 'art_session', session_id: 'ses_before', content: null },
    ],
  );
  for (const sql of [
    "UPDATE artifacts SET session_id='changed' WHERE id='art_key'",
    "UPDATE artifacts SET content='\\x00'::bytea WHERE id='art_key'",
    "DELETE FROM artifacts WHERE id='art_key'",
  ])
    await assert.rejects(
      state.transaction((tx) => tx.run(sql)),
      { code: 'state_constraint' },
      sql,
    );
});

test('rows from before bytes were kept in them read through blobs, and are logged under a writer', async (t) => {
  const f = await fixture(t);
  const put = (bytes: Buffer) => f.disk.put(f.caller.projectId, bytes);
  const legacy = await legacyArtifact(f.state, f.caller, Buffer.from('legacy bytes'), put);
  assert.equal((await f.artifacts.read(f.caller, legacy.id)).content, 'legacy bytes');
  assert.deepEqual(f.blobs.calls, ['get']);

  const logged = t.mock.method(process.stderr, 'write', () => true);
  const lines = () =>
    logged.mock.calls.filter((call) =>
      String(call.arguments[0]).includes('artifacts.io_in_transaction'),
    ).length;
  const fresh = await f.artifacts.create(f.caller, { title: 'New', content: 'row bytes' });
  await f.state.transaction(async (tx) => {
    // Bytes kept in the row are read locally: nothing to report.
    await f.artifacts.read(f.caller, fresh.id, undefined, tx);
    assert.equal(lines(), 0);
    // One report per call site, however often it fetches.
    for (let i = 0; i < 3; i++) await f.artifacts.read(f.caller, legacy.id, undefined, tx);
  });
  assert.equal(lines(), 1);
  // Outside a writer the fetch is not reported.
  await f.artifacts.read(f.caller, legacy.id);
  assert.equal(lines(), 1);
  logged.mock.restore();

  const file = join(f.directory, 'blobs', f.caller.projectId, legacy.hash.slice(0, 2), legacy.hash);
  await writeFile(file, 'tampered');
  await assert.rejects(f.artifacts.read(f.caller, legacy.id), { code: 'blob_corrupt' });
  await unlink(file);
  await assert.rejects(f.artifacts.bytes(f.caller, legacy.id), {
    code: 'artifact_bytes_missing',
    status: 500,
  });
});

/** Large storage holding exactly one object, whose served bytes a test may replace. */
function objectStore(bytes: Buffer) {
  const sha256 = sha256Hex(bytes);
  const store = {
    reads: 0,
    served: async (): Promise<Buffer> => bytes,
    storage: {
      async begin() {
        return {
          objectId: 'obj_rows',
          plan: {
            partSize: bytes.length,
            partCount: 1,
            parts: [],
            completedParts: [1],
            nextPart: null,
          },
        };
      },
      async resume() {
        throw new Error('unused');
      },
      async complete() {
        return { objectId: 'obj_rows', size: bytes.length, sha256, state: 'available' };
      },
      async download() {
        throw new Error('unused');
      },
      async read(): Promise<Buffer> {
        store.reads++;
        return await store.served();
      },
    } satisfies LargeArtifactStorage,
  };
  return { store, sha256 };
}

async function upload(f: Awaited<ReturnType<typeof fixture>>, t: TestContext, bytes: Buffer) {
  const { store, sha256 } = objectStore(bytes);
  t.after(f.artifacts.bindLarge(store.storage));
  const begun = await f.artifacts.uploadBegin(f.caller, {
    title: 'Object',
    size: bytes.length,
    sha256,
    mediaType: 'text/plain',
  });
  return { store, uploadId: begun.uploadId };
}

test('completing a small upload copies its verified bytes into the row', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(1000, 'k');
  const { store, uploadId } = await upload(f, t, bytes);
  const artifact = await f.artifacts.uploadComplete(f.caller, uploadId);
  assert.equal(store.reads, 1);
  assert.deepEqual(await f.content(artifact.id), bytes);
  assert.equal((await f.artifacts.read(f.caller, artifact.id)).content, bytes.toString());
  assert.equal(store.reads, 1, 'later reads are local');
});

test('corrupt bytes served at completion fail it and record no artifact', async (t) => {
  const f = await fixture(t);
  const { store, uploadId } = await upload(f, t, Buffer.from('declared'));
  store.served = async () => Buffer.from('replaced');
  await assert.rejects(f.artifacts.uploadComplete(f.caller, uploadId), {
    code: 'blob_corrupt',
    status: 500,
  });
  assert.deepEqual(await f.artifacts.list(f.caller), []);
  store.served = async () => Buffer.from('declared');
  const artifact = await f.artifacts.uploadComplete(f.caller, uploadId);
  assert.equal((await f.content(artifact.id))?.toString(), 'declared');
});

test('an outage at completion records the artifact, which reads through its object', async (t) => {
  const f = await fixture(t);
  const { store, uploadId } = await upload(f, t, Buffer.from('through the object'));
  store.served = outage;
  const artifact = await f.artifacts.uploadComplete(f.caller, uploadId);
  assert.equal(await f.content(artifact.id), null);
  store.served = async () => Buffer.from('through the object');
  assert.equal((await f.artifacts.read(f.caller, artifact.id)).content, 'through the object');
  assert.equal(store.reads, 2);
});

test('an upload over the inline limit keeps its bytes only in its object', async (t) => {
  const f = await fixture(t);
  const { store, uploadId } = await upload(f, t, Buffer.alloc(2_000_001, 'L'));
  const artifact = await f.artifacts.uploadComplete(f.caller, uploadId);
  assert.equal(store.reads, 0);
  assert.equal(await f.content(artifact.id), null);
  await assert.rejects(f.artifacts.read(f.caller, artifact.id), { code: 'artifact_size' });
});
