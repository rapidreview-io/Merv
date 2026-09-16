import { createService } from '@merv/contracts';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { RecipeContextBuilder } from '@merv/context-builder';
import { createApp } from '../src/app.js';
import type { TaskTypeDefinition } from '@merv/contracts';

const definition: TaskTypeDefinition = {
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
  },
};

test('recipes enforce required context, reserve its budget, pin sources, isolate projects and survive version changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-'));
  const state = new SqliteState(join(directory, 'state.db')),
    scope = await createService(new ProjectScope(state)),
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
    ),
    builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  try {
    const a = await scope.bootstrap({ projectName: 'A', actorName: 'A' }),
      b = await scope.bootstrap({ projectName: 'B', actorName: 'B' });
    const caller = { actorId: a.actor.id, projectId: a.project.id },
      other = { actorId: b.actor.id, projectId: b.project.id };
    const artifact = await artifacts.create(caller, {
      title: 'Proof',
      content: 'The exact evidence.',
    });
    const registration = await builder.register(definition);
    const input = {
      subject: { id: 'task-a', revision: 2 },
      inputs: { evidence: { artifactIds: [artifact.id] }, background: { text: 'x'.repeat(1100) } },
      requestId: 'build',
    };
    const context = await registration.build(caller, input);
    assert.match(context.prompt, /The exact evidence/);
    assert.deepEqual(context.omitted, ['background']);
    assert.equal(context.sources[0].hash, artifact.hash);
    assert.ok(context.prompt.length <= 1200);
    assert.deepEqual(await registration.build(caller, input), context);
    await assert.rejects(
      async () =>
        await registration.build(caller, { ...input, subject: { id: 'task-a', revision: 3 } }),
      /different input/,
    );
    await assert.rejects(
      async () => await registration.build(caller, { ...input, inputs: {}, requestId: 'missing' }),
      /Missing required context/,
    );
    await assert.rejects(
      async () =>
        await registration.build(caller, {
          ...input,
          inputs: { evidence: { text: 'x'.repeat(2000) } },
          requestId: 'too-big',
        }),
      /exceeds the recipe budget/,
    );
    await assert.rejects(
      async () => await registration.build(other, { ...input, requestId: 'cross-project' }),
      /not found/i,
    );
    await assert.rejects(async () => await builder.get(other, context.id), /not found/i);
    await assert.rejects(
      async () =>
        await state.transaction(
          async (tx) =>
            await tx.run('UPDATE context_packages SET package=? WHERE id=?', '{}', context.id),
        ),
      /immutable/,
    );
    registration.dispose();
    await assert.rejects(
      async () => await registration.build(caller, { ...input, requestId: 'disposed' }),
      /not active/,
    );
    assert.deepEqual(await builder.get(caller, context.id), context);
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
    const updated = await version2.build(caller, { ...input, requestId: 'v2' });
    assert.notEqual(updated.recipeHash, context.recipeHash);
    assert.equal((await builder.get(caller, context.id)).typeVersion, 1);
    const before = await state.eventHead();
    await assert.rejects(
      async () =>
        await state.transaction(async (tx) => {
          await version2.build(caller, { ...input, requestId: 'aborted' }, tx);
          throw Error('rollback');
        }),
    );
    assert.equal(await state.eventHead(), before);
    assert.equal(
      await state.read(
        async (sql) =>
          (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM context_packages'))!.n,
      ),
      2,
    );
  } finally {
    builder.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('task types supply distinct recipes; checkpoints and revoked review recovery produce a fresh traceable context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-flow-'));
  let app = await createApp({ directory, api: false });
  try {
    const a = await app.ctx.scope.bootstrap({ projectName: 'Context flow', actorName: 'Operator' });
    const operator = { actorId: a.actor.id, projectId: a.project.id };
    const actor = async (role: 'producer' | 'reviewer') => ({
      actorId: (await app.ctx.scope.issueActor(operator, { name: role, role })).actor.id,
      projectId: operator.projectId,
    });
    const producer = await actor('producer'),
      reviewer = await actor('reviewer'),
      replacement = await actor('reviewer');
    const doc = async (title: string, content: string) =>
      await app.ctx.artifacts.create(producer, { title, content });
    const brief = await doc('Brief', 'Design a test. Define the controls.'),
      research = await doc('Research', 'Prior controlled comparisons.'),
      constraints = await doc('Constraints', 'Use the approved small dataset.');
    const create = {
      type: 'experiment.plan',
      title: 'Plan',
      goal: 'Design a test.',
      checks: ['Define the controls.'],
      briefId: brief.id,
      requestId: 'plan',
    };
    await assert.rejects(
      async () => await app.ctx.tasks.create(producer, create),
      /Missing required context: research/,
    );
    const task = await app.ctx.tasks.create(producer, {
      ...create,
      contextInputs: { research: [research.id], constraints: [constraints.id] },
    });
    const checkpoint = await app.ctx.tasks.checkpoint(producer, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      notes: 'Selected the baseline; controls still need work.',
      requestId: 'progress',
    });
    const context = await app.ctx.tasks.context(producer, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'start',
    });
    assert.equal(context.type, 'experiment.plan');
    assert.match(context.prompt, /Prior controlled comparisons/);
    assert.match(context.prompt, /controls still need work/);
    assert.match(context.prompt, /does not authorize experiment execution/);
    assert.match(context.prompt, new RegExp(checkpoint.id));
    const delivery = await doc(
      'Plan',
      'Define the controls. The control and treatment differ only in the proposed change.',
    );
    const submitted = await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [delivery.id],
        expectedRevision: 0,
        requestId: 'submit',
      }),
    );
    const old = await app.ctx.reviews.start(reviewer, submitted.reviewId!);
    await app.ctx.tasks.checkpoint(reviewer, {
      taskId: task.id,
      purpose: 'review',
      expectedRevision: 1,
      claimId: old.claimId!,
      notes: 'Verified control selection; statistical power remains unchecked.',
      artifactIds: [delivery.id],
      requestId: 'review-progress',
    });
    await app.ctx.scope.revokeActor(operator, reviewer.actorId);
    await app.ctx.domainEvents.drain();
    const claim = await app.ctx.reviews.start(replacement, old.id);
    await assert.rejects(
      async () =>
        await app.ctx.tasks.context(replacement, {
          taskId: task.id,
          purpose: 'review',
          expectedRevision: 1,
          claimId: old.claimId!,
          requestId: 'stale',
        }),
      /current review claim/,
    );
    const reviewContext = await app.ctx.tasks.context(replacement, {
      taskId: task.id,
      purpose: 'review',
      expectedRevision: 1,
      claimId: claim.claimId!,
      requestId: 'replacement-context',
    });
    assert.equal(reviewContext.type, 'task.review');
    assert.equal(reviewContext.subject.claimId, claim.claimId);
    assert.match(reviewContext.prompt, /reviewer_revoked/);
    assert.match(reviewContext.prompt, /statistical power remains unchecked/);
    assert.match(reviewContext.prompt, /not a verdict/);
    assert.match(reviewContext.prompt, /Prior controlled comparisons/);
    assert.match(reviewContext.prompt, /Use the approved small dataset/);
    assert.ok(reviewContext.sources.some((source) => source.id === research.id));
    assert.ok(reviewContext.sources.some((s) => s.id === delivery.id));
    await assert.rejects(
      async () =>
        await app.ctx.tasks.context(reviewer, {
          taskId: task.id,
          purpose: 'review',
          expectedRevision: 1,
          claimId: old.claimId!,
          requestId: 'revoked',
        }),
      /access this project/,
    );
    const reflection = await app.ctx.tasks.create(producer, {
      ...create,
      type: 'project.reflection',
      requestId: 'reflection',
      contextInputs: { experiments: [delivery.id], projectKnowledge: [research.id] },
    });
    assert.match(
      (
        await app.ctx.tasks.context(producer, {
          taskId: reflection.id,
          purpose: 'work',
          expectedRevision: 0,
          requestId: 'reflect-context',
        })
      ).prompt,
      /explicitly selected experiment corpus/,
    );
    await app.setEnabled('tasks', false);
    assert.deepEqual(await app.ctx.contextBuilder.get(operator, reviewContext.id), reviewContext);
    await app.setEnabled('tasks', true);
    const reloaded = await app.ctx.tasks.context(replacement, {
      taskId: task.id,
      purpose: 'review',
      expectedRevision: 1,
      claimId: claim.claimId!,
      requestId: 'replacement-context',
    });
    assert.deepEqual(reloaded, reviewContext);
    await app.stop();
    app = await createApp({ directory, api: false });
    assert.deepEqual(await app.ctx.contextBuilder.get(operator, reviewContext.id), reviewContext);
    const done = await app.ctx.tasks.submitReview(replacement, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      expectedRevision: 1,
      verdict: 'pass',
      notes: 'Completed the remaining independent checks.',
      requestId: 'verdict',
    });
    assert.equal(done.workflow.state, 'done');
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('additional task types register recipes directly and retire without retaining callable handles', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-custom-context-'));
  const app = await createApp({ directory, api: false });
  try {
    const identity = await app.ctx.scope.bootstrap({
      projectName: 'Custom',
      actorName: 'Operator',
    });
    const caller = { actorId: identity.actor.id, projectId: identity.project.id };
    const definition: TaskTypeDefinition = {
      name: 'custom.plan',
      version: 1,
      kind: 'work',
      recipe: {
        instructions: 'Produce a custom plan.',
        sections: [
          { key: 'task', title: 'Task', required: true },
          { key: 'brief', title: 'Brief', required: true },
        ],
        outputInstructions: 'Save the plan.',
        maxChars: 6000,
      },
    };
    const unregister = await app.ctx.tasks.registerType(definition);
    const brief = await app.ctx.artifacts.create(caller, {
      title: 'Brief',
      content: 'Plan. Has steps.',
    });
    const task = await app.ctx.tasks.create(caller, {
      type: 'custom.plan',
      title: 'Custom',
      goal: 'Plan.',
      checks: ['Has steps.'],
      briefId: brief.id,
      requestId: 'create',
    });
    await app.ctx.tasks.checkpoint(caller, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      notes: 'Optional progress is not requested by this recipe.',
      requestId: 'progress',
    });
    const packageInput = {
      taskId: task.id,
      purpose: 'work' as const,
      expectedRevision: 0,
      requestId: 'build',
    };
    const context = await app.ctx.tasks.context(caller, packageInput);
    assert.match(context.prompt, /Produce a custom plan/);
    unregister();
    await assert.rejects(
      async () =>
        await app.ctx.tasks.context(caller, { ...packageInput, requestId: 'after-dispose' }),
      /unavailable/,
    );
    assert.deepEqual(await app.ctx.contextBuilder.get(caller, context.id), context);
    await app.ctx.tasks.registerType(definition);
    assert.deepEqual(await app.ctx.tasks.context(caller, packageInput), context);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
