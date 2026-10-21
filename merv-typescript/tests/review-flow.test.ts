import type { Caller, ReviewApplication, RunningBoard, Verdict } from '@merv/contracts';
import type { Experiment } from '@merv/experiments/types';
import type { Task } from '@merv/tasks/types';
import { LIMIT_ASK } from '@merv/workflows/evaluation';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { feasibilityStatement } from './feasibility-fixture.js';
import { httpApp } from './fixtures/app.js';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

/**
 * Nothing is silently stuck at review: once a gate's rounds are used up, the desk offers only
 * what the engine takes, the work is a project admin's line and its card carries the control,
 * the worker could see the rounds coming, and a claim held by hand can be handed back.
 */
async function fixture(t: TestContext) {
  const { app, directory, tool } = await httpApp(t, 'merv-review-flow-', { cleanup: false });
  t.after(async () => {
    await work.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Review flow',
    actorName: 'Op',
  });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (name: string, role: 'producer' | 'reviewer' | 'operator') => {
    const issued = await app.ctx.scope.credentials.issueActor(operator, { name, role });
    const caller: Caller = {
      actorId: issued.actor.id,
      projectId: operator.projectId,
      credentialId: issued.credential.id,
    };
    return { caller, token: issued.token };
  };
  const producer = await issue('Producer', 'producer');
  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const work = currentWork(app.ctx, { directory, source: producer.caller });
  return { app, boot, operator, producer, issue, tool, id, work };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A Git task returned for changes as often as review_rounds allows, then delivered again. */
async function exhaustedTask(f: Fixture) {
  const reviewer = await f.issue('Leased reviewer', 'operator');
  const task = await currentTask(f.app.ctx, f.producer.caller, {
    title: 'Check figure units',
    goal: 'Finish check figure units so the draft can cite it.',
    checks: ['Every reference resolves.', 'The index is rebuilt from scratch.'],
    requestId: f.id('create'),
  });
  const current = async () => await f.app.ctx.tasks.get(f.operator, task.id);
  const deliver = async () => {
    const held = await f.work.lease(await current());
    try {
      const evidence = await f.work.run(
        held,
        'artifact.create',
        { title: f.id('Evidence'), content: 'Every reference resolved; the index was rebuilt.' },
        (caller, input) => f.app.ctx.artifacts.create(caller, input as never),
      );
      const commandId = await f.work.commit(held);
      return await f.work.run(
        held,
        'task.submit_delivery',
        confirmedDelivery(
          {
            taskId: task.id,
            artifactIds: [evidence.id],
            commandId,
            expectedRevision: (await current()).workflow.revision,
            requestId: f.id('deliver'),
          },
          2,
        ),
        (caller, input) => f.app.ctx.tasks.submitDelivery(caller, input as never),
      );
    } finally {
      await f.work.release(held);
    }
  };
  const verdict = async (pending: Task, value: Verdict) => {
    const held = await f.work.lease(pending, reviewer.caller);
    try {
      const claim = await f.app.ctx.reviews.get(held.worker, pending.reviewId!);
      return await f.work.run(
        held,
        'review.submit',
        {
          ...reviewedFindings(claim),
          reviewId: claim.id,
          claimId: claim.claimId!,
          verdict: value,
          notes: `Independent verdict: ${value}.`,
          expectedRevision: pending.workflow.revision,
          requestId: f.id('verdict'),
        },
        (caller, input) => f.app.ctx.tasks.submitReview(caller, input as never),
      );
    } finally {
      await f.work.release(held);
    }
  };
  const rounds: [number, number][] = [];
  for (let round = 0; round < 3; round++) {
    await verdict(await deliver(), 'needs_changes');
    // The producer, back at work, reads the rounds used and left at the review gate.
    const status = (await f.app.ctx.workflows.evaluate(f.producer.caller, task.id)).limits.find(
      (limit) => limit.name === 'review_rounds',
    )!;
    assert.equal(status.from, 'in_review');
    rounds.push([status.used, status.remaining]);
  }
  return { task: await deliver(), rounds };
}

test('a task whose review rounds are used up is offered only what ends it, and is an admin’s move', async (t) => {
  const f = await fixture(t);
  const { task, rounds } = await exhaustedTask(f);
  assert.deepEqual(rounds, [
    [1, 2],
    [2, 1],
    [3, 0],
  ]);
  // At the cap the work waits for a person; it is not returned again.
  const read = (await f.tool('workflow.status_and_next', f.producer.token, {
    instanceId: task.id,
  })) as { status: number; body: any };
  assert.equal(read.status, 200);
  assert.equal(read.body.result.currentGate, 'loop_limit_reached');

  // A person may claim it by hand now, and is offered only what the engine takes.
  const hand = await f.issue('Hand reviewer', 'reviewer');
  const pageGuidance = async () => {
    const response = await f.tool('workflow.status_and_next', hand.token, { instanceId: task.id });
    assert.equal(response.status, 200);
    return response.body.result.actions as { tool: string; arguments: Record<string, unknown> }[];
  };
  // An already-open review page still uses these exact flat-name predicates.
  const start = (await pageGuidance()).find((step) => step.tool === 'review.start');
  assert.deepEqual(start?.arguments, { reviewId: task.reviewId });
  const claimed = await f.tool('review.start', hand.token, { reviewId: task.reviewId });
  const submit = (await pageGuidance()).find((step) => step.tool === 'review.submit');
  assert.equal(submit?.arguments.reviewId, task.reviewId);
  assert.equal(submit?.arguments.claimId, claimed.body.result.claimId);
  assert.ok(!('action' in submit!.arguments));
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.deepEqual(
    [claimed.body.result.verdicts, claimed.body.result.returns, claimed.body.result.limit],
    [['fail'], undefined, 'Every review round is used: end it, or an admin allows another round.'],
  );

  // Home: the project admin's line, though the work is out for review; the producer has none.
  const home = async (token: string) => (await f.tool('ui.home', token)).body.result;
  const gateOf = (read: any) =>
    read.workflows.workflows.find((gate: any) => gate.instanceId === task.id);
  assert.deepEqual(gateOf(await home(f.boot.token)).yours, { ask: LIMIT_ASK, limit: 'exhausted' });
  assert.equal(gateOf(await home(f.producer.token)).yours, undefined);

  // The Running card carries the admin's control.
  const board = (await f.tool('ui.running', f.boot.token)).body.result as RunningBoard;
  const card = board.lanes.work.nodes.find(({ key }) => key === `work:${task.id}`);
  assert.equal(card?.attention?.action?.tool, 'workflow.write:extend_limit', JSON.stringify(card));
  assert.deepEqual(card?.attention?.action?.input, {
    instanceId: task.id,
    limit: 'review_rounds',
    additional: 1,
  });
  const theirs = (await f.tool('ui.running', f.producer.token)).body.result as RunningBoard;
  assert.equal(
    theirs.lanes.work.nodes.find(({ key }) => key === `work:${task.id}`)?.attention?.action,
    undefined,
  );

  // The desk offers the hand-back to whoever review.release takes it from: the claimer or an
  // admin, never anyone else.
  const releasable = async (token: string) =>
    (await f.tool('review.get', token, { reviewId: task.reviewId })).body.result.releasable;
  assert.deepEqual(
    [
      await releasable(hand.token),
      await releasable(f.boot.token),
      await releasable(f.producer.token),
    ],
    [true, true, undefined],
  );
  // review.release: only the claimer or an admin, and the same review opens to claim again.
  const release = (token: string, requestId: string) =>
    f.tool('review.release', token, {
      reviewId: task.reviewId,
      reason: 'I cannot finish this review.',
      requestId,
    });
  assert.equal((await release(f.producer.token, 'by-producer')).status, 403);
  const released = await release(hand.token, 'by-claimer');
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.deepEqual(
    [released.body.result.status, released.body.result.reviewerId ?? null],
    ['requested', null],
  );
  assert.deepEqual((await release(hand.token, 'by-claimer')).body, released.body);
  const [event] = (await f.app.ctx.state.events(f.operator.projectId)).filter(
    (item) => item.type === 'review.claim_released',
  );
  assert.deepEqual(
    [event.actorId, event.data.previousActorId, event.data.performedBy, event.data.reason],
    [hand.caller.actorId, hand.caller.actorId, 'review.release', 'I cannot finish this review.'],
  );
  // The released claim can no longer submit, and an admin may hand back another's claim.
  await assert.rejects(
    f.app.ctx.tasks.submitReview(hand.caller, {
      ...reviewedFindings(claimed.body.result),
      reviewId: task.reviewId!,
      claimId: claimed.body.result.claimId,
      verdict: 'fail',
      notes: 'Too late.',
      expectedRevision: task.workflow.revision,
      requestId: 'late',
    } as never),
    { code: 'review_closed' },
  );
  assert.equal((await f.tool('review.start', hand.token, { reviewId: task.reviewId })).status, 200);
  assert.equal((await release(f.boot.token, 'by-admin')).status, 200);
  assert.equal((await release(f.boot.token, 'by-admin-again')).status, 409);
});

test('an admin may not hand back a leased reviewer’s claim: its session is halted instead', async (t) => {
  const f = await fixture(t);
  const reviewer = await f.issue('Leased reviewer', 'operator');
  const task = await currentTask(f.app.ctx, f.producer.caller, {
    title: 'Check table units',
    goal: 'Finish check table units so the draft can cite it.',
    checks: ['Every reference resolves.'],
    requestId: f.id('create'),
  });
  const current = async () => await f.app.ctx.tasks.get(f.operator, task.id);
  const held = await f.work.lease(await current());
  try {
    const evidence = await f.work.run(
      held,
      'artifact.create',
      { title: f.id('Evidence'), content: 'Every reference resolved.' },
      (caller, input) => f.app.ctx.artifacts.create(caller, input as never),
    );
    const commandId = await f.work.commit(held);
    await f.work.run(
      held,
      'task.submit_delivery',
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [evidence.id],
          commandId,
          expectedRevision: (await current()).workflow.revision,
          requestId: f.id('deliver'),
        },
        1,
      ),
      (caller, input) => f.app.ctx.tasks.submitDelivery(caller, input as never),
    );
  } finally {
    await f.work.release(held);
  }
  const pending = await current();
  const review = await f.work.lease(pending, reviewer.caller);
  try {
    assert.ok((await f.app.ctx.reviews.get(review.worker, pending.reviewId!)).claimId);
    const refused = await f.tool('review.release', f.boot.token, {
      reviewId: pending.reviewId,
      reason: 'Stuck.',
      requestId: 'by-admin',
    });
    assert.deepEqual(
      [refused.status, refused.body.error?.code],
      [409, 'review_claimed_by_session'],
      JSON.stringify(refused.body),
    );
    assert.match(refused.body.error.message, /halt/);
    // So the desk offers nobody the hand-back of a leased claim.
    assert.equal(
      (await f.app.ctx.reviews.guide(f.operator, pending.reviewId!)).releasable,
      undefined,
    );
    assert.equal((await f.app.ctx.reviews.get(f.operator, pending.reviewId!)).status, 'started');
  } finally {
    await f.work.release(review);
  }
});

