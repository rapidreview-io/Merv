import type { TaskCreate } from '@merv/tasks/types';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { countWrites } from './fixtures/state.js';
import type { PostgresState } from '@merv/state';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

async function fixture(api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-assignment-'));
  const app = await createApp({ directory, api, port: 0 });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Assignments', actorName: 'Operator' });
  const operator: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const identity = await app.ctx.scope.issueActor(operator, { role, name: role });
    return {
      caller: {
        projectId: operator.projectId,
        actorId: identity.actor.id,
        credentialId: identity.credential.id,
      } as Caller,
      token: identity.token,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    replacement = await issue('reviewer'),
    reader = await issue('reader');
  let sequence = 0;
  const create = async (extra: Partial<TaskCreate> = {}) =>
    await currentTask(app.ctx, producer.caller, {
      title: 'Check addition',
      goal: 'Verify addition.',
      checks: ['Two plus three equals five.'],
      requestId: `create-${++sequence}`,
      ...extra,
    });
  const work = currentWork(app.ctx, { directory, source: producer.caller });
  const submit = async (id: string, revision = 0) => {
    const held = await work.lease(await app.ctx.tasks.get(producer.caller, id));
    try {
      const proof = await app.ctx.artifacts.create(held.worker, {
        title: 'Reproduction',
        content: 'Observed 2 + 3 = 5.',
      });
      const commandId = await work.commit(held);
      return await work.run(
        held,
        'task.submit_delivery',
        confirmedDelivery({
          taskId: id,
          expectedRevision: revision,
          artifactIds: [proof.id],
          commandId,
          requestId: `submit-${++sequence}`,
        }),
        (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
      );
    } finally {
      await work.release(held);
    }
  };
  let reviewLease: Awaited<ReturnType<typeof work.lease>> | undefined;
  const claim = async (task: { id: string; workflow: { revision: number } }, actor = reviewer) => {
    const runner = await app.ctx.scope.issueActor(operator, {
      name: 'Independent review runner',
      role: 'operator',
    });
    const held = await work.lease(task, {
      projectId: operator.projectId,
      actorId: runner.actor.id,
      credentialId: runner.credential.id,
    });
    reviewLease = held;
    actor.caller = held.worker;
    return await app.ctx.reviews.get(
      held.worker,
      (await app.ctx.tasks.get(held.worker, task.id)).reviewId!,
    );
  };
  const begin = async (caller: Caller, id: string, revision = 0) =>
    await app.ctx.workflows.begin(caller, { instanceId: id, expectedRevision: revision });
  // Repository initialization is asynchronous; finish its writes before measuring assignments.
  await waitForManagedCode(app.ctx.codeWork, operator);
  await app.ctx.domainEvents.drain();
  // INSERT/UPDATE/DELETE statements issued through the state, rolled back or not.
  const written = countWrites(app.ctx.state as PostgresState);
  const writes = async () => {
    await app.ctx.domainEvents.drain();
    return written();
  };
  return {
    app,
    directory,
    operator,
    producer,
    reviewer,
    replacement,
    reader,
    issue,
    create,
    submit,
    begin,
    claim,
    work,
    get reviewLease() {
      return reviewLease;
    },
    writes,
    close: async () => {
      await work.close();
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('task assignments return full recipe context; begin records one activation independently of delivery readiness', async () => {
  const f = await fixture();
  try {
    const research = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Prior work',
      content: 'Control the input distribution and retain the baseline.',
    });
    const constraints = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Constraints',
      content: 'Use the existing CPU budget.',
    });
    const task = await f.create({
      type: 'project.reflection',
      contextInputs: { experiments: [research.id], projectKnowledge: [constraints.id] },
    });
    assert.equal(task.guidance.nextAction?.tool, 'workflow.begin');
    const before = await f.writes();
    const preview = await f.app.ctx.workflows.assignment(f.producer.caller, task.id);
    assert.equal(await f.writes(), before, 'Assignment lookup must be read-only');
    assert.equal(preview.context?.type, 'project.reflection');
    assert.match(preview.context!.prompt, /Control the input distribution/);
    assert.match(preview.context!.prompt, /existing CPU budget/);
    assert.match(preview.brief, /Verify addition/);
    assert.equal(preview.workStart, null);
    assert.ok(preview.references.some((ref) => ref.id === research.id));
    assert.equal(preview.context!.subject.revision, 0);
    assert.equal('id' in preview.context!, false);
    const started = await f.begin(f.producer.caller, task.id);
    assert.equal(started.workStart?.actorId, f.producer.caller.actorId);
    assert.equal(started.workStart?.revision, 0);
    assert.equal(started.context!.subject.revision, 0);
    assert.match(started.context!.prompt, /"workStart":\{/);
    const current = await f.app.ctx.tasks.get(f.producer.caller, task.id);
    assert.equal(current.workflow.revision, 0);
    assert.equal(current.workflow.state, 'in_progress');
    assert.equal(current.guidance.nextAction?.tool, 'task.submit_delivery');
    assert.equal(current.guidance.nextAction?.status, 'needs_input');
    assert.deepEqual(current.workStarts, [started.workStart]);
    const after = await f.writes();
    assert.deepEqual(await f.begin(f.producer.caller, task.id), started);
    assert.equal(
      await f.writes(),
      after,
      'Repeating begin must not add receipts, contexts or events',
    );
    const saved = await f.app.ctx.tasks.context(f.producer.caller, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'save-start-context',
    });
    assert.equal(saved.hash, started.context!.hash);
    assert.equal(saved.prompt, started.context!.prompt);
    const events = (await f.app.ctx.state.events(f.operator.projectId)).filter(
      (event) => event.type === 'workflow.work_started' && event.subjectId === task.id,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].id, started.workStart!.eventId);
    const admission = await f.app.ctx.workflows.evaluate(f.producer.caller, task.id, {
      action: 'begin',
    });
    assert.equal(admission.nextAction?.tool, 'workflow.begin');
  } finally {
    await f.close();
  }
});

