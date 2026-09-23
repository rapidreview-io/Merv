import { reviewedFindings } from './fixtures/task-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller, Task, TaskCreate, TaskDelivery } from '@merv/contracts';
import { createApp } from './fixtures/app.js';

type App = Awaited<ReturnType<typeof createApp>>;

async function fixture(api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-structured-evidence-'));
  const app = await createApp({ directory, api, port: 0 });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Structured evidence',
    actorName: 'Operator',
  });
  const operator: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const actor = await app.ctx.scope.issueActor(operator, { name: role, role });
    return {
      caller: { actorId: actor.actor.id, projectId: operator.projectId },
      token: actor.token,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
  const proof = await app.ctx.artifacts.create(producer.caller, {
    title: 'Retained execution receipt',
    mediaType: 'application/json',
    content: '{"positive":5,"negative":-1}',
  });
  const checks = ['Adds two numbers.', 'Handles negative inputs.'];
  let sequence = 0;
  const input = (): TaskCreate => ({
    title: 'Adder',
    goal: 'Build an adder.',
    checks: [...checks],
    requestId: `create-${++sequence}`,
  });
  const create = async () => await app.ctx.tasks.create(producer.caller, input());
  const delivery = (task: Task): TaskDelivery => ({
    taskId: task.id,
    artifactIds: [proof.id],
    confirmations: [
      {
        checkNumber: 1,
        status: 'met',
        evidenceIds: [proof.id],
        notes: 'The retained positive case returned five.',
      },
      {
        checkNumber: 2,
        status: 'met',
        evidenceIds: [proof.id],
        notes: 'The retained negative case returned minus one.',
      },
    ],
    expectedRevision: task.workflow.revision,
    requestId: `delivery-${++sequence}`,
  });
  return {
    directory,
    app,
    operator,
    producer,
    reviewer,
    reader,
    issue,
    proof,
    checks,
    input,
    create,
    delivery,
    async close() {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function durable(app: App, caller: Caller) {
  return await app.ctx.state.read(async (sql) => ({
    tasks: await sql.all('SELECT * FROM tasks ORDER BY id'),
    workflows: await sql.all('SELECT * FROM wf_instances ORDER BY id'),
    history: await sql.all('SELECT * FROM wf_history ORDER BY instance_id,revision'),
    commands: await sql.all('SELECT * FROM task_commands ORDER BY request_id'),
    requests: await sql.all('SELECT * FROM wf_requests ORDER BY request_id'),
    artifacts: await sql.all('SELECT * FROM artifacts ORDER BY id'),
    reviews: await app.ctx.reviews.list(caller),
    events: await app.ctx.state.events(caller.projectId),
  }));
}

test('new tasks render one immutable brief, expose numbered checks and replay without duplicate artifacts', async () => {
  const f = await fixture();
  try {
    const input = f.input();
    const task = await f.app.ctx.tasks.create(f.producer.caller, input);
    assert.equal(task.evidenceVersion, 2);
    assert.deepEqual(
      task.acceptanceChecks,
      f.checks.map((text, index) => ({ number: index + 1, text })),
    );
    assert.deepEqual(task.deliveryConfirmations, []);
    assert.equal(task.deliveryAssessmentId, null);
    const brief = await f.app.ctx.artifacts.read(f.producer.caller, task.briefId);
    assert.equal(brief.encoding, 'utf8');
    assert.ok(brief.content.includes('Build an adder.'));
    assert.ok(brief.content.includes('1. Adds two numbers.'));
    assert.ok(brief.content.includes('2. Handles negative inputs.'));
    assert.equal(
      (await f.app.ctx.artifacts.get(f.producer.caller, task.briefId)).createdBy,
      f.producer.caller.actorId,
    );
    const before = await durable(f.app, f.operator);
    assert.deepEqual(await f.app.ctx.tasks.create(f.producer.caller, input), task);
    assert.deepEqual(await durable(f.app, f.operator), before);
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.create(f.producer.caller, { ...input, checks: ['Different.'] }),
      { code: 'request_conflict' },
    );
    assert.deepEqual(
      task.guidance.actions.find((action) => action.action === 'submit_delivery')?.requiredInput,
      ['artifactIds', 'confirmations'],
    );
    const context = await f.app.ctx.tasks.context(f.producer.caller, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'work-context',
    });
    assert.ok(context.sources.some((source) => source.id === task.briefId));
    assert.ok(context.prompt.includes('"acceptanceChecks"'));
    assert.ok(context.prompt.includes(brief.content));

    const supplied = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Existing authored brief',
      content: 'Build an adder. Adds two numbers. Handles negative inputs.',
    });
    const suppliedInput = { ...f.input(), briefId: supplied.id };
    const compatible = await f.app.ctx.tasks.create(f.producer.caller, suppliedInput);
    assert.equal(
      compatible.briefId,
      supplied.id,
      'An explicitly supplied brief remains the pinned artifact',
    );
    assert.equal(
      compatible.evidenceVersion,
      2,
      'New tasks use structured delivery even with a supplied brief',
    );
    const invalid = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Incomplete',
      content: 'Build an adder.',
    });
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.create(f.producer.caller, { ...f.input(), briefId: invalid.id }),
      { code: 'invalid_brief' },
    );
  } finally {
    await f.close();
  }
});

