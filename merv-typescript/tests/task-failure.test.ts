import { mapAsync } from '@merv/contracts';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { legacyTaskPolicy } from './fixtures/legacy-task-policy.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller, Data, Task, TaskMarkFailed, WorkflowDefinition } from '@merv/contracts';
import { createApp } from '../src/app.js';

type App = Awaited<ReturnType<typeof createApp>>;

async function fixture(api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-failure-'));
  const app = await createApp({ directory, api, port: 0 });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Failure tests',
    actorName: 'Operator',
  });
  const operator: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const issued = await app.ctx.scope.issueActor(operator, { role, name: role });
    return {
      caller: { actorId: issued.actor.id, projectId: boot.project.id },
      token: issued.token,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
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
    await app.ctx.tasks.create(producer.caller, {
      title: 'Withdrawable work',
      goal: 'Goal.',
      checks: ['Check.'],
      briefId: brief.id,
      requestId: `create-${++sequence}`,
    });
  const deliver = async (task: Task) =>
    await app.ctx.tasks.submitDelivery(
      producer.caller,
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [evidence.id],
        expectedRevision: task.workflow.revision,
        requestId: `deliver-${++sequence}`,
      }),
    );
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
    async close() {
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

// Original persisted task@1 graph, copied independently of the new program export.
const legacyGraph: WorkflowDefinition = {
  name: 'task',
  version: 1,
  managed: true,
  initial: 'in_progress',
  states: ['in_progress', 'in_review', 'done', 'failed'],
  terminal: ['done', 'failed'],
  edges: [
    { from: 'in_progress', action: 'submit_delivery', to: 'in_review' },
    { from: 'in_review', action: 'reissue_review', to: 'in_review' },
    { from: 'in_review', action: 'accept', to: 'done' },
    { from: 'in_review', action: 'revise', to: 'in_progress' },
    { from: 'in_review', action: 'fail_review', to: 'failed' },
  ],
};

async function legacyTasks(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  await f.app.setEnabled('tasks', false);
  const registration = await f.app.ctx.workflows.register(
    legacyGraph,
    await legacyTaskPolicy(f.app.ctx.state, legacyGraph),
  );
  const ids: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const workflow = await registration.start(f.producer.caller, {
        workflow: 'task',
        version: 1,
        requestId: `legacy-start-${i}`,
        data: {
          title: 'Legacy work',
          goal: 'Goal.',
          checks: ['Check.'],
          producerId: f.producer.caller.actorId,
          briefId: f.brief.id,
        },
      });
      // Only original task columns; later columns receive their migration defaults.
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run(
            'INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
            workflow.id,
            f.operator.projectId,
            'Legacy work',
            'Goal.',
            '["Check."]',
            f.producer.caller.actorId,
            f.brief.id,
            workflow.createdAt,
          ),
      );
      ids.push(workflow.id);
    }
  } finally {
    registration.dispose();
    await f.app.setEnabled('tasks', true);
  }
  return await mapAsync(ids, async (id) => await f.app.ctx.tasks.get(f.producer.caller, id));
}

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
    assert.equal(task.workflow.version, 2);
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
    const other = await f.app.ctx.scope.bootstrap({
      projectName: 'Other project',
      actorName: 'Other operator',
    });
    const outsider = { actorId: other.actor.id, projectId: other.project.id };
    await assert.rejects(async () => await f.app.ctx.tasks.markFailed(outsider, input), {
      code: 'not_found',
    });
    assert.equal((await f.app.ctx.tasks.get(f.operator, task.id)).workflow.revision, 0);
    await f.app.ctx.scope.revokeActor(f.operator, f.producer.caller.actorId);
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

