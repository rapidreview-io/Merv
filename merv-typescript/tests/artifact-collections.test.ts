import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { createService, sha256Hex, type Artifact, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  const owner = await scope.credentials.bootstrap({
    projectName: 'Collections',
    actorName: 'Owner',
  });
  const caller: Caller = { projectId: owner.project.id, actorId: owner.actor.id };
  const other = await scope.credentials.bootstrap({ projectName: 'Other', actorName: 'Owner' });
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
  const owner = await scope.credentials.bootstrap({
    projectName: 'Collections',
    actorName: 'Owner',
  });
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

test('artifact.read reads a member inline or links members, naming the collection without them', async (t) => {
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
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Collection tool',
    actorName: 'Owner',
  });
  const caller: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  // What each member's provider link serves.
  const bytes = new Map([
    ['stored-ref', Buffer.from('{"accuracy": 0.91}\n')],
    ['model-ref', Buffer.from([0, 1, 2, 3, 4])],
  ]);
  const long = `output/${'d'.repeat(200)}/${'n'.repeat(100)}.pt`;
  const artifact = await app.ctx.artifacts.createCollection(caller, {
    title: 'Capture',
    sourceKey: 'run',
    files: [
      ...[
        ['run-a/metrics.json', 'stored-ref'],
        [long, 'model-ref'],
      ].map(([name, reference]) => ({
        name: name!,
        size: bytes.get(reference!)!.length,
        hash: sha256Hex(bytes.get(reference!)!),
        provider: 'compute',
        reference: reference!,
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        name: `run-a/logs/${i}.txt`,
        size: 1,
        hash: 'a'.repeat(64),
        provider: 'compute',
        reference: 'log-ref',
      })),
    ],
  });
  const seen: string[] = [];
  app.ctx.artifacts.registerFileProvider('compute', {
    async download(projectId, reference) {
      seen.push(`${projectId}:${reference}`);
      return { url: `https://example.invalid/${reference}`, expiresAt: '2026-09-30T13:00:00Z' };
    },
  });
  const served = new Map(bytes);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const body = served.get(new URL(url).pathname.slice(1));
    return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 });
  });
  const read = (input: Record<string, unknown>) =>
    app.ctx.tools.call('artifact.read', caller, { artifactId: artifact.id, ...input }) as Promise<
      Record<string, unknown> & { artifact: Record<string, unknown> }
    >;
  // Every answer names the collection and how many members it has, never all of them.
  const named = { ...artifact, files: undefined, fileCount: 52 };
  delete named.files;

  // A member reads inline, whole or by range, as text or base64.
  assert.deepEqual(await read({ fileName: 'run-a/metrics.json' }), {
    artifact: named,
    content: '{"accuracy": 0.91}\n',
    encoding: 'utf8',
    fileName: 'run-a/metrics.json',
  });
  assert.deepEqual(await read({ fileName: 'run-a/metrics.json', offset: 2, length: 8 }), {
    artifact: named,
    content: 'accuracy',
    encoding: 'utf8',
    offset: 2,
    total: 19,
    fileName: 'run-a/metrics.json',
  });
  assert.equal((await read({ fileName: long })).content, 'AAECAwQ=');
  // Bytes other than the retained ones are refused, not shown.
  served.set('stored-ref', Buffer.from('{"accuracy": 0.99}\n'));
  await assert.rejects(read({ fileName: 'run-a/metrics.json' }), { code: 'blob_corrupt' });
  served.delete('stored-ref');
  await assert.rejects(read({ fileName: 'run-a/metrics.json' }), { code: 'blob_unavailable' });

  // One member's link, or many at once in the order named, each with its size and hash.
  seen.length = 0;
  const one = await read({ mode: 'download', fileName: long });
  assert.deepEqual(one, {
    artifact: named,
    download: { url: 'https://example.invalid/model-ref', expiresAt: '2026-09-30T13:00:00Z' },
  });
  const many = await read({
    mode: 'download',
    fileNames: [long, 'run-a/metrics.json', 'run-a/logs/7.txt'],
  });
  assert.deepEqual(many.artifact, named);
  assert.deepEqual(
    (many.downloads as { name: string; url: string }[]).map(({ name, url }) => [name, url]),
    [
      [long, 'https://example.invalid/model-ref'],
      ['run-a/metrics.json', 'https://example.invalid/stored-ref'],
      ['run-a/logs/7.txt', 'https://example.invalid/log-ref'],
    ],
  );
  assert.deepEqual((many.downloads as Record<string, unknown>[])[1], {
    name: 'run-a/metrics.json',
    size: 19,
    hash: sha256Hex(bytes.get('stored-ref')!),
    url: 'https://example.invalid/stored-ref',
    expiresAt: '2026-09-30T13:00:00Z',
  });
  assert.deepEqual(seen, [
    `${caller.projectId}:model-ref`,
    ...['model-ref', 'stored-ref', 'log-ref'].map((r) => `${caller.projectId}:${r}`),
  ]);
  // A download takes no range: the flat tool ignored one.
  assert.deepEqual(await read({ mode: 'download', fileName: long, offset: 0, length: 10 }), one);
  // fileNames are download's alone: content takes no such field.
  await assert.rejects(read({ fileNames: ['run-a/metrics.json'] }), { code: 'invalid_input' });
  for (const input of [
    { mode: 'download', fileName: long, fileNames: [long] },
    { mode: 'download', fileNames: [long, long] },
  ])
    await assert.rejects(read(input), { code: 'invalid_artifact' });
  await assert.rejects(
    read({
      mode: 'download',
      fileNames: Array.from({ length: 101 }, (_, i) => `run-a/logs/${i}.txt`),
    }),
    { code: 'invalid_input' },
  );

  // A name that is not a member says which members were likely meant.
  await assert.rejects(read({ mode: 'download', fileName: 'metrics.json' }), {
    code: 'not_found',
    message: 'Collection file "metrics.json" not found; did you mean "run-a/metrics.json"?',
    details: { fileName: 'metrics.json', fileCount: 52, candidates: ['run-a/metrics.json'] },
  });
  await assert.rejects(read({ fileName: 'other.pt' }), {
    code: 'not_found',
    message:
      /^Collection file "other\.pt" not found; members are named by their whole path in the collection, such as "/,
  });
  const plain = await app.ctx.artifacts.create(caller, { title: 'Notes', content: 'text' });
  await assert.rejects(
    app.ctx.tools.call('artifact.read', caller, { artifactId: plain.id, fileName: 'notes.md' }),
    { code: 'invalid_artifact', message: /not a collection/ },
  );

  // The manifest and the collection's own record still name every member.
  assert.deepEqual(JSON.parse((await read({})).content as string).files, artifact.files);
  assert.deepEqual(
    ((await app.ctx.tools.call('artifact.get', caller, { artifactId: artifact.id })) as Artifact)
      .files,
    artifact.files,
  );
});
