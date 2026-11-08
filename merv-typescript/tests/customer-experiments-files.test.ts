import type { ApiRequest } from '@merv/api/types';
import { MervError, type Caller } from '@merv/contracts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { CustomerAccess } from '../packages/customer-experiments/src/access.js';
import { RequestBuckets } from '../packages/customer-experiments/src/data.js';
import type { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import { filesHttp, isFilesPath } from '../packages/customer-experiments/src/files-http.js';
import {
  deletionSchedule,
  FILES_LIMIT_BYTES,
  FilesService,
  normalizeKey,
  normalizePrefix,
  partCount,
  partLength,
  type FilesLifecycle,
  type RequestFileStorage,
  type StoredFile,
} from '../packages/customer-experiments/src/files.js';
import { RequestStore } from '../packages/customer-experiments/src/store.js';
import { registerWorkerTools } from '../packages/customer-experiments/src/worker-tools.js';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;
const MIB = 1024 * 1024;

test('file keys normalise to relative paths and refuse escapes, control characters and long names', () => {
  assert.equal(normalizeKey('/data//train.csv'), 'data/train.csv');
  assert.equal(normalizeKey('./a/./b\\c.bin'), 'a/b/c.bin');
  assert.equal(normalizeKey('Café.txt'), 'Café.txt');
  assert.throws(() => normalizeKey('a/../b'), code('invalid_key'));
  assert.throws(() => normalizeKey('..'), code('invalid_key'));
  assert.throws(() => normalizeKey('a\u0000b'), code('invalid_key'));
  assert.throws(() => normalizeKey('folder/'), code('invalid_key'));
  assert.throws(() => normalizeKey('//'), code('invalid_key'));
  assert.equal(normalizeKey('x'.repeat(1024)).length, 1024);
  assert.throws(() => normalizeKey('x'.repeat(1025)), code('invalid_key'));
  assert.throws(() => normalizeKey('é'.repeat(513)), code('invalid_key'));
  assert.equal(normalizePrefix(''), '');
  assert.equal(normalizePrefix('/'), '');
  assert.equal(normalizePrefix('a/b'), 'a/b/');
  assert.equal(normalizePrefix('/a//b/'), 'a/b/');
  assert.throws(() => normalizePrefix('a/../'), code('invalid_key'));
});

test('files end 48 hours after completion, failure, or seven quiet days before payment', () => {
  // One clock for the whole test: a second reading can land a millisecond later.
  const day = 86400_000,
    now = Date.now(),
    ago = (ms: number) => new Date(now - ms).toISOString();
  const record = { createdAt: ago(10 * day) };
  const done = deletionSchedule(
    record,
    { version: 3, state: 'complete', updatedAt: ago(day) },
    null,
  );
  assert.equal(done?.reason, 'complete');
  assert.equal(Date.parse(done!.deleteAt), Date.parse(done!.endedAt) + 2 * day);
  assert.equal(
    deletionSchedule(record, { version: 3, state: 'failed', updatedAt: ago(0) }, null)?.reason,
    'failed',
  );
  assert.equal(
    deletionSchedule(record, { version: 3, state: 'running', updatedAt: ago(9 * day) }, null),
    null,
  );
  const quiet = deletionSchedule(
    record,
    { version: 3, state: 'planning', updatedAt: ago(9 * day) },
    ago(8 * day),
  );
  assert.equal(quiet?.reason, 'abandoned');
  assert.equal(Date.parse(quiet!.endedAt), now - 8 * day + 7 * day);
  // A customer returning before deletion keeps the request open.
  assert.equal(
    deletionSchedule(record, { version: 3, state: 'planning', updatedAt: ago(9 * day) }, ago(day)),
    null,
  ); // An accepted contract's frozen files wait for its payment and run, however quiet.
  for (const state of ['ready', 'awaiting_payment'])
    assert.equal(
      deletionSchedule(record, { version: 3, state, updatedAt: ago(9 * day) }, ago(8 * day)),
      null,
    );
});

test('request bucket files: CORS exposes ETag, parts sign their length, large copies go part by part, deletion removes the bucket', async () => {
  const storage = new RequestBuckets({
    endpoint: 'https://s3.example.com',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    bucketPrefix: 'merv-customer',
    publicOrigin: 'https://merv.example.com',
  });
  const calls: { name: string; input: any }[] = [];
  const replies: Record<string, (input: any) => unknown> = {};
  const fake = async (cmd: any) => {
    calls.push({ name: cmd.constructor.name, input: cmd.input });
    return replies[cmd.constructor.name]?.(cmd.input) ?? {};
  };
  const clients = storage as unknown as Record<'client' | 'files', { send: typeof fake }>;
  clients.client.send = fake;
  clients.files.send = fake;
  const id = 'ce_' + 'b'.repeat(32);
  // The bucket's CORS rule is not live at once: the first preflight is refused, the next allowed.
  const preflights: { url: string; origin: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    preflights.push({ url, origin: new Headers(init.headers).get('origin') });
    return new Response(null, {
      status: 204,
      headers:
        preflights.length > 1 ? { 'access-control-allow-origin': 'https://merv.example.com' } : {},
    });
  }) as typeof fetch;
  try {
    await storage.provisionFiles(id);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(preflights.length, 2);
  assert.equal(
    preflights[0]!.url,
    'https://s3.example.com/merv-customer-' + 'b'.repeat(32) + '/cors-check',
  );
  assert.equal(preflights[0]!.origin, 'https://merv.example.com');
  assert.deepEqual(
    calls.map((c) => c.name),
    ['CreateBucketCommand', 'PutPublicAccessBlockCommand', 'PutBucketCorsCommand'],
  );
  const rule = calls[2]!.input.CORSConfiguration.CORSRules[0];
  assert.deepEqual(rule.AllowedOrigins, ['https://merv.example.com']);
  assert.ok(rule.AllowedMethods.includes('PUT') && rule.AllowedMethods.includes('GET'));
  assert.deepEqual(rule.ExposeHeaders, ['ETag']);

  const url = new URL(await storage.presignPart(id, 'a b/c.bin', 'up+1/x', 3, 1234));
  assert.equal(url.pathname, '/merv-customer-' + 'b'.repeat(32) + '/a%20b/c.bin');
  assert.equal(url.searchParams.get('partNumber'), '3');
  assert.equal(url.searchParams.get('uploadId'), 'up+1/x');
  assert.match(url.searchParams.get('X-Amz-SignedHeaders')!, /content-length/);
  assert.ok(![...url.searchParams.keys()].some((k) => k.startsWith('x-amz-checksum')));

  calls.length = 0;
  replies.CreateMultipartUploadCommand = () => ({ UploadId: 'copy-1' });
  replies.UploadPartCopyCommand = (input) => ({
    CopyPartResult: { ETag: `"${input.PartNumber}"` },
  });
  const big = 6 * 1024 ** 3;
  await storage.copyFile(
    id,
    { key: 'big/x.bin', size: big, etag: '', uploaded: '' },
    'moved/x.bin',
  );
  const copies = calls.filter((c) => c.name === 'UploadPartCopyCommand');
  assert.equal(copies.length, partCount(big));
  assert.equal(copies[0]!.input.CopySource, 'merv-customer-' + 'b'.repeat(32) + '/big/x.bin');
  assert.equal(copies.at(-1)!.input.CopySourceRange.split('-')[1], String(big - 1));
  assert.equal(calls.at(-1)!.name, 'CompleteMultipartUploadCommand');
  assert.equal(calls.at(-1)!.input.MultipartUpload.Parts.length, copies.length);

  calls.length = 0;
  replies.ListObjectsV2Command = () => ({
    Contents: [
      { Key: 'a', Size: 1, ETag: '"1"' },
      { Key: 'b/c', Size: 2, ETag: '"2"' },
    ],
  });
  replies.ListMultipartUploadsCommand = () => ({ Uploads: [{ Key: 'p', UploadId: 'u' }] });
  assert.equal(await storage.destroy(id), 2);
  assert.deepEqual(
    calls.map((c) => c.name),
    [
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
      'ListMultipartUploadsCommand',
      'AbortMultipartUploadCommand',
      'DeleteBucketCommand',
    ],
  );
  replies.ListObjectsV2Command = () => {
    throw Object.assign(new Error('gone'), { name: 'NoSuchBucket' });
  };
  assert.deepEqual(await storage.listFiles(id), []);
  await storage.close();
});

/** An S3 bucket per request in memory; `put` is what the browser does with a part URL. */
function memoryStorage() {
  const buckets = new Map<string, Map<string, StoredFile>>();
  const uploads = new Map<string, { id: string; key: string; parts: Map<number, number> }>();
  const destroyed: string[] = [];
  let n = 0;
  const bucket = (id: string) => {
    const b = buckets.get(id);
    assert.ok(b, 'bucket provisioned');
    return b;
  };
  const storage: RequestFileStorage & {
    put(url: string, length: number): string;
    buckets: typeof buckets;
    destroyed: string[];
    uploads: typeof uploads;
  } = {
    buckets,
    destroyed,
    uploads,
    async provisionFiles(id) {
      if (!buckets.has(id)) buckets.set(id, new Map());
    },
    async listFiles(id) {
      return [...(buckets.get(id)?.values() ?? [])];
    },
    async head(id, key) {
      return buckets.get(id)?.get(key) ?? null;
    },
    async createMultipart(id, key) {
      const uploadId = `upload-${++n}`;
      uploads.set(uploadId, { id, key, parts: new Map() });
      return uploadId;
    },
    async presignPart(id, key, uploadId, partNumber, length) {
      return `https://bucket.test/${id}/${key}?uploadId=${uploadId}&partNumber=${partNumber}&length=${length}`;
    },
    put(url, length) {
      const u = new URL(url);
      assert.equal(Number(u.searchParams.get('length')), length, 'signed part length');
      uploads
        .get(u.searchParams.get('uploadId')!)!
        .parts.set(Number(u.searchParams.get('partNumber')), length);
      return `"etag-${u.searchParams.get('partNumber')}"`;
    },
    async completeMultipart(id, key, uploadId, parts) {
      const u = uploads.get(uploadId)!;
      assert.equal(u.key, key);
      bucket(id).set(key, {
        key,
        size: parts.reduce((s, p) => s + (u.parts.get(p.partNumber) ?? 0), 0),
        etag: `"${uploadId}"`,
        uploaded: new Date().toISOString(),
      });
      uploads.delete(uploadId);
    },
    async abortMultipart(_id, _key, uploadId) {
      uploads.delete(uploadId);
    },
    async copyFile(id, from, to) {
      bucket(id).set(to, { ...bucket(id).get(from.key)!, key: to });
    },
    async deleteFiles(id, keys) {
      for (const key of keys) bucket(id).delete(key);
    },
    async presignDownload(id, key) {
      return { url: `https://bucket.test/${id}/${key}?get`, expiresAt: new Date().toISOString() };
    },
    // A file's bytes are its path's digits repeated to its size; a `.bin` file holds a NUL.
    async readFile(id, key, offset, length) {
      const file = bucket(id).get(key);
      assert.ok(file, 'file exists');
      const all = new TextEncoder().encode(
        key.endsWith('.bin') ? '\0'.repeat(file.size) : 'x'.repeat(file.size),
      );
      return {
        bytes: all.subarray(offset, offset + length),
        size: file.size,
        contentType: 'text/plain',
      };
    },
    async destroy(id) {
      const count = buckets.get(id)?.size ?? 0;
      buckets.delete(id);
      destroyed.push(id);
      return count;
    },
  };
  return storage;
}

async function fixture() {
  const state = await openState();
  const store = new RequestStore(state, 'files-fixture-key-never-valid-elsewhere');
  await store.initialize();
  const storage = memoryStorage();
  const lifecycles = new Map<string, FilesLifecycle>();
  const files = new FilesService(state, store, storage, async (record) => {
    const value = lifecycles.get(record.id);
    assert.ok(value, 'lifecycle known');
    return value;
  });
  await files.initialize();
  const request = async (version = 3) => {
    const record = await store.create(randomUUID(), 'Files', 100);
    await store.mutate(record.id, (r) => {
      r.experimentId = `exp_${record.id}`;
    });
    lifecycles.set(record.id, {
      version,
      state: 'planning',
      updatedAt: new Date().toISOString(),
    });
    return store.get(record.id);
  };
  /** The browser: PUT every part to its URL, then complete with the ETags. */
  const upload = async (record: Awaited<ReturnType<typeof request>>, key: string, size: number) => {
    const created = await files.createUpload(record, { key, size, contentType: 'text/csv' });
    const parts = created.parts.map((p) => ({
      partNumber: p.partNumber,
      etag: storage.put(p.url, partLength(size, created.partSize, p.partNumber)),
    }));
    return files.complete(record, created.uploadId, { key: created.key, parts });
  };
  return { state, store, storage, lifecycles, files, request, upload };
}

test('files retain the uploaded manifest, freeze mutations, and replay completion after service restart', async (t) => {
  const f = await fixture();
  t.after(() => f.state.close());
  const r = await f.request();
  const created = await f.files.createUpload(r, { key: '/data/train.csv', size: 10 });
  const input = {
    key: created.key,
    parts: created.parts.map((p) => ({ partNumber: p.partNumber, etag: f.storage.put(p.url, 10) })),
  };
  const first = await f.files.complete(r, created.uploadId, input);
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE customer_experiment_file_uploads SET created_at=? WHERE upload_id=?',
      new Date(0).toISOString(),
      created.uploadId,
    ),
  );
  assert.equal((await f.files.list(r)).totalBytes, 10);
  assert.deepEqual((await f.files.list(r)).folders, [{ prefix: 'data/', size: 10, count: 1 }]);
  f.lifecycles.set(r.id, { version: 3, state: 'ready', updatedAt: new Date().toISOString() });
  const restarted = new FilesService(f.state, f.store, f.storage, async (record) =>
    f.lifecycles.get(record.id)!,
  );
  await restarted.initialize();
  assert.deepEqual(await restarted.complete(r, created.uploadId, input), first);
  await assert.rejects(
    restarted.complete(r, created.uploadId, {
      ...input,
      parts: [{ partNumber: 1, etag: 'changed' }],
    }),
    code('request_conflict'),
  );
  await assert.rejects(restarted.createUpload(r, { key: 'late', size: 1 }), code('files_frozen'));
  await assert.rejects(restarted.remove(r, { key: input.key }), code('files_frozen'));
  await assert.rejects(restarted.rename(r, { from: 'data/', to: 'renamed' }), code('files_frozen'));
  assert.deepEqual(
    (await restarted.manifest(r.id)).map((x) => [x.key, x.size]),
    [['data/train.csv', 10]],
  );
  assert.match((await restarted.download(r, input.key)).url, /data\/train.csv/);
});