test('work assignment preserves operator access and fences other actors, stale revisions and prerequisites', async () => {
  const f = await fixture();
  try {
    const task = await f.create();
    for (const caller of [f.reader.caller, f.reviewer.caller, (await f.issue('producer')).caller]) {
      await assert.rejects(async () => await f.app.ctx.workflows.assignment(caller, task.id), {
        status: 403,
      });
      await assert.rejects(async () => await f.begin(caller, task.id), { status: 403 });
    }
    assert.equal((await f.app.ctx.workflows.assignment(f.operator, task.id)).role, 'producer');
    const started = await f.begin(f.operator, task.id);
    assert.equal(started.actorId, f.operator.actorId);
    assert.equal(
      (await f.begin(f.producer.caller, task.id)).workStart!.actorId,
      f.operator.actorId,
      'Start attribution is historical, not an ownership claim',
    );
    await assert.rejects(async () => await f.begin(f.producer.caller, task.id, 1), {
      code: 'revision_conflict',
    });
    const foreign = await f.app.ctx.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
    await assert.rejects(
      async () =>
        await f.app.ctx.workflows.assignment(
          { projectId: foreign.project.id, actorId: foreign.actor.id },
          task.id,
        ),
      { code: 'not_found' },
    );
    await waitForManagedCode(f.app.ctx.codeWork, {
      projectId: foreign.project.id,
      actorId: foreign.actor.id,
    });
    const dependent = await f.create({ dependsOn: [task.id] });
    const before = await f.writes();
    await assert.rejects(
      async () => await f.app.ctx.workflows.assignment(f.producer.caller, dependent.id),
      {
        code: 'dependencies_pending',
      },
    );
    await assert.rejects(async () => await f.begin(f.producer.caller, dependent.id), {
      code: 'dependencies_pending',
    });
    assert.equal(await f.writes(), before);
    assert.deepEqual(await f.app.ctx.workflows.workStarts(f.operator, dependent.id), []);
    await f.app.ctx.scope.revokeActor(f.operator, f.producer.caller.actorId);
    await assert.rejects(async () => await f.begin(f.producer.caller, task.id), { status: 403 });
  } finally {
    await f.close();
  }
});

test('task contexts and assignments refuse a reader and the other role', async () => {
  // Context Builder only checks that the caller may read the project; the task's own
  // assignment check is what refuses these callers.
  const f = await fixture();
  try {
    const task = await f.create();
    const work = { taskId: task.id, purpose: 'work' as const, expectedRevision: 0 };
    for (const caller of [f.reader.caller, f.reviewer.caller])
      await assert.rejects(
        async () => await f.app.ctx.tasks.context(caller, { ...work, requestId: 'work' }),
        { code: 'forbidden' },
      );
    const submitted = await f.submit(task.id);
    const claim = await f.claim(submitted);
    const review = {
      taskId: task.id,
      purpose: 'review' as const,
      expectedRevision: 1,
      claimId: claim.claimId!,
    };
    const before = await f.writes();
    for (const caller of [f.reader.caller, f.producer.caller]) {
      await assert.rejects(
        async () => await f.app.ctx.tasks.context(caller, { ...review, requestId: 'review' }),
        { code: 'forbidden' },
      );
      await assert.rejects(async () => await f.app.ctx.workflows.assignment(caller, task.id), {
        code: 'forbidden',
      });
    }
    assert.equal(await f.writes(), before);
    assert.equal(
      (await f.app.ctx.tasks.context(f.reviewer.caller, { ...review, requestId: 'review' }))
        .actorId,
      f.reviewer.caller.actorId,
    );
  } finally {
    await f.close();
  }
});

