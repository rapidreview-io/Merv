import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { S3Blobs } from '@merv/blobs';
import type { Artifact, Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { importLegacyFoundation } from '../src/legacy-import.js';
import { s3Server } from './fixtures/s3-server.js';
import { stateConfig } from './fixtures/state.js';

async function fixture(t: TestContext, s3 = true) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-download-'));
  const server = s3 ? await s3Server() : undefined;
  const module = join(directory, 'test-blobs.mjs');
  if (server)
    await writeFile(
      module,
      `import { S3Blobs } from ${JSON.stringify(new URL('../packages/blobs/src/index.ts', import.meta.url).href)};
export default { name: 'merv-blobs', apply(ctx) {
 const blobs = new S3Blobs({ bucket:'merv-artifacts', endpoint:${JSON.stringify(server.endpoint)},
  accessKeyId:'fixture-access-key', secretAccessKey:'fixture-secret-key', prefix:'new',
  allowHttpLoopbackForTests:true, timeoutMs:5000, maxAttempts:1 });
 ctx.effect(function* () { yield () => blobs.close(); yield ctx.provide('blobs',blobs); });
} };`,
    );
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        {
          id: 'blobs',
          name: server ? pathToFileURL(module).href : '@merv/blobs',
          config: server ? {} : { root: join(directory, 'blobs') },
        },
        { id: 'artifacts', name: '@merv/artifacts' },
        { id: 'tools', name: '@merv/api/tools-plugin' },
        { id: 'artifact-tools', name: '@merv/artifacts/tools' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, server };
}

