import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { legacyTaskPolicy } from './fixtures/legacy-task-policy.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller, Task, TaskCreate, Verdict, WorkflowDefinition } from '@merv/contracts';
import { createApp } from '../src/app.js';

type App = Awaited<ReturnType<typeof createApp>>;

async function fixture(api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-dependencies-'));
  const app = await createApp({ directory, api, port: 0 });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Dependency tests',
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
    await app.ctx.tasks.create(producer.caller, input(dependsOn));
  const get = async (task: Task) => await app.ctx.tasks.get(producer.caller, task.id);
  const deliver = async (task: Task) =>
    await app.ctx.tasks.submitDelivery(
      producer.caller,
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [evidence.id],
        expectedRevision: (await get(task)).workflow.revision,
        requestId: `deliver-${++sequence}`,
      }),
    );
  const verdict = async (pending: Task, value: Verdict) => {
    const claim = await app.ctx.reviews.start(reviewer.caller, pending.reviewId!);
    return await app.ctx.tasks.submitReview(reviewer.caller, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      verdict: value,
      notes: `Independent verdict: ${value}.`,
      expectedRevision: pending.workflow.revision,
      requestId: `verdict-${++sequence}`,
    });
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

function assignmentTask(task: Task) {
  // Reverse links can change when unrelated downstream tasks are created. The
  // pinned assignment keeps forward prerequisites and canonical guidance only.
  const { dependents: _dependents, ...assignment } = task;
  return assignment;
}

test('A → B → C becomes ready one independent pass at a time; needs_changes stays pending and context carries current dependency facts', async () => {
  const f = await fixture();
  try {
    const a = await f.create();
    const initialContextInput = {
      taskId: a.id,
      purpose: 'work' as const,
      expectedRevision: 0,
      requestId: 'a-before-dependent',
    };
    const initialContext = await f.app.ctx.tasks.context(f.producer.caller, initialContextInput);
    const b = await f.create(a.id),
      c = await f.create([b.id]);
    assert.deepEqual(
      await f.app.ctx.tasks.context(f.producer.caller, initialContextInput),
      initialContext,
      'Adding a reverse dependency must not break replay of the same assignment context request',
    );
    assert.deepEqual((await f.get(a)).dependencies, []);
    assert.deepEqual(
      (await f.get(a)).dependents.map((item) => item.id),
      [b.id],
    );
    assert.deepEqual((await f.get(b)).dependencies, [
      {
        id: a.id,
        workflow: 'task',
        version: 2,
        name: a.title,
        state: 'in_progress',
        settled: false,
        failed: false,
      },
    ]);
    assert.deepEqual((await f.get(b)).guidance.dependencies, (await f.get(b)).dependencies);
    assert.deepEqual(
      (await f.get(b)).dependents.map((item) => item.id),
      [c.id],
    );
    await assertWaiting(f, b);
    await assertWaiting(f, c);
    const uploaded = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Draft while waiting',
      content: 'Preparatory note.',
    });
    assert.equal(
      (await f.app.ctx.artifacts.read(f.producer.caller, uploaded.id)).content,
      'Preparatory note.',
    );
    const aReview = await f.deliver(a);
    assert.equal((await f.get(b)).dependencies[0].state, 'in_review');
    await assertWaiting(f, b);
    const revisedA = await f.verdict(aReview, 'needs_changes');
    assert.equal(revisedA.workflow.state, 'in_progress');
    await assertWaiting(f, b);
    await f.verdict(await f.deliver(revisedA), 'pass');
    const readyB = await f.get(b);
    assert.equal(readyB.guidance.nextAction?.action, 'begin');
    assert.equal(readyB.dependencies[0].settled, true);
    assert.equal(readyB.dependencies[0].failed, false);
    assert.equal(readyB.dependencies[0].state, 'done');
    assert.equal(
      readyB.workflow.revision,
      0,
      'Upstream progress does not fabricate a dependent transition',
    );
    await assertWaiting(f, c);
    const context = await f.app.ctx.tasks.context(f.producer.caller, {
      taskId: b.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: `blocked-${b.id}`,
    });
    assert.ok(
      context.prompt.includes(JSON.stringify(assignmentTask(readyB))),
      'Required task context carries current prerequisites and canonical guidance',
    );
    assert.ok(context.prompt.includes(a.id), 'Context includes prerequisite references');
    assert.ok(
      !context.prompt.includes('Upstream-only-secret-proof-82971'),
      'Prerequisite evidence is not copied automatically',
    );
    const checkpoint = await f.app.ctx.tasks.checkpoint(f.producer.caller, {
      taskId: b.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'ready-checkpoint',
      notes: 'Started after prerequisite acceptance.',
    });
    assert.equal(checkpoint.taskId, b.id);
    await f.verdict(await f.deliver(b), 'pass');
    assert.equal((await f.get(c)).guidance.nextAction?.action, 'begin');
    await f.verdict(await f.deliver(c), 'pass');
    assert.ok(
      (await f.app.ctx.tasks.list(f.producer.caller)).every(
        (task) => task.workflow.state === 'done',
      ),
    );
    assert.equal((await f.get(a)).dependents[0].settled, true);
    assert.equal((await f.get(b)).dependents[0].settled, true);
  } finally {
    await f.close();
  }
});

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
      assert.equal(blocked.guidance.nextAction?.tool, 'task.mark_failed');
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

