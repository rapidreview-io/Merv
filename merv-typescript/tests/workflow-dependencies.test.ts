import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import {
  check,
  type Caller,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type Workflows,
} from '@merv/contracts';

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
  const state = new SqliteState(path),
    scope = await createService(new ProjectScope(state));
  const identity = await scope.bootstrap({ projectName: 'Dependencies', actorName: 'Operator' });
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

test('registered dependency semantics gate designated actions, guide failure recovery, and leave unrelated commands available', async (t) => {
  const { state, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const prep = await workflows.register(graph(), policy());
  const experiment = await workflows.register(graph('experiment', 'complete'), policy('complete'));
  const upstream = await start(prep, caller, 'preparation', 'upstream');
  const downstream = await start(experiment, caller, 'experiment', 'downstream', [upstream.id]);
  const pending = await workflows.evaluate(caller, downstream.id);
  assert.equal(pending.currentGate, 'dependencies_pending');
  assert.equal(pending.nextAction, null);
  assert.deepEqual(pending.dependencies, [
    {
      id: upstream.id,
      workflow: 'preparation',
      version: 1,
      name: 'upstream',
      state: 'working',
      settled: false,
      failed: false,
    },
  ]);
  const beforeEvents = await state.eventHead();
  await assert.rejects(
    async () =>
      await experiment.transition(caller, {
        instanceId: downstream.id,
        expectedRevision: 0,
        action: 'finish',
        requestId: 'premature',
      }),
    { code: 'dependencies_pending' },
  );
  await assert.rejects(async () => await workflows.checkDependencies(caller, downstream.id), {
    code: 'dependencies_pending',
  });
  assert.equal(await state.eventHead(), beforeEvents);
  assert.equal((await workflows.get(caller, downstream.id)).revision, 0);
  assert.equal(
    (
      await workflows.evaluate(caller, downstream.id, {
        action: 'withdraw',
        input: { reason: 'replan' },
      })
    ).nextAction?.action,
    'withdraw',
  );
  await prep.transition(caller, {
    instanceId: upstream.id,
    expectedRevision: 0,
    action: 'withdraw',
    requestId: 'up-failed',
    input: { reason: 'source unavailable' },
  });
  const failed = await workflows.evaluate(caller, downstream.id);
  assert.equal(failed.currentGate, 'dependency_failed');
  assert.equal(failed.nextAction?.action, 'withdraw');
  assert.equal(failed.nextAction?.status, 'needs_input');
  assert.deepEqual(
    failed.blockers.map((item) => item.code),
    ['dependency_failed', 'input_required'],
  );
  assert.equal(
    (await workflows.evaluate(caller, downstream.id, { action: 'finish' })).nextAction,
    null,
  );
  assert.equal(
    (await workflows.get(caller, downstream.id)).state,
    'working',
    'Failed upstream must not mutate downstream',
  );
  await experiment.transition(caller, {
    instanceId: downstream.id,
    expectedRevision: 0,
    action: 'withdraw',
    requestId: 'down-failed',
    input: { reason: 'upstream failed' },
  });
  assert.equal((await workflows.evaluate(caller, downstream.id)).currentGate, 'terminal');
  const completed = await start(experiment, caller, 'experiment', 'completed');
  await experiment.transition(caller, {
    instanceId: completed.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'completed-finish',
  });
  const dependent = await start(prep, caller, 'preparation', 'consumes-experiment', completed.id);
  assert.equal((await workflows.dependencies(caller, dependent.id)).dependencies[0].settled, true);
  assert.equal((await workflows.dependencies(caller, completed.id)).dependents[0].id, dependent.id);
  await prep.transition(caller, {
    instanceId: dependent.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'dependent-finish',
  });
  assert.equal((await workflows.dependencies(caller, completed.id)).dependents[0].settled, true);
});

test('dependency creation normalizes inputs, rejects unsupported or out-of-scope targets, and rolls back records and events', async (t) => {
  const { state, scope, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const handle = await workflows.register(graph(), policy());
  const upstream = await start(handle, caller, 'preparation', 'upstream');
  const input = {
    workflow: 'preparation',
    requestId: 'normalized',
    dependsOn: [' ', ` ${upstream.id} `, upstream.id],
  };
  const downstream = await handle.start(caller, input);
  assert.equal((await workflows.dependencies(caller, downstream.id)).dependencies.length, 1);
  assert.deepEqual(await handle.start(caller, { ...input, dependsOn: upstream.id }), downstream);
  const otherIdentity = await scope.bootstrap({ projectName: 'Private', actorName: 'Other' });
  const other = { actorId: otherIdentity.actor.id, projectId: otherIdentity.project.id };
  const foreign = await start(handle, other, 'preparation', 'foreign');
  const bare = await workflows.register(graph('undeclared'), {
    ...policy(),
    successStates: undefined,
  });
  const unsupported = await start(bare, caller, 'undeclared', 'unsupported');
  const count = (await workflows.list(caller)).length,
    head = await state.eventHead();
  for (const [dependsOn, code] of [
    [123, 'invalid_dependencies'],
    [{}, 'invalid_dependencies'],
    [['ok', 3], 'invalid_dependencies'],
    ['missing', 'not_found'],
    [foreign.id, 'not_found'],
    [unsupported.id, 'dependency_unsupported'],
  ] as const) {
    await assert.rejects(
      async () =>
        await handle.start(caller, {
          workflow: 'preparation',
          requestId: 'invalid',
          dependsOn: dependsOn as any,
        }),
      { code },
    );
    assert.equal((await workflows.list(caller)).length, count);
    assert.equal(await state.eventHead(), head);
  }
  await assert.rejects(async () => await workflows.dependencies(other, downstream.id), {
    code: 'not_found',
  });
  assert.deepEqual(
    (await workflows.overview(other)).workflows.map((item) => item.instanceId),
    [foreign.id],
  );
  await assert.rejects(
    async () =>
      await state.transaction(async (tx) => {
        await handle.start(
          caller,
          { workflow: 'preparation', requestId: 'abort-create', dependsOn: [upstream.id] },
          tx,
        );
        throw new Error('rollback');
      }),
    /rollback/,
  );
  assert.equal((await workflows.list(caller)).length, count);
  assert.equal(await state.eventHead(), head);
  // With no dependency argument, an existing start's exact fingerprint still replays.
  assert.deepEqual(await start(handle, caller, 'preparation', 'upstream'), upstream);
});

test('owner-only additive dependency composition fences revisions, prevents cycles, and records only actual additions', async (t) => {
  const { state, scope, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const handle = await workflows.register(graph(), policy());
  const a = await start(handle, caller, 'preparation', 'a'),
    b = await start(handle, caller, 'preparation', 'b'),
    c = await start(handle, caller, 'preparation', 'c');
  const command = { instanceId: a.id, dependsOn: [b.id], expectedRevision: 0, requestId: 'attach' };
  const attached = await handle.addDependencies(caller, command);
  assert.equal(attached.revision, 1);
  assert.deepEqual(await handle.addDependencies(caller, command), attached);
  assert.equal(((await workflows.history(caller, a.id)).at(-1) as any).action, 'add_dependencies');
  const head = await state.eventHead();
  assert.deepEqual(
    await handle.addDependencies(caller, { ...command, requestId: 'noop', expectedRevision: 1 }),
    attached,
  );
  assert.equal(await state.eventHead(), head);
  assert.equal((await workflows.history(caller, a.id)).length, 2);
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
  assert.deepEqual((await workflows.dependencies(caller, b.id)).dependencies, []);
  const reader = {
    actorId: (await scope.issueActor(caller, { name: 'Reader', role: 'reader' })).actor.id,
    projectId: caller.projectId,
  };
  await assert.rejects(
    async () =>
      await handle.addDependencies(reader, {
        ...command,
        expectedRevision: 1,
        requestId: 'reader',
      }),
    { code: 'forbidden' },
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
  assert.deepEqual((await workflows.dependencies(caller, b.id)).dependencies, []);
});

test('success declarations and edge contracts survive upgrade, provider removal, and database restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-work-deps-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let { state, scope, workflows, caller } = await setup(join(directory, 'state.sqlite'));
  let closed = false;
  t.after(async () => {
    if (!closed) await state.close();
  });
  const v1 = await workflows.register(graph(), policy());
  const upstream = await start(v1, caller, 'preparation', 'upstream');
  const oldDependent = await start(v1, caller, 'preparation', 'old', [upstream.id]);
  const v2 = await workflows.register(graph('preparation', 'done', 2), policy('failed'));
  const upgraded = await v2.upgrade(caller, {
    instanceId: upstream.id,
    fromVersion: 1,
    expectedRevision: 0,
    requestId: 'upgrade',
  });
  assert.equal(upgraded.version, 2);
  const newDependent = await start(v2, caller, 'preparation', 'new', [upstream.id]);
  await v2.transition(caller, {
    instanceId: upstream.id,
    expectedRevision: 1,
    action: 'finish',
    requestId: 'finish',
  });
  assert.equal(
    (await workflows.dependencies(caller, oldDependent.id)).dependencies[0].settled,
    true,
  );
  assert.equal(
    (await workflows.dependencies(caller, newDependent.id)).dependencies[0].failed,
    true,
  );
  v1.dispose();
  v2.dispose();
  assert.equal(
    (await workflows.dependencies(caller, oldDependent.id)).dependencies[0].settled,
    true,
  );
  await assert.rejects(
    async () =>
      await v1.addDependencies(caller, {
        instanceId: oldDependent.id,
        dependsOn: [],
        expectedRevision: 0,
        requestId: 'disposed',
      }),
    { code: 'workflow_unavailable' },
  );
  await state.close();
  closed = true;
  state = new SqliteState(join(directory, 'state.sqlite'));
  closed = false;
  scope = await createService(new ProjectScope(state));
  workflows = await createService(new WorkflowsService(state, scope));
  assert.equal(
    (await workflows.dependencies(caller, oldDependent.id)).dependencies[0].settled,
    true,
  );
  await assert.rejects(async () => await workflows.checkDependencies(caller, newDependent.id), {
    code: 'dependency_failed',
  });
  assert.equal((await workflows.evaluate(caller, oldDependent.id)).available, false);
  const restored = await workflows.register(graph(), policy());
  restored.dispose();
  await assert.rejects(async () => await workflows.register(graph(), policy('failed')), {
    code: 'workflow_version_conflict',
  });
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
    (await workflows.dependencies(caller, target.id)).dependents.map(({ settled, failed }) => ({
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
    (await workflows.dependencies(caller, dangling.id)).dependencies[0].state,
    'missing',
  );
  await assert.rejects(async () => await workflows.checkDependencies(caller, dangling.id), {
    code: 'dependencies_pending',
  });
  const identity = await scope.bootstrap({ projectName: 'Secret', actorName: 'Other' });
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
  const dependencies = (await workflows.dependencies(caller, dangling.id)).dependencies;
  assert.equal(dependencies[0].state, 'missing');
  assert.equal(dependencies[0].settled, false);
  assert.ok(!JSON.stringify(dependencies).includes('PRIVATE TITLE'));
});

test('dependency policy validation and immutable contexts prevent changing registered success or bypassing authorization', async (t) => {
  const { state, workflows, caller } = await setup();
  t.after(async () => await state.close());
  for (const successStates of [[], ['working'], ['done', 'done'], ['unknown']])
    await assert.rejects(
      async () => await workflows.register(graph(), { ...policy(), successStates }),
      {
        code: 'invalid_workflow_policy',
      },
    );
  await assert.rejects(
    async () =>
      await workflows.register(graph(), { ...policy(), dependencyFailureAction: 'missing' }),
    { code: 'invalid_workflow_policy' },
  );
  const definition = graph(),
    original = policy();
  const handle = await workflows.register(definition, original);
  original.successStates![0] = 'failed';
  const upstream = await start(handle, caller, 'preparation', 'upstream');
  await handle.transition(caller, {
    instanceId: upstream.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'finish',
  });
  const downstream = await start(handle, caller, 'preparation', 'downstream', [upstream.id]);
  assert.equal((await workflows.dependencies(caller, downstream.id)).dependencies[0].settled, true);
  const denied = await workflows.register(graph('denied'), policy('done', false));
  const failure = await start(handle, caller, 'preparation', 'failure');
  await handle.transition(caller, {
    instanceId: failure.id,
    expectedRevision: 0,
    action: 'withdraw',
    requestId: 'failed',
    input: { reason: 'ended' },
  });
  const privateWork = await start(denied, caller, 'denied', 'private', [failure.id]);
  const decision = await workflows.evaluate(caller, privateWork.id);
  assert.equal(decision.nextAction, null);
  assert.equal(decision.actions[0].blockers[0].code, 'forbidden');
  assert.equal(decision.currentGate, 'dependency_failed');
  const operatorPolicy = policy();
  operatorPolicy.actions[0].check = async () => check(false, 'forbidden', 'Producer only', 403);
  const operatorProgram = await workflows.register(graph('operator_recovery'), operatorPolicy);
  const operatorWork = await start(operatorProgram, caller, 'operator_recovery', 'operator-work', [
    failure.id,
  ]);
  const operatorDecision = await workflows.evaluate(caller, operatorWork.id);
  assert.equal(operatorDecision.currentGate, 'dependency_failed');
  assert.equal(operatorDecision.nextAction?.action, 'withdraw');
  assert.equal(operatorDecision.actions[0].blockers[0].code, 'forbidden');
  assert.equal(
    (await workflows.evaluate(caller, operatorWork.id, { action: 'finish' })).nextAction,
    null,
  );
  const immutable = policy();
  immutable.actions[0].check = async ({ dependencies }) => {
    assert.ok(Object.isFrozen(dependencies));
    assert.ok(Object.isFrozen(dependencies![0]));
    assert.throws(() => {
      dependencies![0].settled = false;
    }, TypeError);
  };
  const readOnly = await workflows.register(graph('read_only'), immutable);
  const guarded = await start(readOnly, caller, 'read_only', 'guarded', [upstream.id]);
  assert.equal((await workflows.evaluate(caller, guarded.id)).nextAction?.action, 'finish');
});
