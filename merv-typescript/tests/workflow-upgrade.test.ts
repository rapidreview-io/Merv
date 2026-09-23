import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import type { Caller, WorkflowDefinition } from '@merv/contracts';
import { openState } from './fixtures/state.js';

const graph = (version: number): WorkflowDefinition => ({
  name: 'upgradeable',
  version,
  managed: true,
  initial: 'draft',
  states: ['draft', 'review', 'done'],
  terminal: ['done'],
  edges: [
    { from: 'draft', action: 'submit', to: 'review' },
    { from: 'review', action: 'revise', to: 'draft' },
    { from: 'review', action: 'accept', to: 'done' },
    ...(version > 1 ? [{ from: 'draft', action: 'withdraw', to: 'done' }] : []),
  ],
});

async function setup(path = ':memory:') {
  const state = await openState(path);
  const scope = await createService(new ProjectScope(state));
  const bootstrap = await scope.bootstrap({ projectName: 'Upgrades', actorName: 'Operator' });
  const caller = { actorId: bootstrap.actor.id, projectId: bootstrap.project.id };
  const workflows = await createService(new WorkflowsService(state, scope));
  const source = await workflows.register(graph(1));
  const target = await workflows.register(graph(2));
  const initial = await source.start(caller, {
    workflow: 'upgradeable',
    requestId: 'start',
    data: { pinned: ['art_brief'], outcome: null },
  });
  const command = {
    instanceId: initial.id,
    fromVersion: 1,
    expectedRevision: 0,
    requestId: 'upgrade',
  };
  return { state, scope, caller, workflows, source, target, initial, command };
}

const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test('a managed additive upgrade records an explicit revision without changing state, data or other instances', async (t) => {
  const { state, scope, workflows, caller, source, target, initial, command } = await setup();
  t.after(async () => await state.close());
  const replacement = (await scope.issueActor(caller, { name: 'Replacement', role: 'producer' }))
    .actor;
  const untouched = await source.start(caller, { workflow: 'upgradeable', requestId: 'untouched' });
  const declarations = await state.read(
    async (sql) => await sql.all('SELECT * FROM wf_definitions ORDER BY version'),
  );
  const requested = { ...command };
  const pendingCaller = { ...caller };
  const pending = target.upgrade(pendingCaller, command);
  pendingCaller.actorId = replacement.id;
  Object.assign(command, { instanceId: untouched.id, requestId: 'changed', fromVersion: 99 });
  const upgraded = await pending;
  Object.assign(command, requested);
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.revision, 1);
  assert.equal(upgraded.state, initial.state);
  assert.equal(upgraded.createdAt, initial.createdAt);
  assert.deepEqual(upgraded.data, initial.data);
  assert.deepEqual(
    await state.read(async (sql) => await sql.all('SELECT * FROM wf_definitions ORDER BY version')),
    declarations,
  );
  const history = await workflows.history(caller, initial.id);
  assert.equal(history.length, 2);
  assert.equal(history[1].action, 'upgrade');
  assert.equal(history[1].fromState, 'draft');
  assert.equal(history[1].toState, 'draft');
  assert.deepEqual(history[1].data, { fromVersion: 1, toVersion: 2 });
  const event = (await state.events(caller.projectId)).find(
    (item) => item.data.action === 'upgrade',
  );
  assert.ok(event);
  assert.equal(event.type, 'workflow.transition');
  assert.equal(event.actorId, caller.actorId);
  assert.equal(event.subjectId, initial.id);
  assert.deepEqual(event.data, {
    action: 'upgrade',
    from: 'draft',
    to: 'draft',
    fromVersion: 1,
    toVersion: 2,
    workflow: 'upgradeable',
    version: 2,
    revision: 1,
  });
  assert.deepEqual(await workflows.get(caller, untouched.id), untouched);
  assert.equal(
    (
      await source.transition(caller, {
        instanceId: untouched.id,
        action: 'submit',
        expectedRevision: 0,
        requestId: 'still-v1',
      })
    ).version,
    1,
  );
  assert.equal('upgrade' in workflows, false, 'Upgrade is available only on the owning handle');
});