test('returned-for-changes work has a new start and retained review feedback; terminal work cannot begin', async () => {
  const f = await fixture();
  try {
    const task = await f.create();
    await f.begin(f.producer.caller, task.id);
    const pending = await f.submit(task.id);
    const claim = await f.claim(pending);
    await f.begin(f.reviewer.caller, task.id, 1);
    const held = f.reviewLease!;
    const returned = await f.work.run(
      held,
      'review.submit',
      {
        reviewId: claim.id,
        claimId: claim.claimId!,
        expectedRevision: 1,
        verdict: 'needs_changes',
        notes: 'Recheck arithmetic against the original input receipt.',
        ...reviewedFindings(claim),
        requestId: 'return',
      },
      (caller, input) => f.app.ctx.tasks.submitReview(caller, input as never),
    );
    await f.work.release(held);
    assert.equal(returned.workflow.revision, 2);
    assert.equal(returned.guidance.workStart, null);
    assert.equal(
      (await f.app.ctx.tasks.get(f.producer.caller, task.id)).guidance.nextAction?.tool,
      'workflow.begin',
    );
    const revision = await f.begin(f.producer.caller, task.id, 2);
    assert.match(revision.context!.prompt, /original input receipt/);
    assert.deepEqual(
      (await f.app.ctx.workflows.workStarts(f.operator, task.id)).map((start) => start.revision),
      [0, 1, 2],
    );
    await f.app.ctx.tasks.markFailed(f.producer.caller, {
      taskId: task.id,
      expectedRevision: 2,
      reason: 'The required receipt cannot be obtained.',
      requestId: 'close',
    });
    await assert.rejects(async () => await f.begin(f.producer.caller, task.id, 3));
    await assert.rejects(
      async () => await f.app.ctx.workflows.assignment(f.producer.caller, task.id),
    );
    assert.equal((await f.app.ctx.tasks.get(f.operator, task.id)).workStarts.length, 3);
  } finally {
    await f.close();
  }
});

test('unavailable task recipes block begin while task reads and explicit closure remain usable', async () => {
  const f = await fixture();
  try {
    const type = {
      name: 'test.small-work',
      version: 1,
      kind: 'work' as const,
      recipe: {
        instructions: 'Perform the task.',
        maxChars: 48000,
        sections: [
          { key: 'task', title: 'Task', required: true },
          { key: 'brief', title: 'Brief', required: true },
        ],
        outputInstructions: 'Submit retained evidence.',
        format: 2 as const,
      },
    };
    const dispose = await f.app.ctx.tasks.registerType(type);
    const task = await f.create({ type: type.name });
    dispose();
    const guidance = (await f.app.ctx.tasks.get(f.producer.caller, task.id)).guidance;
    assert.equal(
      guidance.actions.find((action) => action.action === 'begin')?.blockers[0].code,
      'task_type_unavailable',
    );
    const blocked = await f.app.ctx.workflows.evaluate(f.producer.caller, task.id, {
      action: 'begin',
    });
    assert.equal(blocked.nextAction, null);
    assert.equal(blocked.blockers[0].status, 503);
    const before = await f.writes();
    await assert.rejects(async () => await f.begin(f.producer.caller, task.id), {
      code: 'task_type_unavailable',
    });
    assert.equal(await f.writes(), before);
    await f.app.ctx.tasks.registerType(type);
    const restored = await f.begin(f.producer.caller, task.id);
    assert.equal(restored.context!.type, type.name);
  } finally {
    await f.close();
  }
});

test('experiment.plan is retired: no version of it can be created', async () => {
  const f = await fixture();
  try {
    for (const typeVersion of [undefined, 1, 2])
      await assert.rejects(
        async () =>
          await f.app.ctx.tasks.create(f.producer.caller, {
            title: 'Unavailable type',
            goal: 'Reject retired types.',
            checks: ['No work created.'],
            requestId: `retired-${typeVersion}`,
            type: 'experiment.plan',
            ...(typeVersion ? { typeVersion } : {}),
            contextInputs: {},
          }),
        { code: 'task_type_unavailable' },
      );
  } finally {
    await f.close();
  }
});