test('dependency creation normalizes IDs, enforces scope and declared success, rejects malformed input and preserves replay fingerprints', async () => {
  const f = await fixture();
  try {
    const a = await f.create(),
      b = await f.create();
    const input = f.input([` ${a.id} `, '', a.id, '\n', b.id, b.id]);
    const normalized = await f.app.ctx.tasks.create(f.producer.caller, input);
    assert.deepEqual(
      new Set(normalized.dependencies.map((item) => item.id)),
      new Set([a.id, b.id]),
    );
    const beforeReplay = await snapshot(f.app, f.operator);
    assert.deepEqual(await f.app.ctx.tasks.create(f.producer.caller, input), normalized);
    assert.deepEqual(await snapshot(f.app, f.operator), beforeReplay);
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.create(f.producer.caller, { ...input, dependsOn: [a.id, b.id] }),
      { code: 'request_conflict' },
    );
    await assert.rejects(
      async () => await f.app.ctx.tasks.create(f.producer.caller, { ...input, dependsOn: [a.id] }),
      { code: 'request_conflict' },
    );
    for (const value of [null, '', ' \n ', [], [' ', '']])
      assert.deepEqual((await f.create(value)).dependencies, []);
    assert.deepEqual(
      (await f.create(` ${a.id} `)).dependencies.map((item) => item.id),
      [a.id],
    );
    for (const value of [1, true, {}, [a.id, 1], [null], [[a.id]]]) {
      const invalid = { ...f.input(), dependsOn: value } as unknown as TaskCreate;
      const before = await snapshot(f.app, f.operator);
      await assert.rejects(async () => await f.app.ctx.tasks.create(f.producer.caller, invalid), {
        code: 'invalid_dependencies',
      });
      assert.deepEqual(await snapshot(f.app, f.operator), before);
    }
    const beforeMissing = await snapshot(f.app, f.operator);
    await assert.rejects(async () => await f.create([a.id, 'wf_missing']), { code: 'not_found' });
    assert.deepEqual(await snapshot(f.app, f.operator), beforeMissing);
    const foreign = await f.app.ctx.scope.bootstrap({
      projectName: 'Other project',
      actorName: 'Foreign operator',
    });
    const foreignCaller = { actorId: foreign.actor.id, projectId: foreign.project.id };
    const foreignBrief = await f.app.ctx.artifacts.create(foreignCaller, {
      title: 'Foreign brief',
      content: 'Goal. Check.',
    });
    const foreignTask = await f.app.ctx.tasks.create(foreignCaller, {
      ...f.input(),
      briefId: foreignBrief.id,
    });
    const beforeForeign = await snapshot(f.app, f.operator);
    await assert.rejects(async () => await f.create(foreignTask.id), { code: 'not_found' });
    assert.deepEqual(await snapshot(f.app, f.operator), beforeForeign);
    const graph: WorkflowDefinition = {
      name: 'no_success_contract',
      version: 1,
      initial: 'working',
      states: ['working', 'ended'],
      terminal: ['ended'],
      edges: [{ from: 'working', action: 'finish', to: 'ended' }],
    };
    const registration = await f.app.ctx.workflows.register(graph);
    const unsupported = await registration.start(f.producer.caller, {
      workflow: graph.name,
      requestId: 'unsupported-start',
    });
    const beforeUnsupported = await snapshot(f.app, f.operator);
    await assert.rejects(async () => await f.create(unsupported.id), {
      code: 'dependency_unsupported',
    });
    assert.deepEqual(await snapshot(f.app, f.operator), beforeUnsupported);
    registration.dispose();
  } finally {
    await f.close();
  }
});

