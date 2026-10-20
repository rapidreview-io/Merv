import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createService,
  MervError,
  sha256Hex,
  type Artifact,
  type Blobs,
  type Caller,
} from '@merv/contracts';
import type { ArtifactFile } from '@merv/contracts/artifact-models';
import { ArtifactStore } from '@merv/artifacts';
import { artifactToolsPlugin } from '@merv/artifacts/tools';
import type { NounDefinition } from '@merv/api/types';
import { noun } from '../packages/api/src/noun.js';
import { DiskBlobs } from '@merv/blobs';
import type { z } from 'zod';
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
  const owner = await scope.credentials.bootstrap({
    projectName: 'Collections',
    actorName: 'Owner',
  });
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

/** A succeeded capture's collection record, holding `files`. */
const capture = (files: ArtifactFile[]) => ({
  id: 'art_capture',
  projectId: 'project_1',
  createdBy: 'actor_1',
  title: 'Capture',
  mediaType: 'application/vnd.merv.collection+json',
  hash: 'a'.repeat(64),
  size: 10,
  createdAt: '2026-10-18T00:00:00.000Z',
  files,
  metadata: { captureState: 'succeeded' },
});
/** The artifact tools by name, registered over a stub of the artifacts service. */
function toolsOver(artifacts: object) {
  const tools = new Map<
    string,
    { handler: (caller: Caller, input: object) => unknown; inputSchema: z.ZodTypeAny }
  >();
  artifactToolsPlugin.apply({
    artifacts,
    tools: {
      register: (tool: { name: string }) => void tools.set(tool.name, tool as never),
      // Each retired name runs its action with its own flat input, as the registry's alias does.
      noun: (name: string, definition: NounDefinition) => {
        tools.set(name, noun(name, definition) as never);
        for (const action of Object.values(definition.actions))
          for (const was of action.was ?? [])
            tools.set(was, { handler: action.handler, inputSchema: action.input });
      },
      contributeInstructions: () => () => {},
      contributePicture: () => () => {},
    },
    effect: (fn: () => unknown) => fn(),
  } as never);
  return tools;
}

test('artifact.list gives an agent each collection’s member count, and a person its members', async () => {
  const collection = capture([
    { name: 'run/metrics.json', size: 2, hash: 'b'.repeat(64), provider: 'compute' },
  ]);
  const tools = toolsOver({ list: async () => [collection], downloadAvailable: true });
  const list = (caller: Partial<Caller>) =>
    tools
      .get('artifact.list')!
      .handler({ actorId: 'actor_1', projectId: 'project_1', ...caller }, {});
  const { files: _, ...named } = collection;
  for (const agent of [
    { session: { id: 'session_1' } },
    { conversation: { id: 'c', epoch: 1, commandId: 'k', runtimeId: 'r' } },
  ])
    assert.deepEqual(await list(agent), [{ ...named, fileCount: 1, downloadAvailable: true }]);
  assert.deepEqual(await list({}), [{ ...collection, downloadAvailable: true }]);
});

test('artifact.get gives an agent a collection’s members a page at a time, by prefix', async () => {
  const member = (name: string) => ({
    name,
    size: 142_310,
    hash: 'b'.repeat(64),
    provider: 'sandboxes-native',
  });
  // Shaped like the 940-member capture whose every get was 174,060 characters.
  const files = [
    ...Array.from({ length: 900 }, (_, i) => member(`pilot-a2-complete/shards/${i}/MANIFEST.json`)),
    ...Array.from({ length: 40 }, (_, i) => member(`pilot-a2-complete/metrics/${i}.json`)),
  ];
  const collection = capture(files);
  const { files: _, ...rest } = collection;
  const plain = { ...rest, id: 'art_notes', mediaType: 'text/markdown' };
  const tool = toolsOver({
    get: async (_: Caller, id: string) => (id === plain.id ? plain : collection),
    downloadAvailable: true,
  }).get('artifact.get')!;
  const agent: Caller = { actorId: 'actor_1', projectId: 'project_1', session: { id: 's' } };
  const person: Caller = { actorId: 'actor_1', projectId: 'project_1' };
  type Answer = Artifact & { fileCount?: number; matchCount?: number; nextOffset?: number };
  const get = async (caller: Caller, input: object = {}) =>
    (await tool.handler(
      caller,
      tool.inputSchema.parse({ artifactId: collection.id, ...input }),
    )) as Answer;
  const names = (members?: ArtifactFile[]) => members!.map((file) => file.name);

  // Unasked, a session's or Pi conversation's agent gets the first 100 members, how many there
  // are, and where the next start.
  const conversation = { id: 'c', epoch: 1, commandId: 'k', runtimeId: 'r' };
  for (const caller of [agent, { ...person, conversation }]) {
    const first = await get(caller);
    assert.deepEqual(names(first.files), names(files.slice(0, 100)));
    assert.equal(first.fileCount, 940);
    assert.equal(first.nextOffset, 100);
    assert.equal(first.matchCount, undefined);
    assert.deepEqual(first.metadata, collection.metadata);
    assert.equal((first as { downloadAvailable?: boolean }).downloadAvailable, true);
    assert.ok(JSON.stringify(first).length < 25_000, String(JSON.stringify(first).length));
  }
  // The pages tile the collection in its own order.
  const pages: string[] = [];
  for (let offset: number | undefined = 0; offset !== undefined;) {
    const page = await get(agent, { offset, limit: 300 });
    pages.push(...names(page.files));
    offset = page.nextOffset;
  }
  assert.deepEqual(pages, names(files));
  // A prefix keeps the members under a path and says how many there are.
  const metrics = await get(agent, { prefix: 'pilot-a2-complete/metrics/' });
  assert.deepEqual(names(metrics.files), names(files.slice(900)));
  assert.deepEqual(
    [metrics.matchCount, metrics.nextOffset, metrics.fileCount],
    [40, undefined, 940],
  );
  const late = await get(agent, { prefix: 'pilot-a2-complete/shards/', offset: 850 });
  assert.deepEqual([late.files!.length, late.matchCount, late.nextOffset], [50, 900, undefined]);
  assert.deepEqual((await get(agent, { prefix: 'nothing/' })).files, []);
  assert.deepEqual((await get(agent, { offset: 5_000 })).files, []);
  // A person's Files page still gets every member unless it asks for a page.
  const whole = await get(person);
  assert.deepEqual(whole.files, files);
  assert.deepEqual([whole.fileCount, whole.nextOffset], [940, undefined]);
  assert.deepEqual(names((await get(person, { limit: 2 })).files), names(files.slice(0, 2)));
  // A file that is not a collection is its record, whatever the paging asks.
  assert.deepEqual(await tool.handler(agent, { artifactId: plain.id, limit: 5 }), {
    ...plain,
    downloadAvailable: true,
  });
  for (const input of [{ limit: 0 }, { limit: 1_001 }, { offset: -1 }, { prefix: '' }])
    assert.equal(tool.inputSchema.safeParse({ artifactId: 'a', ...input }).success, false);
});
