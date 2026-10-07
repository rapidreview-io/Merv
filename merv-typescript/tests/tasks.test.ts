import { managedServices } from './fixtures/managed-services.js';
import { inputsTaskType } from './fixtures/input-task-type.js';
import { createService } from '@merv/contracts';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecipeContextBuilder } from '@merv/context-builder';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { TaskService } from '@merv/tasks';
import { PaperService } from '@merv/paper';
import { TASK_TYPES } from '../packages/tasks/src/definitions.js';
import type { Caller, Workflows } from '@merv/contracts';
import type { ReviewHistory } from '@merv/reviews/rules';
import { openState } from './fixtures/state.js';
import { ownReviews } from './fixtures/review-verdict.js';
import type { PostgresState } from '@merv/state';

async function fixture(limits?: { reviewRounds: number }) {
  const path = mkdtempSync(join(tmpdir(), 'merv-task-test-'));
  const state = await openState(path),
    scope = await createService(new ProjectScope(state));
  const credentials = await scope.credentials.bootstrap({
    projectName: 'Test',
    actorName: 'Operator',
  });
  const operator: Caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const issue = async (name: string, role: 'producer' | 'reviewer' | 'reader'): Promise<Caller> => {
    const issued = await scope.credentials.issueActor(operator, { name, role });
    return {
      actorId: issued.actor.id,
      projectId: operator.projectId,
      credentialId: issued.credential.id,
    };
  };
  const producer = await issue('Producer', 'producer'),
    reviewer = await issue('Reviewer', 'reviewer'),
    reviewer2 = await issue('Other reviewer', 'reviewer'),
    reader = await issue('Reader', 'reader');
  const blobs = new DiskBlobs(join(path, 'blobs')),
    artifacts = await createService(new ArtifactStore(state, scope, blobs));
  const workflows = await createService(new WorkflowsService(state, scope)),
    reviews = await createService(new ReviewService(state, scope, artifacts));
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const paper = await createService(new PaperService(state, scope, artifacts));
  const managed = await managedServices(
    { state, scope, artifacts, workflows, reviews },
    path,
    operator,
  );
  const tasks = await createService(
    new TaskService(
      state,
      scope,
      artifacts,
      workflows,
      reviews,
      builder,
      managed.code,
      paper,
      limits,
    ),
  );
  const brief = await artifacts.create(producer, {
    title: 'Brief',
    content:
      '# Goal\nBuild an adder.\n# Done when\n- Adds two numbers.\n- Handles negative inputs.',
  });
  const create = async () =>
    await tasks.create(producer, {
      title: 'Adder',
      goal: 'Build an adder.',
      checks: ['Adds two numbers.', 'Handles negative inputs.'],
      briefId: brief.id,
      requestId: 'create',
    });
  const delivery = async (label = 'Delivery') =>
    await artifacts.create(producer, {
      title: label,
      content: `${label}\nAdds two numbers. Verified add(2,3)=5.\nHandles negative inputs. Verified add(-2,1)=-1.`,
    });
  const cleanup = async () => {
    await managed.close();
    tasks.dispose();
    paper.close();
    await state.close();
    rmSync(path, { recursive: true, force: true });
  };
  return {
    path,
    state,
    scope,
    operator,
    producer,
    reviewer,
    reviewer2,
    reader,
    blobs,
    artifacts,
    workflows,
    reviews,
    builder,
    paper,
    tasks,
    brief,
    create,
    delivery,
    cleanup,
    managed,
  };
}
const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test('an Agent conversation directs a task while producer work stays available to Fleet', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const source = await f.scope.delegationSource(f.producer);
  t.after(f.scope.registerConversationAuthority({ require: async () => source }));
  const chat: Caller = {
    actorId: f.producer.actorId,
    projectId: f.producer.projectId,
    conversation: {
      id: 'conversation_1',
      epoch: 1,
      commandId: 'command_1',
      runtimeId: 'runtime_1',
    },
  };
  const task = await f.tasks.create(chat, {
    title: 'Directed work',
    goal: 'Build an adder.',
    checks: ['Adds two numbers.'],
    requestId: 'chat-task',
  });
  assert.equal((await f.tasks.get(chat, task.id)).id, task.id);
  assert.ok(
    (await f.workflows.dispatchCandidates(f.producer)).some((item) => item.instanceId === task.id),
  );
  const note = await f.artifacts.create(chat, {
    title: 'Conversation note',
    content: 'Plan the checks.',
  });
  assert.equal(note.createdBy, chat.actorId);
  for (const operation of [
    () =>
      f.tasks.context(chat, {
        taskId: task.id,
        purpose: 'work',
        expectedRevision: 0,
        requestId: 'chat-context',
      }),
    () =>
      f.tasks.checkpoint(chat, {
        taskId: task.id,
        purpose: 'work',
        expectedRevision: 0,
        notes: 'Starting',
        requestId: 'chat-checkpoint',
      }),
    () =>
      f.tasks.submitDelivery(
        chat,
        confirmedDelivery({
          taskId: task.id,
          expectedRevision: 0,
          artifactIds: [note.id],
          requestId: 'chat-delivery',
        }),
      ),
  ])
    await assert.rejects(operation, code('conversation_task_producer_forbidden'));
  assert.equal((await f.tasks.get(chat, task.id)).workflow.state, 'in_progress');
  assert.ok(
    (await f.workflows.dispatchCandidates(f.producer)).some((item) => item.instanceId === task.id),
  );
});

