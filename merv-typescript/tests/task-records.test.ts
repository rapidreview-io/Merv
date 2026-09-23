import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { TaskService } from '@merv/tasks';
import type { Caller, Task, Transaction } from '@merv/contracts';
import type { TaskRecord } from '@merv/tasks/types';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-records-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Corpus inputs', actorName: 'Operator' });
  const operator: Caller = {
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
    projectId: boot.project.id,
  };
  const issue = async (role: 'producer' | 'reader') => {
    const issued = await scope.issueActor(operator, { name: role, role });
    return {
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
      projectId: operator.projectId,
    };
  };
  const producer = await issue('producer'),
    reader = await issue('reader');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const tasks = await createService(
    new TaskService(state, scope, artifacts, workflows, reviews, builder),
  );
  t.after(async () => {
    tasks.dispose();
    builder.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = async (requestId: string) =>
    await tasks.create(producer, {
      title: requestId,
      goal: 'Measure the output.',
      checks: ['The retained measurement is reproducible.'],
      requestId,
    });
  return { state, scope, operator, producer, reader, artifacts, workflows, tasks, create };
}

test('Task records include all states in stable order without reading bytes or evaluating guidance', async (t) => {
  const f = await fixture(t);
  const first = await f.create('First input');
  const second = await f.create('Second input');
  await f.tasks.markFailed(f.producer, {
    taskId: second.id,
    expectedRevision: 0,
    reason: 'The experiment was cancelled.',
    requestId: 'cancel',
  });
  const interactive = await f.tasks.list(f.reader);
  const head = await f.state.eventHead();
  t.mock.method(f.artifacts, 'read', () => assert.fail('A record must not read artifact bytes'));
  t.mock.method(f.workflows, 'evaluate', () => assert.fail('A record must not evaluate guidance'));
  const records = await f.tasks.records(f.reader);
  assert.deepEqual(records, interactive);
  assert.deepEqual(
    await f.tasks.record(f.reader, first.id),
    interactive.find((task) => task.id === first.id)!,
  );
  assert.deepEqual(
    new Set(records.map((task) => task.workflow.state)),
    new Set(['in_progress', 'failed']),
  );
  assert.ok(records.every((record) => !Object.hasOwn(record, 'guidance')));
  assert.deepEqual(
    records.map((record) => [record.createdAt, record.id]),
    records
      .map((record) => [record.createdAt, record.id])
      .sort((a, b) => {
        const left = a.join(':'),
          right = b.join(':');
        return left < right ? -1 : left > right ? 1 : 0;
      }),
  );
  assert.equal(await f.state.eventHead(), head);
});

test('Task and project records share the caller transaction and do not commit or retain rolled-back work', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Atomic input');
  const before = await f.tasks.record(f.producer, task.id);
  const project = await f.scope.project(f.producer);
  const head = await f.state.eventHead();
  const rollback = new Error('rollback the owning command');
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.workflows.begin(f.producer, { instanceId: task.id, expectedRevision: 0 }, tx);
        const record = await f.tasks.record(f.producer, task.id, tx);
        assert.equal(record.workStarts.length, 1);
        assert.equal(record.workStarts[0]!.actorId, f.producer.actorId);
        assert.deepEqual(await f.tasks.records(f.producer, tx), [record]);
        assert.deepEqual(await f.scope.project(f.producer, tx), project);
        assert.ok((await f.state.eventHead(tx)) > head);
        throw rollback;
      }),
    (error) => error === rollback,
  );
  assert.deepEqual(await f.tasks.record(f.producer, task.id), before);
  assert.deepEqual(await f.scope.project(f.producer), project);
  assert.equal(await f.state.eventHead(), head);
});

test('Record reads authenticate within borrowed transactions and never cross projects', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Private input');
  const other = await f.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other operator',
  });
  const otherCaller: Caller = {
    actorId: other.actor.id,
    credentialId: other.credential.id,
    projectId: other.project.id,
  };
  await f.state.transaction(async (tx) => {
    assert.deepEqual(await f.tasks.records(otherCaller, tx), []);
    await assert.rejects(async () => await f.tasks.record(otherCaller, task.id, tx), {
      code: 'not_found',
    });
    assert.equal((await f.scope.project(otherCaller, tx)).id, other.project.id);
    await assert.rejects(
      async () => await f.scope.project({ ...otherCaller, projectId: f.operator.projectId }, tx),
      {
        code: 'forbidden',
      },
    );
    assert.equal((await f.tasks.record(f.reader, task.id, tx)).id, task.id);
  });
  await f.scope.revokeActor(f.operator, f.reader.actorId);
  await f.state.transaction(async (tx) => {
    await assert.rejects(async () => await f.tasks.record(f.reader, task.id, tx), {
      code: 'forbidden',
    });
    await assert.rejects(async () => await f.tasks.records(f.reader, tx), { code: 'forbidden' });
    await assert.rejects(async () => await f.scope.project(f.reader, tx), { code: 'forbidden' });
  });
});

test('Record reads reject expired and foreign transaction handles', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Transaction input');
  const expired = await f.state.transaction(async (tx) => tx);
  const refuse = async (tx: Transaction) => {
    await assert.rejects(async () => await f.tasks.record(f.reader, task.id, tx), {
      code: 'invalid_transaction',
    });
    await assert.rejects(async () => await f.tasks.records(f.reader, tx), {
      code: 'invalid_transaction',
    });
    await assert.rejects(async () => await f.scope.project(f.reader, tx), {
      code: 'invalid_transaction',
    });
  };
  await refuse(expired);
  const otherState = await openState(':memory:');
  try {
    await otherState.transaction(refuse);
  } finally {
    await otherState.close();
  }
});

test('Interactive Task get evaluates guidance, the list carries records, and returned records are detached', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Interactive input');
  const originalEvaluate = f.workflows.evaluate.bind(f.workflows);
  const evaluate = t.mock.method(f.workflows, 'evaluate', originalEvaluate);
  const interactive = await f.tasks.get(f.reader, task.id);
  assert.equal(evaluate.mock.callCount(), 1);
  assert.deepEqual(interactive.guidance, await originalEvaluate(f.reader, task.id));
  const { guidance: _guidance, ...listed }: Task = interactive;
  assert.deepEqual(await f.tasks.list(f.reader), [listed satisfies TaskRecord]);
  // A list is one read per row, never one guidance evaluation per row.
  assert.equal(evaluate.mock.callCount(), 1);
  const record = await f.tasks.record(f.reader, task.id);
  const original = structuredClone(record);
  record.checks.push('A caller cannot mutate stored checks.');
  record.workflow.data.untrusted = true;
  record.contextInputs.injected = ['art_unknown'];
  assert.deepEqual(await f.tasks.record(f.reader, task.id), original);
  assert.equal(evaluate.mock.callCount(), 1);
});