test('generated brief metadata, task, workflow and receipts roll back together after a late creation failure', async () => {
  const f = await fixture();
  try {
    const input = f.input(),
      before = await durable(f.app, f.operator),
      append = f.app.ctx.state.appendEvent;
    f.app.ctx.state.appendEvent = function (tx, event) {
      const result = append.call(this, tx, event);
      if (event.type === 'task.created') throw new Error('injected after generated brief creation');
      return result;
    };
    try {
      await assert.rejects(
        async () => await f.app.ctx.tasks.create(f.producer.caller, input),
        /injected after generated brief creation/,
      );
    } finally {
      f.app.ctx.state.appendEvent = append;
    }
    assert.deepEqual(await durable(f.app, f.operator), before);
    const task = await f.app.ctx.tasks.create(f.producer.caller, input);
    assert.equal(task.evidenceVersion, 2);
    assert.deepEqual(await f.app.ctx.tasks.create(f.producer.caller, input), task);
    assert.equal(
      await f.app.ctx.state.read(async (sql) => (await sql.all('SELECT id FROM artifacts')).length),
      before.artifacts.length + 1,
    );
  } finally {
    await f.close();
  }
});

test('structured preflight and delivery reject incomplete, ambiguous and unretained confirmations without writes', async () => {
  const f = await fixture();
  try {
    const task = await f.create(),
      input = f.delivery(task),
      valid = input.confirmations!;
    const unattached = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Unselected',
      content: 'Not selected for this delivery.',
    });
    const variants: unknown[] = [
      undefined,
      null,
      {},
      [],
      [valid[0]],
      [valid[0], valid[0]],
      [...valid, { ...valid[0], checkNumber: 3 }],
      [{ ...valid[0], checkNumber: 0 }, valid[1]],
      [{ ...valid[0], checkNumber: 1.5 }, valid[1]],
      [{ ...valid[0], checkNumber: '1' }, valid[1]],
      [{ ...valid[0], status: 'partial' }, valid[1]],
      [{ ...valid[0], notes: ' \n ' }, valid[1]],
      [{ ...valid[0], evidenceIds: [] }, valid[1]],
      [{ ...valid[0], evidenceIds: [f.proof.id, f.proof.id] }, valid[1]],
      [{ ...valid[0], evidenceIds: [unattached.id] }, valid[1]],
      [{ ...valid[0], evidenceIds: ['art_missing'] }, valid[1]],
    ];
    const before = await durable(f.app, f.operator);
    for (const confirmations of variants) {
      const proposed = { ...input, confirmations } as TaskDelivery;
      if (confirmations === undefined) delete proposed.confirmations;
      let commandCode: string | undefined;
      await assert.rejects(
        async () => await f.app.ctx.tasks.submitDelivery(f.producer.caller, proposed),
        (error: unknown) => {
          commandCode = (error as { code?: string }).code;
          return typeof commandCode === 'string';
        },
      );
      const decision = await f.app.ctx.workflows.evaluate(f.producer.caller, task.id, {
        action: 'submit_delivery',
        input: { ...proposed },
      });
      const action = decision.actions.find((item) => item.action === 'submit_delivery')!;
      assert.equal(action.status, 'blocked');
      assert.ok(action.blockers.some((blocker) => blocker.code === commandCode));
      assert.deepEqual(await durable(f.app, f.operator), before);
    }
    const ready = await f.app.ctx.workflows.evaluate(f.producer.caller, task.id, {
      action: 'submit_delivery',
      input: { ...input },
    });
    assert.equal(
      ready.actions.find((action) => action.action === 'submit_delivery')?.status,
      'ready',
    );
    assert.deepEqual(
      await durable(f.app, f.operator),
      before,
      'Successful preflight cannot create an assessment',
    );
    const pending = await f.app.ctx.tasks.submitDelivery(f.producer.caller, input);
    assert.equal(
      pending.workflow.state,
      'in_review',
      'The same request ID is available after failed validation',
    );
  } finally {
    await f.close();
  }
});