test('upload reservations retain the 1 TB cap across completion during an in-flight storage listing', async (t) => {
  const f = await fixture();
  t.after(() => f.state.close());
  const r = await f.request(),
    size = FILES_LIMIT_BYTES * 0.6;
  const a = await f.files.createUpload(r, { key: 'a', size });
  // Metadata-only large objects: never allocate or transfer these bytes.
  const multipart = f.storage.uploads.get(a.uploadId)!;
  const parts = Array.from({ length: a.partCount }, (_, i) => {
    multipart.parts.set(i + 1, partLength(size, a.partSize, i + 1));
    return { partNumber: i + 1, etag: 'part-' + i };
  });
  const listed = deferred(),
    resume = deferred();
  const list = f.storage.listFiles;
  let paused = false;
  f.storage.listFiles = async (id) => {
    const snapshot = await list(id);
    if (!paused) {
      paused = true;
      listed.resolve();
      await resume.promise;
    }
    return snapshot;
  };
  const second = f.files.createUpload(r, { key: 'b', size });
  const rejected = assert.rejects(second, code('files_limit'));
  await listed.promise;
  const completing = f.files.complete(r, a.uploadId, { key: 'a', parts });
  resume.resolve();
  await Promise.all([rejected, completing]);
  assert.equal((await f.files.list(r)).totalBytes, size);
  assert.equal(f.storage.uploads.size, 0, 'refused provider upload is aborted');
  const remaining = await f.files.createUpload(r, {
    key: 'remainder',
    size: FILES_LIMIT_BYTES - size,
  });
  await assert.rejects(f.files.createUpload(r, { key: 'extra', size: 1 }), code('files_limit'));
  await f.files.abort(r, remaining.uploadId, 'remainder');
  await f.files.createUpload(r, { key: 'replacement', size: 1 });
});