test('task creation rolls dependency edges, workflow rows, dedup and events back together on brief and final-event failure', async () => {
  const f = await fixture();
  try {
    const a = await f.create(),
      input = f.input(a.id);
    const badBrief = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Incomplete brief',
      content: 'Goal. The acceptance criterion is absent.',
    });
    const before = await snapshot(f.app, f.operator);
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.create(f.producer.caller, { ...input, briefId: badBrief.id }),
      { code: 'invalid_brief' },
    );
    assert.deepEqual(await snapshot(f.app, f.operator), before);
    const append = f.app.ctx.state.appendEvent;
    f.app.ctx.state.appendEvent = function (tx, event) {
      const result = append.call(this, tx, event);
      if (event.type === 'task.created') throw new Error('injected after dependent task event');
      return result;
    };
    try {
      await assert.rejects(
        async () => await f.app.ctx.tasks.create(f.producer.caller, input),
        /injected after dependent task event/,
      );
    } finally {
      f.app.ctx.state.appendEvent = append;
    }
    assert.deepEqual(await snapshot(f.app, f.operator), before);
    assert.deepEqual((await f.get(a)).dependents, []);
    const created = await f.app.ctx.tasks.create(f.producer.caller, input);
    assert.deepEqual(
      created.dependencies.map((item) => item.id),
      [a.id],
    );
    assert.deepEqual(
      (await f.get(a)).dependents.map((item) => item.id),
      [created.id],
    );
    assert.deepEqual(await f.app.ctx.tasks.create(f.producer.caller, input), created);
  } finally {
    await f.close();
  }
});

test('dependency-bearing review assignments keep normal independent context, checkpoint and verdict behavior', async () => {
  const f = await fixture();
  try {
    const upstream = await f.create(),
      downstream = await f.create(upstream.id);
    await f.verdict(await f.deliver(upstream), 'pass');
    const pending = await f.deliver(downstream),
      claim = await f.app.ctx.reviews.start(f.reviewer.caller, pending.reviewId!);
    await f.app.ctx.workflows.begin(f.reviewer.caller, {
      instanceId: downstream.id,
      expectedRevision: 1,
    });
    const reviewTask = await f.app.ctx.tasks.get(f.reviewer.caller, downstream.id);
    assert.equal(reviewTask.guidance.nextAction?.tool, 'review.submit');
    assert.equal(reviewTask.dependencies[0].settled, true);
    const input = {
      taskId: downstream.id,
      purpose: 'review' as const,
      expectedRevision: 1,
      claimId: claim.claimId!,
      requestId: 'dependent-review-context',
    };
    const context = await f.app.ctx.tasks.context(f.reviewer.caller, input);
    assert.ok(context.prompt.includes(JSON.stringify(assignmentTask(reviewTask))));
    assert.deepEqual(reviewTask.guidance.dependencies, reviewTask.dependencies);
    const checkpoint = await f.app.ctx.tasks.checkpoint(f.reviewer.caller, {
      ...input,
      requestId: 'dependent-review-checkpoint',
      notes: 'Independently checking this delivery.',
    });
    assert.equal(checkpoint.claimId, claim.claimId);
    const done = await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      verdict: 'pass',
      notes: 'Verified downstream checks.',
      expectedRevision: 1,
      requestId: 'dependent-review-pass',
    });
    assert.equal(done.workflow.state, 'done');
    assert.equal(done.dependencies[0].settled, true);
  } finally {
    await f.close();
  }
});

