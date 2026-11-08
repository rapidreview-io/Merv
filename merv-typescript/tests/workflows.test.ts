import type { Caller, WorkflowDefinition, WorkflowPolicy } from '@merv/contracts';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { PostgresState } from '@merv/state';
import { WorkflowsService } from '@merv/workflows';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openState } from './fixtures/state.js';

const graph = (version = 1): WorkflowDefinition => ({
  name: 'approval',
  version,
  initial: 'draft',
  states: ['draft', 'review', 'done'],
  terminal: ['done'],
  edges: [
    { from: 'draft', action: 'submit', to: 'review' },
    { from: 'review', action: 'revise', to: 'draft' },
    { from: 'review', action: 'accept', to: 'done' },
  ],
});
async function setup(path = ':memory:', given?: PostgresState) {
  const state = given ?? (await openState(path));
  const scope = await createService(new ProjectScope(state));
  const credentials = await scope.credentials.bootstrap({
    projectName: 'Workflow tests',
    actorName: 'Operator',
  });
  const caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const workflows = await createService(new WorkflowsService(state, scope));
  // Every instance changes through its graph's handle.
  const approval = await workflows.register(graph());
  return { state, scope, workflows, approval, caller };
}
const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;
/** Who made each recorded move of an instance, oldest first, as wf_history keeps them. */
const movers = async (state: PostgresState, instanceId: string) =>
  (
    await state.read((sql) =>
      sql.all<{ actor_id: string }>(
        'SELECT actor_id FROM wf_history WHERE instance_id=? ORDER BY revision',
        instanceId,
      ),
    )
  ).map((row) => row.actor_id);

test('competing connections reject stale revisions and transaction rollback includes ledger and events', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'merv-workflow-cas-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = folder;
  const { state, scope, workflows, approval, caller } = await setup(path);
  t.after(async () => await state.close());
  const state2 = await openState(path);
  t.after(async () => await state2.close());
  const other = await createService(
    new WorkflowsService(state2, await createService(new ProjectScope(state2))),
  );
  const otherApproval = await other.register(graph());
  const initial = await approval.start(caller, { workflow: 'approval', requestId: 'start' });
  const stale = await other.get(caller, initial.id);
  await approval.transition(caller, {
    instanceId: initial.id,
    action: 'submit',
    expectedRevision: 0,
    requestId: 'winner',
  });
  await assert.rejects(
    async () =>
      await otherApproval.transition(caller, {
        instanceId: initial.id,
        action: 'submit',
        expectedRevision: stale.revision,
        requestId: 'loser',
      }),
    code('revision_conflict'),
  );
  const eventCount = (await state.events(caller.projectId)).length;
  const retry = {
    instanceId: initial.id,
    action: 'accept',
    expectedRevision: 1,
    requestId: 'rollback',
  };
  await assert.rejects(
    async () =>
      await state.transaction(async (tx) => {
        await approval.transition(caller, retry, tx);
        throw new Error('Caller-owned operation failed');
      }),
    /Caller-owned operation failed/,
  );
  assert.equal((await workflows.get(caller, initial.id)).revision, 1);
  assert.equal((await movers(state, initial.id)).length, 2);
  assert.equal((await state.events(caller.projectId)).length, eventCount);
  assert.equal((await approval.transition(caller, retry)).revision, 2);
  await assert.rejects(
    async () => await state2.transaction(async (tx) => await workflows.get(caller, initial.id, tx)),
    code('invalid_transaction'),
  );
  assert.ok(await scope.project(caller));
});

