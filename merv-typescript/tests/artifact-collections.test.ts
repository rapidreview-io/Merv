import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createService, MervError, sha256Hex, type Blobs, type Caller } from '@merv/contracts';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';

test('collection is one immutable, scoped artifact; retries and member links use retained references', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-collections-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const owner = await scope.bootstrap({ projectName: 'Collections', actorName: 'Owner' });
  const caller: Caller = { projectId: owner.project.id, actorId: owner.actor.id };
  const other = await scope.bootstrap({ projectName: 'Other', actorName: 'Owner' });
  const outsider: Caller = { projectId: other.project.id, actorId: other.actor.id };
  const input = {
    title: 'Training capture',
    sourceKey: 'capture-1',
    files: [
      {
        name: 'outputs/control.pt',
        size: 123,
        hash: sha256Hex(Buffer.from('control')),
        provider: 'compute',
        reference: 'private-1',
      },
      {
        name: 'outputs/models/augmented.pt',
        size: 456,
        hash: sha256Hex(Buffer.from('augmented')),
        provider: 'compute',
        reference: 'private-2',
      },
    ],
    metadata: { run: 9 },
  };
  const [first, retry] = await Promise.all([
    artifacts.createCollection(caller, input),
    artifacts.createCollection(caller, input),
  ]);
  assert.equal(first.id, retry.id);
  // Fingerprints and manifests stored before artifacts shared contracts' canonical JSON.
  assert.deepEqual(
    await state.read((sql) =>
      sql.get('SELECT hash, collection_input_hash FROM artifacts WHERE id=?', first.id),
    ),
    {
      hash: '212cfbb1b430911cb484608527ed3475d42ba7b2b57ddc2a40d638b487933fff',
      collection_input_hash: 'bbd3ae093b09e2019bc3fba26550a73c1cc5c32b720e04d8b881b5d01c259711',
    },
  );
  assert.equal((await artifacts.list(caller)).length, 1);
  assert.equal(first.files?.length, 2);
  assert.equal(JSON.stringify(first).includes('private-1'), false);
  const manifest = await artifacts.read(caller, first.id);
  assert.equal(first.size, Buffer.byteLength(manifest.content));
  assert.equal(first.hash, sha256Hex(Buffer.from(manifest.content)));
  assert.deepEqual((await artifacts.get(caller, first.id)).files, first.files);
  assert.deepEqual((await artifacts.getMany(caller, [first.id]))[0]?.metadata, input.metadata);
  assert.deepEqual((await artifacts.list(caller))[0]?.files, first.files);
  assert.equal(manifest.encoding, 'utf8');
  assert.equal(manifest.content.includes('private-1'), false);
  assert.deepEqual(JSON.parse(manifest.content).files, first.files);
  const downloaded: string[] = [];
  const dispose = artifacts.registerFileProvider('compute', {
    async download(projectId, reference) {
      downloaded.push(`${projectId}:${reference}`);
      return {
        url: `https://example.invalid/${downloaded.length}`,
        expiresAt: '2026-09-30T13:00:00Z',
      };
    },
  });
  const one = await artifacts.download(caller, first.id, 'outputs/control.pt');
  const two = await artifacts.download(caller, first.id, 'outputs/control.pt');
  assert.notEqual(one.download.url, two.download.url);
  assert.deepEqual(downloaded, [`${caller.projectId}:private-1`, `${caller.projectId}:private-1`]);
  await assert.rejects(artifacts.download(caller, first.id, 'missing.pt'), { code: 'not_found' });
  await assert.rejects(artifacts.download(outsider, first.id, 'outputs/control.pt'), {
    code: 'not_found',
  });
  await assert.rejects(artifacts.get(outsider, first.id), { code: 'not_found' });
  assert.equal(downloaded.length, 2);
  dispose();
  assert.equal((await artifacts.read(caller, first.id)).content, manifest.content);
  await assert.rejects(artifacts.download(caller, first.id, 'outputs/control.pt'), {
    code: 'download_unsupported',
  });
  await assert.rejects(
    artifacts.createCollection(caller, {
      ...input,
      files: [{ ...input.files[0]!, reference: 'different' }, input.files[1]!],
    }),
    { code: 'artifact_source_conflict' },
  );
  assert.equal((await artifacts.list(caller)).length, 1);
});