test('a rename checks every new name first and leaves no copies when it fails; files hold still while the plan is verified', async () => {
  const f = await fixture();
  const r = await f.request();
  await f.upload(r, 'data/a.csv', 1);
  await f.upload(r, 'data/' + 'b'.repeat(1000), 2);
  // The second file's new name is too long: nothing is copied and nothing moves.
  await assert.rejects(
    f.files.rename(r, { from: 'data/', to: 'x'.repeat(30) }),
    code('invalid_key'),
  );
  const keys = () => [...f.storage.buckets.get(r.id)!.keys()].sort();
  assert.deepEqual(keys(), ['data/a.csv', 'data/' + 'b'.repeat(1000)]);
  // A copy failing partway removes the copies already made.
  const copy = f.storage.copyFile;
  let copies = 0;
  f.storage.copyFile = async (id, from, to) => {
    if (++copies === 2) throw new Error('copy failed');
    await copy(id, from, to);
  };
  await assert.rejects(f.files.rename(r, { from: 'data/', to: 'in' }), /copy failed/);
  f.storage.copyFile = copy;
  assert.deepEqual(keys(), ['data/a.csv', 'data/' + 'b'.repeat(1000)]);

  const at = new Date().toISOString();
  for (const planStatus of ['verifying', 'accepted']) {
    f.lifecycles.set(r.id, { version: 3, state: 'planning', updatedAt: at, planStatus });
    await assert.rejects(f.files.createUpload(r, { key: 'late', size: 1 }), code('files_frozen'));
    await assert.rejects(f.files.rename(r, { from: 'data/', to: 'in' }), code('files_frozen'));
    await assert.rejects(f.files.remove(r, { key: 'data/a.csv' }), code('files_frozen'));
  }
  f.lifecycles.set(r.id, {
    version: 3,
    state: 'planning',
    updatedAt: at,
    planStatus: 'changes_requested',
  });
  assert.deepEqual(await f.files.rename(r, { from: 'data/', to: 'in' }), { renamed: 2 });
});

