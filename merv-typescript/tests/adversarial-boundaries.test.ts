import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RecipeContextBuilder } from '../packages/context-builder/src/index.js';
import { ProjectScope } from '../packages/scope/src/index.js';
import { ArtifactStore } from '../packages/artifacts/src/index.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { createService } from '../packages/contracts/src/index.js';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

test('a PostgreSQL download must reject a caller revoked while its link is signed', async (t) => {
  const state = await openState(undefined, { readConnections: 1 });
  t.after(async () => {
    await state.close();
  });
  const scope = await createService(new ProjectScope(state));
  const entered = deferred();
  const release = deferred();
  const artifacts = await createService(
    new ArtifactStore(state, scope, {
      put: async (_namespace, bytes) => ({
        hash: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      }),
      get: async () => Buffer.from('private evidence'),
      download: async () => {
        entered.resolve();
        await release.promise;
        return {
          url: 'https://storage.test/private-signed-url',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    }),
  );
  const boot = await scope.credentials.bootstrap({
    projectName: 'Adversarial test',
    actorName: 'Owner',
  });
  const operator = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.credentials.issueActor(operator, { name: 'Reader', role: 'reader' });
  const reader = {
    projectId: boot.project.id,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const artifact = await artifacts.create(operator, {
    title: 'Private',
    content: 'private evidence',
  });
  // This is the exact snapshot wrapper used by the shipped toolsPlugin, and artifact.read is
  // registered as shipped: an open-world read, which waits on storage outside any snapshot.
  const tools = new ToolRegistry(scope, scope.toolPolicy, (fn) => state.snapshot(fn));
  t.after(() => tools.close());
  const { z } = await import('zod');
  tools.register({
    name: 'artifact.read',
    description: 'Download',
    readOnly: true,
    openWorld: true,
    inputSchema: z.object({ artifactId: z.string() }),
    handler: (caller, input) => artifacts.download(caller, input.artifactId),
  });
  const pending = tools.call('artifact.read', reader, { artifactId: artifact.id });
  const rejected = assert.rejects(pending, { code: 'forbidden' });
  await entered.promise;
  try {
    await scope.credentials.revokeActor(operator, reader.actorId);
  } finally {
    release.resolve();
  }
  await rejected;
  await assert.rejects(scope.require(reader, 'read'), { code: 'forbidden' });
});

test('concurrent registrations of one recipe must have exactly one owner', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const builder = await createService(new RecipeContextBuilder(state, scope, {} as never));
  t.after(() => builder.close());
  const boot = await scope.credentials.bootstrap({
    projectName: 'Recipe race',
    actorName: 'Owner',
  });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const definition = {
    name: 'test.race',
    version: 1,
    kind: 'work' as const,
    recipe: {
      instructions: 'Do the task.',
      outputInstructions: 'Return the result.',
      sections: [{ key: 'task', title: 'Task', required: true }],
      maxChars: 1200,
      format: 2 as const,
    },
  };
  const results = await Promise.allSettled([
    builder.register(definition),
    builder.register(definition),
  ]);
  const successful = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(successful.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason.code, 'recipe_registered');
  const input = {
    subject: { id: 'task_test', revision: 0 },
    inputs: { task: { items: [{ id: 'task', title: 'Task', body: { text: 'Work' } }] } },
  };
  assert.match((await successful[0].value.preview(caller, input)).prompt, /Work/);
  successful[0].value.dispose();
  const replacement = await builder.register(definition);
  assert.match((await replacement.preview(caller, input)).prompt, /Work/);
  replacement.dispose();
  await assert.rejects(
    builder.register({ ...definition, recipe: { ...definition.recipe, instructions: 'Changed' } }),
    { code: 'recipe_changed' },
  );
  // A failed storage registration must release its reservation for the original version.
  assert.match((await (await builder.register(definition)).preview(caller, input)).prompt, /Work/);
});

test('closing Context Builder during registration cannot publish a live handle', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  const builder = await createService(new RecipeContextBuilder(state, {} as never, {} as never));
  const entered = deferred(),
    release = deferred();
  const held = state.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending = builder.register({
    name: 'test.close',
    version: 1,
    kind: 'work',
    recipe: {
      instructions: 'Work',
      outputInstructions: 'Report',
      sections: [{ key: 'task', title: 'Task', required: true }],
      maxChars: 1200,
      format: 2,
    },
  });
  const rejected = assert.rejects(pending, { code: 'context_builder_closed' });
  builder.close();
  release.resolve();
  await held;
  await rejected;
});