test('collection rejects duplicate names and malformed file claims before writing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-collections-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const owner = await scope.bootstrap({ projectName: 'Collections', actorName: 'Owner' });
  const caller: Caller = { projectId: owner.project.id, actorId: owner.actor.id };
  const file = {
    name: 'model.pt',
    size: 1,
    hash: 'a'.repeat(64),
    provider: 'compute',
    reference: 'r',
  };
  await assert.rejects(
    artifacts.createCollection(caller, { title: 'X', sourceKey: 'x', files: [file, file] }),
    { code: 'invalid_artifact' },
  );
  await assert.rejects(
    artifacts.createCollection(caller, {
      title: 'X',
      sourceKey: 'x',
      files: [{ ...file, name: '../model.pt' }],
    }),
    { code: 'invalid_artifact' },
  );
  for (const name of [
    '/model.pt',
    './model.pt',
    'a/../model.pt',
    'a//model.pt',
    'a/',
    'a\\model.pt',
    'C:/model.pt',
    'a/./model.pt',
    'a/\u0000model.pt',
  ]) {
    await assert.rejects(
      artifacts.createCollection(caller, {
        title: 'X',
        sourceKey: 'bad',
        files: [{ ...file, name }],
      }),
      { code: 'invalid_artifact' },
    );
    await assert.rejects(artifacts.download(caller, 'missing', name), { code: 'invalid_artifact' });
  }
  await assert.rejects(
    artifacts.createCollection(caller, {
      title: 'Too many',
      sourceKey: 'many',
      files: Array.from({ length: 10_001 }, (_, i) => ({ ...file, name: `files/${i}.txt` })),
    }),
    { code: 'invalid_artifact' },
  );
  assert.deepEqual(await artifacts.list(caller), []);
  const many = await artifacts.createCollection(caller, {
    title: 'Full capture',
    sourceKey: 'full',
    files: Array.from({ length: 10_000 }, (_, i) => ({
      ...file,
      name: `outputs/${'a'.repeat(180)}/${i}.txt`,
    })),
  });
  assert.equal(many.files?.length, 10_000);
  assert.ok(many.size > 2_000_000);
  // Collection registration may retain a large manifest, but ordinary inline reads/creates
  // keep their existing ceiling; member downloads do not need to read the manifest.
  await assert.rejects(artifacts.read(caller, many.id), { code: 'artifact_size' });
  await assert.rejects(
    artifacts.create(caller, { title: 'Ordinary', content: 'x'.repeat(2_000_001) }),
    { code: 'artifact_size' },
  );
  artifacts.registerFileProvider('compute', {
    async download() {
      return { url: 'https://example.invalid/nested', expiresAt: '2026-09-30T13:00:00Z' };
    },
  });
  assert.equal(
    (await artifacts.download(caller, many.id, many.files![9999]!.name)).download.url,
    'https://example.invalid/nested',
  );
});

test('a manifest above the inline blob limit is mirrored by signed upload and downloads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-collections-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const disk = new DiskBlobs(join(directory, 'blobs'));
  const stored = new Map<string, number>();
  // Signed transfers of any size beside Disk's inline puts, as the S3 provider has.
  const blobs: Blobs = {
    put: (namespace, bytes) => disk.put(namespace, bytes),
    get: (namespace, hash) => disk.get(namespace, hash),
    async download(_namespace, hash, size) {
      if (stored.get(hash) !== size) throw new MervError('blob_not_found', 'Blob not found', 404);
      return { url: `https://bucket.invalid/${hash}`, expiresAt: '2026-09-30T13:00:00Z' };
    },
    async upload(_namespace, hash) {
      return {
        url: `https://bucket.invalid/${hash}`,
        headers: { 'if-none-match': '*' },
        expiresAt: '',
      };
    },
  };
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(init.method, 'PUT');
    const bytes = init.body as Uint8Array;
    assert.equal(String(url), `https://bucket.invalid/${sha256Hex(bytes)}`);
    stored.set(sha256Hex(bytes), bytes.length);
    return new Response(null, { status: 200 });
  });
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(new ArtifactStore(state, scope, blobs));
  const owner = await scope.bootstrap({ projectName: 'Collections', actorName: 'Owner' });
  const caller: Caller = { projectId: owner.project.id, actorId: owner.actor.id };
  const many = await artifacts.createCollection(caller, {
    title: 'Full capture',
    sourceKey: 'full',
    files: Array.from({ length: 10_000 }, (_, i) => ({
      name: `outputs/${'a'.repeat(180)}/${i}.txt`,
      size: 1,
      hash: 'a'.repeat(64),
      provider: 'compute',
      reference: 'r',
    })),
  });
  assert.ok(many.size > 2_000_000);
  const { download } = await artifacts.download(caller, many.id);
  assert.equal(download.url, `https://bucket.invalid/${many.hash}`);
});

test('artifact.read selects a collection member only in download mode', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-collections-tool-'));
  const { createApp } = await import('./fixtures/app.js');
  const { stateConfig } = await import('./fixtures/state.js');
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
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Collection tool',
    actorName: 'Owner',
  });
  const caller: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const artifact = await app.ctx.artifacts.createCollection(caller, {
    title: 'Capture',
    sourceKey: 'run',
    files: [
      {
        name: `output/${'d'.repeat(200)}/${'n'.repeat(100)}.pt`,
        size: 5,
        hash: 'a'.repeat(64),
        provider: 'compute',
        reference: 'stored-ref',
      },
    ],
  });
  const seen: string[] = [];
  app.ctx.artifacts.registerFileProvider('compute', {
    async download(projectId, reference) {
      seen.push(`${projectId}:${reference}`);
      return { url: 'https://example.invalid/file', expiresAt: '2026-09-30T13:00:00Z' };
    },
  });
  const result = (await app.ctx.tools.call('artifact.read', caller, {
    artifactId: artifact.id,
    mode: 'download',
    fileName: artifact.files![0]!.name,
  })) as { download: { url: string } };
  assert.equal(result.download.url, 'https://example.invalid/file');
  assert.deepEqual(seen, [`${caller.projectId}:stored-ref`]);
  await assert.rejects(
    app.ctx.tools.call('artifact.read', caller, {
      artifactId: artifact.id,
      fileName: artifact.files![0]!.name,
    }),
    { code: 'invalid_artifact' },
  );
  await assert.rejects(
    app.ctx.tools.call('artifact.read', caller, {
      artifactId: artifact.id,
      mode: 'download',
      fileName: 'other.pt',
    }),
    { code: 'not_found' },
  );
});
