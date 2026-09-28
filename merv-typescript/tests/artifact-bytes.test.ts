import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Bytes', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  return { app, caller, directory };
}

test('bytes gone from behind an existing row are a server fault, not a missing artifact', async (t) => {
  const { app, caller, directory } = await fixture(t);
  // A row from before bytes were kept in it: its bytes are in blobs.
  const artifact = await legacyArtifact(app.ctx.state, caller, Buffer.from('kept'), (bytes) =>
    app.ctx.blobs.put(caller.projectId, bytes),
  );
  await unlink(
    join(directory, 'blobs', caller.projectId, artifact.hash.slice(0, 2), artifact.hash),
  );
  assert.equal((await app.ctx.artifacts.get(caller, artifact.id)).id, artifact.id);
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'artifact_bytes_missing',
    status: 500,
  });
  await assert.rejects(app.ctx.artifacts.read(caller, 'art_unknown'), { code: 'not_found' });
});

test('a row whose bytes were in sandbox storage reads them from blobs, verified', async (t) => {
  const { app, caller, directory } = await fixture(t);
  const artifact = await legacyArtifact(
    app.ctx.state,
    caller,
    Buffer.from('ten bytes!'),
    (bytes) => app.ctx.blobs.put(caller.projectId, bytes),
    { objectId: 'obj_bytes' },
  );
  assert.equal((await app.ctx.artifacts.read(caller, artifact.id)).content, 'ten bytes!');
  const file = join(directory, 'blobs', caller.projectId, artifact.hash.slice(0, 2), artifact.hash);
  await writeFile(file, 'ten bytes?');
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'blob_corrupt',
    status: 500,
  });
  await unlink(file);
  await assert.rejects(app.ctx.artifacts.read(caller, artifact.id), {
    code: 'artifact_bytes_missing',
    status: 500,
  });
});