test('producer withdrawal is terminal, attributed and exactly replayable while preserving checkpoints and evidence', async () => {
  const f = await fixture();
  try {
    const task = await f.create();
    const checkpoint = await f.app.ctx.tasks.checkpoint(f.producer.caller, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      artifactIds: [f.evidence.id],
      notes: 'Partial result before source loss.',
      requestId: 'checkpoint',
    });
    const context = await f.app.ctx.tasks.context(f.producer.caller, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'context',
    });
    const input = failureInput(task),
      failed = await f.app.ctx.tasks.markFailed(f.producer.caller, input);
    assert.equal(failed.workflow.state, 'failed');
    assert.equal(failed.workflow.revision, 1);
    assert.equal(failed.guidance.currentGate, 'terminal');
    assert.deepEqual(failed.guidance.actions, []);
    assert.deepEqual(failed.failure, {
      reason: input.reason,
      actorId: f.producer.caller.actorId,
      reviewId: null,
      createdAt: failed.failure!.createdAt,
    });
    assert.ok(Number.isFinite(Date.parse(failed.failure!.createdAt)));
    const events = (await f.app.ctx.state.events(f.operator.projectId)).filter(
      (event) => event.type === 'task.failed',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].subjectId, task.id);
    assert.equal(events[0].actorId, f.producer.caller.actorId);
    assert.deepEqual(events[0].data, failed.failure);
    const head = await f.app.ctx.state.eventHead();
    assert.deepEqual(await f.app.ctx.tasks.markFailed(f.producer.caller, input), failed);
    assert.equal(await f.app.ctx.state.eventHead(), head);
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.markFailed(f.producer.caller, { ...input, reason: 'Changed input' }),
      { code: 'request_conflict' },
    );
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.markFailed(f.producer.caller, {
          ...input,
          expectedRevision: 1,
          requestId: 'again',
        }),
      { code: 'invalid_transition' },
    );
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.submitDelivery(
          f.producer.caller,
          confirmedDelivery({
            taskId: task.id,
            artifactIds: [f.evidence.id],
            expectedRevision: 1,
            requestId: 'late-delivery',
          }),
        ),
      { code: 'invalid_transition' },
    );
    const assignment = {
      taskId: task.id,
      purpose: 'work' as const,
      expectedRevision: 1,
      requestId: 'late-context',
    };
    await assert.rejects(async () => await f.app.ctx.tasks.context(f.producer.caller, assignment), {
      code: 'invalid_transition',
    });
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.checkpoint(f.producer.caller, {
          ...assignment,
          notes: 'Late checkpoint',
        }),
      { code: 'invalid_transition' },
    );
    assert.deepEqual(await f.app.ctx.contextBuilder.get(f.producer.caller, context.id), context);
    const stored = await f.app.ctx.state.read(
      async (sql) =>
        await sql.get<{ checkpoint: string }>(
          'SELECT checkpoint FROM task_checkpoints WHERE id=?',
          checkpoint.id,
        ),
    );
    assert.deepEqual(JSON.parse(stored!.checkpoint), checkpoint);
    assert.equal(
      (await f.app.ctx.artifacts.read(f.producer.caller, f.evidence.id)).content,
      'Check. Verified output.',
    );
  } finally {
    await f.close();
  }
});

