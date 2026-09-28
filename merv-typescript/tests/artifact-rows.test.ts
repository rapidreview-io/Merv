import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createService,
  executionOutputs,
  MervError,
  now,
  sha256Hex,
  type Blobs,
  type Caller,
  type Scope,
} from '@merv/contracts';
import { DiskBlobs } from '@merv/blobs';
import { ProjectScope } from '@merv/scope';
import { ArtifactStore } from '@merv/artifacts';
import { postgresMigrations } from '@merv/artifacts/index.postgres';
import { deferred } from './fixtures/deferred.js';
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
  const boot = await scope.bootstrap({ projectName: 'Rows', actorName: 'Owner' });
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
  // Both creates may share a millisecond, so the rows are compared by id, not creation order.
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
  const sessions = await f.state.read((sql) =>
    sql.all<{ id: string; session_id: string | null }>('SELECT id,session_id FROM artifacts'),
  );
  assert.deepEqual(
    sessions.sort(byId),
    [
      { id: artifact.id, session_id: 'ses_worker' },
      { id: plain.id, session_id: null },
    ].sort(byId),
  );
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
  const outputs = await executionOutputs(store, worker);
  assert.deepEqual(outputs, [artifact]);
  assert.deepEqual(Object.keys(outputs[0]).sort(), keys);
});

/** Session authority is Sessions'; this stub grants it so a test can drive session callers. */
async function sessionStore(f: Awaited<ReturnType<typeof fixture>>) {
  const scope = { require: async () => ({}) } as unknown as Scope;
  return await createService(new ArtifactStore(f.state, scope, f.counted));
}

test('execution outputs are what this session created as this actor, oldest first', async (t) => {
  const f = await fixture(t);
  const store = await sessionStore(f);
  const peer = (await f.scope.issueActor(f.caller, { name: 'Peer', role: 'producer' })).actor.id;
  // One agent's two sessions, and another actor working under the first session's id.
  const first: Caller = { ...f.caller, session: { id: 'ses_first' } };
  const second: Caller = {
    ...f.caller,
    session: { id: 'ses_second', agentSessionId: 'ses_agent' },
  };
  const other: Caller = { ...f.caller, actorId: peer, session: { id: 'ses_first' } };
  for (const [n, caller] of [first, second, other, f.caller, first, second].entries())
    await store.create(caller, { title: `Output ${n}`, content: `bytes ${n}` });
  const uploaded = await store.uploadComplete(
    first,
    await f.upload(Buffer.from('uploaded'), store, first),
  );
  // What authored() answered: rows by this actor whose creation event names this session.
  const receipts = async (caller: Caller) =>
    (
      await f.state.read((sql) =>
        sql.all<{ id: string }>(
          `SELECT id FROM artifacts a WHERE a.project_id=? AND a.created_by=? AND EXISTS(SELECT 1 FROM events e WHERE e.project_id=a.project_id AND e.subject_id=a.id AND e.type='artifact.created' AND (e.data_json::jsonb #>> '{source,sessionId}')=?) ORDER BY a.created_at,a.id`,
          caller.projectId,
          caller.actorId,
          caller.session!.id,
        ),
      )
    ).map((row) => row.id);
  const outputs = async (caller: Caller) =>
    (await executionOutputs(store, caller)).map((artifact) => artifact.id);
  for (const caller of [first, second, other])
    assert.deepEqual(await outputs(caller), await receipts(caller));
  assert.equal((await outputs(first)).length, 3);
  assert.equal((await outputs(first)).at(-1), uploaded.id);
  assert.equal((await outputs(second)).length, 2);
  assert.equal((await outputs(other)).length, 1);

  const list = t.mock.method(store, 'list');
  await assert.rejects(executionOutputs(store, f.caller), { code: 'forbidden', status: 403 });
  assert.equal(list.mock.callCount(), 0);
});

test('execution outputs page through every output with the caller they started with', async (t) => {
  const f = await fixture(t);
  const store = await sessionStore(f);
  const peer = (await f.scope.issueActor(f.caller, { name: 'Peer', role: 'producer' })).actor.id;
  // 1,205 rows of this session, ten to a second so pages cross ties on created_at; every fifth
  // was created by another actor.
  await f.state.transaction((tx) =>
    tx.run(
      `INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,session_id)
       SELECT 'art_' || lpad(n::text, 5, '0'), ?, CASE WHEN n % 5 = 0 THEN ? ELSE ? END, 'Row ' || n,
         'text/plain', repeat('0', 64), 1,
         to_char(timestamp '2026-09-01' + (n / 10) * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'ses_worker'
       FROM generate_series(1, 1205) n`,
      f.caller.projectId,
      peer,
      f.caller.actorId,
    ),
  );
  const expected = Array.from({ length: 1205 }, (_, i) => i + 1)
    .filter((n) => n % 5 !== 0)
    .map((n) => `art_${String(n).padStart(5, '0')}`);
  const worker: Caller = { ...f.caller, session: { id: 'ses_worker' } };
  const list = store.list.bind(store);
  const pages = t.mock.method(store, 'list', async (...args: Parameters<typeof list>) => {
    const page = await list(...args);
    // Whatever the caller's object becomes after the first page, the pages keep its start.
    Object.assign(worker, { actorId: peer, session: { id: 'ses_other' } });
    return page;
  });
  const outputs = await executionOutputs(store, worker);
  assert.deepEqual(
    outputs.map((artifact) => artifact.id),
    expected,
  );
  assert.equal(pages.mock.callCount(), 2);
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
  // The guard refuses every UPDATE, a fill of the row's own bytes too.
  for (const sql of [
    "UPDATE artifacts SET session_id='changed' WHERE id='art_key'",
    "UPDATE artifacts SET content='\\x00'::bytea WHERE id='art_key'",
    "UPDATE artifacts SET content=convert_to('art_key','UTF8') WHERE id='art_key'",
    "DELETE FROM artifacts WHERE id='art_key'",
  ])
    await assert.rejects(
      state.transaction((tx) => tx.run(sql)),
      (error: MervError) =>
        error.code === 'state_constraint' &&
        (error.cause as { sqlstate?: string }).sqlstate === '23514',
      sql,
    );
});

test('completing a small upload copies its verified bytes into the row', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(1000, 'k');
  const artifact = await f.artifacts.uploadComplete(f.caller, await f.upload(bytes));
  assert.deepEqual(f.blobs.calls, ['get']);
  assert.deepEqual(await f.content(artifact.id), bytes);
  assert.equal((await f.artifacts.read(f.caller, artifact.id)).content, bytes.toString());
  assert.deepEqual(f.blobs.calls, ['get'], 'later reads are local');
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

test('an upload over the inline limit keeps its bytes only in blobs', async (t) => {
  const f = await fixture(t);
  const uploadId = await f.upload(Buffer.alloc(2_000_001, 'L'));
  const artifact = await f.artifacts.uploadComplete(f.caller, uploadId);
  assert.deepEqual(f.blobs.calls, []);
  assert.equal(await f.content(artifact.id), null);
  await assert.rejects(f.artifacts.read(f.caller, artifact.id), { code: 'artifact_size' });
});