test('all project reads and mutation replays check actor scope and permission', async (t) => {
  const { state, scope, workflows, approval, caller } = await setup();
  t.after(async () => await state.close());
  const initial = await approval.start(caller, { workflow: 'approval', requestId: 'start' });
  const foreign = await scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Other operator',
  });
  const other: Caller = { actorId: foreign.actor.id, projectId: foreign.project.id };
  for (const method of ['get', 'evaluate', 'workStarts', 'process', 'list', 'overview'] as const) {
    await t.test(method, async () => {
      const pendingCaller = { ...other };
      const reading =
        method === 'list' || method === 'overview'
          ? workflows[method](pendingCaller)
          : workflows[method](pendingCaller, initial.id);
      Object.assign(pendingCaller, caller);
      if (method === 'list') assert.deepEqual(await reading, []);
      else if (method === 'overview') {
        const result = (await reading) as Awaited<ReturnType<typeof workflows.overview>>;
        assert.equal(result.projectId, other.projectId);
        assert.deepEqual(result.workflows, []);
      } else await assert.rejects(reading, code('not_found'));
    });
  }
  await assert.rejects(async () => await workflows.get(other, initial.id), code('not_found'));
  assert.equal((await workflows.list(other)).length, 0);
  await assert.rejects(
    async () => await workflows.get({ ...other, projectId: caller.projectId }, initial.id),
    code('forbidden'),
  );
  const reader = (await scope.credentials.issueActor(caller, { name: 'Reader', role: 'reader' }))
    .actor;
  const readerCaller = { actorId: reader.id, projectId: caller.projectId };
  assert.equal((await workflows.get(readerCaller, initial.id)).id, initial.id);
  const producer = (
    await scope.credentials.issueActor(caller, { name: 'Producer', role: 'producer' })
  ).actor;
  await assert.rejects(
    async () =>
      await approval.start(
        { actorId: producer.id, projectId: caller.projectId },
        { workflow: 'approval', requestId: 'start' },
      ),
    code('request_conflict'),
  );
  await scope.credentials.revokeActor(caller, producer.id);
  await assert.rejects(
    async () => await workflows.list({ actorId: producer.id, projectId: caller.projectId }),
    code('forbidden'),
  );
  // A handle's commands ask that the caller may read the project, before any replay.
  for (const outsider of [
    { ...other, projectId: caller.projectId },
    { actorId: producer.id, projectId: caller.projectId },
  ]) {
    await assert.rejects(
      async () => await approval.start(outsider, { workflow: 'approval', requestId: 'start' }),
      code('forbidden'),
    );
    await assert.rejects(
      async () =>
        await approval.transition(outsider, {
          instanceId: initial.id,
          action: 'submit',
          expectedRevision: 0,
          requestId: 'submit',
        }),
      code('forbidden'),
    );
    await assert.rejects(
      async () =>
        await approval.addDependencies(outsider, {
          instanceId: initial.id,
          expectedRevision: 0,
          dependsOn: [],
          requestId: 'depend',
        }),
      code('forbidden'),
    );
  }
});

async function callbackFixture(t: TestContext) {
  const state = await openState();
  t.after(async () => {
    await state.close();
  });
  return await setup(':memory:', state);
}

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await released;
    },
  };
}
test('awaited transition checks share the writer and withdrawal rolls back the entire command', async (t) => {
  const { state, workflows, caller } = await callbackFixture(t);
  await state.transaction((tx) => tx.run('CREATE TABLE callback_receipts (id TEXT PRIMARY KEY)'));
  const gate = barrier();
  const definition: WorkflowDefinition = {
    name: 'awaited_guard',
    version: 1,
    initial: 'work',
    states: ['work', 'done'],
    terminal: ['done'],
    edges: [{ from: 'work', action: 'finish', to: 'done' }],
  };
  const policy: WorkflowPolicy = {
    actions: [
      {
        name: 'finish',
        states: ['work'],
        transitions: ['finish'],
        tool: 'work.finish',
        instruction: 'Finish the work.',
        async check({ tx }) {
          assert.ok(await tx.get('SELECT id FROM callback_receipts WHERE id=?', 'command'));
          await gate.wait();
          // This must still be the live caller-owned transaction after the pause.
          assert.ok(await tx.get('SELECT id FROM callback_receipts WHERE id=?', 'command'));
        },
        arguments: async ({ snapshot }) => ({ instanceId: snapshot.id }),
        requiredInput: async () => [],
      },
    ],
  };
  let program = await workflows.register(definition, policy);
  const instance = await program.start(caller, {
    workflow: definition.name,
    requestId: 'guard-start',
  });
  const before = await state.eventHead();
  const command = {
    instanceId: instance.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'guard-finish',
  };
  const execute = () =>
    state.transaction(async (tx) => {
      await tx.run('INSERT INTO callback_receipts (id) VALUES (?)', 'command');
      return await program.transition(caller, command, tx);
    });
  const pending = execute();
  await gate.entered;
  program.dispose();
  gate.release();
  await assert.rejects(pending, { code: 'workflow_unavailable' });
  assert.equal((await workflows.get(caller, instance.id)).revision, 0);
  assert.equal(await state.eventHead(), before);
  assert.deepEqual(await state.read((sql) => sql.all('SELECT id FROM callback_receipts')), []);
  program = await workflows.register(definition, policy);
  assert.equal((await execute()).state, 'done');
  assert.equal((await movers(state, instance.id)).length, 2);
  assert.deepEqual(
    await program.transition(caller, command),
    await workflows.get(caller, instance.id),
  );
});