test('dependency facts survive provider unload and restart; legacy v1 rows default to empty relations', async () => {
  const f = await fixture();
  let restarted: App | undefined;
  try {
    const a = await f.create(),
      b = await f.create(a.id);
    const graph: WorkflowDefinition = {
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
    await f.app.setEnabled('tasks', false);
    const registration = await f.app.ctx.workflows.register(
      graph,
      await legacyTaskPolicy(f.app.ctx.state, graph),
    );
    const legacy = await registration.start(f.producer.caller, {
      workflow: 'task',
      version: 1,
      requestId: 'legacy-start',
      data: {
        title: 'Legacy task',
        goal: 'Goal.',
        checks: ['Check.'],
        producerId: f.producer.caller.actorId,
        briefId: f.brief.id,
      },
    });
    await f.app.ctx.state.transaction(
      async (tx) =>
        await tx.run(
          'INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
          legacy.id,
          f.operator.projectId,
          'Legacy task',
          'Goal.',
          '["Check."]',
          f.producer.caller.actorId,
          f.brief.id,
          legacy.createdAt,
        ),
    );
    registration.dispose();
    const persisted = await f.app.ctx.workflows.dependencies(f.producer.caller, b.id);
    assert.deepEqual(
      persisted.dependencies.map((item) => item.id),
      [a.id],
    );
    const unavailable = await f.app.ctx.workflows.evaluate(f.producer.caller, b.id);
    assert.equal(unavailable.available, false);
    assert.deepEqual(unavailable.dependencies, persisted.dependencies);
    await f.app.setEnabled('tasks', true);
    await assertWaiting(f, b);
    const old = await f.app.ctx.tasks.get(f.producer.caller, legacy.id);
    assert.equal(old.workflow.version, 1);
    assert.deepEqual(old.dependencies, []);
    assert.deepEqual(old.dependents, []);
    assert.deepEqual(old.guidance.dependencies, []);
    await f.verdict(await f.deliver(a), 'pass');
    const ready = await f.get(b);
    await f.app.stop();
    restarted = await createApp({ directory: f.directory });
    assert.deepEqual(await restarted.ctx.tasks.get(f.producer.caller, b.id), ready);
    assert.deepEqual(
      (await restarted.ctx.workflows.dependencies(f.producer.caller, b.id)).dependencies,
      ready.dependencies,
    );
    assert.equal((await restarted.ctx.tasks.get(f.producer.caller, legacy.id)).workflow.version, 1);
    await restarted.setEnabled('workflows', false);
    await restarted.setEnabled('workflows', true);
    assert.deepEqual(await restarted.ctx.tasks.get(f.producer.caller, b.id), ready);
  } finally {
    await restarted?.stop();
    await f.close();
  }
});

test('HTTP and MCP accept dependency input forms, reject extra keys and malformed values, and return one task/context/guidance model', async () => {
  const f = await fixture(true);
  let client: Client | undefined;
  try {
    client = new Client({ name: 'task-dependencies-integration', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${f.app.ctx.api.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${f.producer.token}` } },
      }),
    );
    const parsed = (result: Awaited<ReturnType<Client['callTool']>>) =>
      JSON.parse((result.content as { text: string }[])[0].text);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return parsed(result);
    };
    const http = async (name: string, args: object) =>
      fetch(`${f.app.ctx.api.url}/tools/${name}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${f.producer.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
    const a = await f.create();
    const input = f.input([` ${a.id} `, a.id, '']);
    const response = await http('task.create', input);
    assert.equal(response.status, 200);
    const b = (await response.json()).result;
    assert.deepEqual(
      b.dependencies.map((item: { id: string }) => item.id),
      [a.id],
    );
    assert.deepEqual(await call('task.create', { ...input }), b);
    assert.deepEqual(await call('task.get', { taskId: b.id }), b);
    assert.deepEqual(await call('workflow.status_and_next', { instanceId: b.id }), b.guidance);
    for (const dependsOn of [a.id, null, []]) {
      const created = await call('task.create', { ...f.input(dependsOn) });
      assert.equal(created.dependencies.length, dependsOn === a.id ? 1 : 0);
    }
    for (const invalid of [
      { ...f.input(), dependsOn: [null] },
      { ...f.input(), dependsOn: {} },
      { ...f.input(), depends_on: [a.id] },
      { ...f.input(), extra: true },
    ]) {
      const result = await client.callTool({ name: 'task.create', arguments: invalid });
      assert.equal(result.isError, true);
      assert.equal(parsed(result).error.code, 'invalid_input');
      const badHttp = await http('task.create', invalid);
      assert.equal(badHttp.status, 400);
      assert.equal((await badHttp.json()).error.code, 'invalid_input');
    }
    const blockedContext = await client.callTool({
      name: 'task.context',
      arguments: {
        taskId: b.id,
        purpose: 'work',
        expectedRevision: 0,
        requestId: 'transport-context',
      },
    });
    assert.equal(blockedContext.isError, true);
    assert.equal(parsed(blockedContext).error.code, 'dependencies_pending');
    await f.verdict(await f.deliver(a), 'pass');
    const task = await call('task.get', { taskId: b.id });
    const guidance = await call('workflow.status_and_next', { instanceId: b.id });
    const context = await call('task.context', {
      taskId: b.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'transport-context',
    });
    assert.deepEqual(task.guidance, guidance);
    assert.deepEqual(task.dependencies, guidance.dependencies);
    assert.ok(context.prompt.includes(JSON.stringify(assignmentTask(task))));
    const httpTask = await http('task.get', { taskId: b.id });
    assert.deepEqual((await httpTask.json()).result, task);
    const tools = (await client.listTools()).tools;
    assert.ok(
      !tools.some((tool) =>
        /(?:add|update|set).*depend|depend.*(?:add|update|set)/i.test(tool.name),
      ),
      'No agent-facing dependency mutation tool',
    );
  } finally {
    await client?.close();
    await f.close();
  }
});
