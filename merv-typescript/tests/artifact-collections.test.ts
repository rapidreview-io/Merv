import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createService, sha256Hex, type Caller } from '@merv/contracts';
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
        name: 'control.pt',
        size: 123,
        hash: sha256Hex(Buffer.from('control')),
        provider: 'compute',
        reference: 'private-1',
      },
      {
        name: 'augmented.pt',
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
  const one = await artifacts.download(caller, first.id, 'control.pt');
  const two = await artifacts.download(caller, first.id, 'control.pt');
  assert.notEqual(one.download.url, two.download.url);
  assert.deepEqual(downloaded, [`${caller.projectId}:private-1`, `${caller.projectId}:private-1`]);
  await assert.rejects(artifacts.download(caller, first.id, 'missing.pt'), { code: 'not_found' });
  await assert.rejects(artifacts.download(outsider, first.id, 'control.pt'), { code: 'not_found' });
  await assert.rejects(artifacts.get(outsider, first.id), { code: 'not_found' });
  assert.equal(downloaded.length, 2);
  dispose();
  assert.equal((await artifacts.read(caller, first.id)).content, manifest.content);
  await assert.rejects(artifacts.download(caller, first.id, 'control.pt'), {
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
  assert.deepEqual(await artifacts.list(caller), []);
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
        name: 'model.pt',
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
    fileName: 'model.pt',
  })) as { download: { url: string } };
  assert.equal(result.download.url, 'https://example.invalid/file');
  assert.deepEqual(seen, [`${caller.projectId}:stored-ref`]);
  await assert.rejects(
    app.ctx.tools.call('artifact.read', caller, { artifactId: artifact.id, fileName: 'model.pt' }),
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