test('the sweeper retains concurrent activity and deletes ended files exactly once', async (t) => {
  const f = await fixture();
  t.after(() => f.state.close());
  const r = await f.request(),
    other = await f.request();
  await f.upload(r, 'a.csv', 3);
  await f.upload(other, 'b.csv', 4);
  const now = Date.now();
  f.lifecycles.set(r.id, {
    version: 3,
    state: 'complete',
    updatedAt: new Date(now - 49 * 3600_000).toISOString(),
  });
  f.lifecycles.set(other.id, {
    version: 3,
    state: 'complete',
    updatedAt: new Date(now - 3600_000).toISOString(),
  });
  const before = await f.files.list(other);
  assert.equal(before.deleteAt, new Date(now - 3600_000 + 48 * 3600_000).toISOString());
  await f.files.sweep();
  assert.deepEqual(f.storage.destroyed, [r.id]);
  const gone = await f.files.list(r);
  assert.deepEqual([gone.files, gone.folders, gone.totalBytes], [[], [], 0]);
  assert.equal(gone.deleteAt, new Date(now - 49 * 3600_000 + 48 * 3600_000).toISOString());
  assert.ok(gone.deletedAt);
  assert.deepEqual(await f.files.manifest(r.id), []);
  await assert.rejects(f.files.download(r, 'a.csv'), code('files_deleted'));
  const row = await f.state.read((sql) =>
    sql.get<{ deleted_objects: string | number; end_reason: string }>(
      'SELECT deleted_objects, end_reason FROM customer_experiment_files WHERE request_id=?',
      r.id,
    ),
  );
  assert.equal(Number(row!.deleted_objects), 1);
  assert.equal(row!.end_reason, 'complete');
  // Once deleted, a request is never swept again.
  await f.files.sweep();
  assert.deepEqual(f.storage.destroyed, [r.id]);
  assert.equal((await f.files.list(other)).files.length, 1);

  // A sweep scans an old row while a rename is in flight; the finished rename renews activity.
  const active = await f.request(),
    old = new Date(Date.now() - 10 * 86400_000).toISOString();
  await f.upload(active, 'original', 3);
  await f.store.mutate(active.id, (record) => {
    record.createdAt = old;
  });
  f.lifecycles.set(active.id, { version: 3, state: 'planning', updatedAt: old });
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE customer_experiment_files SET last_activity_at=? WHERE request_id=?',
      old,
      active.id,
    ),
  );
  const copied = deferred(),
    resume = deferred(),
    scanned = deferred();
  const copy = f.storage.copyFile,
    read = f.state.read.bind(f.state);
  f.storage.copyFile = async (...args) => {
    await copy(...args);
    copied.resolve();
    await resume.promise;
  };
  f.state.read = async (fn) => {
    const result = await read(fn);
    if (Array.isArray(result) && result.some((row) => row.request_id === active.id))
      scanned.resolve();
    return result;
  };
  const renaming = f.files.rename(active, { from: 'original', to: 'renamed' });
  await copied.promise;
  const sweeping = f.files.sweep();
  await scanned.promise;
  resume.resolve();
  try {
    await Promise.all([renaming, sweeping]);
    assert.equal((await f.storage.head(active.id, 'renamed'))?.size, 3);
    assert.deepEqual(f.storage.destroyed, [r.id]);
  } finally {
    resume.resolve();
    f.storage.copyFile = copy;
    f.state.read = read;
  }
});