test('structured delivery pins its generated assessment, preserves prior review evidence after revision and never self-verifies claims', async () => {
  const f = await fixture();
  try {
    const task = await f.create(),
      input = f.delivery(task);
    input.confirmations![1] = {
      checkNumber: 2,
      status: 'not_met',
      evidenceIds: [],
      notes: 'Negative input support is unfinished.',
    };
    const pending = await f.app.ctx.tasks.submitDelivery(f.producer.caller, input);
    assert.equal(
      pending.workflow.state,
      'in_review',
      'An unmet claim is presented to the independent reviewer',
    );
    assert.deepEqual(pending.deliveryConfirmations, input.confirmations);
    assert.ok(pending.deliveryAssessmentId);
    assert.deepEqual(pending.deliveryIds, [f.proof.id, pending.deliveryAssessmentId]);
    const assessment = await f.app.ctx.artifacts.read(
      f.producer.caller,
      pending.deliveryAssessmentId!,
    );
    assert.ok(assessment.content.includes('Negative input support is unfinished.'));
    assert.ok(assessment.content.includes(f.proof.id));
    assert.ok(assessment.content.includes('Adds two numbers.'));
    const pinned = await f.app.ctx.reviews.get(f.reviewer.caller, pending.reviewId!);
    assert.deepEqual(pinned.artifactIds, [task.briefId, ...pending.deliveryIds]);
    assert.equal(pinned.verdict, null);
    const beforeReplay = await durable(f.app, f.operator);
    assert.deepEqual(await f.app.ctx.tasks.submitDelivery(f.producer.caller, input), pending);
    assert.deepEqual(await durable(f.app, f.operator), beforeReplay);
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.submitDelivery(f.producer.caller, {
          ...input,
          confirmations: f.delivery(task).confirmations,
        }),
      { code: 'request_conflict' },
    );
    const claim = await f.app.ctx.reviews.start(f.reviewer.caller, pinned.id);
    const context = await f.app.ctx.tasks.context(f.reviewer.caller, {
      taskId: task.id,
      purpose: 'review',
      expectedRevision: pending.workflow.revision,
      claimId: claim.claimId!,
      requestId: 'review-context',
    });
    assert.ok(context.sources.some((source) => source.id === pending.deliveryAssessmentId));
    assert.ok(context.prompt.includes('Negative input support is unfinished.'));
    const revised = await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      verdict: 'needs_changes',
      notes: 'Complete the negative case.',
      expectedRevision: pending.workflow.revision,
      requestId: 'revise',
    });
    assert.equal(revised.workflow.state, 'in_progress');
    const second = await f.app.ctx.tasks.submitDelivery(f.producer.caller, f.delivery(revised));
    assert.notEqual(second.deliveryAssessmentId, pending.deliveryAssessmentId);
    assert.notEqual(second.reviewId, pending.reviewId);
    assert.deepEqual(
      (await f.app.ctx.reviews.get(f.reviewer.caller, pinned.id)).artifactIds,
      pinned.artifactIds,
    );
    assert.deepEqual(
      await f.app.ctx.artifacts.read(f.reviewer.caller, pending.deliveryAssessmentId!),
      assessment,
    );
    assert.equal(
      second.workflow.state,
      'in_review',
      'Met is a producer claim; it never advances to done without a verdict',
    );
    const secondClaim = await f.app.ctx.reviews.start(f.reviewer.caller, second.reviewId!);
    const failed = await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
      ...reviewedFindings(secondClaim),
      reviewId: secondClaim.id,
      claimId: secondClaim.claimId!,
      verdict: 'fail',
      notes: 'The claimed result is not supported by execution.',
      expectedRevision: second.workflow.revision,
      requestId: 'reject-false-claim',
    });
    assert.equal(failed.workflow.state, 'failed');
    assert.deepEqual(failed.deliveryConfirmations, second.deliveryConfirmations);
  } finally {
    await f.close();
  }
});

