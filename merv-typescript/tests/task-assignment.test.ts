import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller, TaskCreate } from '@merv/contracts';
import { createApp } from '../src/app.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { TYPE_REQUIRED_CHECKS } from '../packages/tasks/src/definitions.js';

async function fixture(api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-assignment-'));
  const app = await createApp({ directory, api, port: 0 });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Assignments', actorName: 'Operator' });
  const operator: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const identity = await app.ctx.scope.issueActor(operator, { role, name: role });
    return {
      caller: { projectId: operator.projectId, actorId: identity.actor.id },
      token: identity.token,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    replacement = await issue('reviewer'),
    reader = await issue('reader');
  let sequence = 0;
  const create = async (extra: Partial<TaskCreate> = {}) =>
    await app.ctx.tasks.create(producer.caller, {
      title: 'Check addition',
      goal: 'Verify addition.',
      checks: ['Two plus three equals five.'],
      requestId: `create-${++sequence}`,
      ...extra,
    });
  const submit = async (id: string, revision = 0) => {
    const proof = await app.ctx.artifacts.create(producer.caller, {
      title: 'Reproduction',
      content: 'Observed 2 + 3 = 5.',
    });
    return await app.ctx.tasks.submitDelivery(
      producer.caller,
      confirmedDelivery({
        taskId: id,
        expectedRevision: revision,
        artifactIds: [proof.id],
        requestId: `submit-${++sequence}`,
      }),
    );
  };
  const begin = async (caller: Caller, id: string, revision = 0) =>
    await app.ctx.workflows.begin(caller, { instanceId: id, expectedRevision: revision });
  const writes = async () => {
    await app.ctx.domainEvents.drain();
    return await app.ctx.state.read(
      async (sql) => (await sql.get<{ n: number }>('SELECT total_changes() AS n'))!.n,
    );
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
    writes,
    close: async () => {
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
      type: 'experiment.plan',
      contextInputs: { research: [research.id], constraints: [constraints.id] },
    });
    assert.equal(task.guidance.nextAction?.tool, 'workflow.begin');
    const before = await f.writes();
    const preview = await f.app.ctx.workflows.assignment(f.producer.caller, task.id);
    assert.equal(await f.writes(), before, 'Assignment lookup must be read-only');
    assert.equal(preview.context?.type, 'experiment.plan');
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

test('review assignment can precede claim; recovery rebuilds context without rewriting first activation', async () => {
  const f = await fixture();
  try {
    const task = await f.submit((await f.create()).id);
    const before = await f.writes();
    const open = await f.app.ctx.workflows.assignment(f.reviewer.caller, task.id);
    assert.equal(await f.writes(), before);
    assert.equal(open.role, 'reviewer');
    assert.equal(open.execution.readOnly, true);
    assert.equal(open.context!.subject.claimId, undefined);
    assert.deepEqual(open.handoff.tools, ['review.start', 'workflow.assignment']);
    assert.match(open.context!.prompt, /Observed 2 \+ 3 = 5/);
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.context(f.reviewer.caller, {
          taskId: task.id,
          purpose: 'review',
          expectedRevision: 1,
          requestId: 'before-claim',
        }),
      { code: 'review_independence' },
    );
    await assert.rejects(
      async () => await f.app.ctx.workflows.assignment(f.producer.caller, task.id),
      {
        status: 403,
      },
    );
    const started = await f.begin(f.reviewer.caller, task.id, 1);
    assert.equal(
      (await f.app.ctx.reviews.get(f.operator, task.reviewId!)).status,
      'requested',
      'Beginning must not claim a review',
    );
    const claim = await f.app.ctx.reviews.start(f.reviewer.caller, task.reviewId!);
    const assigned = await f.app.ctx.workflows.assignment(f.reviewer.caller, task.id);
    assert.equal(assigned.context!.subject.claimId, claim.claimId);
    assert.equal(assigned.handoff.tools[0], 'review.submit');
    await assert.rejects(async () => await f.begin(f.replacement.caller, task.id, 1), {
      code: 'review_unavailable',
    });
    await f.app.ctx.tasks.checkpoint(f.reviewer.caller, {
      taskId: task.id,
      expectedRevision: 1,
      purpose: 'review',
      claimId: claim.claimId!,
      notes: 'Checked the arithmetic; still verify the input receipt.',
      requestId: 'checkpoint',
    });
    await f.app.ctx.scope.revokeActor(f.operator, f.reviewer.caller.actorId);
    await f.app.ctx.domainEvents.drain();
    const recovered = await f.begin(f.replacement.caller, task.id, 1);
    assert.equal(recovered.workStart!.eventId, started.workStart!.eventId);
    assert.equal(recovered.workStart!.actorId, f.reviewer.caller.actorId);
    assert.equal(recovered.actorId, f.replacement.caller.actorId);
    assert.match(recovered.context!.prompt, /reviewer_revoked/);
    assert.match(recovered.context!.prompt, /still verify the input receipt/);
    assert.notEqual(recovered.context!.hash, started.context!.hash);
    const nextClaim = await f.app.ctx.reviews.start(f.replacement.caller, task.reviewId!);
    assert.notEqual(nextClaim.claimId, claim.claimId);
    const next = await f.app.ctx.workflows.assignment(f.replacement.caller, task.id);
    assert.equal(next.context!.subject.claimId, nextClaim.claimId);
    assert.equal((await f.app.ctx.workflows.workStarts(f.operator, task.id)).length, 1);
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
    const claim = await f.app.ctx.reviews.start(f.reviewer.caller, pending.reviewId!);
    await f.begin(f.reviewer.caller, task.id, 1);
    const returned = await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
      reviewId: claim.id,
      claimId: claim.claimId!,
      expectedRevision: 1,
      verdict: 'needs_changes',
      notes: 'Recheck arithmetic against the original input receipt.',
      ...reviewedFindings(claim),
      requestId: 'return',
    });
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

test('an experiment plan task carries a feasibility check its delivery review cannot waive', async () => {
  const f = await fixture();
  try {
    const feasible = TYPE_REQUIRED_CHECKS['experiment.plan']!.checks[0]!;
    const source = async (title: string) =>
      (await f.app.ctx.artifacts.create(f.producer.caller, { title, content: `${title}.` })).id;
    const contextInputs = {
      research: [await source('Prior work')],
      constraints: [await source('Constraints')],
    };
    const task = await f.create({ type: 'experiment.plan', contextInputs });
    assert.equal(task.typeVersion, 2);
    assert.deepEqual(task.checks, ['Two plus three equals five.', feasible]);
    const brief = await f.app.ctx.artifacts.read(f.producer.caller, task.briefId);
    assert.ok(brief.content.includes(feasible), 'The rendered brief states the appended check');
    // A caller who already wrote the check keeps it where they put it, once.
    const supplied = await f.create({
      type: 'experiment.plan',
      contextInputs,
      checks: [feasible.toUpperCase(), 'Two plus three equals five.'],
    });
    assert.deepEqual(supplied.checks, [feasible.toUpperCase(), 'Two plus three equals five.']);
    // The older version stays registered for its own tasks but is no way around the check.
    await assert.rejects(
      async () => await f.create({ type: 'experiment.plan', typeVersion: 1, contextInputs }),
      { code: 'task_type_unavailable' },
    );

    const deliver = async (taskId: string, checkCount: number) => {
      const plan = await f.app.ctx.artifacts.create(f.producer.caller, {
        title: 'Plan',
        content: 'The plan and what it needs against what exists.',
      });
      const delivered = await f.app.ctx.tasks.submitDelivery(
        f.producer.caller,
        confirmedDelivery(
          { taskId, expectedRevision: 0, artifactIds: [plan.id], requestId: `deliver-${taskId}` },
          checkCount,
        ),
      );
      return await f.app.ctx.reviews.start(f.reviewer.caller, delivered.reviewId!);
    };
    const first = await deliver(task.id, 2);
    assert.deepEqual(first.requiredCriteria, [2]);
    assert.deepEqual((await deliver(supplied.id, 2)).requiredCriteria, [1]);
    assert.equal('requiredCriteria' in (await deliver((await f.create()).id, 1)), false);

    const verdict = (findings: unknown) => ({
      ...reviewedFindings(first),
      ...(findings ? { findings } : {}),
      reviewId: first.id,
      claimId: first.claimId!,
      expectedRevision: 1,
      verdict: 'pass' as const,
      notes: 'Read the plan against the project records.',
    });
    const met = reviewedFindings(first).findings as { criterionNumber: number }[];
    const waived = met.map((finding) =>
      finding.criterionNumber === 2
        ? {
            criterionNumber: 2,
            status: 'waived',
            evidenceIds: [],
            notes: 'Feasibility is taken on trust.',
          }
        : finding,
    );
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
          ...verdict(waived),
          requestId: 'waived',
        } as never),
      { code: 'criterion_not_waivable' },
    );
    assert.equal(
      (await f.app.ctx.tasks.get(f.producer.caller, task.id)).workflow.state,
      'in_review',
    );
    const done = await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
      ...verdict(null),
      requestId: 'met',
    } as never);
    assert.equal(done.workflow.state, 'done');
  } finally {
    await f.close();
  }
});
