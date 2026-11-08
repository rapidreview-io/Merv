import { createService } from '@merv/contracts';
import { requireDependencies } from '@merv/workflows/rules';
import assert from 'node:assert/strict';

import { test } from 'node:test';

import {
  check,
  type Caller,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type Workflows,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { openState } from './fixtures/state.js';

function graph(name = 'preparation', success = 'done', version = 1): WorkflowDefinition {
  return {
    name,
    version,
    managed: true,
    initial: 'working',
    states: ['working', success, 'failed'],
    terminal: [success, 'failed'],
    edges: [
      { from: 'working', action: 'finish', to: success },
      { from: 'working', action: 'withdraw', to: 'failed' },
    ],
  };
}
function policy(success = 'done', authorize = true): WorkflowPolicy {
  return {
    successStates: [success],
    dependencyFailureAction: 'withdraw',
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'work.finish',
        instruction: 'Complete the work.',
        requiresDependencies: true,
        check: async () => {
          check(authorize, 'forbidden', 'This actor cannot complete the work', 403);
        },
      },
      {
        name: 'withdraw',
        states: ['working'],
        transitions: ['withdraw'],
        tool: 'work.withdraw',
        instruction: 'Withdraw with a reason.',
        suggested: false,
        requiredInput: ['reason'],
        check: async () => {
          check(authorize, 'forbidden', 'This actor cannot withdraw the work', 403);
        },
      },
    ],
  };
}
async function setup(path = ':memory:') {
  const state = await openState(path),
    scope = await createService(new ProjectScope(state));
  const identity = await scope.credentials.bootstrap({
    projectName: 'Dependencies',
    actorName: 'Operator',
  });
  const caller = { actorId: identity.actor.id, projectId: identity.project.id };
  return {
    state,
    scope,
    caller,
    workflows: await createService(new WorkflowsService(state, scope)),
  };
}
async function start(
  handle: Awaited<ReturnType<Workflows['register']>>,
  caller: Caller,
  workflow: string,
  requestId: string,
  dependsOn?: string[] | string | null,
) {
  return await handle.start(caller, {
    workflow,
    requestId,
    data: { title: requestId },
    ...(dependsOn === undefined ? {} : { dependsOn }),
  });
}

/** An instance's recorded moves, oldest first, as wf_history keeps them. */
async function history(state: Awaited<ReturnType<typeof openState>>, instanceId: string) {
  const rows = await state.read((sql) =>
    sql.all<{ action: string; actor_id: string; data_json: string }>(
      'SELECT action,actor_id,data_json FROM wf_history WHERE instance_id=? ORDER BY revision',
      instanceId,
    ),
  );
  return rows.map(({ data_json, ...row }) => ({ ...row, data: JSON.parse(data_json) as unknown }));
}