async function imported(t: TestContext) {
  const f = await fixture(t);
  const bytes = Buffer.alloc(2_000_001, 97);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const source = new S3Blobs({
    bucket: 'merv-artifacts',
    endpoint: f.server!.endpoint,
    accessKeyId: 'fixture-access-key',
    secretAccessKey: 'fixture-secret-key',
    prefix: 'old',
    allowHttpLoopbackForTests: true,
  });
  t.after(() => source.close());
  f.server!.objects.set(`old/project_retained/${hash}`, bytes);
  const snapshot = {
    sourceId: 'large-download-rehearsal',
    schemaVersion: 81,
    issuer: 'https://shared.example/auth/v1',
    projects: [
      {
        id: 'project_retained',
        name: 'Retained',
        summary: '',
        status: 'active',
        created_at: '2026-08-01T00:00:00Z',
      },
    ],
    memberships: [
      { project_id: 'project_retained', user_id: 'shared-user', added_at: '2026-08-01T00:00:00Z' },
    ],
    artifacts: [
      {
        id: 'artifact_retained',
        project_id: 'project_retained',
        title: 'Large evidence',
        path: 'evidence.bin',
        created_by: 'old-agent',
        created_at: '2026-08-01T00:00:00Z',
        status: 'complete',
        content_type: 'application/octet-stream',
        content_sha256: hash,
        size_bytes: bytes.length,
      },
    ],
    claims: [],
  };
  const services = {
    state: f.app.ctx.state,
    sourceBlobs: source,
    destinationBlobs: f.app.ctx.blobs,
    copyArtifact: (projectId: string, key: string, size: number) =>
      (f.app.ctx.blobs as S3Blobs).copyVerifiedFrom(source, projectId, key, size),
  };
  const receipt = await importLegacyFoundation(services, snapshot);
  const count = f.server!.requests.length;
  assert.deepEqual(await importLegacyFoundation(services, snapshot), receipt);
  assert.equal(f.server!.requests.length, count, 'Exact replay does not copy or download again');
  const principal = await f.app.ctx.scope.acceptVerifiedIdentity({
    issuer: snapshot.issuer,
    subject: 'shared-user',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const operator = await f.app.ctx.scope.caller(principal, 'project_retained');
  const worker = await f.app.ctx.scope.issueActor(operator, { name: 'Reader', role: 'producer' });
  const caller: Caller = { actorId: worker.actor.id, projectId: operator.projectId };
  return { ...f, operator, caller, bytes, hash };
}

test('imported large artifacts remain accessible through the existing tool while inline reads stay bounded', async (t) => {
  const f = await imported(t);
  const metadata = (await f.app.ctx.tools.call('artifact.get', f.caller, {
    artifactId: 'artifact_retained',
  })) as Artifact & { downloadAvailable: boolean };
  assert.equal(metadata.id, 'artifact_retained');
  assert.equal(metadata.downloadAvailable, true);
  assert.equal(metadata.createdBy, 'old-agent');
  await assert.rejects(
    f.app.ctx.tools.call('artifact.read', f.caller, { artifactId: metadata.id }),
    { code: 'artifact_size' },
  );
  const link = (await f.app.ctx.tools.call('artifact.read', f.caller, {
    artifactId: metadata.id,
    mode: 'download',
  })) as { download: { url: string } };
  assert.deepEqual(Buffer.from(await (await fetch(link.download.url)).arrayBuffer()), f.bytes);
  assert.deepEqual(
    f.server!.objects.get(`old/project_retained/${f.hash}`),
    f.bytes,
    'Source stays untouched',
  );
});

test('artifact downloads reject other projects and arbitrary keys before storage access', async (t) => {
  const f = await imported(t);
  const outsider = await f.app.ctx.scope.bootstrap({
    projectName: 'Other',
    actorName: 'Other operator',
  });
  const other = { actorId: outsider.actor.id, projectId: outsider.project.id };
  const count = f.server!.requests.length;
  await assert.rejects(
    f.app.ctx.tools.call('artifact.read', other, {
      artifactId: 'artifact_retained',
      mode: 'download',
    }),
    { code: 'not_found' },
  );
  await assert.rejects(
    f.app.ctx.tools.call('artifact.read', f.caller, {
      artifactId: 'artifact_retained',
      mode: 'download',
      hash: f.hash,
      projectId: other.projectId,
    }),
    { code: 'invalid_input' },
  );
  assert.equal(f.server!.requests.length, count);
});

test('revocation during download preparation prevents URL issuance and later requests', async (t) => {
  const f = await imported(t);
  const held = f.server!.holdNext('HEAD');
  const pending = f.app.ctx.tools.call('artifact.read', f.caller, {
    artifactId: 'artifact_retained',
    mode: 'download',
  });
  const rejected = assert.rejects(pending, { code: 'forbidden' });
  await held.started;
  await f.app.ctx.scope.revokeActor(f.operator, f.caller.actorId);
  held.release();
  await rejected;
  const count = f.server!.requests.length;
  await assert.rejects(
    f.app.ctx.tools.call('artifact.read', f.caller, {
      artifactId: 'artifact_retained',
      mode: 'download',
    }),
    { code: 'forbidden' },
  );
  assert.equal(f.server!.requests.length, count);
});

test('Disk advertises no direct download capability and retains ordinary inline reading', async (t) => {
  const { app } = await fixture(t, false);
  const identity = await app.ctx.scope.bootstrap({ projectName: 'Disk', actorName: 'Operator' });
  const caller = { actorId: identity.actor.id, projectId: identity.project.id };
  const artifact = await app.ctx.artifacts.create(caller, {
    title: 'Small',
    content: 'Small inline document.',
  });
  assert.equal(
    (
      (await app.ctx.tools.call('artifact.get', caller, { artifactId: artifact.id })) as {
        downloadAvailable: boolean;
      }
    ).downloadAvailable,
    false,
  );
  assert.equal(
    (await app.ctx.artifacts.read(caller, artifact.id)).content,
    'Small inline document.',
  );
  await assert.rejects(
    app.ctx.tools.call('artifact.read', caller, { artifactId: artifact.id, mode: 'download' }),
    { code: 'download_unsupported' },
  );
  // Text carrying NUL decodes as UTF-8 but cannot be written back, so it is read as base64
  // and the answer round-trips to an identical artifact.
  const binary = await app.ctx.artifacts.create(caller, {
    title: 'NUL bytes',
    content: Buffer.from('a\0b').toString('base64'),
    encoding: 'base64',
    mediaType: 'text/plain',
  });
  const read = await app.ctx.artifacts.read(caller, binary.id);
  assert.equal(read.encoding, 'base64');
  const again = await app.ctx.artifacts.create(caller, {
    title: 'NUL bytes again',
    content: read.content,
    encoding: read.encoding,
    mediaType: 'text/plain',
  });
  assert.equal(again.hash, binary.hash);
});
