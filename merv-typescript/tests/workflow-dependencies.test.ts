import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import {
  check,
  type Caller,
  type Transaction,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type Workflows,
} from '@merv/contracts';
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

/** The statements `run` sends through the transaction it is given, as their SQL. */
async function statements(
  state: Awaited<ReturnType<typeof openState>>,
  run: (tx: Transaction) => Promise<unknown>,
): Promise<string[]> {
  const sent: string[] = [];
  await state.transaction(async (tx) => {
    const spied = tx as unknown as Record<'get' | 'all' | 'run', (...args: unknown[]) => unknown>;
    for (const method of ['get', 'all', 'run'] as const) {
      const original = spied[method].bind(tx);
      spied[method] = (sql, ...args) => {
        sent.push(String(sql));
        return original(sql, ...args);
      };
    }
    await run(tx);
  });
  return sent;
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
      revision: 0,
      settled: false,
      terminal: false,
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
  // Its only remaining move ends it, so the project overview must not call it ready: nothing
  // is dispatched for work like this, and it waits for its owner.
  const overview = await workflows.overview(caller);
  assert.ok(overview.stalled.includes(downstream.id));
  assert.ok(!overview.ready.includes(downstream.id));
  assert.ok(!overview.blocked.includes(downstream.id));
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
  // The fingerprint names the set asked for: another order, or an empty list for none, replays.
  const second = await start(handle, caller, 'preparation', 'second');
  const pair = await start(handle, caller, 'preparation', 'pair', [upstream.id, second.id]);
  assert.deepEqual(
    await start(handle, caller, 'preparation', 'pair', [second.id, upstream.id]),
    pair,
  );
  assert.deepEqual(await start(handle, caller, 'preparation', 'second', []), second);
  const none = await start(handle, caller, 'preparation', 'none', []);
  assert.deepEqual(await start(handle, caller, 'preparation', 'none'), none);
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
    // Every id is bound in each statement over the set, so one call names at most 1,000.
    [Array.from({ length: 1001 }, (_, i) => `missing-${i}`), 'invalid_dependencies'],
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
  const requested = structuredClone(command);
  const replacement = (await scope.issueActor(caller, { name: 'Replacement', role: 'producer' }))
    .actor;
  const pendingCaller = { ...caller };
  const pending = handle.addDependencies(pendingCaller, command);
  pendingCaller.actorId = replacement.id;
  Object.assign(command, { instanceId: c.id, requestId: 'changed', expectedRevision: 99 });
  command.dependsOn[0] = a.id;
  const attached = await pending;
  Object.assign(command, requested);
  assert.equal(attached.revision, 1);
  assert.deepEqual(await handle.addDependencies(caller, command), attached);
  assert.equal(((await workflows.history(caller, a.id)).at(-1) as any).action, 'add_dependencies');
  assert.equal((await workflows.history(caller, a.id)).at(-1)!.actorId, caller.actorId);
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
  assert.deepEqual((await workflows.dependencies(caller, b.id)).dependencies, []);
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
  // An unmanaged graph's handle leaves authority to the engine, which asks for write.
  const loose = await workflows.register({ ...graph('loose'), managed: false }, policy());
  const g = await start(loose, caller, 'loose', 'g');
  await assert.rejects(
    async () =>
      await loose.addDependencies(reader, {
        instanceId: g.id,
        dependsOn: [d.id],
        expectedRevision: 0,
        requestId: 'reader-loose',
      }),
    { code: 'forbidden' },
  );
});

