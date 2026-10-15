import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { MervError, type Caller } from '@merv/contracts';
import type { ApiRequest } from '@merv/api/types';
import { RequestBuckets } from '../packages/customer-experiments/src/data.js';
import {
  deletionSchedule,
  FILES_LIMIT_BYTES,
  FilesService,
  folderView,
  MAX_PARTS,
  normalizeKey,
  normalizePrefix,
  partCount,
  partLength,
  partSize,
  type FilesLifecycle,
  type RequestFileStorage,
  type StoredFile,
} from '../packages/customer-experiments/src/files.js';
import { filesHttp, isFilesPath } from '../packages/customer-experiments/src/files-http.js';
import { CustomerAccess } from '../packages/customer-experiments/src/access.js';
import { RequestStore } from '../packages/customer-experiments/src/store.js';
import { registerWorkerTools } from '../packages/customer-experiments/src/worker-tools.js';
import type { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import { openState } from './fixtures/state.js';

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

test('part size fits a terabyte in 10,000 whole-MiB parts of at least 8 MiB', () => {
  assert.equal(partSize(0), 8 * MIB);
  assert.equal(partSize(10 * MIB), 8 * MIB);
  assert.equal(partCount(0), 1);
  assert.equal(partLength(0, 8 * MIB, 1), 0);
  for (const size of [1, 8 * MIB, 8 * MIB + 1, 81_920 * MIB, FILES_LIMIT_BYTES]) {
    const part = partSize(size),
      count = partCount(size);
    assert.equal(part % MIB, 0);
    assert.ok(count <= MAX_PARTS, `${size} needs ${count} parts`);
    let total = 0;
    for (let n = 1; n <= count; n++) total += partLength(size, part, n);
    assert.equal(total, size);
    assert.ok(partLength(size, part, count) > 0);
  }
  assert.equal(
    partCount(FILES_LIMIT_BYTES),
    Math.ceil(FILES_LIMIT_BYTES / partSize(FILES_LIMIT_BYTES)),
  );
});

test('a folder level lists subfolders with their total size and pages its own files', () => {
  const file = (key: string, size = 1): StoredFile => ({
    key,
    size,
    etag: '"e"',
    uploaded: '2026-10-14T00:00:00.000Z',
  });
  const all = [
    file('top.txt', 5),
    file('a/one.csv', 10),
    file('a/b/two.csv', 20),
    file('c/three.csv', 30),
  ];
  assert.deepEqual(folderView(all, ''), {
    folders: [
      { prefix: 'a/', size: 30, count: 2 },
      { prefix: 'c/', size: 30, count: 1 },
    ],
    files: [{ key: 'top.txt', size: 5, uploaded: '2026-10-14T00:00:00.000Z' }],
    cursor: null,
  });
  assert.deepEqual(folderView(all, 'a/').folders, [{ prefix: 'a/b/', size: 20, count: 1 }]);
  const many = Array.from({ length: 1500 }, (_, i) => file(`f${String(i).padStart(4, '0')}`));
  const first = folderView(many, '');
  assert.equal(first.files.length, 1000);
  const second = folderView(many, '', first.cursor!);
  assert.equal(second.files.length, 500);
  assert.equal(second.files[0]!.key, 'f1000');
  assert.equal(second.cursor, null);
});

test('files end 48 hours after completion, failure, or seven quiet days before payment', () => {
  const day = 86400_000,
    ago = (ms: number) => new Date(Date.now() - ms).toISOString();
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
  assert.equal(Date.parse(quiet!.endedAt), Date.now() - 8 * day + 7 * day);
  // A customer returning before deletion keeps the request open.
  assert.equal(
    deletionSchedule(record, { version: 3, state: 'planning', updatedAt: ago(9 * day) }, ago(day)),
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
  await storage.provisionFiles(id);
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

test('v3 request files: upload, list, rename, delete, download, manifest and the 1 TB cap', async () => {
  const f = await fixture();
  const old = await f.request(2);
  await assert.rejects(f.files.list(old), code('not_found'));
  await assert.rejects(
    new FilesService(f.state, f.store, undefined, async () => f.lifecycles.get(old.id)!).list(old),
    code('files_unavailable'),
  );

  const r = await f.request();
  assert.deepEqual((await f.files.list(r)).files, []);
  assert.deepEqual(await f.files.manifest(r.id), []);
  assert.deepEqual(await f.upload(r, '/data/train.csv', 10), {
    key: 'data/train.csv',
    size: 10,
    uploaded: f.storage.buckets.get(r.id)!.get('data/train.csv')!.uploaded,
  });
  await f.upload(r, 'data/nested/eval.csv', 20);
  await f.upload(r, 'paper.pdf', 30);
  const root = await f.files.list(r);
  assert.deepEqual(root.folders, [{ prefix: 'data/', size: 30, count: 2 }]);
  assert.deepEqual(
    root.files.map((x) => x.key),
    ['paper.pdf'],
  );
  assert.equal(root.totalBytes, 60);
  assert.equal(root.limitBytes, FILES_LIMIT_BYTES);
  assert.equal(root.deleteAt, null);
  assert.equal(root.deletionPolicy, 'Deleted 48 hours after the experiment ends');

  // Multi-part: the first batch is presigned with the create, the rest on request.
  const size = 150 * 8 * MIB + 3;
  const created = await f.files.createUpload(r, { key: 'big.bin', size });
  assert.equal(created.partSize, 8 * MIB);
  assert.equal(created.partCount, 151);
  assert.equal(created.parts.length, 100);
  const more = await f.files.parts(r, created.uploadId, {
    key: 'big.bin',
    partNumbers: Array.from({ length: 51 }, (_, i) => i + 101),
  });
  await assert.rejects(
    f.files.parts(r, created.uploadId, { key: 'big.bin', partNumbers: [152] }),
    code('invalid_part'),
  );
  await assert.rejects(
    f.files.parts(r, created.uploadId, { key: 'other.bin', partNumbers: [1] }),
    code('not_found'),
  );
  const all = [...created.parts, ...more.parts];
  await assert.rejects(
    f.files.complete(r, created.uploadId, { key: 'big.bin', parts: [] }),
    code('invalid_part'),
  );
  assert.equal(
    (
      await f.files.complete(r, created.uploadId, {
        key: 'big.bin',
        parts: all.map((p) => ({
          partNumber: p.partNumber,
          etag: f.storage.put(p.url, partLength(size, created.partSize, p.partNumber)),
        })),
      })
    ).size,
    size,
  );

  // A part short of its declared size leaves no file behind.
  const short = await f.files.createUpload(r, { key: 'short.bin', size: 5 });
  f.storage.uploads.get(short.uploadId)!.parts.set(1, 4);
  await assert.rejects(
    f.files.complete(r, short.uploadId, {
      key: 'short.bin',
      parts: [{ partNumber: 1, etag: 'x' }],
    }),
    code('invalid_upload'),
  );
  assert.equal(await f.storage.head(r.id, 'short.bin'), null);

  // Abort releases a pending upload's share of the cap.
  const pending = await f.files.createUpload(r, {
    key: 'pending.bin',
    size: FILES_LIMIT_BYTES / 2,
  });
  await assert.rejects(
    f.files.createUpload(r, { key: 'over.bin', size: FILES_LIMIT_BYTES / 2 }),
    code('files_limit'),
  );
  await f.files.abort(r, pending.uploadId, 'pending.bin');
  assert.equal(f.storage.uploads.has(pending.uploadId), false);
  await assert.rejects(
    f.files.createUpload(r, { key: 'over.bin', size: FILES_LIMIT_BYTES }),
    code('files_limit'),
  );
  await assert.rejects(f.files.createUpload(r, { key: '../escape', size: 1 }), code('invalid_key'));

  // Rename a file, then a folder with everything under it.
  assert.deepEqual(await f.files.rename(r, { from: 'paper.pdf', to: 'docs/paper.pdf' }), {
    renamed: 1,
  });
  await assert.rejects(
    f.files.rename(r, { from: 'big.bin', to: 'docs/paper.pdf' }),
    code('file_exists'),
  );
  assert.deepEqual(await f.files.rename(r, { from: 'data/', to: 'inputs' }), { renamed: 2 });
  await assert.rejects(f.files.rename(r, { from: 'inputs', to: 'inputs/x' }), code('invalid_key'));
  await assert.rejects(f.files.rename(r, { from: 'missing', to: 'x' }), code('not_found'));
  assert.deepEqual(
    (await f.files.manifest(r.id)).map((m) => m.key),
    ['big.bin', 'docs/paper.pdf', 'inputs/nested/eval.csv', 'inputs/train.csv'],
  );
  assert.deepEqual(Object.keys((await f.files.manifest(r.id))[0]!), ['key', 'size', 'etag']);

  assert.deepEqual(await f.files.remove(r, { prefix: 'inputs' }), { deleted: 2 });
  assert.deepEqual(await f.files.remove(r, { key: 'big.bin' }), { deleted: 1 });
  await assert.rejects(f.files.remove(r, { key: 'big.bin' }), code('not_found'));
  await assert.rejects(f.files.remove(r, { prefix: '/' }), code('invalid_key'));
  assert.match((await f.files.download(r, '/docs/paper.pdf')).url, /docs\/paper\.pdf\?get$/);
  await assert.rejects(f.files.download(r, 'nope'), code('not_found'));

  // The accepted contract freezes the files; reads go on.
  f.lifecycles.set(r.id, { version: 3, state: 'ready', updatedAt: new Date().toISOString() });
  await assert.rejects(f.files.createUpload(r, { key: 'late', size: 1 }), code('files_frozen'));
  await assert.rejects(f.files.remove(r, { key: 'docs/paper.pdf' }), code('files_frozen'));
  await assert.rejects(f.files.rename(r, { from: 'docs/', to: 'd' }), code('files_frozen'));
  assert.equal((await f.files.manifest(r.id)).length, 1);
});

test('the sweeper deletes every object and the bucket at deleteAt and records it', async () => {
  const f = await fixture();
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
