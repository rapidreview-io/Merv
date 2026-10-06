import type { Task, TaskCreate, TaskDelivery } from '@merv/tasks/types';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { validateConfirmations } from '@merv/tasks/evidence';

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
      caller: {
        actorId: actor.actor.id,
        projectId: operator.projectId,
        credentialId: actor.credential.id,
      } as Caller,
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
  const producerSource = producer.caller;
  const work = currentWork(app.ctx, { directory, source: producerSource });
  let commandId: string;
  let held: Awaited<ReturnType<typeof work.lease>>;
  const create = async () => {
    const task = await currentTask(app.ctx, producerSource, input());
    held = await work.lease(task);
    producer.caller = held.worker;
    Object.assign(
      proof,
      await app.ctx.artifacts.create(held.worker, {
        title: 'Retained execution receipt',
        mediaType: 'application/json',
        content: '{"positive":5,"negative":-1}',
      }),
    );
    commandId = await work.commit(held);
    return task;
  };
  const delivery = (task: Task): TaskDelivery => ({
    commandId,
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
    submit: (input: TaskDelivery) =>
      work.run(
        held,
        'task.submit_delivery',
        input as unknown as import('@merv/contracts').Data,
        (caller, bound) => app.ctx.tasks.submitDelivery(caller, bound as unknown as TaskDelivery),
      ),
    async close() {
      await work.close();
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
      ['artifactIds', 'commandId', 'confirmations'],
    );
    const context = await f.app.ctx.tasks.context(f.producer.caller, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'work-context',
    });
    assert.ok(context.sources.some((source) => source.id === task.briefId));
    // The numbered checks are the brief's; the task record does not repeat them.
    assert.ok(!context.prompt.includes('"acceptanceChecks"'));
    assert.ok(context.prompt.includes(brief.content));
    assert.equal(context.prompt.split('Handles negative inputs.').length, 2);

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
    // A producer's own brief need not number the checks, so the work context does.
    const own = await f.app.ctx.tasks.context(f.producer.caller, {
      taskId: compatible.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'own-brief-context',
    });
    assert.ok(
      own.prompt.includes(
        '"acceptanceChecks":[{"number":1,"text":"Adds two numbers."},{"number":2',
      ),
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
    const pending = await f.submit(input);
    assert.equal(
      pending.workflow.state,
      'in_review',
      'The same request ID is available after failed validation',
    );
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
      await assert.rejects(async () => await f.submit(input), /injected after structured delivery/);
    } finally {
      f.app.ctx.state.appendEvent = append;
    }
    assert.deepEqual(await durable(f.app, f.operator), before);
    const pending = await f.submit(input);
    assert.equal(pending.workflow.state, 'in_review');
    assert.equal(
      await f.app.ctx.state.read(async (sql) => (await sql.all('SELECT id FROM artifacts')).length),
      before.artifacts.length + 2,
    );
  } finally {
    await f.close();
  }
});

test('a confirmation cites at most 50 evidence artifacts', () => {
  const ids = Array.from({ length: 51 }, (_, index) => `art_${index}`);
  const confirmations = (evidenceIds: string[]) => [
    { checkNumber: 1, status: 'met', evidenceIds, notes: 'Checked each cited artifact.' },
  ];
  assert.equal(validateConfirmations(confirmations(ids.slice(1)), ['One.'], ids).length, 1);
  assert.throws(() => validateConfirmations(confirmations(ids), ['One.'], ids), {
    code: 'invalid_confirmations',
  });
});