test('v1 to v6 migration never enrolls legacy buckets in document-plan retention or its file manager', async (t) => {
  const f = await fixture();
  t.after(() => f.state.close());
  const r = await f.request(1);
  // Legacy dataset storage shares this bucket name. Seed an existing lifecycle row as well
  // to prove the sweep guard preserves bytes even if bookkeeping already exists.
  await f.storage.provisionFiles(r.id);
  const file = {
    key: 'dataset-sha256',
    size: 4,
    etag: 'legacy',
    uploaded: new Date().toISOString(),
  };
  f.storage.buckets.get(r.id)!.set(file.key, file);
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO customer_experiment_files(request_id,provisioned_at,last_activity_at) VALUES(?,?,?)',
      r.id,
      new Date(0).toISOString(),
      new Date(0).toISOString(),
    ),
  );
  f.lifecycles.set(r.id, { version: 6, state: 'complete', updatedAt: new Date(0).toISOString() });
  await f.files.sweep();
  assert.deepEqual(f.storage.destroyed, []);
  assert.deepEqual(await f.storage.listFiles(r.id), [file]);
  await assert.rejects(f.files.list(r), code('not_found'));
  await assert.rejects(f.files.download(r, file.key), code('not_found'));
  const fresh = await f.request(6);
  await f.files.warm(fresh);
  assert.equal(
    f.storage.buckets.has(fresh.id),
    false,
    'structured intake does not provision a document-plan bucket',
  );
  assert.equal(
    (await f.state.read((sql) =>
      sql.get<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM customer_experiment_files WHERE request_id=?',
        r.id,
      ),
    ))!.deleted_at,
    null,
  );
});

