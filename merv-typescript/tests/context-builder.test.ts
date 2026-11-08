import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { RecipeContextBuilder } from '@merv/context-builder';
import type { ContextInput, ContextRecipeDefinition } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';

import { buildContext } from './fixtures/context.js';

import { openState, storedContext } from './fixtures/state.js';

const definition: ContextRecipeDefinition = {
  name: 'test.context',
  version: 1,
  kind: 'work',
  recipe: {
    instructions: 'Do the assigned work.',
    sections: [
      { key: 'background', title: 'Background', required: false },
      { key: 'evidence', title: 'Evidence', required: true },
    ],
    outputInstructions: 'Provide evidence.',
    maxChars: 1200,
    format: 2,
  },
};
const text = (id: string, body: string, rest = {}) => ({
  items: [{ id, title: id, body: { text: body }, ...rest }],
});

test('recipes enforce required context, reserve its budget, pin sources, isolate projects and survive version changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-'));
  const state = await openState(directory),
    scope = await createService(new ProjectScope(state)),
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
    ),
    builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  try {
    const a = await scope.credentials.bootstrap({ projectName: 'A', actorName: 'A' }),
      b = await scope.credentials.bootstrap({ projectName: 'B', actorName: 'B' });
    const caller = { actorId: a.actor.id, projectId: a.project.id },
      other = { actorId: b.actor.id, projectId: b.project.id };
    const artifact = await artifacts.create(caller, {
      title: 'Proof',
      content: 'The exact evidence.',
    });
    const registration = await builder.register(definition);
    const input = {
      subject: { id: 'task-a', revision: 2 },
      inputs: {
        evidence: {
          items: [{ id: 'evidence', title: 'Proof', body: { artifactId: artifact.id } }],
        },
        background: text('background', 'x'.repeat(1100)),
      },
      requestId: 'build',
    };
    const context = await buildContext(registration, caller, input);
    assert.match(context.prompt, /The exact evidence/);
    assert.deepEqual(context.omitted, ['background']);
    assert.equal(context.sources[0].hash, artifact.hash);
    assert.ok(context.prompt.length <= 1200);
    assert.deepEqual(await buildContext(registration, caller, input), context);
    // Only the builder decides what was omitted: a caller cannot add entries.
    await assert.rejects(
      buildContext(registration, caller, {
        ...input,
        requestId: 'carried-omissions',
        inputs: {
          ...input.inputs,
          background: {
            ...text('background', 'Latest review feedback.'),
            omitted: ['background:round:1'],
          } as ContextInput,
        },
      }),
      { code: 'invalid_context' },
    );
    const fitting = await buildContext(registration, caller, {
      ...input,
      requestId: 'fitting-background',
      inputs: { ...input.inputs, background: text('background', 'Latest review feedback.') },
    });
    assert.deepEqual(fitting.omitted, []);

    await assert.rejects(
      async () =>
        await buildContext(registration, caller, {
          ...input,
          subject: { id: 'task-a', revision: 3 },
        }),
      { code: 'request_conflict' },
    );
    await assert.rejects(
      async () =>
        await buildContext(registration, caller, { ...input, inputs: {}, requestId: 'missing' }),
      /Missing required context/,
    );
    await assert.rejects(
      async () =>
        await buildContext(registration, caller, {
          ...input,
          inputs: { evidence: text('evidence', 'x'.repeat(2000), { embed: 'always' }) },
          requestId: 'too-big',
        }),
      /exceeds the recipe budget/,
    );
    await assert.rejects(
      async () => await buildContext(registration, other, { ...input, requestId: 'cross-project' }),
      /not found/i,
    );
    await assert.rejects(
      async () =>
        await state.transaction(
          async (tx) =>
            await tx.run('UPDATE context_packages SET package=? WHERE id=?', '{}', context.id),
        ),
      { code: 'state_constraint' },
    );
    registration.dispose();
    await assert.rejects(
      async () => await buildContext(registration, caller, { ...input, requestId: 'disposed' }),
      /not active/,
    );
    assert.deepEqual(await storedContext(state, context.id), context);
    await assert.rejects(
      async () =>
        await builder.register({
          ...definition,
          recipe: { ...definition.recipe, instructions: 'Changed' },
        }),
      /new version/,
    );
    const version2 = await builder.register({
      ...definition,
      version: 2,
      recipe: { ...definition.recipe, instructions: 'Changed' },
    });
    const updated = await buildContext(version2, caller, { ...input, requestId: 'v2' });
    assert.notEqual(updated.recipeHash, context.recipeHash);
    assert.equal((await storedContext(state, context.id)).typeVersion, 1);
    const before = await state.eventHead();
    await assert.rejects(
      async () =>
        await state.transaction(async (tx) => {
          await buildContext(version2, caller, { ...input, requestId: 'aborted' }, tx);
          throw Error('rollback');
        }),
    );
    assert.equal(await state.eventHead(), before);
    assert.equal(
      await state.read(
        async (sql) =>
          (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM context_packages'))!.n,
      ),
      3,
    );
  } finally {
    builder.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