test('success declarations and edge contracts survive provider removal and database restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-work-deps-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let { state, scope, workflows, caller } = await setup(directory);
  let closed = false;
  t.after(async () => {
    if (!closed) await state.close();
  });
  // Each edge pins its target version's success declaration: the same finishing state settles
  // a prerequisite on version 1 and fails one on version 2, which declares a different success.
  const v1 = await workflows.register(graph(), policy());
  const v2 = await workflows.register(graph('preparation', 'done', 2), policy('failed'));
  const upstream = await start(v1, caller, 'preparation', 'upstream');
  const later = await start(v2, caller, 'preparation', 'later');
  const oldDependent = await start(v1, caller, 'preparation', 'old', [upstream.id]);
  const newDependent = await start(v2, caller, 'preparation', 'new', [later.id]);
  for (const [handle, target] of [
    [v1, upstream],
    [v2, later],
  ] as const)
    await handle.transition(caller, {
      instanceId: target.id,
      expectedRevision: 0,
      action: 'finish',
      requestId: `finish-${target.id}`,
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
  state = await openState(directory);
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

test('success states are pinned per version, their absence included, and absence reads as undeclared', async (t) => {
  const { state, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const targetProgram = await workflows.register(graph(), policy());
  const absentProgram = await workflows.register(graph('absent_success'), {
    ...policy(),
    successStates: undefined,
  });
  assert.deepEqual(
    await state.read(
      async (sql) =>
        await sql.all(
          'SELECT success_json FROM wf_success_states WHERE workflow=?',
          'absent_success',
        ),
    ),
    [{ success_json: 'null' }],
  );
  // Absence is as pinned as any declaration: neither direction may change it in place.
  absentProgram.dispose();
  await assert.rejects(async () => await workflows.register(graph('absent_success'), policy()), {
    code: 'workflow_version_conflict',
    status: 409,
  });
  const reinstalled = await workflows.register(graph('absent_success'), {
    ...policy(),
    successStates: undefined,
  });
  targetProgram.dispose();
  await assert.rejects(
    async () => await workflows.register(graph(), { ...policy(), successStates: undefined }),
    { code: 'workflow_version_conflict', status: 409 },
  );
  const reinstalledTarget = await workflows.register(graph(), policy());
  const absent = await start(reinstalled, caller, 'absent_success', 'absent');
  await assert.rejects(
    async () => await start(reinstalledTarget, caller, 'preparation', 'waiter', [absent.id]),
    { code: 'dependency_unsupported', status: 409 },
  );
  const target = await start(reinstalledTarget, caller, 'preparation', 'target');
  const source = await start(reinstalled, caller, 'absent_success', 'source', [target.id]);
  await reinstalled.transition(caller, {
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
  const relations = await state.transaction(
    async (tx) => await workflows.dependencyRelations(caller.projectId, source.id, tx),
  );
  assert.equal(relations?.instance.settled, false);
  assert.equal(relations?.dependencies[0].id, target.id);
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

test('an overview reads each fact once for every instance and runs each callback once per instance', async (t) => {
  const { state, workflows, caller } = await setup();
  t.after(async () => await state.close());
  let described = 0;
  const handle = await workflows.register(graph(), {
    ...policy(),
    describe: ({ snapshot }) => {
      described++;
      return { label: String(snapshot.data.title), references: [] };
    },
    limits: [{ name: 'finishes', from: 'working', actions: ['finish'], max: 3 }],
  });
  const upstream = await start(handle, caller, 'preparation', 'upstream');
  let made = 0;
  const add = async (count: number) => {
    for (let i = 0; i < count; i++)
      await start(handle, caller, 'preparation', `work-${made++}`, [upstream.id]);
  };
  await add(9);
  const done = await start(handle, caller, 'preparation', 'done');
  await handle.transition(caller, {
    instanceId: done.id,
    action: 'finish',
    expectedRevision: 0,
    requestId: 'finish-done',
  });
  await state.transaction(
    async (tx) =>
      await workflows.replaceBlockers(
        {
          projectId: caller.projectId,
          instanceId: upstream.id,
          provider: 'probe',
          blockers: [{ key: 'held', code: 'held', message: 'Held.', status: 409, next: 'Wait.' }],
        },
        tx,
      ),
  );
  const cost = async () => {
    described = 0;
    const read = await statements(state, async (tx) => await workflows.overview(caller, tx));
    return { statements: read.length, described };
  };
  const small = await cost();
  assert.equal(small.described, 11);
  await add(90);
  const large = await cost();
  assert.deepEqual(large, { statements: small.statements, described: 101 });
  // Read together, each instance is decided exactly as it is on its own.
  const overview = await workflows.overview(caller);
  assert.equal(overview.workflows.length, 101);
  for (const decided of overview.workflows)
    assert.deepEqual(decided, await workflows.evaluate(caller, decided.instanceId));
  const held = overview.workflows.find((item) => item.instanceId === upstream.id)!;
  assert.deepEqual([held.currentGate, held.limits[0]?.name], ['held', 'finishes']);
  assert.equal(overview.workflows.find((item) => item.instanceId === done.id)!.label, 'done');
});

test('a closure and its roots ask each version for its children at once, for no caller', async (t) => {
  const { state, scope, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const asked: string[][] = [];
  const fanOut = new Map<string, string[]>();
  const handle = await workflows.register(graph(), {
    ...policy(),
    children: (context) => {
      assert.deepEqual(Object.keys(context).sort(), ['instanceIds', 'projectId', 'tx']);
      asked.push([...context.instanceIds].sort());
      return Object.fromEntries(
        context.instanceIds.filter((id) => fanOut.has(id)).map((id) => [id, fanOut.get(id)!]),
      );
    },
  });
  const [first, second, third] = [
    await start(handle, caller, 'preparation', 'first'),
    await start(handle, caller, 'preparation', 'second'),
    await start(handle, caller, 'preparation', 'third'),
  ];
  const left = await start(handle, caller, 'preparation', 'left'),
    right = await start(handle, caller, 'preparation', 'right');
  const root = await start(handle, caller, 'preparation', 'root', [left.id, right.id]);
  fanOut.set(left.id, [first.id, second.id]);
  fanOut.set(right.id, [second.id, third.id, 'gone']);
  const serviceActor = t.mock.method(scope, 'serviceActor');

  assert.deepEqual(
    (await workflows.dependencyClosure(caller, root.id)).sort(),
    [root.id, left.id, right.id, first.id, second.id, third.id].sort(),
  );
  // One call per level of the walk, each with the whole level.
  assert.deepEqual(asked, [
    [root.id],
    [left.id, right.id].sort(),
    [first.id, second.id, third.id].sort(),
  ]);

  asked.length = 0;
  const roots = await state.transaction(
    async (tx) => await workflows.sponsoringRoots(caller.projectId, [second.id], tx),
  );
  assert.deepEqual(roots, [root.id]);
  assert.deepEqual(asked, [[first.id, second.id, third.id, left.id, right.id, root.id].sort()]);
  assert.equal(serviceActor.mock.callCount(), 0, 'no actor is minted to ask for children');
});

test('children is asked for at most 1,000 instances at once', async (t) => {
  const { state, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const sizes: number[] = [];
  await workflows.register(graph(), {
    ...policy(),
    children: ({ instanceIds }) => {
      sizes.push(instanceIds.length);
      return {};
    },
  });
  const at = new Date().toISOString();
  await state.transaction(
    async (tx) =>
      await tx.run(
        `INSERT INTO wf_instances (id, project_id, workflow, version, state, revision, data_json, created_at, updated_at)
         SELECT 'many-' || n, ?, 'preparation', 1, 'working', 0, '{}', ?, ? FROM generate_series(1, 2500) AS n`,
        caller.projectId,
        at,
        at,
      ),
  );
  const roots = await state.transaction(
    async (tx) => await workflows.sponsoringRoots(caller.projectId, ['many-1'], tx),
  );
  assert.deepEqual(roots, ['many-1']);
  assert.deepEqual(sizes, [1000, 1000, 500]);
});

test('a closure deeper than the bound is refused, not cut short', async (t) => {
  const { state, workflows, caller } = await setup();
  t.after(async () => await state.close());
  await workflows.register(graph(), policy());
  const at = new Date().toISOString();
  await state.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO wf_instances (id, project_id, workflow, version, state, revision, data_json, created_at, updated_at)
       SELECT 'link-' || n, ?, 'preparation', 1, 'working', 0, '{}', ?, ? FROM generate_series(1, 5200) AS n`,
      caller.projectId,
      at,
      at,
    );
    await tx.run(
      `INSERT INTO wf_dependencies (project_id, source_id, target_id, target_workflow, target_version, target_success_json, target_terminal_json, created_at, kind, owner)
       SELECT ?, 'link-' || n, 'link-' || (n + 1), 'preparation', 1, '["done"]', '["done","failed"]', ?, 'declared', '' FROM generate_series(1, 5199) AS n`,
      caller.projectId,
      at,
    );
  });
  await assert.rejects(async () => await workflows.dependencyClosure(caller, 'link-1'), {
    code: 'closure_too_large',
    status: 409,
  });
});

test('dependency reads and attaching cost the same however many edges there are', async (t) => {
  const { state, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const handle = await workflows.register(graph(), policy());
  const busy = await start(handle, caller, 'preparation', 'busy'),
    quiet = await start(handle, caller, 'preparation', 'quiet');
  for (let i = 0; i < 100; i++)
    await start(handle, caller, 'preparation', `waiter-${i}`, [busy.id]);
  assert.equal((await workflows.dependencies(caller, busy.id)).dependents.length, 100);
  // Guidance, the gate and a move read what an instance depends on, never what depends on it.
  const cost = async (id: string) =>
    (
      await statements(state, async (tx) => {
        await workflows.evaluate(caller, id, {}, tx);
        await workflows.checkDependencies(caller, id, tx);
        await handle.transition(
          caller,
          { instanceId: id, action: 'finish', expectedRevision: 0, requestId: `finish-${id}` },
          tx,
        );
      })
    ).length;
  assert.equal(await cost(busy.id), await cost(quiet.id));
  // Both directions come from the kept contracts, with no definition or success read.
  const read = await statements(
    state,
    async (tx) => await workflows.dependencies(caller, busy.id, tx),
  );
  assert.deepEqual(
    read.filter((sql) => /wf_definitions|wf_success_states/.test(sql)),
    [],
  );

  // A start names a fresh id, so nothing can lead back to it: no probe and no walk however
  // long the chain it joins (it was 317 statements for this one).
  const chain = [await start(handle, caller, 'preparation', 'link-0')];
  for (let i = 1; i < 20; i++)
    chain.push(await start(handle, caller, 'preparation', `link-${i}`, [chain[i - 1].id]));
  let tail!: Awaited<ReturnType<typeof start>>;
  const started = await statements(state, async (tx) => {
    tail = await handle.start(
      caller,
      {
        workflow: 'preparation',
        requestId: 'tail',
        dependsOn: chain.map((link) => link.id),
      },
      tx,
    );
  });
  assert.ok(started.length <= 12, `${started.length} statements to start on a 20-chain`);
  assert.deepEqual(
    (await workflows.dependencies(caller, tail.id)).dependencies.map((item) => item.id).sort(),
    chain.map((link) => link.id).sort(),
  );

  // Otherwise one recursive query finds a cycle of any length, after every target is known.
  const [a, b, c] = [chain[0], chain[1], chain[2]];
  await assert.rejects(
    async () =>
      await handle.addDependencies(caller, {
        instanceId: a.id,
        dependsOn: [quiet.id, c.id],
        expectedRevision: 0,
        requestId: 'three-cycle',
      }),
    { code: 'dependency_cycle' },
  );
  await assert.rejects(
    async () =>
      await handle.addDependencies(caller, {
        instanceId: a.id,
        dependsOn: [c.id, 'missing'],
        expectedRevision: 0,
        requestId: 'missing-first',
      }),
    { code: 'not_found' },
  );
  assert.deepEqual((await workflows.dependencies(caller, a.id)).dependencies, []);
  assert.deepEqual(
    (await workflows.dependencies(caller, b.id)).dependencies.map((item) => item.id),
    [a.id],
  );
  const linked = await handle.addDependencies(caller, {
    instanceId: a.id,
    dependsOn: [quiet.id],
    expectedRevision: 0,
    requestId: 'acyclic',
  });
  assert.equal(linked.revision, 1);
});
