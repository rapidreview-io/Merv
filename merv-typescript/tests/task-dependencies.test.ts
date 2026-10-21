import type { Caller, Verdict } from '@merv/contracts';
import type { Task, TaskCreate } from '@merv/tasks/types';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from './fixtures/app.js';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { taskActors } from './fixtures/task-actors.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

type App = Awaited<ReturnType<typeof createApp>>;

async function fixture(api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-dependencies-'));
  const app = await createApp({ directory, api, port: 0 });
  const { operator, issue, producer, reviewer, reader } = await taskActors(app, 'Dependency tests');
  await waitForManagedCode(app.ctx.codeWork, operator);
  const brief = await app.ctx.artifacts.create(producer.caller, {
    title: 'Brief',
    content: 'Goal. Check.',
  });
  const evidence = await app.ctx.artifacts.create(producer.caller, {
    title: 'Evidence',
    content: 'Check. Upstream-only-secret-proof-82971.',
  });
  let sequence = 0;
  const input = (dependsOn?: TaskCreate['dependsOn']): TaskCreate => ({
    title: `Work ${++sequence}`,
    goal: 'Goal.',
    checks: ['Check.'],
    briefId: brief.id,
    requestId: `create-${sequence}`,
    ...(dependsOn === undefined ? {} : { dependsOn }),
  });
  const create = async (dependsOn?: TaskCreate['dependsOn']) =>
    await currentTask(app.ctx, producer.caller, input(dependsOn));
  const get = async (task: Task) => await app.ctx.tasks.get(producer.caller, task.id);
  const work = currentWork(app.ctx, { directory, source: producer.caller });
  const deliver = async (task: Task) => {
    const held = await work.lease(await get(task));
    try {
      Object.assign(
        evidence,
        await app.ctx.artifacts.create(held.worker, {
          title: 'Evidence',
          content: 'Check. Upstream-only-secret-proof-82971.',
        }),
      );
      const commandId = await work.commit(held);
      return await work.run(
        held,
        'task.submit_delivery',
        confirmedDelivery({
          taskId: task.id,
          artifactIds: [evidence.id],
          commandId,
          expectedRevision: (await get(task)).workflow.revision,
          requestId: `deliver-${++sequence}`,
        }),
        (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
      );
    } finally {
      await work.release(held);
    }
  };
  const verdict = async (pending: Task, value: Verdict) => {
    const runner = await app.ctx.scope.credentials.issueActor(operator, {
      name: 'Independent review runner',
      role: 'operator',
    });
    const held = await work.lease(pending, {
      projectId: operator.projectId,
      actorId: runner.actor.id,
      credentialId: runner.credential.id,
    });
    try {
      const claim = await app.ctx.reviews.get(held.worker, pending.reviewId!);
      return await work.run(
        held,
        'review.submit',
        {
          ...reviewedFindings(claim),
          reviewId: claim.id,
          claimId: claim.claimId!,
          verdict: value,
          notes: `Independent verdict: ${value}.`,
          expectedRevision: pending.workflow.revision,
          requestId: `verdict-${++sequence}`,
        },
        (caller, input) => app.ctx.tasks.submitReview(caller, input as never),
      );
    } finally {
      await work.release(held);
    }
  };
  const withdraw = async (task: Task) =>
    await app.ctx.tasks.markFailed(producer.caller, {
      taskId: task.id,
      expectedRevision: (await get(task)).workflow.revision,
      reason: 'Prerequisite cannot be completed.',
      requestId: `withdraw-${++sequence}`,
    });
  return {
    directory,
    app,
    operator,
    producer,
    reviewer,
    reader,
    issue,
    brief,
    evidence,
    input,
    create,
    get,
    deliver,
    verdict,
    withdraw,
    async close() {
      await work.close();
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function assertWaiting(
  f: Awaited<ReturnType<typeof fixture>>,
  task: Task,
  code = 'dependencies_pending',
) {
  const current = await f.get(task);
  assert.equal(current.workflow.state, 'in_progress');
  assert.equal(current.guidance.currentGate, code);
  assert.equal(
    current.guidance.nextAction?.action ?? null,
    code === 'dependency_failed' ? 'mark_failed' : null,
  );
  assert.ok(current.guidance.blockers.some((blocker) => blocker.code === code));
  const assignment = {
    taskId: task.id,
    purpose: 'work' as const,
    expectedRevision: current.workflow.revision,
    requestId: `blocked-${task.id}`,
  };
  await assert.rejects(async () => await f.app.ctx.tasks.context(f.producer.caller, assignment), {
    code,
  });
  await assert.rejects(
    async () =>
      await f.app.ctx.tasks.checkpoint(f.producer.caller, {
        ...assignment,
        notes: 'Started prematurely.',
      }),
    { code },
  );
  await assert.rejects(async () => await f.deliver(task), { code });
  assert.deepEqual(await f.get(task), current, 'Failed dependent commands have no domain effects');
}

async function snapshot(app: App, caller: Caller) {
  return await app.ctx.state.read(async (sql) => ({
    tasks: await sql.all('SELECT * FROM tasks ORDER BY id'),
    workflows: await sql.all('SELECT * FROM wf_instances ORDER BY id'),
    edges: await sql.all('SELECT * FROM wf_dependencies ORDER BY source_id,target_id'),
    history: await sql.all('SELECT * FROM wf_history ORDER BY instance_id,revision'),
    commands: await sql.all('SELECT * FROM task_commands ORDER BY request_id'),
    requests: await sql.all('SELECT * FROM wf_requests ORDER BY request_id'),
    events: await app.ctx.state.events(caller.projectId),
  }));
}

test('failed prerequisites recommend authorized explicit withdrawal; failures never automatically cascade to descendants', async () => {
  const f = await fixture();
  try {
    const otherProducer = (await f.issue('producer')).caller;
    for (const failure of ['review', 'withdrawal'] as const) {
      const a = await f.create(),
        b = await f.create(a.id),
        c = await f.create(b.id);
      if (failure === 'review') await f.verdict(await f.deliver(a), 'fail');
      else await f.withdraw(a);
      await assertWaiting(f, b, 'dependency_failed');
      await assertWaiting(f, c);
      const blocked = await f.get(b);
      assert.equal(blocked.dependencies[0].failed, true);
      assert.equal(blocked.dependencies[0].settled, false);
      assert.equal(blocked.guidance.nextAction?.tool, 'task.write:mark_failed');
      assert.equal(blocked.guidance.nextAction?.status, 'needs_input');
      assert.equal(blocked.workflow.state, 'in_progress');
      const beforePreflight = await snapshot(f.app, f.operator);
      const deliveryPreflight = await f.app.ctx.workflows.evaluate(f.producer.caller, b.id, {
        action: 'submit_delivery',
        input: confirmedDelivery({
          taskId: b.id,
          expectedRevision: 0,
          artifactIds: [f.evidence.id],
        }),
      });
      assert.equal(
        deliveryPreflight.nextAction,
        null,
        'Explicit delivery preflight must not switch to withdrawal',
      );
      assert.ok(deliveryPreflight.blockers.some((blocker) => blocker.code === 'dependency_failed'));
      const failurePreflight = await f.app.ctx.workflows.evaluate(f.producer.caller, b.id, {
        action: 'mark_failed',
        input: { taskId: b.id, expectedRevision: 0, reason: 'Prerequisite failed.' },
      });
      assert.equal(failurePreflight.nextAction?.action, 'mark_failed');
      assert.equal(failurePreflight.nextAction?.status, 'ready');
      assert.deepEqual(
        await snapshot(f.app, f.operator),
        beforePreflight,
        'Guidance never performs the recommended failure',
      );
      for (const caller of [f.reader.caller, f.reviewer.caller, otherProducer]) {
        const guidance = await f.app.ctx.workflows.evaluate(caller, b.id);
        assert.equal(
          guidance.nextAction,
          null,
          'Another actor cannot inherit withdrawal authority',
        );
        assert.equal(
          guidance.actions.find((action) => action.action === 'mark_failed')?.status,
          'blocked',
        );
      }
      assert.equal(
        (await f.app.ctx.workflows.evaluate(f.operator, b.id)).nextAction?.action,
        'mark_failed',
      );
      await f.withdraw(b);
      await assertWaiting(f, c, 'dependency_failed');
      assert.equal((await f.get(c)).workflow.state, 'in_progress');
      await f.withdraw(c);
      assert.equal((await f.get(c)).workflow.state, 'failed');
    }
  } finally {
    await f.close();
  }
});