test('producer and operator withdrawal close requested or claimed reviews and fence all later review work', async () => {
  const f = await fixture();
  try {
    for (const claimed of [false, true])
      for (const caller of [f.producer.caller, f.operator]) {
        const pending = await f.deliver(await f.create());
        const review = claimed
          ? await f.app.ctx.reviews.start(f.reviewer.caller, pending.reviewId!)
          : await f.app.ctx.reviews.get(f.operator, pending.reviewId!);
        const failed = await f.app.ctx.tasks.markFailed(
          caller,
          failureInput(pending, `withdraw-${pending.id}`),
        );
        assert.equal(failed.workflow.revision, 2);
        assert.equal(failed.failure?.reviewId, review.id);
        assert.equal(failed.failure?.actorId, caller.actorId);
        assert.deepEqual(failed.deliveryIds, pending.deliveryIds);
        assert.equal(failed.reviewId, review.id);
        const closed = await f.app.ctx.reviews.get(f.operator, review.id);
        assert.equal(closed.status, 'superseded');
        assert.deepEqual(closed.artifactIds, review.artifactIds);
        assert.equal(closed.snapshotHash, review.snapshotHash);
        assert.equal(closed.reviewerId, review.reviewerId);
        assert.equal(closed.claimId, review.claimId);
        await assert.rejects(
          async () => await f.app.ctx.reviews.start(f.reviewer.caller, review.id),
          {
            code: 'review_unavailable',
          },
        );
        const late = {
          ...reviewedFindings(review),
          reviewId: review.id,
          claimId: review.claimId ?? 'never-claimed',
          verdict: 'pass' as const,
          notes: 'Late verdict',
          expectedRevision: 2,
          requestId: `late-${review.id}`,
        };
        await assert.rejects(
          async () => await f.app.ctx.tasks.submitReview(f.reviewer.caller, late),
          {
            code: 'review_closed',
          },
        );
        await assert.rejects(async () => await f.app.ctx.reviews.submit(f.reviewer.caller, late), {
          code: 'review_closed',
        });
        const assignment = {
          taskId: pending.id,
          purpose: 'review' as const,
          claimId: late.claimId,
          expectedRevision: 2,
          requestId: `late-context-${review.id}`,
        };
        await assert.rejects(
          async () => await f.app.ctx.tasks.context(f.reviewer.caller, assignment),
          {
            code: 'invalid_transition',
          },
        );
        await assert.rejects(
          async () =>
            await f.app.ctx.tasks.checkpoint(f.reviewer.caller, {
              ...assignment,
              notes: 'Late review checkpoint',
            }),
          { code: 'invalid_transition' },
        );
        await assert.rejects(
          async () =>
            await f.app.ctx.tasks.reissueReview(f.producer.caller, {
              taskId: pending.id,
              expectedRevision: 2,
              reason: 'Reopen',
              requestId: `reopen-${review.id}`,
            }),
          { code: 'invalid_transition' },
        );
        await f.app.ctx.scope.revokeActor(f.operator, f.reviewer.caller.actorId);
        await f.app.ctx.domainEvents.drain();
        assert.equal((await f.app.ctx.reviews.get(f.operator, review.id)).status, 'superseded');
        // Each iteration uses a fresh active reviewer, after checking recovery cannot reopen the withdrawn review.
        f.reviewer.caller = (await f.issue('reviewer')).caller;
      }
  } finally {
    await f.close();
  }
});

test('withdrawal after needs_changes preserves the submitted assessment and its evidence', async () => {
  const f = await fixture();
  try {
    const pending = await f.deliver(await f.create()),
      claim = await f.app.ctx.reviews.start(f.reviewer.caller, pending.reviewId!);
    const revised = await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      verdict: 'needs_changes',
      notes: 'Recover the missing source before acceptance.',
      expectedRevision: 1,
      requestId: 'needs-changes',
    });
    const assessment = await f.app.ctx.reviews.get(f.operator, claim.id);
    const failed = await f.app.ctx.tasks.markFailed(f.producer.caller, failureInput(revised));
    assert.equal(failed.workflow.revision, 3);
    assert.equal(failed.failure?.reviewId, null, 'Only an open review is closed by withdrawal');
    assert.equal(failed.reviewId, claim.id, 'The previous assessment remains attached');
    assert.deepEqual(await f.app.ctx.reviews.get(f.operator, claim.id), assessment);
    assert.equal(assessment.status, 'submitted');
    assert.equal(assessment.verdict, 'needs_changes');
    assert.deepEqual(failed.deliveryIds, revised.deliveryIds);
    assert.equal(failed.workflow.data.revisionContext, revised.workflow.data.revisionContext);
    await assert.rejects(async () => await f.app.ctx.reviews.supersede(f.operator, claim.id), {
      code: 'review_closed',
    });
    assert.deepEqual(await f.app.ctx.reviews.get(f.operator, claim.id), assessment);
  } finally {
    await f.close();
  }
});