test('generated assessment, review snapshot and transition roll back after a late delivery failure', async () => {
  const f = await fixture();
  try {
    const task = await f.create(),
      input = f.delivery(task),
      before = await durable(f.app, f.operator),
      append = f.app.ctx.state.appendEvent;
    f.app.ctx.state.appendEvent = function (tx, event) {
      const result = append.call(this, tx, event);
      if (event.type === 'task.delivery_submitted')
        throw new Error('injected after structured delivery');
      return result;
    };
    try {
      await assert.rejects(
        async () => await f.app.ctx.tasks.submitDelivery(f.producer.caller, input),
        /injected after structured delivery/,
      );
    } finally {
      f.app.ctx.state.appendEvent = append;
    }
    assert.deepEqual(await durable(f.app, f.operator), before);
    const pending = await f.app.ctx.tasks.submitDelivery(f.producer.caller, input);
    assert.equal(pending.workflow.state, 'in_review');
    assert.equal(
      await f.app.ctx.state.read(async (sql) => (await sql.all('SELECT id FROM artifacts')).length),
      before.artifacts.length + 1,
    );
    assert.deepEqual(await f.app.ctx.tasks.submitDelivery(f.producer.caller, input), pending);
  } finally {
    await f.close();
  }
});

test('structured delivery keeps actor/project checks and publishes identical HTTP, MCP and preflight contracts', async () => {
  const f = await fixture(true);
  let client: Client | undefined;
  try {
    client = new Client({ name: 'structured-evidence-integration', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${f.app.ctx.api.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${f.producer.token}` } },
      }),
    );
    const parse = (result: Awaited<ReturnType<Client['callTool']>>) =>
      JSON.parse((result.content as { text: string }[])[0].text);
    const call = async (name: string, args: object) => {
      const result = await client!.callTool({ name, arguments: { ...args } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return parse(result);
    };
    const http = (name: string, args: object, token = f.producer.token) =>
      fetch(`${f.app.ctx.api.url}/tools/${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    const createInput = f.input(),
      created = await http('task.create', createInput);
    assert.equal(created.status, 200);
    const task: Task = (await created.json()).result;
    assert.equal(task.evidenceVersion, 2);
    assert.deepEqual(await call('task.create', createInput), task);
    const input = f.delivery(task),
      before = await durable(f.app, f.operator);
    const decision = await call('workflow.status_and_next', {
      instanceId: task.id,
      action: 'submit_delivery',
      input,
    });
    assert.equal(
      decision.actions.find((action: { action: string }) => action.action === 'submit_delivery')
        .status,
      'ready',
    );
    assert.deepEqual(await durable(f.app, f.operator), before);
    const missing = { ...input };
    delete missing.confirmations;
    for (const invalid of [
      missing,
      {
        ...input,
        confirmations: [{ ...input.confirmations![0], extra: true }, input.confirmations![1]],
      },
    ]) {
      const result = await client.callTool({ name: 'task.submit_delivery', arguments: invalid });
      assert.equal(result.isError, true);
      const response = await http('task.submit_delivery', invalid);
      assert.equal(response.status, 400);
    }
    const otherProducer = await f.issue('producer');
    for (const actor of [f.reader, f.reviewer, otherProducer]) {
      await assert.rejects(async () => await f.app.ctx.tasks.submitDelivery(actor.caller, input), {
        code: 'forbidden',
      });
      assert.equal((await http('task.submit_delivery', input, actor.token)).status, 403);
    }
    const otherProof = await f.app.ctx.artifacts.create(otherProducer.caller, {
      title: 'Someone else’s evidence',
      content: 'Unowned.',
    });
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.submitDelivery(f.producer.caller, {
          ...input,
          artifactIds: [otherProof.id],
          confirmations: input.confirmations!.map((entry) => ({
            ...entry,
            evidenceIds: [otherProof.id],
          })),
        }),
      { code: 'invalid_delivery' },
    );
    const outsider = await f.app.ctx.scope.bootstrap({
      projectName: 'Other project',
      actorName: 'Other operator',
    });
    await assert.rejects(
      async () =>
        await f.app.ctx.tasks.submitDelivery(
          { actorId: outsider.actor.id, projectId: outsider.project.id },
          input,
        ),
      { code: 'not_found' },
    );
    const pending: Task = await call('task.submit_delivery', input);
    const replay = await http('task.submit_delivery', input);
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).result, pending);
    assert.deepEqual(await call('task.get', { taskId: task.id }), pending);
    assert.deepEqual(
      await call('workflow.status_and_next', { instanceId: task.id }),
      pending.guidance,
    );
  } finally {
    await client?.close();
    await f.close();
  }
});