const plan =
  '# Summary\nCompare two methods.\n# Objective & hypothesis\nA improves held-out accuracy.\n# Evaluation\nUse the same held-out examples, baseline, metric and denominator.\n';

test('an experiment whose design rounds are used up is offered only a pass, with nowhere to return it', async (t) => {
  // This owner-gate test has no harness snapshot uploader. Advance the fixture clock past
  // the production grace for a stopped planner before testing its next design round.
  const wallClock = Date.now;
  let elapsed = 0;
  t.mock.method(Date, 'now', () => wallClock() + elapsed);
  const f = await fixture(t);
  // Sessions captured its clock at construction; Git writer fences keep real elapsed time.
  Date.now = wallClock;
  await waitForManagedCode(f.app.ctx.codeWork, f.operator);
  const reviewer = await f.issue('Reviewer', 'reviewer');
  const attach = async (
    e: Experiment,
    role: 'plan' | 'feasibility',
    path: string,
    caller: Caller,
  ) => {
    const artifact = await f.app.ctx.artifacts.create(caller, {
      title: role,
      content: role === 'feasibility' ? feasibilityStatement() : plan,
      mediaType: role === 'feasibility' ? 'application/json' : 'text/markdown',
    });
    await f.app.ctx.experiments.attach(caller, {
      experimentId: e.id,
      expectedRevision: e.workflow.revision,
      attemptIndex: e.attempt.index,
      artifactId: artifact.id,
      role,
      path,
      requestId: f.id('attach'),
    });
  };
  const design = async (e: Experiment) => {
    const held = await f.work.lease(e, f.operator);
    await attach(e, 'feasibility', 'feasibility.json', held.worker);
    await attach(e, 'plan', 'design/plan.md', held.worker);
    const pending = await f.work.run(
      held,
      'experiment.transition',
      {
        transition: 'submit_design',
        requestId: f.id('submit'),
      },
      (caller, input) => f.app.ctx.experiments.transition(caller, input as never),
    );
    await f.work.release(held);
    return pending;
  };
  let experiment = await design(
    await f.app.ctx.experiments.create(f.operator, {
      name: 'ablate-x',
      intent: 'Does x change accuracy?',
      dependsOn: [],
      requestId: f.id('create'),
    }),
  );
  const desk = async () =>
    await f.tool('review.get', reviewer.token, { reviewId: experiment.reviewId });
  const open = (await desk()).body.result;
  assert.deepEqual(
    [open.verdicts, open.returns?.map(({ value }: { value: string }) => value), open.limit],
    [undefined, ['planned'], undefined],
  );
  for (let round = 0; round < 4; round++) {
    const claim = await f.app.ctx.reviews.start(reviewer.caller, experiment.reviewId!);
    experiment = await f.app.ctx.experiments.submitReview(reviewer.caller, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      verdict: 'needs_changes',
      notes: 'Baseline missing.',
      expectedRevision: experiment.workflow.revision,
      requestId: f.id('verdict'),
    } as ReviewApplication);
    elapsed += 60_001;
    experiment = await design(experiment);
  }
  const used = (await desk()).body.result;
  assert.deepEqual(
    [used.verdicts, used.returns, used.limit],
    [['pass'], undefined, 'Every review round is used: pass it, or an admin allows another round.'],
  );
});
