import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxArtifactStorage } from '../packages/sandboxes/src/artifact-storage.js';
import { createApp } from './fixtures/app.js';
import { stateConfig } from './fixtures/state.js';

test('artifact object requests use the ML project subject and surface its storage cap', async (t) => {
  const original = globalThis.fetch;
  const tokenEnv = 'MERV_ARTIFACT_STORAGE_TEST_GRANT';
  process.env[tokenEnv] = 'sbxt_test_consumer_grant';
  const seen: { path: string; subject: string | null; body?: any }[] = [];
  let cap = false;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const subject = new Headers(init?.headers).get('x-sandbox-subject');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    seen.push({ path, subject, body });
    const json = (value: object, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/v1/auth/me') return json({ role: 'consumer', namespace: 'merv-ml' });
    if (path === '/v1/storage/objects' && cap)
      return json(
        {
          error: {
            code: 'capacity_unavailable',
            message: 'member storage quota would be exceeded',
            details: { reason: 'storage_cap_exceeded' },
          },
        },
        503,
      );
    if (path === '/v1/storage/objects')
      return json(
        {
          object: { id: 'obj_one' },
          part_size: 5,
          part_count: 1,
          completed_parts: [],
          next_part: null,
          parts: [
            { part_number: 1, size_bytes: 5, url: 'https://bucket.example/part', headers: {} },
          ],
        },
        201,
      );
    if (path.endsWith('/upload'))
      return json({
        part_size: 5,
        part_count: 1,
        completed_parts: [1],
        next_part: null,
        parts: [],
      });
    if (path.endsWith('/complete'))
      return json({ id: 'obj_one', size_bytes: 5, sha256: 'a'.repeat(64), state: 'available' });
    if (path.endsWith('/download-short')) return json({ url: 'https://bucket.example/file' });
    throw new Error(`Unexpected ${path}`);
  };
  t.after(() => {
    globalThis.fetch = original;
    delete process.env[tokenEnv];
  });
  const storage = new SandboxArtifactStorage('https://sandbox.example', 1000, {
    namespace: 'merv-ml',
    tokenEnv,
    storageOrigins: ['https://bucket.example'],
  });
  const input = { title: 'Rows', size: 5, sha256: 'a'.repeat(64), mediaType: 'text/csv' };
  const begun = await storage.begin('project_one', 'aup_one', input);
  assert.equal(begun.objectId, 'obj_one');
  assert.equal(begun.status.parts[0]?.url, 'https://bucket.example/part');
  assert.deepEqual(seen.find((entry) => entry.path === '/v1/storage/objects')?.body, {
    name: 'artifacts/aup_one',
    idempotency_key: 'aup_one',
    sha256: input.sha256,
    size_bytes: 5,
    content_type: 'text/csv',
    retain_until_deleted: true,
  });
  assert.deepEqual((await storage.resume('project_one', 'obj_one', 1)).completedParts, [1]);
  assert.equal((await storage.complete('project_one', 'obj_one')).state, 'available');
  assert.equal(
    (await storage.download('project_one', 'obj_one')).url,
    'https://bucket.example/file',
  );
  assert.ok(seen.every((entry) => entry.subject === 'project_one'));
  const directory = await mkdtemp(join(tmpdir(), 'merv-sandbox-artifact-'));
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
  const unbind = app.ctx.artifacts.bindLarge(storage);
  t.after(async () => {
    unbind();
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Rows', actorName: 'Owner' });
  const owner = { actorId: boot.actor.id, projectId: boot.project.id };
  const upload = (await app.ctx.tools.call('artifact.upload_begin', owner, input)) as {
    uploadId: string;
  };
  const artifact = (await app.ctx.tools.call('artifact.upload_complete', owner, {
    uploadId: upload.uploadId,
  })) as { id: string; objectId: string };
  assert.equal(artifact.objectId, 'obj_one');
  assert.equal(
    (
      (await app.ctx.tools.call('artifact.read', owner, {
        artifactId: artifact.id,
        mode: 'download',
      })) as { download: { url: string } }
    ).download.url,
    'https://bucket.example/file',
  );
  assert.ok(
    seen.some((entry) => entry.path === '/v1/storage/objects' && entry.subject === owner.projectId),
  );
  cap = true;
  await assert.rejects(storage.begin('project_two', 'aup_two', input), {
    code: 'sandbox_storage_cap_exceeded',
  });
});
