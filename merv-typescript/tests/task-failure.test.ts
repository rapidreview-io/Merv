import type { Caller, Data } from '@merv/contracts';
import type { Task, TaskMarkFailed } from '@merv/tasks/types';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from './fixtures/app.js';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { taskActors } from './fixtures/task-actors.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

type App = Awaited<ReturnType<typeof createApp>>;

async function fixture(api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-failure-'));
  const app = await createApp({ directory, api, port: 0 });
  const { operator, issue, producer, reviewer, reader } = await taskActors(app, 'Failure tests');
  const brief = await app.ctx.artifacts.create(producer.caller, {
    title: 'Brief',
    content: 'Goal. Check.',
  });
  const evidence = await app.ctx.artifacts.create(producer.caller, {
    title: 'Evidence',
    content: 'Check. Verified output.',
  });
  let sequence = 0;
  const create = async () =>
    await currentTask(app.ctx, producer.caller, {
      title: 'Withdrawable work',
      goal: 'Goal.',
      checks: ['Check.'],
      briefId: brief.id,
      requestId: `create-${++sequence}`,
    });
  const work = currentWork(app.ctx, { directory, source: producer.caller });
  const deliver = async (task: Task) => {
    const held = await work.lease(task);
    try {
      Object.assign(
        evidence,
        await app.ctx.artifacts.create(held.worker, {
          title: 'Evidence',
          content: 'Check. Verified output.',
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
          expectedRevision: task.workflow.revision,
          requestId: `deliver-${++sequence}`,
        }),
        (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
      );
    } finally {
      await work.release(held);
    }
  };
  const claim = async (task: Task) => {
    const runner = await app.ctx.scope.credentials.issueActor(operator, {
      name: 'Independent review runner',
      role: 'operator',
    });
    const held = await work.lease(task, {
      projectId: operator.projectId,
      actorId: runner.actor.id,
      credentialId: runner.credential.id,
    });
    return { held, review: await app.ctx.reviews.get(held.worker, task.reviewId!) };
  };
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
    create,
    deliver,
    claim,
    work,
    async close() {
      await work.close();
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const failureInput = (task: Task, requestId = 'withdraw'): TaskMarkFailed => ({
  taskId: task.id,
  expectedRevision: task.workflow.revision,
  reason: 'Required source data cannot be recovered.',
  requestId,
});

async function durableState(app: App, caller: Caller, taskId: string) {
  return await app.ctx.state.read(async (sql) => ({
    task: await app.ctx.tasks.get(caller, taskId),
    history: await sql.all(
      'SELECT * FROM wf_history WHERE instance_id=? ORDER BY revision',
      taskId,
    ),
    commands: await sql.all('SELECT * FROM task_commands ORDER BY request_id'),
    requests: await sql.all('SELECT * FROM wf_requests ORDER BY request_id'),
    events: await app.ctx.state.events(caller.projectId),
    reviews: await app.ctx.reviews.list(caller),
  }));
}

test('task withdrawal shares guidance guards, checks identity and reason, and remains an explicit action', async () => {
  const f = await fixture();
  try {
    const task = await f.create(),
      input = failureInput(task);
    assert.equal(task.workflow.version, 46);
    assert.equal(task.failure, null);
    assert.equal(task.guidance.nextAction?.action, 'begin');
    assert.ok(task.guidance.actions.some((action) => action.action === 'mark_failed'));
    const preflight = async (caller: Caller, proposal: Data) =>
      (
        await f.app.ctx.workflows.evaluate(caller, task.id, {
          action: 'mark_failed',
          input: proposal,
        })
      ).actions.find((action) => action.action === 'mark_failed')!;
    const head = await f.app.ctx.state.eventHead();
    assert.equal((await preflight(f.producer.caller, { ...input })).status, 'ready');
    assert.equal(await f.app.ctx.state.eventHead(), head);
    for (const caller of [f.reader.caller, f.reviewer.caller, (await f.issue('producer')).caller]) {
      assert.equal((await preflight(caller, { ...input })).blockers[0].code, 'forbidden');
      await assert.rejects(async () => await f.app.ctx.tasks.markFailed(caller, input), {
        code: 'forbidden',
      });
    }
    for (const reason of ['', ' \n ', 'x'.repeat(16001), null, 1]) {
      const bad = { ...input, reason } as unknown as TaskMarkFailed;
      assert.equal(
        (await preflight(f.producer.caller, { ...bad })).blockers[0].code,
        'invalid_reason',
      );
      await assert.rejects(async () => await f.app.ctx.tasks.markFailed(f.producer.caller, bad), {
        code: 'invalid_reason',
      });
    }
    const stale = { ...input, expectedRevision: 1 };
    await assert.rejects(async () => await preflight(f.producer.caller, stale), {
      code: 'revision_conflict',
    });
    await assert.rejects(async () => await f.app.ctx.tasks.markFailed(f.producer.caller, stale), {
      code: 'revision_conflict',
    });
    for (const expectedRevision of [-1, 0.5, NaN]) {
      await assert.rejects(
        async () =>
          await f.app.ctx.tasks.markFailed(f.producer.caller, { ...input, expectedRevision }),
        { code: 'invalid_revision' },
      );
    }
    const other = await f.app.ctx.scope.credentials.bootstrap({
      projectName: 'Other project',
      actorName: 'Other operator',
    });
    const outsider = { actorId: other.actor.id, projectId: other.project.id };
    await assert.rejects(async () => await f.app.ctx.tasks.markFailed(outsider, input), {
      code: 'not_found',
    });
    assert.equal((await f.app.ctx.tasks.get(f.operator, task.id)).workflow.revision, 0);
    await f.app.ctx.scope.credentials.revokeActor(f.operator, f.producer.caller.actorId);
    await assert.rejects(async () => await f.app.ctx.tasks.markFailed(f.producer.caller, input), {
      code: 'forbidden',
    });
    const failed = await f.app.ctx.tasks.markFailed(f.operator, input);
    assert.equal(failed.failure?.actorId, f.operator.actorId);
    assert.equal(failed.workflow.state, 'failed');
  } finally {
    await f.close();
  }
});

test('review closure and final event faults roll back withdrawal and dedup together', async () => {
  const f = await fixture();
  try {
    const pending = await f.deliver(await f.create());
    await f.claim(pending);
    await f.app.ctx.domainEvents.drain();
    const input = failureInput(pending),
      before = await durableState(f.app, f.operator, pending.id);
    const originalSupersede = f.app.ctx.reviews.supersede;
    f.app.ctx.reviews.supersede = async function (...args) {
      await originalSupersede.apply(this, args);
      throw new Error('injected after supersede');
    };
    try {
      await assert.rejects(
        async () => await f.app.ctx.tasks.markFailed(f.producer.caller, input),
        /injected after supersede/,
      );
    } finally {
      f.app.ctx.reviews.supersede = originalSupersede;
    }
    assert.deepEqual(await durableState(f.app, f.operator, pending.id), before);
    const originalAppend = f.app.ctx.state.appendEvent;
    f.app.ctx.state.appendEvent = async function (tx, event) {
      const result = await originalAppend.call(this, tx, event);
      if (event.type === 'task.failed') throw new Error('injected after failure event');
      return result;
    };
    try {
      await assert.rejects(
        async () => await f.app.ctx.tasks.markFailed(f.producer.caller, input),
        /injected after failure event/,
      );
    } finally {
      f.app.ctx.state.appendEvent = originalAppend;
    }
    assert.deepEqual(await durableState(f.app, f.operator, pending.id), before);
    const failed = await f.app.ctx.tasks.markFailed(f.producer.caller, input);
    assert.equal(failed.workflow.version, 46);
    assert.equal(failed.workflow.state, 'failed');
    assert.equal(failed.workflow.revision, pending.workflow.revision + 1);
    assert.equal((await f.app.ctx.reviews.get(f.operator, pending.reviewId!)).status, 'superseded');
    assert.equal(
      (await f.app.ctx.state.events(f.operator.projectId)).filter(
        (event) => event.type === 'task.failed',
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});
