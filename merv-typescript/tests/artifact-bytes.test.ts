import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { stateConfig } from './fixtures/state.js';
import { legacyArtifact } from './fixtures/legacy-artifact.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-bytes-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Bytes',
    actorName: 'Owner',
  });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  return { app, caller };
}

test('a row without its bytes is a server fault, not a missing artifact', async (t) => {
  const { app, caller } = await fixture(t);
  // Its bytes stored in blobs are not read: a row of this size keeps them in the row.
  const bytes = Buffer.from('kept');
  await app.ctx.blobs.put(caller.projectId, bytes);
  const artifact = await legacyArtifact(app.ctx.state, caller, bytes);
  assert.equal((await app.ctx.artifacts.get(caller, artifact.id)).id, artifact.id);
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'artifact_bytes_missing',
    status: 500,
  });
  await assert.rejects(app.ctx.artifacts.read(caller, 'art_unknown'), { code: 'not_found' });
});
