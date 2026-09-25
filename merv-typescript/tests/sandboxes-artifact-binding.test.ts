import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './fixtures/app.js';
import { stateConfig } from './fixtures/state.js';

test('configured Sandboxes binds optional artifact storage without a required credential at boot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-binding-'));
  const urlEnv = 'MERV_ARTIFACT_BINDING_TEST_URL';
  process.env[urlEnv] = 'http://127.0.0.1:1';
  t.after(async () => {
    delete process.env[urlEnv];
    await rm(directory, { recursive: true, force: true });
  });
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
        {
          id: 'sandboxes',
          name: '@merv/sandboxes',
          config: {
            urlEnv,
            connections: [
              {
                projectId: 'synthetic',
                namespace: 'merv-ml',
                tokenEnv: 'MERV_ARTIFACT_BINDING_NO_GRANT',
              },
            ],
            ml: {
              namespace: 'merv-ml',
              tokenEnv: 'MERV_ARTIFACT_BINDING_NO_GRANT',
              since: '2026-09-25T00:00:00Z',
              storageOrigins: ['https://bucket.example'],
            },
          },
        },
      ],
    },
  });
  t.after(async () => await app.stop());
  assert.equal(app.ctx.artifacts.largeUploadAvailable, true);
});
