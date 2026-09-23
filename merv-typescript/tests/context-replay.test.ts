import { createService } from '@merv/contracts';
import { reviewedFindings } from './fixtures/task-evidence.js';
import { legacyTaskPolicy } from './fixtures/legacy-task-policy.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { RecipeContextBuilder } from '@merv/context-builder';
import { TASK_WORKFLOW } from '@merv/tasks';
import { TASK_TYPES } from '../packages/tasks/src/definitions.js';
import type { Caller, TaskTypeDefinition } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { openState, storedContext } from './fixtures/state.js';

const recipe: TaskTypeDefinition = {
  name: 'test.reference-context',
  version: 1,
  kind: 'work',
  recipe: {
    instructions: 'Inspect the retained evidence.',
    sections: [{ key: 'evidence', title: 'Evidence', required: true }],
    outputInstructions: 'Report what you verified.',
    maxChars: 1800,
  },
};

test('artifact context modes retain binary references without charging blob size against the prompt budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-reference-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  try {
    const identity = await scope.bootstrap({ projectName: 'References', actorName: 'Operator' });
    const caller: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
    const otherIdentity = await scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
    const other: Caller = { actorId: otherIdentity.actor.id, projectId: otherIdentity.project.id };
    const binary = await artifacts.create(caller, {
      title: 'Retained binary evidence',
      mediaType: 'application/octet-stream',
      content: Buffer.alloc(100_000, 255).toString('base64'),
      encoding: 'base64',
    });
    const text = await artifacts.create(caller, {
      title: 'Readable receipt',
      content: 'Verified result: 42.',
    });
    const largeText = await artifacts.create(caller, {
      title: 'Large log',
      content: 'verified\n'.repeat(20_000),
    });
    const registration = await builder.register(recipe);
    const subject = { id: 'assignment', revision: 1 };
    const result = await registration.build(caller, {
      subject,
      inputs: { evidence: { artifactIds: [text.id, binary.id], mode: 'auto' } },
      requestId: 'auto',
    });
    assert.match(result.prompt, /Verified result: 42\./);
    assert.ok(result.prompt.includes(binary.id));
    assert.ok(result.prompt.includes(binary.hash));
    assert.match(result.prompt, /artifact\.read/);
    assert.deepEqual(
      result.sources.map((source) => source.id),
      [text.id, binary.id],
    );
    assert.equal(result.sources[1].size, 100_000);
    assert.ok(result.prompt.length <= recipe.recipe.maxChars);
    const reference = await registration.build(caller, {
      subject,
      inputs: { evidence: { artifactIds: [largeText.id], mode: 'references' } },
      requestId: 'references',
    });
    assert.ok(reference.prompt.includes(largeText.hash));
    assert.equal(reference.sources[0].size, largeText.size);
    assert.ok(reference.prompt.length <= recipe.recipe.maxChars);
    await assert.rejects(
      async () =>
        await registration.build(caller, {
          subject,
          inputs: { evidence: { artifactIds: [binary.id] } },
          requestId: 'default-text',
        }),
      { code: 'context_too_large' },
    );
    const smallBinary = await artifacts.create(caller, {
      title: 'Small binary',
      mediaType: 'application/octet-stream',
      content: '/w==',
      encoding: 'base64',
    });
    await assert.rejects(
      async () =>
        await registration.build(caller, {
          subject,
          inputs: { evidence: { artifactIds: [smallBinary.id] } },
          requestId: 'default-encoding',
        }),
      { code: 'context_encoding' },
    );
    await assert.rejects(
      async () =>
        await registration.build(other, {
          subject,
          inputs: { evidence: { artifactIds: [binary.id], mode: 'auto' } },
          requestId: 'foreign',
        }),
      { code: 'not_found' },
    );
    const many = await Promise.all(
      Array.from(
        { length: 12 },
        async (_, index) =>
          await artifacts.create(caller, {
            title: `Reference ${index}: ${'x'.repeat(270)}`,
            content: String(index),
          }),
      ),
    );
    await assert.rejects(
      async () =>
        await registration.build(caller, {
          subject,
          inputs: { evidence: { artifactIds: many.map((item) => item.id), mode: 'references' } },
          requestId: 'manifest-budget',
        }),
      { code: 'context_too_large' },
    );
  } finally {
    builder.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('owner replay pins recipe and exact assignment while ordinary context builds still reject changed inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-replay-owner-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  try {
    const identity = await scope.bootstrap({ projectName: 'Replay', actorName: 'Operator' });
    const caller: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
    const registration = await builder.register(recipe);
    const subject = { id: 'assignment', revision: 3, claimId: 'claim-a' };
    const input = {
      subject,
      inputs: { evidence: { text: 'Original input.' } },
      requestId: 'receipt',
    };
    const result = await registration.build(caller, input);
    assert.deepEqual(await registration.replay(caller, { subject, requestId: 'receipt' }), result);
    assert.equal(await registration.replay(caller, { subject, requestId: 'unknown' }), null);
    for (const changed of [
      { ...subject, id: 'other' },
      { ...subject, revision: 4 },
      { ...subject, claimId: 'claim-b' },
      { id: subject.id, revision: subject.revision },
    ])
      await assert.rejects(
        async () => await registration.replay(caller, { subject: changed, requestId: 'receipt' }),
        {
          code: 'request_conflict',
        },
      );
    await assert.rejects(
      async () =>
        await registration.build(caller, {
          ...input,
          inputs: { evidence: { text: 'Changed input.' } },
        }),
      { code: 'request_conflict' },
    );
    const newer = await builder.register({ ...recipe, version: 2 });
    await assert.rejects(
      async () => await newer.replay(caller, { subject, requestId: 'receipt' }),
      {
        code: 'request_conflict',
      },
    );
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

test('historical task context replays unchanged after deployment and restart, with fresh assignment authorization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-replay-legacy-'));
  let app = await createApp({ directory, api: false });
  try {
    const identity = await app.ctx.scope.bootstrap({
      projectName: 'Legacy context',
      actorName: 'Operator',
    });
    const operator: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
    const issued = await app.ctx.scope.issueActor(operator, { name: 'Producer', role: 'producer' });
    const producer: Caller = { actorId: issued.actor.id, projectId: operator.projectId };
    const brief = await app.ctx.artifacts.create(producer, {
      title: 'Brief',
      content: 'Verify addition. Check two plus three.',
    });
    await app.setEnabled('tasks', false);
    const workflow = await app.ctx.workflows.register(
      TASK_WORKFLOW,
      await legacyTaskPolicy(app.ctx.state, TASK_WORKFLOW),
    );
    const snapshot = await app.ctx.state.transaction(async (tx) => {
      const instance = await workflow.start(
        producer,
        {
          workflow: 'task',
          version: 2,
          requestId: 'legacy-start',
          data: {
            title: 'Addition',
            goal: 'Verify addition.',
            checks: ['Check two plus three.'],
            producerId: producer.actorId,
            briefId: brief.id,
          },
        },
        tx,
      );
      // A row an earlier release wrote: later columns take their defaults, except the evidence
      // contract, which is 2 for every task that remains (tasks migration 8 retired version 1).
      await tx.run(
        'INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at,evidence_version) VALUES(?,?,?,?,?,?,?,?,2)',
        instance.id,
        producer.projectId,
        'Addition',
        'Verify addition.',
        JSON.stringify(['Check two plus three.']),
        producer.actorId,
        brief.id,
        instance.createdAt,
      );
      return instance;
    });
    workflow.dispose();
    await app.setEnabled('tasks', true);
    const task = await app.ctx.tasks.get(producer, snapshot.id);
    assert.equal(task.evidenceVersion, 2);
    const {
      dependents: _dependents,
      evidenceVersion: _evidenceVersion,
      acceptanceChecks: _acceptanceChecks,
      deliveryConfirmations: _deliveryConfirmations,
      deliveryAssessmentId: _deliveryAssessmentId,
      ...historicalTask
    } = task;
    await app.setEnabled('tasks', false);
    const priorOwner = await app.ctx.contextBuilder.register(
      TASK_TYPES.find((item) => item.name === 'task.work')!,
    );
    const historical = await priorOwner.build(producer, {
      subject: { id: task.id, revision: 0 },
      inputs: {
        task: { text: JSON.stringify(historicalTask) },
        brief: { artifactIds: [brief.id] },
      },
      requestId: 'original-assignment',
    });
    assert.doesNotMatch(historical.prompt, /"evidenceVersion"/);
    priorOwner.dispose();
    await app.setEnabled('tasks', true);
    const input = {
      taskId: task.id,
      purpose: 'work' as const,
      expectedRevision: 0,
      requestId: 'original-assignment',
    };
    assert.deepEqual(await app.ctx.tasks.context(producer, input), historical);
    await app.ctx.tasks.checkpoint(producer, {
      ...input,
      requestId: 'progress',
      notes: 'A new checkpoint after the frozen package.',
    });
    assert.deepEqual(await app.ctx.tasks.context(producer, input), historical);
    const refreshed = await app.ctx.tasks.context(producer, {
      ...input,
      requestId: 'refresh-assignment',
    });
    assert.match(refreshed.prompt, /"evidenceVersion":2/);
    assert.match(refreshed.prompt, /A new checkpoint after the frozen package/);
    assert.notEqual(refreshed.id, historical.id);
    await assert.rejects(
      async () => await app.ctx.tasks.context(producer, { ...input, expectedRevision: 1 }),
      {
        code: 'revision_conflict',
      },
    );
    const otherTask = await app.ctx.tasks.create(producer, {
      title: 'Other',
      goal: 'Other goal',
      checks: ['Other check'],
      requestId: 'other-task',
    });
    await assert.rejects(
      async () => await app.ctx.tasks.context(producer, { ...input, taskId: otherTask.id }),
      {
        code: 'request_conflict',
      },
    );
    await app.stop();
    app = await createApp({ directory, api: false });
    assert.deepEqual(await app.ctx.tasks.context(producer, input), historical);
    await app.ctx.scope.revokeActor(operator, producer.actorId);
    await assert.rejects(async () => await app.ctx.tasks.context(producer, input), {
      code: 'forbidden',
    });
    assert.deepEqual(await storedContext(app.ctx.state, historical.id), historical);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('structured binary evidence remains reviewable and replay cannot bypass revoked or stale review claims', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-binary-review-'));
  const app = await createApp({ directory, api: false });
  try {
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Binary review',
      actorName: 'Operator',
    });
    const operator: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
    const issue = async (name: string, role: 'producer' | 'reviewer'): Promise<Caller> => ({
      actorId: (await app.ctx.scope.issueActor(operator, { name, role })).actor.id,
      projectId: operator.projectId,
    });
    const producer = await issue('Producer', 'producer');
    const reviewer = await issue('Reviewer', 'reviewer');
    const replacement = await issue('Replacement', 'reviewer');
    const task = await app.ctx.tasks.create(producer, {
      title: 'Retain bytes',
      goal: 'Retain binary evidence.',
      checks: ['The recorded bytes are available.'],
      requestId: 'create',
    });
    const binary = await app.ctx.artifacts.create(producer, {
      title: 'Recorded bytes',
      mediaType: 'application/octet-stream',
      content: Buffer.alloc(400_000, 255).toString('base64'),
      encoding: 'base64',
    });
    const submitted = await app.ctx.tasks.submitDelivery(producer, {
      taskId: task.id,
      expectedRevision: 0,
      artifactIds: [binary.id],
      requestId: 'deliver',
      confirmations: [
        {
          checkNumber: 1,
          status: 'met',
          evidenceIds: [binary.id],
          notes: 'Retained the observed binary output for independent inspection.',
        },
      ],
    });
    const claim = await app.ctx.reviews.start(reviewer, submitted.reviewId!);
    const input = {
      taskId: task.id,
      purpose: 'review' as const,
      claimId: claim.claimId!,
      expectedRevision: 1,
      requestId: 'review-context',
    };
    const context = await app.ctx.tasks.context(reviewer, input);
    assert.ok(context.prompt.includes(binary.hash));
    assert.match(context.prompt, /artifact\.read/);
    assert.deepEqual(
      context.sources.find((source) => source.id === binary.id),
      binary,
    );
    assert.ok(context.sources.some((source) => source.id === submitted.deliveryAssessmentId));
    await app.ctx.tasks.checkpoint(reviewer, {
      ...input,
      requestId: 'checkpoint',
      notes: 'The binary output still needs format inspection.',
      artifactIds: [binary.id],
    });
    assert.deepEqual(await app.ctx.tasks.context(reviewer, input), context);
    const refreshed = await app.ctx.tasks.context(reviewer, { ...input, requestId: 'refreshed' });
    assert.match(refreshed.prompt, /still needs format inspection/);
    assert.ok(refreshed.sources.some((source) => source.id === binary.id));
    await app.ctx.scope.revokeActor(operator, reviewer.actorId);
    await assert.rejects(async () => await app.ctx.tasks.context(reviewer, input), {
      code: 'forbidden',
    });
    await app.ctx.domainEvents.drain();
    const newClaim = await app.ctx.reviews.start(replacement, claim.id);
    await assert.rejects(async () => await app.ctx.tasks.context(replacement, input), {
      code: 'stale_claim',
    });
    const replacementInput = { ...input, claimId: newClaim.claimId! };
    const replacementContext = await app.ctx.tasks.context(replacement, replacementInput);
    assert.equal(replacementContext.subject.claimId, newClaim.claimId);
    assert.match(replacementContext.prompt, /still needs format inspection/);
    await app.ctx.tasks.submitReview(replacement, {
      ...reviewedFindings(newClaim),
      reviewId: newClaim.id,
      claimId: newClaim.claimId!,
      expectedRevision: 1,
      verdict: 'needs_changes',
      notes: 'Retain a decoder and verification output for these opaque bytes.',
      requestId: 'return',
    });
    await assert.rejects(async () => await app.ctx.tasks.context(replacement, replacementInput), {
      code: 'revision_conflict',
    });
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