test('a format-2 context lists a PDF context input without reading it', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const pdf = await f.artifacts.create(f.producer, {
    title: 'Signed protocol',
    mediaType: 'application/pdf',
    encoding: 'base64',
    content: Buffer.from('%PDF-1.4 protocol').toString('base64'),
  });
  const notes = await f.artifacts.create(f.producer, {
    title: 'Knowledge notes',
    content: 'The adder must handle negative inputs.',
  });
  await f.tasks.registerType(inputsTaskType);
  const task = await f.tasks.create(f.producer, {
    title: 'Adder',
    goal: 'Build an adder.',
    checks: ['Adds two numbers.', 'Handles negative inputs.'],
    briefId: f.brief.id,
    requestId: 'create-pdf-input',
    type: 'fixture.inputs',
    contextInputs: { experiments: [pdf.id], projectKnowledge: [notes.id] },
  });
  const read = f.artifacts.read.bind(f.artifacts);
  const reads: string[] = [];
  t.mock.method(f.artifacts, 'read', async (...args: Parameters<typeof f.artifacts.read>) => {
    reads.push(args[1]);
    return await read(...args);
  });
  const work = await f.tasks.context(f.producer, {
    taskId: task.id,
    purpose: 'work',
    expectedRevision: task.workflow.revision,
    requestId: 'work-pdf-input',
  });
  assert.equal(`${work.type}@${work.typeVersion}`, 'fixture.inputs@1');
  assert.ok(
    work.prompt.includes(
      `\n- experiments:${pdf.id} — Signed protocol (artifact ${pdf.id}, application/pdf, `,
    ),
  );
  assert.ok(work.prompt.includes('\nThe adder must handle negative inputs.\n'));
  assert.ok(reads.includes(notes.id) && !reads.includes(pdf.id));
});

test('a format-2 context names an artifact by its ID when its title shows nothing on a line', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  // A line break the builder folds away still counts as visible to an artifact title.
  const brief = await f.artifacts.create(f.producer, {
    title: '\u0085',
    content: '# Goal\nBuild an adder.\n# Done when\n- Adds two numbers.',
  });
  const task = await f.tasks.create(f.producer, {
    title: 'Adder',
    goal: 'Build an adder.',
    checks: ['Adds two numbers.'],
    briefId: brief.id,
    requestId: 'create-untitled-brief',
  });
  const work = await f.tasks.context(f.producer, {
    taskId: task.id,
    purpose: 'work',
    expectedRevision: task.workflow.revision,
    requestId: 'work-untitled-brief',
  });
  assert.equal(`${work.type}@${work.typeVersion}`, 'task.work@4');
  assert.ok(work.prompt.includes(`\n### brief:${brief.id} — ${brief.id} (artifact ${brief.id}, `));
});