test('owner-only additive dependency composition fences revisions, prevents cycles, and records only actual additions', async (t) => {
  const { state, scope, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const handle = await workflows.register(graph(), policy());
  const a = await start(handle, caller, 'preparation', 'a'),
    b = await start(handle, caller, 'preparation', 'b'),
    c = await start(handle, caller, 'preparation', 'c');
  const command = { instanceId: a.id, dependsOn: [b.id], expectedRevision: 0, requestId: 'attach' };
  const requested = structuredClone(command);
  const replacement = (
    await scope.credentials.issueActor(caller, { name: 'Replacement', role: 'producer' })
  ).actor;
  const pendingCaller = { ...caller };
  const pending = handle.addDependencies(pendingCaller, command);
  pendingCaller.actorId = replacement.id;
  Object.assign(command, { instanceId: c.id, requestId: 'changed', expectedRevision: 99 });
  command.dependsOn[0] = a.id;
  const attached = await pending;
  Object.assign(command, requested);
  assert.equal(attached.revision, 1);
  assert.deepEqual(await handle.addDependencies(caller, command), attached);
  const last = (await history(state, a.id)).at(-1)!;
  assert.deepEqual([last.action, last.actor_id], ['add_dependencies', caller.actorId]);
  const head = await state.eventHead();
  assert.deepEqual(
    await handle.addDependencies(caller, { ...command, requestId: 'noop', expectedRevision: 1 }),
    attached,
  );
  assert.equal(await state.eventHead(), head);
  assert.equal((await history(state, a.id)).length, 2);
  await assert.rejects(
    async () => await handle.addDependencies(caller, { ...command, requestId: 'stale' }),
    {
      code: 'revision_conflict',
    },
  );
  await assert.rejects(
    async () => await handle.addDependencies(caller, { ...command, dependsOn: [c.id] }),
    {
      code: 'request_conflict',
    },
  );
  await assert.rejects(
    async () =>
      await handle.addDependencies(caller, {
        instanceId: b.id,
        dependsOn: [a.id],
        expectedRevision: 0,
        requestId: 'cycle',
      }),
    { code: 'dependency_cycle' },
  );
  await assert.rejects(
    async () =>
      await handle.addDependencies(caller, {
        instanceId: b.id,
        dependsOn: b.id,
        expectedRevision: 0,
        requestId: 'self',
      }),
    { code: 'dependency_cycle' },
  );
  await assert.rejects(
    async () =>
      await handle.addDependencies(caller, {
        instanceId: b.id,
        dependsOn: [c.id, 'missing'],
        expectedRevision: 0,
        requestId: 'partial',
      }),
    { code: 'not_found' },
  );
  assert.deepEqual((await workflows.prerequisites(caller, [b.id])).get(b.id)!, []);
  const reader = {
    actorId: (await scope.credentials.issueActor(caller, { name: 'Reader', role: 'reader' })).actor
      .id,
    projectId: caller.projectId,
  };
  // A managed program authorizes its own commands, as for start and transition, so the
  // engine asks only that the caller can read the project.
  assert.deepEqual(
    await handle.addDependencies(reader, {
      ...command,
      expectedRevision: 1,
      requestId: 'reader',
    }),
    attached,
  );
  assert.equal(await state.eventHead(), head + 1, 'Only actor creation should append an event');
  await handle.transition(caller, {
    instanceId: a.id,
    expectedRevision: 1,
    action: 'withdraw',
    requestId: 'close',
    input: { reason: 'No longer needed' },
  });
  assert.deepEqual(
    await handle.addDependencies(caller, command),
    attached,
    'Old additions replay historical receipts after closure',
  );
  await assert.rejects(
    async () =>
      await handle.addDependencies(caller, {
        ...command,
        dependsOn: [c.id],
        expectedRevision: 2,
        requestId: 'closed-add',
      }),
    { code: 'invalid_transition' },
  );
  const other = await workflows.register(graph('other'), policy());
  await assert.rejects(
    async () =>
      await other.addDependencies(caller, {
        ...command,
        expectedRevision: 2,
        requestId: 'wrong-owner',
      }),
    { code: 'workflow_handle_mismatch' },
  );
  await assert.rejects(
    async () =>
      await state.transaction(async (tx) => {
        await handle.addDependencies(
          caller,
          { instanceId: b.id, dependsOn: [c.id], expectedRevision: 0, requestId: 'rollback' },
          tx,
        );
        throw Error('rollback');
      }),
    /rollback/,
  );
  assert.equal((await workflows.get(caller, b.id)).revision, 0);
  assert.deepEqual((await workflows.prerequisites(caller, [b.id])).get(b.id)!, []);
  // Fingerprinted as sets: a retry naming the same ids in another order replays.
  const d = await start(handle, caller, 'preparation', 'd'),
    e = await start(handle, caller, 'preparation', 'e'),
    f = await start(handle, caller, 'preparation', 'f');
  const set = { instanceId: f.id, dependsOn: [d.id, e.id], expectedRevision: 0, requestId: 'set' };
  const added = await handle.addDependencies(caller, set);
  assert.equal(added.revision, 1);
  assert.deepEqual(
    await handle.addDependencies(caller, { ...set, dependsOn: [e.id, d.id] }),
    added,
  );
  const replan = { ...set, dependsOn: [], drop: [d.id, e.id], expectedRevision: 1 };
  const replanned = await handle.addDependencies(caller, { ...replan, requestId: 'replan' });
  assert.deepEqual(
    await handle.addDependencies(caller, { ...replan, drop: [e.id, d.id], requestId: 'replan' }),
    replanned,
  );
  // Every graph is its program's: no graph leaves authority to the engine.
  await assert.rejects(
    async () =>
      await workflows.register({ ...graph('loose'), managed: false as unknown as true }, policy()),
    { code: 'invalid_workflow_policy', status: 400 },
  );
});

test('missing or foreign targets cannot open a gate or reveal another project; unknown source success is not invented', async (t) => {
  const { state, scope, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const targetProgram = await workflows.register(graph(), policy());
  const sourceProgram = await workflows.register(graph('unknown_source'), {
    ...policy(),
    successStates: undefined,
  });
  const target = await start(targetProgram, caller, 'preparation', 'target');
  const source = await start(sourceProgram, caller, 'unknown_source', 'source', [target.id]);
  await sourceProgram.transition(caller, {
    instanceId: source.id,
    expectedRevision: 0,
    action: 'withdraw',
    requestId: 'withdraw',
    input: { reason: 'stop' },
  });
  assert.deepEqual(
    (await workflows.records(caller, [target.id]))
      .get(target.id)!
      .dependents.map(({ settled, failed }) => ({
        settled,
        failed,
      })),
    [{ settled: false, failed: false }],
  );
  const dangling = await start(targetProgram, caller, 'preparation', 'dangling', [target.id]);
  await state.transaction(
    async (tx) =>
      await tx.run(
        'UPDATE wf_dependencies SET target_id=? WHERE source_id=?',
        'removed-target',
        dangling.id,
      ),
  );
  assert.equal(
    (await workflows.prerequisites(caller, [dangling.id])).get(dangling.id)![0].state,
    'missing',
  );
  await assert.rejects(
    async () =>
      requireDependencies((await workflows.prerequisites(caller, [dangling.id])).get(dangling.id)!),
    {
      code: 'dependencies_pending',
    },
  );
  const identity = await scope.credentials.bootstrap({ projectName: 'Secret', actorName: 'Other' });
  const other = { actorId: identity.actor.id, projectId: identity.project.id };
  const foreign = await start(targetProgram, other, 'preparation', 'PRIVATE TITLE');
  await targetProgram.transition(other, {
    instanceId: foreign.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'foreign-finish',
  });
  await state.transaction(
    async (tx) =>
      await tx.run(
        'UPDATE wf_dependencies SET target_id=? WHERE source_id=?',
        foreign.id,
        dangling.id,
      ),
  );
  const dependencies = (await workflows.prerequisites(caller, [dangling.id])).get(dangling.id)!;
  assert.equal(dependencies[0].state, 'missing');
  assert.equal(dependencies[0].settled, false);
  assert.ok(!JSON.stringify(dependencies).includes('PRIVATE TITLE'));
});