test('review closure and final event faults roll back withdrawal, version upgrade and dedup together', async () => {
  const f = await fixture();
  try {
    const [legacy] = await legacyTasks(f, 1);
    const pending = await f.deliver(legacy);
    await f.app.ctx.reviews.start(f.reviewer.caller, pending.reviewId!);
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
    assert.equal(failed.workflow.version, 2);
    assert.equal(failed.workflow.revision, pending.workflow.revision + 2);
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

test('legacy tasks keep v1 pins and normal review behavior; explicit withdrawal upgrades atomically and survives restart', async () => {
  const f = await fixture();
  let restarted: App | undefined;
  try {
    const [normal, withdrawn, untouched] = await legacyTasks(f, 3);
    const definitionBefore = await f.app.ctx.state.read(
      async (sql) =>
        await sql.get('SELECT * FROM wf_definitions WHERE name=? AND version=?', 'task', 1),
    );
    assert.ok([normal, withdrawn, untouched].every((task) => task.workflow.version === 1));
    assert.ok(withdrawn.guidance.actions.some((action) => action.action === 'mark_failed'));
    const pending = await f.deliver(normal),
      claim = await f.app.ctx.reviews.start(f.reviewer.caller, pending.reviewId!);
    const done = await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      verdict: 'pass',
      notes: 'All evidence verified.',
      expectedRevision: 1,
      requestId: 'legacy-pass',
    });
    assert.equal(done.workflow.version, 1);
    assert.equal(done.workflow.state, 'done');
    assert.equal(done.workflow.revision, 2);
    const input = failureInput(withdrawn),
      failed = await f.app.ctx.tasks.markFailed(f.producer.caller, input);
    assert.equal(failed.workflow.version, 2);
    assert.equal(failed.workflow.revision, 2);
    assert.equal((await f.app.ctx.tasks.get(f.producer.caller, untouched.id)).workflow.version, 1);
    assert.deepEqual(
      await f.app.ctx.state.read(
        async (sql) =>
          await sql.get('SELECT * FROM wf_definitions WHERE name=? AND version=?', 'task', 1),
      ),
      definitionBefore,
    );
    const head = await f.app.ctx.state.eventHead();
    await f.app.stop();
    restarted = await createApp({ directory: f.directory });
    assert.deepEqual(await restarted.ctx.tasks.get(f.producer.caller, withdrawn.id), failed);
    assert.deepEqual(await restarted.ctx.tasks.markFailed(f.producer.caller, input), failed);
    assert.equal(await restarted.ctx.state.eventHead(), head);
    assert.equal((await restarted.ctx.tasks.get(f.producer.caller, normal.id)).workflow.version, 1);
    assert.equal(
      (await restarted.ctx.tasks.get(f.producer.caller, untouched.id)).workflow.version,
      1,
    );
    assert.equal(
      (await restarted.ctx.tasks.get(f.producer.caller, untouched.id)).guidance.nextAction?.action,
      'begin',
    );
  } finally {
    await restarted?.stop();
    await f.close();
  }
});

test('HTTP and MCP expose strict task.mark_failed input, canonical guidance and replay', async () => {
  const f = await fixture(true);
  let client: Client | undefined;
  try {
    client = new Client({ name: 'task-failure-integration', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${f.app.ctx.api.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${f.producer.token}` } },
      }),
    );
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'task.mark_failed'));
    const task = await f.create(),
      input = failureInput(task);
    const parsed = (result: Awaited<ReturnType<Client['callTool']>>) =>
      JSON.parse((result.content as { text: string }[])[0].text);
    for (const invalid of [
      { ...input, unexpected: true },
      { ...input, reason: ' ' },
      { ...input, expectedRevision: -1 },
      { taskId: task.id, reason: 'No revision', requestId: 'missing' },
    ]) {
      const result = await client.callTool({ name: 'task.mark_failed', arguments: invalid });
      assert.equal(result.isError, true);
      assert.equal(parsed(result).error.code, 'invalid_input');
    }
    assert.equal((await f.app.ctx.tasks.get(f.producer.caller, task.id)).workflow.revision, 0);
    const response = await fetch(`${f.app.ctx.api.url}/tools/task.mark_failed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${f.producer.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    const failed = (await response.json()).result;
    assert.equal(failed.workflow.state, 'failed');
    const replay = await client.callTool({ name: 'task.mark_failed', arguments: { ...input } });
    assert.equal(replay.isError, undefined);
    assert.deepEqual(parsed(replay), failed);
    const guidance = await client.callTool({
      name: 'workflow.status_and_next',
      arguments: { instanceId: task.id },
    });
    assert.deepEqual(parsed(guidance), failed.guidance);
    assert.equal(failed.guidance.currentGate, 'terminal');
    const fresh = await f.create();
    const mcpFailure = await client.callTool({
      name: 'task.mark_failed',
      arguments: { ...failureInput(fresh, 'mcp-withdraw') },
    });
    assert.equal(mcpFailure.isError, undefined);
    assert.equal(parsed(mcpFailure).workflow.state, 'failed');
  } finally {
    await client?.close();
    await f.close();
  }
});