test('a format-2 context freezes no more of a mature paper than its budget can embed', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  for (const kind of ['literature', 'methods'] as const)
    await f.paper.patch(f.producer, {
      kind,
      expectedRevision: 0,
      requestId: `paper-${kind}`,
      changes: Array.from({ length: 40 }, (_, index) => ({
        id: `${kind}-${index}`,
        title: `${kind} section ${index}`,
        content: `${kind} finding ${index}. `.repeat(150),
      })),
    });
  await f.paper.patch(f.producer, {
    kind: 'problem',
    expectedRevision: 0,
    requestId: 'paper-goal',
    changes: [{ id: 'goals', content: 'Build a reliable arithmetic library.' }],
  });
  const task = await f.create();
  const work = await f.tasks.context(f.producer, {
    taskId: task.id,
    purpose: 'work',
    expectedRevision: task.workflow.revision,
    requestId: 'work-mature',
  });
  assert.ok(work.prompt.length <= 96_000);
  // The goal outranks every other section, and the brief is always embedded beside it.
  assert.ok(work.prompt.includes('\n### paper:problem:current:1:2:goals — '));
  assert.ok(work.prompt.includes(`\n### brief:${f.brief.id} — Brief (`));
  // The sections past the budget are named, not frozen, and paper.read reaches them.
  const [, count] =
    /\n(?:### |- )paper:not-included — (\d+) more paper sections, not included in this assignment/.exec(
      work.prompt,
    )!;
  assert.ok(Number(count) > 0 && Number(count) < 80);
});

test('task reads, context and failure keep their original caller and inputs', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const task = await f.create();
  const other = await f.scope.credentials.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const foreign = { projectId: other.project.id, actorId: other.actor.id };
  for (const method of ['get', 'record', 'records', 'list', 'process'] as const) {
    await t.test(method, async () => {
      const caller = { ...(method === 'process' ? f.producer : foreign) };
      const reading =
        method === 'list' || method === 'records'
          ? f.tasks[method](caller)
          : f.tasks[method](caller, task.id);
      Object.assign(caller, method === 'process' ? foreign : f.producer);
      if (method === 'list' || method === 'records') assert.deepEqual(await reading, []);
      else if (method === 'process') await reading;
      else await assert.rejects(reading, code('not_found'));
    });
  }
  await t.test('context', async () => {
    const caller = { ...f.producer };
    const input = {
      taskId: task.id,
      purpose: 'work' as const,
      expectedRevision: 0,
      requestId: 'context',
    };
    const original = { ...input };
    const building = f.tasks.context(caller, input);
    Object.assign(caller, f.reader);
    input.requestId = 'replacement';
    const context = await building;
    assert.deepEqual(await f.tasks.context(f.producer, original), context);
  });
  await t.test('failure', async () => {
    const caller = { ...f.producer };
    const input = {
      taskId: task.id,
      expectedRevision: 0,
      reason: 'Original reason',
      requestId: 'failure',
    };
    const failing = f.tasks.markFailed(caller, input);
    Object.assign(caller, f.operator);
    input.reason = 'Replacement reason';
    assert.deepEqual([task.settled, task.failed], [false, false]);
    const failed = await failing;
    // Workflows' word for its end, on the record and on the list Home reads.
    assert.deepEqual([failed.settled, failed.failed], [false, true]);
    const [listed] = await f.tasks.list(f.producer);
    assert.deepEqual([listed.settled, listed.failed], [false, true]);
    assert.equal(failed.failure!.actorId, f.producer.actorId);
    assert.equal(failed.failure!.reason, 'Original reason');
  });
});

test('a task can be created inside a caller\u2019s transaction and rolls back with it', async () => {
  const f = await fixture();
  try {
    // A wave materialized from one approved decision creates its records together or not at
    // all, so task creation has to compose into the caller's transaction like every other.
    await assert.rejects(
      async () =>
        await f.state.transaction(async (tx) => {
          const task = await f.tasks.create(
            f.producer,
            {
              title: 'Composed',
              goal: 'Build an adder.',
              checks: ['Adds two numbers.'],
              requestId: 'composed',
            },
            tx,
          );
          assert.ok(task.id);
          throw new Error('Abandon the wave');
        }),
      /Abandon the wave/,
    );
    assert.equal((await f.tasks.list(f.producer)).length, 0);
  } finally {
    await f.cleanup();
  }
});