test('files HTTP: the customer writes, the agent only lists and downloads', async () => {
  const f = await fixture();
  const r = await f.request();
  await f.upload(r, 'x.csv', 2);
  const base = `/customer-experiments/requests/${r.id}/files`;
  assert.ok(isFilesPath(base));
  assert.ok(isFilesPath(`${base}/uploads/abc%2Fdef/complete`));
  assert.ok(!isFilesPath(`/customer-experiments/requests/${r.id}/uploads`));
  // The customer is the capability plus the browser bound to the request.
  const access = new CustomerAccess({ store: f.store, version: async () => 3 });
  const touched: string[] = [];
  access.activity = async (id) => void touched.push(id);
  access.identity = {
    async verify(token) {
      if (token !== 'browser') throw new MervError('unauthorized', 'Authentication required', 401);
      return {
        issuer: 'https://identity.example',
        subject: 'anonymous-browser',
        anonymous: true,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
    configuration: () => ({
      enabled: true,
      login: { url: 'https://identity.example', publishableKey: 'publishable' },
    }),
  };
  const headers = { 'x-merv-identity': 'browser' };
  await access.bind(r.id, f.store.token(r, 'customer'), { headers });
  const call = (method: string, path: string, bearer: string, body?: unknown) =>
    filesHttp(
      access,
      f.files,
      { method, headers } as unknown as IncomingMessage,
      {
        url: new URL(`https://merv.example.com${path}`),
        bearer: () => bearer,
        json: async (schema?: { parse(v: unknown): unknown }) =>
          schema ? schema.parse(body) : body,
      } as unknown as ApiRequest,
    );
  const agent = f.store.token(r, 'agent'),
    customer = f.store.token(r, 'customer');
  assert.equal(((await call('GET', base, agent)) as { files: unknown[] }).files.length, 1);
  assert.ok(((await call('GET', `${base}/download?key=x.csv`, agent)) as { url: string }).url);
  await assert.rejects(call('DELETE', `${base}?key=x.csv`, agent), code('unauthorized'));
  await assert.rejects(
    call('POST', `${base}/uploads`, agent, { key: 'y', size: 1 }),
    code('unauthorized'),
  );
  const created = (await call('POST', `${base}/uploads`, customer, { key: 'y', size: 1 })) as {
    uploadId: string;
  };
  assert.deepEqual(
    await call('DELETE', `${base}/uploads/${encodeURIComponent(created.uploadId)}?key=y`, customer),
    { aborted: true },
  );
  assert.deepEqual(await call('DELETE', `${base}?key=x.csv`, customer), { deleted: 1 });
  await assert.rejects(
    filesHttp(
      access,
      undefined,
      { method: 'GET', headers } as unknown as IncomingMessage,
      {
        url: new URL(`https://merv.example.com${base}`),
        bearer: () => customer,
      } as unknown as ApiRequest,
    ),
    code('files_unavailable'),
  );
  // Customer calls count as activity; the agent's reads do not.
  assert.ok(touched.length >= 3 && touched.every((id) => id === r.id));
  await assert.rejects(
    filesHttp(
      access,
      f.files,
      { method: 'DELETE', headers: {} } as unknown as IncomingMessage,
      {
        url: new URL(`https://merv.example.com${base}?key=y`),
        bearer: () => customer,
      } as unknown as ApiRequest,
    ),
    code('identity_required'),
  );
});

test('the executing worker reads the frozen v3 files and nothing before acceptance', async () => {
  const f = await fixture();
  const r = await f.request();
  await f.upload(r, 'in/data.csv', 7);
  const handlers = new Map<string, (caller: Caller, input: any) => Promise<any>>();
  const tools = {
    register(tool: { name: string; handler: (caller: Caller, input: any) => Promise<any> }) {
      handlers.set(tool.name, tool.handler);
      return () => {};
    },
  };
  const experiment = {
    id: r.experimentId!,
    acceptedContractId: null as string | null,
    contract: null as unknown,
    workflow: { version: 3 },
  };
  const domain = {
    async get(_caller: Caller, id: string) {
      assert.equal(id, r.experimentId);
      return experiment;
    },
  } as unknown as CustomerExperiments;
  await registerWorkerTools(tools as never, domain, f.files);
  const caller = {} as Caller;
  await assert.rejects(
    handlers.get('customer_experiment.files')!(caller, { id: r.experimentId }),
    code('files_not_frozen'),
  );
  // The worker reads the manifest frozen into the contract, not the live bucket.
  experiment.acceptedContractId = 'contract_1';
  experiment.contract = {
    document: '# Plan',
    files: [{ key: 'in/data.csv', size: 7, etag: '"upload-1"' }],
  };
  await f.upload(r, 'later.csv', 3);
  f.lifecycles.set(r.id, { version: 3, state: 'running', updatedAt: new Date().toISOString() });
  const listed = await handlers.get('customer_experiment.files')!(caller, { id: r.experimentId });
  assert.deepEqual(listed.files, [{ key: 'in/data.csv', size: 7, etag: '"upload-1"' }]);
  const download = await handlers.get('customer_experiment.file_download')!(caller, {
    id: r.experimentId,
    key: 'in/data.csv',
  });
  assert.match(download.url, /in\/data\.csv\?get$/);
  await assert.rejects(
    handlers.get('customer_experiment.file_download')!(caller, {
      id: r.experimentId,
      key: 'later.csv',
    }),
    code('not_found'),
  );
  experiment.workflow.version = 2;
  await assert.rejects(
    handlers.get('customer_experiment.files')!(caller, { id: r.experimentId }),
    code('not_found'),
  );
});

test('the intake agent gets a short-lived link to one of its own request files, and only those', async () => {
  const f = await fixture();
  const r = await f.request();
  await f.upload(r, 'data/train.csv', 32);
  const link = await f.files.link(r.id, './data/train.csv');
  assert.equal(link.key, 'data/train.csv');
  assert.match(link.url, /data\/train\.csv/);
  assert.ok(Date.parse(link.expiresAt));
  await assert.rejects(f.files.link(r.id, '../other.csv'));
  await assert.rejects(
    f.files.link(r.id, 'missing.csv'),
    (e: { code?: string }) => e.code === 'not_found',
  );
  const other = await f.request();
  await assert.rejects(
    f.files.link(other.id, 'data/train.csv'),
    (e: { code?: string }) => e.code === 'not_found',
  );
});

test(
  'abort cannot release an in-flight completion reservation or erase its retry receipt',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture();
    const r = await f.request(),
      size = FILES_LIMIT_BYTES * 0.6;
    const a = await f.files.createUpload(r, { key: 'a', size });
    const multipart = f.storage.uploads.get(a.uploadId)!;
    const input = {
      key: a.key,
      parts: Array.from({ length: a.partCount }, (_, i) => {
        multipart.parts.set(i + 1, partLength(size, a.partSize, i + 1));
        return { partNumber: i + 1, etag: 'part-' + i };
      }),
    };
    const published = deferred(),
      resumeHead = deferred();
    const head = f.storage.head;
    f.storage.head = async (id, key) => {
      published.resolve();
      await resumeHead.promise;
      return head(id, key);
    };
    const completing = f.files.complete(r, a.uploadId, input);
    t.after(async () => {
      resumeHead.resolve();
      await completing.catch(() => {});
      await f.state.close();
    });
    await published.promise;
    const rejected = assert.rejects(
      f.files.createUpload(r, { key: 'b', size }),
      code('files_limit'),
    );
    const aborting = f.files.abort(r, a.uploadId, a.key);
    const retrying = f.files.complete(r, a.uploadId, input);
    resumeHead.resolve();
    const completed = await completing;
    await rejected;
    assert.deepEqual(await aborting, { aborted: true });
    assert.deepEqual(await retrying, completed);
    assert.deepEqual(await f.files.complete(r, a.uploadId, input), completed);
    assert.equal((await f.files.list(r)).totalBytes, size);
  },
);

test('a failed completion releases its operation gate for retry or abort', async (t) => {
  const f = await fixture();
  t.after(() => f.state.close());
  const r = await f.request();
  const complete = f.storage.completeMultipart;
  for (const recovery of ['retry', 'abort']) {
    const created = await f.files.createUpload(r, { key: recovery, size: 1 });
    const input = {
      key: created.key,
      parts: created.parts.map((p) => ({
        partNumber: p.partNumber,
        etag: f.storage.put(p.url, 1),
      })),
    };
    f.storage.completeMultipart = async () => {
      throw new Error('provider unavailable');
    };
    await assert.rejects(f.files.complete(r, created.uploadId, input), /provider unavailable/);
    f.storage.completeMultipart = complete;
    if (recovery === 'retry')
      assert.equal((await f.files.complete(r, created.uploadId, input)).size, 1);
    else await f.files.abort(r, created.uploadId, created.key);
    assert.equal(f.storage.uploads.has(created.uploadId), false);
  }
});

test('an expired upload cannot complete after its quota reservation has been reused', async (t) => {
  const f = await fixture();
  t.after(() => f.state.close());
  const r = await f.request(),
    size = FILES_LIMIT_BYTES * 0.6;
  const old = await f.files.createUpload(r, { key: 'old', size });
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE customer_experiment_file_uploads SET created_at=? WHERE upload_id=?',
      new Date(0).toISOString(),
      old.uploadId,
    ),
  );
  await f.files.createUpload(r, { key: 'new', size });
  f.storage.completeMultipart = async () => assert.fail('expired bytes must never be published');
  await assert.rejects(
    f.files.complete(r, old.uploadId, {
      key: old.key,
      parts: Array.from({ length: old.partCount }, (_, i) => ({
        partNumber: i + 1,
        etag: 'part-' + i,
      })),
    }),
    { code: 'upload_expired', status: 410 },
  );
  await f.files.abort(r, old.uploadId, old.key);
  assert.equal(f.storage.uploads.has(old.uploadId), false);
  assert.equal((await f.files.list(r)).totalBytes, 0);
});

