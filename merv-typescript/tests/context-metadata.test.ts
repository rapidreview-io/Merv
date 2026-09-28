/**
 * A package's metadata tells the truth about its prompt: `sources` lists every artifact the build
 * resolved, embedded or not, by its ID, title, media type, hash and size.
 */
import { createService, type Artifact } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { RecipeContextBuilder } from '@merv/context-builder';
import type { Caller, TaskTypeDefinition } from '@merv/contracts';
import { openState } from './fixtures/state.js';

const definition: TaskTypeDefinition = {
  name: 'test.metadata',
  version: 1,
  kind: 'work',
  recipe: {
    instructions: 'Inspect the assigned evidence.',
    sections: [{ key: 'evidence', title: 'Evidence', required: true }],
    outputInstructions: 'Report the result with evidence.',
    maxChars: 1600,
    format: 2,
  },
};
const subject = { id: 'assignment', revision: 1 };
async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-metadata-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  t.after(async () => {
    builder.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const identity = await scope.bootstrap({ projectName: 'Metadata', actorName: 'Operator' });
  const operator: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
  return { artifacts, builder, operator };
}

test('sources carry exactly an artifact’s ID, title, media type, hash and size', async (t) => {
  const { artifacts, builder, operator } = await setup(t);
  const plain = await artifacts.create(operator, { title: 'Plain', content: 'Plain bytes.' });
  // Not textual, so no renderer reads the bytes the fake objectId would point at.
  const stored = await artifacts.create(operator, {
    title: 'Stored',
    mediaType: 'application/octet-stream',
    content: Buffer.from([0, 1, 2]).toString('base64'),
    encoding: 'base64',
  });
  const getMany = artifacts.getMany.bind(artifacts);
  artifacts.getMany = async (caller, ids, tx) =>
    (await getMany(caller, ids, tx)).map(
      (artifact) =>
        ({
          ...artifact,
          ...(artifact.id === stored.id ? { objectId: 'object_stored' } : {}),
          internal: 'not part of the schema',
        }) as Artifact,
    );
  const items = await builder.register(definition);
  const preview = await items.preview(operator, {
    subject,
    inputs: {
      evidence: {
        items: [plain, stored].map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          body: { artifactId: artifact.id },
        })),
      },
    },
  });
  assert.deepEqual(
    preview.sources,
    [plain, stored].map(({ id, title, mediaType, hash, size }) => ({
      id,
      title,
      mediaType,
      hash,
      size,
    })),
  );
});