test('upgrade and following domain work share rollback, replay and conflict fences', async (t) => {
  const { state, workflows, caller, target, initial, command } = await setup();
  t.after(async () => await state.close());
  const eventCount = (await state.events(caller.projectId)).length;
  const finish = {
    instanceId: initial.id,
    expectedRevision: 1,
    action: 'withdraw',
    requestId: 'withdraw',
    data: { reason: 'Source is unavailable' },
  };
  await assert.rejects(
    async () =>
      await state.transaction(async (tx) => {
        await target.upgrade(caller, command, tx);
        await target.transition(caller, finish, tx);
        throw new Error('Domain operation failed');
      }),
    /Domain operation failed/,
  );
  assert.deepEqual(await workflows.get(caller, initial.id), initial);
  assert.equal((await workflows.history(caller, initial.id)).length, 1);
  assert.equal((await state.events(caller.projectId)).length, eventCount);
  let upgraded;
  await state.transaction(async (tx) => {
    upgraded = await target.upgrade(caller, command, tx);
    await target.transition(caller, finish, tx);
  });
  const final = await workflows.get(caller, initial.id);
  assert.equal(final.version, 2);
  assert.equal(final.state, 'done');
  assert.equal(final.revision, 2);
  assert.deepEqual(await target.upgrade(caller, command), upgraded);
  assert.deepEqual(await target.transition(caller, finish), final);
  assert.equal((await workflows.history(caller, initial.id)).length, 3);
  assert.equal((await state.events(caller.projectId)).length, eventCount + 2);
  await assert.rejects(
    async () => await target.upgrade(caller, { ...command, expectedRevision: 1 }),
    code('request_conflict'),
  );
  await assert.rejects(
    async () => await target.upgrade(caller, { ...command, fromVersion: 2 }),
    code('request_conflict'),
  );
  await assert.rejects(
    async () => await target.upgrade(caller, { ...command, requestId: 'withdraw' }),
    code('request_conflict'),
  );
  const third = await workflows.register(graph(3));
  await assert.rejects(async () => await third.upgrade(caller, command), code('request_conflict'));
  await assert.rejects(
    async () => await third.upgrade(caller, { ...command, fromVersion: 2 }),
    code('request_conflict'),
  );
  await assert.rejects(
    async () => await target.upgrade(caller, { ...command, requestId: 'again' }),
    code('workflow_version_conflict'),
  );
});

test('upgrade requires an active actor with write permission in the instance project, including replay', async (t) => {
  const { state, scope, workflows, caller, target, initial, command } = await setup();
  t.after(async () => await state.close());
  const other = await scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const foreign = { actorId: other.actor.id, projectId: other.project.id };
  await assert.rejects(async () => await target.upgrade(foreign, command), code('not_found'));
  await assert.rejects(
    async () => await target.upgrade({ ...foreign, projectId: caller.projectId }, command),
    code('forbidden'),
  );
  for (const role of ['reader', 'reviewer'] as const) {
    const actor = (await scope.issueActor(caller, { name: role, role })).actor;
    await assert.rejects(
      async () => await target.upgrade({ actorId: actor.id, projectId: caller.projectId }, command),
      code('forbidden'),
    );
  }
  const producer = (await scope.issueActor(caller, { name: 'Producer', role: 'producer' })).actor;
  const producerCaller: Caller = { actorId: producer.id, projectId: caller.projectId };
  await target.upgrade(producerCaller, command);
  await assert.rejects(async () => await target.upgrade(caller, command), code('request_conflict'));
  await scope.revokeActor(caller, producer.id);
  await assert.rejects(
    async () => await target.upgrade(producerCaller, command),
    code('forbidden'),
  );
  const otherHandle = await workflows.register({ ...graph(2), name: 'another' });
  await workflows.register({ ...graph(1), name: 'another' });
  await assert.rejects(
    async () => await otherHandle.upgrade(caller, { ...command, requestId: 'wrong-handle' }),
    code('workflow_handle_mismatch'),
  );
  assert.equal((await workflows.get(caller, initial.id)).version, 2);
});

test('upgrades reject stale revisions, terminal instances, invalid input and inactive definitions', async (t) => {
  const { state, workflows, caller, source, target, initial, command } = await setup();
  t.after(async () => await state.close());
  for (const [override, errorCode] of [
    [{ instanceId: '' }, 'invalid_instance'],
    [{ requestId: '' }, 'invalid_request'],
    [{ fromVersion: 0 }, 'invalid_version'],
    [{ expectedRevision: -1 }, 'invalid_revision'],
  ] as const) {
    await assert.rejects(
      async () => await target.upgrade(caller, { ...command, ...override }),
      code(errorCode),
    );
  }
  await source.transition(caller, {
    instanceId: initial.id,
    expectedRevision: 0,
    action: 'submit',
    requestId: 'submit',
  });
  await assert.rejects(
    async () => await target.upgrade(caller, command),
    code('revision_conflict'),
  );
  await source.transition(caller, {
    instanceId: initial.id,
    expectedRevision: 1,
    action: 'accept',
    requestId: 'accept',
  });
  await assert.rejects(
    async () => await target.upgrade(caller, { ...command, expectedRevision: 2 }),
    code('invalid_transition'),
  );
  await assert.rejects(
    async () => await source.upgrade(caller, command),
    code('workflow_upgrade_incompatible'),
  );
  await assert.rejects(
    async () => await source.upgrade(caller, { ...command, fromVersion: 2 }),
    code('workflow_upgrade_incompatible'),
  );
  source.dispose();
  await assert.rejects(
    async () => await target.upgrade(caller, command),
    code('workflow_unavailable'),
  );
  await workflows.register(graph(1));
  target.dispose();
  await assert.rejects(
    async () => await target.upgrade(caller, command),
    code('workflow_unavailable'),
  );
  const replacement = await workflows.register(graph(2));
  target.dispose();
  const active = workflows
    .catalog()
    .some((item) => item.name === 'upgradeable' && item.version === 2);
  assert.equal(active, true);
  await assert.rejects(
    async () => await replacement.upgrade(caller, { ...command, expectedRevision: 2 }),
    code('invalid_transition'),
  );
});