test('overlapping completions and renames preserve each successful file mutation', async (t) => {
  const f = await fixture();
  t.after(() => f.state.close());
  for (const operation of ['complete', 'rename'] as const) {
    const r = await f.request();
    const paused = deferred(),
      resume = deferred();
    const head = f.storage.head,
      copy = f.storage.copyFile;
    let first: Promise<unknown>;
    if (operation === 'complete') {
      const a = await f.files.createUpload(r, { key: 'same.csv', size: 10 });
      f.storage.head = async (id, key) => {
        if (id === r.id) {
          paused.resolve();
          await resume.promise;
        }
        return head(id, key);
      };
      first = f.files.complete(r, a.uploadId, {
        key: a.key,
        parts: a.parts.map((p) => ({ partNumber: p.partNumber, etag: f.storage.put(p.url, 10) })),
      });
    } else {
      await f.upload(r, 'same.csv', 10);
      f.storage.copyFile = async (id, from, to) => {
        await copy(id, from, to);
        paused.resolve();
        await resume.promise;
      };
      first = f.files.rename(r, { from: 'same.csv', to: 'renamed.csv' });
    }
    await paused.promise;
    const manifest = f.files.manifest(r.id);
    const next = f.upload(r, 'same.csv', 20);
    // Deliberately overlap the second mutation with the first provider response.
    const timer = setTimeout(() => resume.resolve(), 30);
    t.after(() => {
      clearTimeout(timer);
      resume.resolve();
    });
    await Promise.all([first, next]);
    assert.deepEqual(
      (await manifest).map(({ key, size }) => ({ key, size })),
      [{ key: operation === 'rename' ? 'renamed.csv' : 'same.csv', size: 10 }],
    );
    f.storage.head = head;
    f.storage.copyFile = copy;
    assert.equal((await head(r.id, 'same.csv'))?.size, 20);
    if (operation === 'rename') assert.equal((await head(r.id, 'renamed.csv'))?.size, 10);
  }
});
