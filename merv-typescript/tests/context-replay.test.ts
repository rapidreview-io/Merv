import { historicalTask } from './fixtures/historical-task.js';
import { createService, digest } from '@merv/contracts';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
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
import type { Caller, ContextPackage, TaskTypeDefinition } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { buildContext, contextSource } from './fixtures/context.js';
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
    const identity = await scope.bootstrap({ projectName: 'Replay', actorName: 'Operator' });
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

/**
 * Owner, 2026-09-28: format-less recipes no longer register. Production still held one open task
 * (workflow task@2) created under a retired task.work version: its saved packages replay unchanged,
 * and everything it renders from now on uses task.work@4 and task.review@5.
 */
test('a task of a retired recipe version replays its saved package, then renders, advances and is reviewed with the format-2 successors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-replay-retired-'));
  let app = await createApp({ directory, api: false });
  try {
    const identity = await app.ctx.scope.bootstrap({
      projectName: 'Retired recipe',
      actorName: 'Operator',
    });
    const operator: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
    const issue = async (name: string, role: 'producer' | 'reviewer'): Promise<Caller> => ({
      actorId: (await app.ctx.scope.issueActor(operator, { name, role })).actor.id,
      projectId: operator.projectId,
    });
    const producer = await issue('Producer', 'producer');
    const reviewer = await issue('Reviewer', 'reviewer');
    const brief = await app.ctx.artifacts.create(producer, {
      title: 'Brief',
      content: 'Verify addition. Check two plus three.',
    });
    await assert.rejects(
      app.ctx.tasks.create(producer, {
        title: 'Addition',
        goal: 'Verify addition.',
        checks: ['Check two plus three.'],
        briefId: brief.id,
        typeVersion: 3,
        requestId: 'retired-type',
      }),
      { code: 'task_type_unavailable' },
    );
    // The rows production holds: a task.work@3 task, its recipe and a package it saved.
    const retired = {
      name: 'task.work',
      version: 3,
      kind: 'work',
      recipe: {
        instructions: 'Complete the assigned task.',
        sections: [
          { key: 'task', title: 'Task', required: true },
          { key: 'brief', title: 'Brief', required: true },
        ],
        outputInstructions: 'Submit the delivery.',
        maxChars: 96000,
      },
    };
    await app.setEnabled('tasks', false);
    const workflow = await app.ctx.workflows.register(
      TASK_WORKFLOW,
      await legacyTaskPolicy(app.ctx.state, TASK_WORKFLOW),
    );
    const saved = await app.ctx.state.transaction(async (tx) => {
      const instance = await workflow.start(
        producer,
        {
          workflow: 'task',
          version: 2,
          requestId: 'retired-start',
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
      await tx.run(
        'INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at,evidence_version,type_name,type_version) VALUES(?,?,?,?,?,?,?,?,2,?,?)',
        instance.id,
        producer.projectId,
        'Addition',
        'Verify addition.',
        JSON.stringify(['Check two plus three.']),
        producer.actorId,
        brief.id,
        instance.createdAt,
        'task.work',
        3,
      );
      await tx.run(
        'INSERT INTO context_recipes VALUES(?,?,?,?)',
        retired.name,
        retired.version,
        digest(retired),
        JSON.stringify(retired),
      );
      const body = {
        projectId: producer.projectId,
        actorId: producer.actorId,
        type: retired.name,
        typeVersion: retired.version,
        recipeHash: digest(retired),
        subject: { id: instance.id, revision: 0 },
        prompt: 'Complete the assigned task.\n\nThe prompt the retired renderer gave.\n',
        sources: [],
        omitted: [],
      };
      const result: ContextPackage = {
        ...body,
        hash: digest(body),
        id: 'context_retired',
        createdAt: instance.createdAt,
      };
      await tx.run(
        'INSERT INTO context_packages VALUES(?,?,?,?,?,?)',
        result.id,
        result.projectId,
        result.actorId,
        'original-assignment',
        result.hash,
        JSON.stringify(result),
      );
      return result;
    });
    workflow.dispose();
    await app.setEnabled('tasks', true);
    const taskId = saved.subject.id;
    const input = {
      taskId,
      purpose: 'work' as const,
      expectedRevision: 0,
      requestId: 'original-assignment',
    };
    // Replayed as saved, with no render, and again after a restart.
    assert.deepEqual(await app.ctx.tasks.context(producer, input), saved);
    await app.stop();
    app = await createApp({ directory, api: false });
    assert.deepEqual(await app.ctx.tasks.context(producer, input), saved);
    // A request for another subject under that ID still conflicts.
    await assert.rejects(app.ctx.tasks.context(producer, { ...input, expectedRevision: 1 }), {
      code: 'revision_conflict',
    });
    const work = await app.ctx.tasks.context(producer, { ...input, requestId: 'fresh' });
    assert.equal(`${work.type}@${work.typeVersion}`, 'task.work@4');
    assert.match(work.prompt, /Verify addition\./);
    assert.ok(work.sources.some((source) => source.id === brief.id));
    const delivery = await app.ctx.artifacts.create(producer, {
      title: 'Result',
      content: 'Two plus three is five.',
    });
    const submitted = await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery({
        taskId,
        artifactIds: [delivery.id],
        expectedRevision: 0,
        requestId: 'deliver',
      }),
    );
    assert.equal(submitted.workflow.state, 'in_review');
    const claim = await app.ctx.reviews.start(reviewer, submitted.reviewId!);
    const review = await app.ctx.tasks.context(reviewer, {
      taskId,
      purpose: 'review',
      claimId: claim.claimId!,
      expectedRevision: 1,
      requestId: 'review',
    });
    assert.equal(`${review.type}@${review.typeVersion}`, 'task.review@5');
    assert.match(review.prompt, /Two plus three is five\./);
    const done = await app.ctx.tasks.submitReview(reviewer, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      expectedRevision: 1,
      verdict: 'pass',
      notes: 'Checked the sum.',
      requestId: 'verdict',
    });
    assert.equal(done.workflow.state, 'done');
    assert.deepEqual(await storedContext(app.ctx.state, saved.id), saved);
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
    const task = await historicalTask(app.ctx, producer, {
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
      contextSource(binary),
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