test('generic reviews work without a workflow engine or task program and reject operator self-review', async () => {
  const path = mkdtempSync(join(tmpdir(), 'merv-review-only-'));
  const state = await openState(path),
    scope = await createService(new ProjectScope(state));
  const credential = await scope.credentials.bootstrap({
    projectName: 'Standalone review',
    actorName: 'Operator',
  });
  const operator = { actorId: credential.actor.id, projectId: credential.project.id };
  const reviewer = {
    actorId: (await scope.credentials.issueActor(operator, { name: 'Reviewer', role: 'reviewer' }))
      .actor.id,
    projectId: operator.projectId,
  };
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(path, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  // No task program: the one domain that owns an opaque subject's reviews is the caller's own.
  ownReviews(reviews);
  const f = {
    operator,
    reviewer,
    artifacts,
    reviews,
    cleanup: async () => {
      await state.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
  try {
    const artifact = await f.artifacts.create(f.operator, {
      title: 'Assessment input',
      content: 'Assess this.',
    });
    const input = {
      subjectId: 'opaque-external-subject',
      subjectRevision: 7,
      producerId: f.operator.actorId,
      artifactIds: [artifact.id],
      criteria: ['Correctness'],
      requestId: 'standalone',
    };
    const requested = await f.reviews.request(f.operator, input);
    assert.deepEqual(await f.reviews.request(f.operator, input), requested);
    await assert.rejects(
      async () => await f.reviews.request(f.operator, { ...input, criteria: ['Different'] }),
      code('request_conflict'),
    );
    await assert.rejects(
      async () => await f.reviews.start(f.operator, requested.id),
      code('review_independence'),
    );
    await f.reviews.start(f.reviewer, requested.id);
    const submit = {
      ...reviewedFindings(await f.reviews.get(f.operator, requested.id)),
      reviewId: requested.id,
      claimId: (await f.reviews.get(f.operator, requested.id)).claimId!,
      verdict: 'pass' as const,
      notes: 'Assessed independently.',
      requestId: 'verdict',
    };
    assert.equal((await f.reviews.submit(f.reviewer, submit)).verdict, 'pass');
    assert.equal((await f.reviews.submit(f.reviewer, submit)).verdict, 'pass');
    await assert.rejects(
      async () => await f.reviews.submit(f.reviewer, { ...submit, requestId: 'new-verdict' }),
      code('review_closed'),
    );
  } finally {
    await f.cleanup();
  }
});

test('a rendered brief is checked as written, without reading it back', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  t.mock.method(f.artifacts, 'read', () => assert.fail('A rendered brief is not read back'));
  const task = await f.tasks.create(f.producer, {
    title: 'Adder',
    goal: 'Build an adder.',
    checks: ['Adds two numbers.'],
    requestId: 'rendered',
  });
  assert.match((await f.artifacts.bytes(f.producer, task.briefId)).bytes.toString(), /adder/);
  const artifacts = (await f.artifacts.list(f.producer)).length;
  await assert.rejects(
    async () =>
      await f.tasks.create(f.producer, {
        title: 'Adder',
        goal: 'x'.repeat(32_000),
        checks: ['Adds two numbers.'],
        requestId: 'long',
      }),
    code('invalid_brief'),
  );
  assert.equal((await f.artifacts.list(f.producer)).length, artifacts);
});

test('a task record says whether Tasks composed its brief, so no reader tests the title', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const composed = await f.tasks.create(f.producer, {
    title: 'Adder',
    goal: 'Build an adder.',
    checks: ['Adds two numbers.'],
    requestId: 'composed',
  });
  const written = await f.create();
  assert.equal((await f.tasks.get(f.producer, composed.id)).composed, true);
  assert.deepEqual(
    (await f.tasks.list(f.producer)).map((task) => [task.id, task.composed]),
    [
      [composed.id, true],
      [written.id, false],
    ],
  );
});

test('a task keeps at most 200 Done-when checks, so its delivery always fits a workflow move', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const create = async (count: number) =>
    await f.tasks.create(f.producer, {
      title: 'Many checks',
      goal: 'Check many things.',
      checks: Array.from({ length: count }, (_, n) => `Check ${n} holds.`),
      requestId: `checks-${count}`,
    });
  await assert.rejects(async () => await create(201), code('invalid_checks'));
  assert.equal((await create(200)).acceptanceChecks.length, 200);
});

