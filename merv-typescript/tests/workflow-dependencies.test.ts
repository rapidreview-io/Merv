import { createService } from '@merv/contracts';
import { requireDependencies } from '@merv/workflows/rules';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  check,
  type Caller,
  type Transaction,
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
  await assert.rejects(
    async () =>
      requireDependencies(
        (await workflows.prerequisites(caller, [downstream.id])).get(downstream.id)!,
      ),
    {
      code: 'dependencies_pending',
    },
  );
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
  assert.equal(
    (await workflows.prerequisites(caller, [dependent.id])).get(dependent.id)![0].settled,
    true,
  );
  assert.equal(
    (await workflows.records(caller, [completed.id])).get(completed.id)!.dependents[0].id,
    dependent.id,
  );
  await prep.transition(caller, {
    instanceId: dependent.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'dependent-finish',
  });
  assert.equal(
    (await workflows.records(caller, [completed.id])).get(completed.id)!.dependents[0].settled,
    true,
  );
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
  assert.equal(
    (await workflows.prerequisites(caller, [downstream.id])).get(downstream.id)!.length,
    1,
  );
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
  const otherIdentity = await scope.credentials.bootstrap({
    projectName: 'Private',
    actorName: 'Other',
  });
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
  assert.deepEqual((await workflows.prerequisites(other, [downstream.id])).get(downstream.id), []);
  assert.equal((await workflows.records(other, [downstream.id])).size, 0);
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
    (await workflows.prerequisites(caller, [oldDependent.id])).get(oldDependent.id)![0].settled,
    true,
  );
  assert.equal(
    (await workflows.prerequisites(caller, [newDependent.id])).get(newDependent.id)![0].failed,
    true,
  );
  v1.dispose();
  v2.dispose();
  assert.equal(
    (await workflows.prerequisites(caller, [oldDependent.id])).get(oldDependent.id)![0].settled,
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
    (await workflows.prerequisites(caller, [oldDependent.id])).get(oldDependent.id)![0].settled,
    true,
  );
  await assert.rejects(
    async () =>
      requireDependencies(
        (await workflows.prerequisites(caller, [newDependent.id])).get(newDependent.id)!,
      ),
    {
      code: 'dependency_failed',
    },
  );
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
  // The move is judged by the success states as registered, not as the caller changed them.
  const finished = (await state.events(caller.projectId)).find(
    (event) => event.subjectId === upstream.id && event.data.action === 'finish',
  );
  assert.equal(finished?.data.settled, true);
  const downstream = await start(handle, caller, 'preparation', 'downstream', [upstream.id]);
  assert.equal(
    (await workflows.prerequisites(caller, [downstream.id])).get(downstream.id)![0].settled,
    true,
  );
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

test('replanning removes declared edges in one bounded write, preserving ownership, order and replay', async (t) => {
  const { state, scope, workflows, caller } = await setup();
  t.after(async () => await state.close());
  const handle = await workflows.register(graph(), policy());
  const targets: string[] = [];
  for (let i = 0; i < 20; i++)
    targets.push((await start(handle, caller, 'preparation', `target-${i}`)).id);
  const source = await start(handle, caller, 'preparation', 'source', targets);
  const neighbor = await start(handle, caller, 'preparation', 'neighbor', targets);
  await state.transaction((tx) =>
    workflows
      .systemPrerequisites('provider')
      .replace(
        { projectId: caller.projectId, instanceId: source.id, dependencies: targets.slice(0, 2) },
        tx,
      ),
  );
  const identity = await scope.credentials.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const other = { actorId: identity.actor.id, projectId: identity.project.id };
  const foreignTarget = await start(handle, other, 'preparation', 'foreign-target');
  const foreignSource = await start(handle, other, 'preparation', 'foreign-source', [
    foreignTarget.id,
  ]);
  // The upper bound includes unknown and another project's IDs. They remove nothing here.
  const drop = [
    ...targets.toReversed(),
    foreignTarget.id,
    ...Array.from({ length: 979 }, (_, i) => `missing-${i}`),
  ];
  const input = {
    instanceId: source.id,
    expectedRevision: 0,
    requestId: 'replan-many',
    dependsOn: [],
    drop,
  };
  await assert.rejects(
    state.transaction(async (tx) => {
      await handle.addDependencies(caller, input, tx);
      throw new Error('rollback replan');
    }),
    /rollback replan/,
  );
  assert.equal((await workflows.get(caller, source.id)).revision, 0);
  assert.equal((await workflows.prerequisites(caller, [source.id])).get(source.id)!.length, 22);
  const writes = await statements(state, (tx) => handle.addDependencies(caller, input, tx));
  assert.equal(writes.filter((sql) => sql.startsWith('DELETE FROM wf_dependencies')).length, 1);
  const moves = await history(state, source.id);
  assert.equal(moves.at(-1)?.action, 'replan_dependencies');
  assert.deepEqual(moves.at(-1)?.data, { dependsOn: [], dropped: targets.toReversed() });
  const remaining = (await workflows.prerequisites(caller, [source.id])).get(source.id)!;
  assert.deepEqual(remaining.map(({ id }) => id).sort(), targets.slice(0, 2).sort());
  assert.ok(remaining.every(({ kind, owner }) => kind === 'system' && owner === 'provider'));
  assert.equal((await workflows.prerequisites(caller, [neighbor.id])).get(neighbor.id)!.length, 20);
  assert.deepEqual(
    (await workflows.prerequisites(other, [foreignSource.id]))
      .get(foreignSource.id)!
      .map(({ id }) => id),
    [foreignTarget.id],
  );
  const after = await workflows.get(caller, source.id);
  assert.equal(after.revision, 1);
  assert.deepEqual(
    await handle.addDependencies(caller, { ...input, drop: drop.toReversed() }),
    after,
    'replay keeps the original receipt even when requested in another order',
  );
  assert.deepEqual(
    await handle.addDependencies(caller, { ...input, expectedRevision: 1, requestId: 'no-op' }),
    after,
    'already removed edges neither advance revision nor erase system ownership',
  );
  assert.deepEqual(await history(state, source.id), moves);
  await assert.rejects(
    handle.addDependencies(caller, {
      ...input,
      expectedRevision: 1,
      requestId: 'too-many',
      drop: [...drop, 'one-too-many'],
    }),
    { code: 'invalid_dependencies' },
  );
});
