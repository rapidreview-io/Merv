import { currentTaskSuite } from './fixtures/current-task-suite.js';
import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { RecipeContextBuilder } from '@merv/context-builder';
import type { Caller, ContextRecipeDefinition } from '@merv/contracts';
import { buildContext } from './fixtures/context.js';
import { openState, storedContext } from './fixtures/state.js';

const recipe: ContextRecipeDefinition = {
  name: 'test.reference-context',
  version: 1,
  kind: 'work',
  recipe: {
    instructions: 'Inspect the retained evidence.',
    sections: [{ key: 'evidence', title: 'Evidence', required: true }],
    outputInstructions: 'Report what you verified.',
    maxChars: 1800,
    format: 2,
  },
};
const evidence = (text: string) => ({
  items: [{ id: 'evidence', title: 'Evidence', body: { text } }],
});

test('owner replay and build pin recipe and exact assignment, and a reused request ID returns its saved package whatever the inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-replay-owner-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  try {
    const identity = await scope.credentials.bootstrap({
      projectName: 'Replay',
      actorName: 'Operator',
    });
    const caller: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
    const registration = await builder.register(recipe);
    const subject = { id: 'assignment', revision: 3, claimId: 'claim-a' };
    const input = {
      subject,
      inputs: { evidence: evidence('Original input.') },
      requestId: 'receipt',
    };
    const result = await buildContext(registration, caller, input);
    assert.deepEqual(await registration.replay(caller, { subject, requestId: 'receipt' }), result);
    assert.equal(await registration.replay(caller, { subject, requestId: 'unknown' }), null);
    for (const changed of [
      { ...subject, id: 'other' },
      { ...subject, revision: 4 },
      { ...subject, claimId: 'claim-b' },
      { id: subject.id, revision: subject.revision },
    ]) {
      await assert.rejects(
        async () => await registration.replay(caller, { subject: changed, requestId: 'receipt' }),
        {
          code: 'request_conflict',
        },
      );
      await assert.rejects(
        async () => await buildContext(registration, caller, { ...input, subject: changed }),
        { code: 'request_conflict' },
      );
    }
    // The request ID names the saved package: other inputs for the same recipe and subject get it.
    assert.deepEqual(
      await buildContext(registration, caller, {
        ...input,
        inputs: { evidence: evidence('Changed input.') },
      }),
      result,
    );
    const newer = await builder.register({ ...recipe, version: 2 });
    await assert.rejects(
      async () => await newer.replay(caller, { subject, requestId: 'receipt' }),
      {
        code: 'request_conflict',
      },
    );
    await assert.rejects(async () => await buildContext(newer, caller, input), {
      code: 'request_conflict',
    });
    registration.dispose();
    await assert.rejects(
      async () => await registration.replay(caller, { subject, requestId: 'receipt' }),
      {
        code: 'recipe_unavailable',
      },
    );
  } finally {
    builder.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current leased binary evidence stays reviewable and saved review context remains immutable', async (t) => {
  const f = await currentTaskSuite(t);
  const prepared = await f.delivery(await f.create());
  const binary = await f.work.run(
    prepared.held,
    'artifact.create',
    {
      title: 'Recorded bytes',
      mediaType: 'application/octet-stream',
      content: Buffer.alloc(400_000, 255).toString('base64'),
      encoding: 'base64',
    },
    (caller, input) => f.app.ctx.artifacts.create(caller, input as never),
  );
  prepared.input.artifactIds.push(binary.id);
  prepared.input.confirmations.forEach((item) => item.evidenceIds.push(binary.id));
  const pending = await f.submit(prepared);
  const { held, review } = await f.claim(pending);
  const input = {
    taskId: pending.id,
    purpose: 'review' as const,
    claimId: review.claimId!,
    expectedRevision: pending.workflow.revision,
    requestId: f.work.request(),
  };
  const context = await f.app.ctx.tasks.context(held.worker, input);
  assert.ok(context.prompt.includes(binary.hash));
  assert.match(context.prompt, /artifact\.read/);
  assert.ok(context.sources.some((source) => source.id === binary.id));
  await f.app.ctx.tasks.checkpoint(held.worker, {
    ...input,
    requestId: f.work.request(),
    notes: 'The binary output still needs format inspection.',
    artifactIds: [binary.id],
  });
  assert.deepEqual(await f.app.ctx.tasks.context(held.worker, input), context);
  const refreshed = await f.app.ctx.tasks.context(held.worker, {
    ...input,
    requestId: f.work.request(),
  });
  assert.match(refreshed.prompt, /still needs format inspection/);
  await f.work.release(held);
  assert.deepEqual(await storedContext(f.app.ctx.state, context.id), context);
});
