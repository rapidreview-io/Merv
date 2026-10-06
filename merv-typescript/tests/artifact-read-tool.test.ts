import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MervError, type Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { deferred } from './fixtures/deferred.js';
import { stateConfig } from './fixtures/state.js';

test('artifact.read waits on storage holding no reader connection, and a revocation still refuses it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-read-tool-'));
  // Two reader connections: reads that kept theirs while storage answered would leave none.
  const app = await createApp({
    directory,
    config: {
      plugins: [
        {
          id: 'state',
          name: '@merv/state',
          config: stateConfig(directory, { readConnections: 2, connectionTimeoutMs: 2000 }),
        },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
        { id: 'tools', name: '@merv/api/tools-plugin' },
        { id: 'artifact-tools', name: '@merv/artifacts/tools' },
      ],
    },
  });
  const gate = deferred();
  // A failed assertion must not leave a read waiting on storage, or stopping hangs.
  t.after(async () => {
    gate.resolve();
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Reads',
    actorName: 'Owner',
  });
  const owner: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const issued = await app.ctx.scope.credentials.issueActor(owner, {
    name: 'Reader',
    role: 'reader',
  });
  const reader: Caller = { actorId: issued.actor.id, projectId: owner.projectId };

  // Downloads whose links storage holds.
  let waiting = 0;
  const all = deferred();
  const blobs = app.ctx.blobs;
  blobs.download = async (namespace, hash) => {
    if (++waiting === 3) all.resolve();
    await gate.promise;
    return {
      url: `https://bucket.example/${namespace}/${hash}`,
      expiresAt: new Date().toISOString(),
    };
  };
  t.after(() => delete blobs.download);
  const rows = [];
  for (const n of [1, 2, 3])
    rows.push(await app.ctx.artifacts.create(owner, { title: 'Object', content: `object ${n}` }));

  const reads = rows.map((row) =>
    app.ctx.tools.call('artifact.read', reader, { artifactId: row.id, mode: 'download' }),
  );
  const outcomes = Promise.allSettled(reads);
  // A read that could not get a reader connection fails here instead of waiting forever.
  await Promise.race([all.promise, Promise.all(reads)]);
  // Three reads wait on storage, and the two reader connections still answer.
  const listed = (await app.ctx.tools.call('artifact.list', owner, {})) as { id: string }[];
  assert.deepEqual(listed.map((artifact) => artifact.id).sort(), rows.map((row) => row.id).sort());
  // The reader is revoked while its reads wait: none of their URLs reach it.
  await app.ctx.scope.credentials.revokeActor(owner, reader.actorId);
  gate.resolve();
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.equal((outcome.reason as MervError).code, 'forbidden');
  }
  assert.deepEqual(
    await app.ctx.tools.call('artifact.read', owner, { artifactId: rows[0].id }),
    await app.ctx.artifacts.read(owner, rows[0].id),
  );
  assert.equal((await app.ctx.artifacts.read(owner, rows[0].id)).content, 'object 1');
});