test('only additive managed definitions can upgrade existing instances', async (t) => {
  const incompatible = [
    ['changed initial state', (value: WorkflowDefinition) => ({ ...value, initial: 'review' })],
    ['changed terminal states', (value: WorkflowDefinition) => ({ ...value, terminal: [] })],
    [
      'removed edge',
      (value: WorkflowDefinition) => ({
        ...value,
        edges: value.edges.filter((edge) => edge.action !== 'revise'),
      }),
    ],
    [
      'redirected edge',
      (value: WorkflowDefinition) => ({
        ...value,
        edges: value.edges.map((edge) =>
          edge.action === 'revise' ? { ...edge, to: 'review' } : edge,
        ),
      }),
    ],
    [
      'added state',
      (value: WorkflowDefinition) => ({
        ...value,
        states: [...value.states, 'extra'],
        edges: [...value.edges, { from: 'draft', action: 'extra', to: 'extra' }],
      }),
    ],
  ] as const;
  for (const [name, change] of incompatible) {
    await t.test(name, async (t) => {
      const { state, workflows, caller, target, initial, command } = await setup();
      t.after(async () => await state.close());
      target.dispose();
      const incompatibleTarget = await workflows.register(change(graph(3)));
      await assert.rejects(
        async () => await incompatibleTarget.upgrade(caller, command),
        code('workflow_upgrade_incompatible'),
      );
      assert.deepEqual(await workflows.get(caller, initial.id), initial);
    });
  }
  for (const unmanagedVersion of [1, 2]) {
    await t.test(`unmanaged version ${unmanagedVersion}`, async (t) => {
      const state = await openState(':memory:');
      t.after(async () => await state.close());
      const scope = await createService(new ProjectScope(state));
      const bootstrap = await scope.bootstrap({ projectName: 'Unmanaged', actorName: 'Operator' });
      const caller = { actorId: bootstrap.actor.id, projectId: bootstrap.project.id };
      const workflows = await createService(new WorkflowsService(state, scope));
      const source = await workflows.register({ ...graph(1), managed: unmanagedVersion !== 1 });
      const target = await workflows.register({ ...graph(2), managed: unmanagedVersion !== 2 });
      const initial = await source.start(caller, { workflow: 'upgradeable', requestId: 'start' });
      await assert.rejects(
        async () =>
          await target.upgrade(caller, {
            instanceId: initial.id,
            fromVersion: 1,
            expectedRevision: 0,
            requestId: 'upgrade',
          }),
        code('workflow_upgrade_forbidden'),
      );
    });
  }
});

test('upgrade remains explicit and replayable across restart and competing connections', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'merv-upgrade-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = folder;
  const first = await setup(path);
  const secondState = await openState(path);
  t.after(async () => await secondState.close());
  const second = await createService(
    new WorkflowsService(secondState, await createService(new ProjectScope(secondState))),
  );
  await second.register(graph(1));
  const secondTarget = await second.register(graph(2));
  await first.source.transition(first.caller, {
    instanceId: first.initial.id,
    expectedRevision: 0,
    action: 'submit',
    requestId: 'submit',
  });
  await assert.rejects(
    async () => await secondTarget.upgrade(first.caller, first.command),
    code('revision_conflict'),
  );
  await assert.rejects(
    async () =>
      await secondState.transaction(
        async (tx) => await first.target.upgrade(first.caller, first.command, tx),
      ),
    code('invalid_transaction'),
  );
  const command = { ...first.command, expectedRevision: 1 };
  const upgraded = await secondTarget.upgrade(first.caller, command);
  assert.equal((await first.workflows.get(first.caller, first.initial.id)).revision, 2);
  await first.state.close();
  const reopened = await openState(path);
  t.after(async () => await reopened.close());
  const restored = await createService(
    new WorkflowsService(reopened, await createService(new ProjectScope(reopened))),
  );
  await restored.register(graph(1));
  const restoredTarget = await restored.register(graph(2));
  assert.deepEqual(await restoredTarget.upgrade(first.caller, command), upgraded);
  assert.equal((await restored.history(first.caller, first.initial.id)).length, 3);
});