test('task creation retains the validated input while its pinned brief is read', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const original = {
    title: 'Original task',
    goal: 'Build an adder.',
    checks: ['Adds two numbers.', 'Handles negative inputs.'],
    briefId: f.brief.id,
    requestId: 'input-snapshot',
  };
  const input = structuredClone(original);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = f.artifacts.read.bind(f.artifacts);
  t.mock.method(f.artifacts, 'read', async (...args: Parameters<typeof read>) => {
    const result = await read(...args);
    enter();
    await waiting;
    return result;
  });
  const caller = { ...f.producer };
  const pending = f.tasks.create(caller, input);
  try {
    await entered;
    input.title = '';
    input.checks.splice(0, 2, 'Adds');
    input.requestId = 'mutated-request';
    Object.assign(caller, f.operator);
  } finally {
    release();
  }
  const task = await pending;
  assert.equal(task.producerId, f.producer.actorId);
  assert.equal(task.title, original.title);
  assert.deepEqual(task.checks, original.checks);
  assert.deepEqual(await f.tasks.create(f.producer, original), task);
  assert.equal((await f.tasks.list(f.producer)).length, 1);
});

test('task type registration snapshots the definition before Context Builder yields', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const definition = { ...structuredClone(TASK_TYPES[0]), name: 'task.snapshot' };
  const original = structuredClone(definition);
  const register = f.builder.register.bind(f.builder);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.builder, 'register', async (...args: Parameters<typeof register>) => {
    const handle = await register(...args);
    enter();
    await waiting;
    return handle;
  });
  const pending = f.tasks.registerType(definition);
  try {
    await entered;
    definition.name = 'task.changed';
    definition.version = 999;
    definition.recipe.sections.length = 0;
  } finally {
    release();
  }
  const dispose = await pending;
  try {
    const task = await f.tasks.create(f.producer, {
      title: 'Original type',
      goal: 'Build an adder.',
      checks: ['Adds two numbers.'],
      briefId: f.brief.id,
      requestId: 'registered-type',
      type: original.name,
      typeVersion: original.version,
    });
    const context = await f.tasks.context(f.producer, {
      taskId: task.id,
      purpose: 'work',
      requestId: 'registered-context',
      expectedRevision: task.workflow.revision,
    });
    assert.equal(context.type, original.name);
    assert.equal(context.typeVersion, original.version);
  } finally {
    dispose();
  }
});

for (const pending of [false, true]) {
  test(`task type registration ${pending ? 'pending during' : 'started after'} disposal cannot retain a context recipe`, async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const definition = { ...structuredClone(TASK_TYPES[0]), name: 'task.retired' };
    const register = f.builder.register.bind(f.builder);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (pending)
      t.mock.method(f.builder, 'register', async (...args: Parameters<typeof register>) => {
        const handle = await register(...args);
        enter();
        await waiting;
        return handle;
      });
    else f.tasks.dispose();
    const registration = f.tasks.registerType(definition);
    const rejected = assert.rejects(registration, { code: 'tasks_closed' });
    try {
      if (pending) {
        await entered;
        f.tasks.dispose();
      }
    } finally {
      release();
    }
    await rejected;
    const replacement = await register(definition);
    replacement.dispose();
  });
}

test('task checkpoints retain validated notes and artifact IDs during evidence lookup', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const task = await f.create(),
    evidence = await f.delivery();
  const original = {
    taskId: task.id,
    purpose: 'work' as const,
    expectedRevision: task.workflow.revision,
    requestId: 'stable-checkpoint',
    notes: 'Verified the current result.',
    artifactIds: [evidence.id],
  };
  const input = structuredClone(original);
  const getMany = f.artifacts.getMany.bind(f.artifacts);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.artifacts, 'getMany', async (...args: Parameters<typeof getMany>) => {
    const result = await getMany(...args);
    if (args[1].includes(evidence.id)) {
      enter();
      await waiting;
    }
    return result;
  });
  const caller = { ...f.producer };
  const pending = f.tasks.checkpoint(caller, input);
  try {
    await entered;
    input.notes = '';
    input.artifactIds[0] = 'unchecked-artifact';
    Object.assign(caller, f.operator);
  } finally {
    release();
  }
  const checkpoint = await pending;
  assert.equal(checkpoint.actorId, f.producer.actorId);
  assert.equal(checkpoint.notes, original.notes);
  assert.deepEqual(checkpoint.artifactIds, original.artifactIds);
  assert.deepEqual(await f.tasks.checkpoint(f.producer, original), checkpoint);
});
