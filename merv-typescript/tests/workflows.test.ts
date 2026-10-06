import { createService } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { PostgresState, statePlugin } from '@merv/state';
import { ProjectScope, scopePlugin } from '@merv/scope';
import { WorkflowsService, workflowsPlugin } from '@merv/workflows';
import type {
  Caller,
  Data,
  Transaction,
  WorkflowDefinition,
  WorkflowPolicy,
} from '@merv/contracts';
import { openState, stateConfig } from './fixtures/state.js';

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
  const credentials = await scope.bootstrap({
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

test('durable graph transitions record exact command responses, history, and events once', async (t) => {
  const { state, scope, workflows, approval, caller } = await setup();
  t.after(async () => await state.close());
  const replacement = (await scope.issueActor(caller, { name: 'Replacement', role: 'producer' }))
    .actor;
  const pendingCaller = { ...caller };
  const start = { workflow: 'approval', requestId: 'start-1', data: { title: 'A', untouched: 1 } };
  const requestedStart = structuredClone(start);
  const starting = approval.start(pendingCaller, start);
  pendingCaller.actorId = replacement.id;
  Object.assign(start, { workflow: 'changed', requestId: 'changed' });
  start.data.title = 'Changed';
  const initial = await starting;
  Object.assign(start, requestedStart);
  assert.equal(initial.revision, 0);
  const command = {
    instanceId: initial.id,
    expectedRevision: 0,
    action: 'submit',
    requestId: 'submit-1',
    data: { submitted: true },
  };
  const requestedTransition = structuredClone(command);
  Object.assign(pendingCaller, caller);
  const transitioning = approval.transition(pendingCaller, command);
  pendingCaller.actorId = replacement.id;
  Object.assign(command, { action: 'changed', requestId: 'changed', expectedRevision: 99 });
  command.data.submitted = false;
  const submitted = await transitioning;
  Object.assign(command, requestedTransition);
  assert.equal(submitted.state, 'review');
  assert.deepEqual(submitted.data, { title: 'A', untouched: 1, submitted: true });
  const finished = await approval.transition(caller, {
    instanceId: initial.id,
    expectedRevision: 1,
    action: 'accept',
    requestId: 'accept-1',
  });
  assert.equal(finished.state, 'done');
  assert.deepEqual(await approval.start(caller, start), initial);
  assert.deepEqual(await approval.transition(caller, command), submitted);
  assert.equal((await workflows.get(caller, initial.id)).revision, 2);
  assert.equal((await workflows.history(caller, initial.id)).length, 3);
  assert.deepEqual(
    (await workflows.history(caller, initial.id)).map((entry) => entry.actorId),
    [caller.actorId, caller.actorId, caller.actorId],
  );
  assert.equal(
    (await state.events(caller.projectId)).filter((event) => event.type === 'workflow.transition')
      .length,
    3,
  );
  await assert.rejects(
    async () =>
      await approval.transition(caller, { ...command, requestId: 'new', expectedRevision: 2 }),
    code('invalid_transition'),
  );
  await assert.rejects(
    async () => await approval.transition(caller, { ...command, data: { changed: true } }),
    code('request_conflict'),
  );
  await assert.rejects(
    async () => await approval.start(caller, { ...start, data: { title: 'Different' } }),
    code('request_conflict'),
  );
  await assert.rejects(
    async () => await approval.transition(caller, { ...command, requestId: 'start-1' }),
    code('request_conflict'),
  );
});

test('versions are pinned and changed declarations are rejected across restart', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'merv-workflow-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = folder;
  const first = await setup(path);
  const initial = await first.approval.start(first.caller, {
    workflow: 'approval',
    requestId: 'start',
  });
  const secondGraph = graph(2);
  secondGraph.edges[0].action = 'send';
  const second = await first.workflows.register(secondGraph);
  assert.equal(
    (await second.start(first.caller, { workflow: 'approval', requestId: 'start-v2' })).version,
    2,
  );
  await first.state.close();

  const state = await openState(path);
  t.after(async () => await state.close());
  const workflows = await createService(
    new WorkflowsService(state, await createService(new ProjectScope(state))),
  );
  const changed = graph();
  changed.edges[0].action = 'send';
  await assert.rejects(
    async () => await workflows.register(changed),
    code('workflow_version_conflict'),
  );
  const approval = await workflows.register(graph());
  await workflows.register(secondGraph);
  assert.equal(
    (
      await approval.transition(first.caller, {
        instanceId: initial.id,
        action: 'submit',
        expectedRevision: 0,
        requestId: 'after-restart',
      })
    ).version,
    1,
  );
  assert.deepEqual(
    await approval.start(first.caller, { workflow: 'approval', requestId: 'start' }),
    initial,
  );
  assert.equal((await workflows.history(first.caller, initial.id)).length, 2);
});

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
  assert.equal((await workflows.history(caller, initial.id)).length, 2);
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
  const foreign = await scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const other: Caller = { actorId: foreign.actor.id, projectId: foreign.project.id };
  for (const method of [
    'get',
    'history',
    'evaluate',
    'workStarts',
    'process',
    'list',
    'overview',
  ] as const) {
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
  await assert.rejects(async () => await workflows.history(other, initial.id), code('not_found'));
  assert.equal((await workflows.list(other)).length, 0);
  await assert.rejects(
    async () => await workflows.get({ ...other, projectId: caller.projectId }, initial.id),
    code('forbidden'),
  );
  const reader = (await scope.issueActor(caller, { name: 'Reader', role: 'reader' })).actor;
  const readerCaller = { actorId: reader.id, projectId: caller.projectId };
  assert.equal((await workflows.get(readerCaller, initial.id)).id, initial.id);
  const producer = (await scope.issueActor(caller, { name: 'Producer', role: 'producer' })).actor;
  await assert.rejects(
    async () =>
      await approval.start(
        { actorId: producer.id, projectId: caller.projectId },
        { workflow: 'approval', requestId: 'start' },
      ),
    code('request_conflict'),
  );
  await scope.revokeActor(caller, producer.id);
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

test('a program handle changes only its own version and disposal preserves durable data', async (t) => {
  const { state, scope, workflows, approval, caller } = await setup();
  t.after(async () => await state.close());
  const definition = { ...graph(), name: 'owned' };
  const program = await workflows.register(definition);
  const initial = await program.start(caller, { workflow: 'owned', requestId: 'owned-start' });
  for (const other of [
    { workflow: 'approval' },
    { workflow: 'owned', version: 2 },
    { workflow: undefined as unknown as string },
  ])
    await assert.rejects(
      async () => await program.start(caller, { ...other, requestId: 'other-start' }),
      { code: 'workflow_handle_mismatch', status: 403 },
    );
  const unowned = await approval.start(caller, { workflow: 'approval', requestId: 'other-start' });
  for (const [handle, instanceId] of [
    [program, unowned.id],
    [approval, initial.id],
  ] as const)
    await assert.rejects(
      async () =>
        await handle.transition(caller, {
          instanceId,
          action: 'submit',
          expectedRevision: 0,
          requestId: 'other-transition',
        }),
      { code: 'workflow_handle_mismatch', status: 403 },
    );
  await program.transition(caller, {
    instanceId: initial.id,
    action: 'submit',
    expectedRevision: 0,
    requestId: 'owned-submit',
  });
  const reviewer = (await scope.issueActor(caller, { name: 'Reviewer', role: 'reviewer' })).actor;
  // A program authorizes its own actions: the engine asks only that the caller may read.
  const reviewerCaller = { actorId: reviewer.id, projectId: caller.projectId };
  await scope.require(reviewerCaller, 'review');
  const accepted = await program.transition(reviewerCaller, {
    instanceId: initial.id,
    action: 'accept',
    expectedRevision: 1,
    requestId: 'owned-accept',
  });
  assert.equal(accepted.revision, 2);
  program.dispose();
  program.dispose();
  assert.equal((await workflows.get(caller, initial.id)).state, 'done');
  await assert.rejects(
    async () => await program.start(caller, { workflow: 'owned', requestId: 'disposed' }),
    code('workflow_unavailable'),
  );
  const replacement = await workflows.register(definition);
  assert.deepEqual(
    await replacement.start(caller, { workflow: 'owned', requestId: 'owned-start' }),
    initial,
  );
  program.dispose(); // An old disposer cannot remove the replacement.
  assert.ok(workflows.catalog().some((item) => item.name === 'owned'));
  // Every graph is managed, and says so in its stored form.
  assert.ok(workflows.catalog().every((item) => item.managed === true));
  await assert.rejects(
    async () =>
      await workflows.register({ ...graph(), name: 'loose', managed: false as unknown as true }),
    { code: 'invalid_workflow_policy', status: 400 },
  );
});

test('graph validation and defensive copies prevent changing installed behavior', async (t) => {
  const { state, workflows, approval, caller } = await setup();
  t.after(async () => await state.close());
  const mutable = { ...graph(), name: 'mutable' };
  const handle = await workflows.register(mutable);
  mutable.edges[0].action = 'sneaky';
  workflows.catalog().find((item) => item.name === 'mutable')!.edges[0].action = 'another';
  const initial = await handle.start(caller, { workflow: 'mutable', requestId: 'start' });
  assert.equal(
    (
      await handle.transition(caller, {
        instanceId: initial.id,
        action: 'submit',
        expectedRevision: 0,
        requestId: 'submit',
      })
    ).state,
    'review',
  );
  await assert.rejects(
    async () => await workflows.register({ ...graph(), name: 'invalid', terminal: ['missing'] }),
    /terminal states/,
  );
  await assert.rejects(
    async () =>
      await workflows.register({
        ...graph(),
        name: 'invalid',
        states: [...graph().states, 'unreachable'],
      }),
    /reachable/,
  );
  await assert.rejects(
    async () => await approval.start(caller, { workflow: 'approval', requestId: '', data: {} }),
    code('invalid_request'),
  );
  let callbacks = 0;
  const unexpected = () => {
    callbacks++;
    return [];
  };
  const before = await state.eventHead();
  for (const data of [
    Object.defineProperty({}, 'value', { enumerable: true, get: unexpected }),
    { value: NaN },
    new Proxy({}, { ownKeys: unexpected }),
    { value: Object.setPrototypeOf([1], { map: unexpected }) },
  ]) {
    await assert.rejects(
      async () =>
        await approval.start(caller, { workflow: 'approval', requestId: 'invalid-data', data }),
      { code: 'invalid_data', status: 400 },
    );
    assert.equal(callbacks, 0);
  }
  assert.equal(await state.eventHead(), before);
});

test('one data cap bounds start data, transition data and input, and preflight input', async (t) => {
  const { state, workflows, approval, caller } = await setup();
  t.after(async () => await state.close());
  const large = { text: 'x'.repeat(300_000) };
  let deep: Data = { leaf: true };
  for (let level = 0; level < 40; level++) deep = { next: deep };
  const half = 'x'.repeat(200_000);
  const initial = await approval.start(caller, {
    workflow: 'approval',
    requestId: 'start',
    data: { first: half },
  });
  const before = await state.eventHead();
  for (const data of [large, deep]) {
    await assert.rejects(
      async () => await approval.start(caller, { workflow: 'approval', requestId: 'big', data }),
      { code: 'invalid_data', status: 400 },
    );
    const command = {
      instanceId: initial.id,
      action: 'submit',
      expectedRevision: 0,
      requestId: 'big',
    };
    await assert.rejects(async () => await approval.transition(caller, { ...command, data }), {
      code: 'invalid_data',
      status: 400,
    });
    await assert.rejects(
      async () => await approval.transition(caller, { ...command, input: data }),
      { code: 'invalid_data', status: 400 },
    );
    // A preview and the transition it previews are held to the same cap.
    await assert.rejects(
      async () => await workflows.evaluate(caller, initial.id, { action: 'submit', input: data }),
      { code: 'invalid_data', status: 400 },
    );
  }
  assert.equal(await state.eventHead(), before);
  // Only what a caller sends is capped: the merged record may grow past it, and an instance
  // above the cap still moves with a small delta.
  const submitted = await approval.transition(caller, {
    instanceId: initial.id,
    action: 'submit',
    expectedRevision: 0,
    requestId: 'submit',
    data: { second: half },
  });
  const revised = await approval.transition(caller, {
    instanceId: initial.id,
    action: 'revise',
    expectedRevision: submitted.revision,
    requestId: 'revise',
    data: { note: 'small' },
  });
  assert.deepEqual(revised.data, { first: half, second: half, note: 'small' });
});

test('a version pauses starts while an instance is in one of its nonterminal states', async (t) => {
  const { state, workflows, approval, caller } = await setup();
  t.after(async () => await state.close());
  const pausing = (name: string, states: string[], terminal: string[]): WorkflowDefinition => ({
    name,
    version: 1,
    initial: states[0],
    states,
    terminal,
    edges: [],
    blocksStarts: ['approval'],
  });
  // With no nonterminal state an instance is over as it starts, so it pauses nothing.
  const instant = await workflows.register(pausing('instant', ['over'], ['over']));
  await instant.start(caller, { workflow: 'instant', requestId: 'instant' });
  await approval.start(caller, { workflow: 'approval', requestId: 'after-instant' });
  // With no terminal state every instance stays open, so one pauses starts for good.
  const standing = await workflows.register(pausing('standing', ['on'], []));
  await standing.start(caller, { workflow: 'standing', requestId: 'standing' });
  await assert.rejects(
    async () => await approval.start(caller, { workflow: 'approval', requestId: 'paused' }),
    code('workflow_creation_paused'),
  );
  // Only the workflows it names are paused, and a retry of a committed start still replays.
  await instant.start(caller, { workflow: 'instant', requestId: 'unnamed' });
  await approval.start(caller, { workflow: 'approval', requestId: 'after-instant' });
});

test('pinned contracts are kept in memory, immutable in storage, and found when another service adds one', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'merv-workflow-pinned-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { state, workflows, approval, caller } = await setup(folder);
  t.after(async () => await state.close());
  /** How many statements `run` sends to wf_definitions through the transaction it is given. */
  const definitionReads = async (run: (tx: Transaction) => Promise<unknown>) => {
    let reads = 0;
    await state.transaction(async (tx) => {
      const spied = tx as unknown as Record<'get' | 'all' | 'run', (...args: unknown[]) => unknown>;
      for (const method of ['get', 'all', 'run'] as const) {
        const original = spied[method].bind(tx);
        spied[method] = (sql, ...args) => {
          if (String(sql).includes('wf_definitions')) reads++;
          return original(sql, ...args);
        };
      }
      await run(tx);
    });
    return reads;
  };
  const initial = await approval.start(caller, { workflow: 'approval', requestId: 'start' });
  assert.equal(
    await definitionReads(async (tx) => {
      await workflows.evaluate(caller, initial.id, {}, tx);
      await approval.transition(
        caller,
        { instanceId: initial.id, action: 'submit', expectedRevision: 0, requestId: 'submit' },
        tx,
      );
    }),
    0,
  );

  // Registered by another service after this one loaded what was stored: the first read finds
  // it, and later reads keep it.
  const otherState = await openState(folder);
  t.after(async () => await otherState.close());
  const other = await createService(
    new WorkflowsService(otherState, await createService(new ProjectScope(otherState))),
  );
  const program = await other.register(graph(2));
  const late = await program.start(caller, { workflow: 'approval', requestId: 'late' });
  assert.equal(
    await definitionReads(async (tx) => {
      const decision = await workflows.evaluate(caller, late.id, {}, tx);
      assert.equal(decision.version, 2);
      assert.equal(decision.available, false);
    }),
    1,
  );
  assert.equal(
    await definitionReads(async (tx) => await workflows.evaluate(caller, late.id, {}, tx)),
    0,
  );
  await assert.rejects(
    async () =>
      await approval.transition(caller, {
        instanceId: late.id,
        action: 'submit',
        expectedRevision: 0,
        requestId: 'bypass',
      }),
    code('workflow_handle_mismatch'),
  );

  // A version no instance uses, so only the guard can refuse its removal.
  await workflows.register(graph(3));
  for (const sql of [
    'UPDATE wf_definitions SET created_at = created_at',
    "DELETE FROM wf_definitions WHERE name = 'approval' AND version = 3",
    'UPDATE wf_success_states SET success_json = success_json',
    "DELETE FROM wf_success_states WHERE workflow = 'approval' AND version = 3",
  ])
    await assert.rejects(
      async () => await state.transaction(async (tx) => await tx.run(sql)),
      { code: 'state_constraint' },
      sql,
    );
});

test('a stored definition keeps only edge endpoints in code-unit order and refuses engine actions', async (t) => {
  const { state, workflows, approval, caller } = await setup();
  t.after(async () => await state.close());
  // A function, BigInt or Date on an edge would otherwise reach definition_json, where it is
  // unencodable, or encodes as something no reader can parse back.
  const extras = { note: () => 'extra', size: 1n, at: new Date(0) };
  const edge = (from: string, action: string, to: string) =>
    ({ from, action, to, ...extras }) as WorkflowDefinition['edges'][number];
  // Code-unit order differs from every locale's collation here: 'B' < 'aa' < 'z', where most
  // locales put 'aa' first and Danish puts it after 'z'.
  const handle = await workflows.register({
    name: 'ordered',
    version: 1,
    initial: 'z',
    states: ['z', 'aa', 'B', 'done'],
    terminal: ['done'],
    edges: [edge('z', 'next', 'aa'), edge('aa', 'next', 'B'), edge('B', 'next', 'done')],
  });
  const stored = await state.read(
    async (sql) =>
      await sql.get<{ definition_json: string }>(
        "SELECT definition_json FROM wf_definitions WHERE name = 'ordered'",
      ),
  );
  assert.deepEqual(JSON.parse(stored!.definition_json).edges, [
    { from: 'B', action: 'next', to: 'done' },
    { from: 'aa', action: 'next', to: 'B' },
    { from: 'z', action: 'next', to: 'aa' },
  ]);
  assert.deepEqual(
    workflows.catalog().find((item) => item.name === 'ordered')!.edges,
    JSON.parse(stored!.definition_json).edges.map((edge: object) => ({ ...edge, tool: null })),
  );
  const ordered = await handle.start(caller, { workflow: 'ordered', requestId: 'ordered' });
  assert.equal(
    (
      await handle.transition(caller, {
        instanceId: ordered.id,
        action: 'next',
        expectedRevision: 0,
        requestId: 'next',
      })
    ).state,
    'aa',
  );
  assert.equal(
    (await approval.start(caller, { workflow: 'approval', requestId: 'other' })).state,
    'draft',
  );
  for (const action of ['start', 'add_dependencies', 'replan_dependencies'])
    await assert.rejects(
      async () =>
        await workflows.register({
          ...graph(),
          name: `reserved-${action}`,
          edges: [...graph().edges, { from: 'review', action, to: 'draft' }],
        }),
      {
        code: 'invalid_workflow_policy',
        status: 400,
        message: `${action} is reserved by the engine`,
      },
    );
  const chain = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`);
  await assert.rejects(
    async () =>
      await workflows.register({
        name: 'wide',
        version: 1,
        initial: 's0',
        states: chain(257),
        terminal: [],
        edges: chain(256).map((from, i) => ({ from, action: 'next', to: `s${i + 1}` })),
      }),
    { code: 'invalid_workflow_policy', status: 400, message: 'Workflow graph too large' },
  );
  await assert.rejects(
    async () =>
      await workflows.register({
        name: 'dense',
        version: 1,
        initial: 's0',
        states: chain(2),
        terminal: [],
        edges: Array.from({ length: 2049 }, (_, i) => ({ from: 's0', action: `a${i}`, to: 's1' })),
      }),
    { code: 'invalid_workflow_policy', status: 400, message: 'Workflow graph too large' },
  );
  // At the bounds a graph registers.
  await workflows.register({
    name: 'bounded',
    version: 1,
    initial: 's0',
    states: chain(256),
    terminal: [],
    edges: [
      ...chain(255).map((from, i) => ({ from, action: 'next', to: `s${i + 1}` })),
      ...Array.from({ length: 1793 }, (_, i) => ({ from: 's0', action: `a${i}`, to: 's1' })),
    ],
  });
});

test('real Cordis dependency activation and disposal preserve database state', async (t) => {
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
  });
  const workflowFiber = await ctx.plugin(workflowsPlugin);
  assert.equal(ctx.get('workflows'), undefined);
  const stateFiber = ctx.plugin(statePlugin, stateConfig(':memory:'));
  await stateFiber.await();
  const scopeFiber = ctx.plugin(scopePlugin);
  await scopeFiber.await();
  await workflowFiber.await();
  assert.ok(ctx.workflows);
  const scope = ctx.scope;
  const credential = await scope.bootstrap({ projectName: 'Cordis', actorName: 'Operator' });
  const caller = { actorId: credential.actor.id, projectId: credential.project.id };
  const service = ctx.workflows;
  const approval = await service.register(graph());
  const initial = await approval.start(caller, { workflow: 'approval', requestId: 'cordis' });
  await scopeFiber.dispose();
  assert.equal(ctx.get('workflows'), undefined);
  await assert.rejects(
    async () => await service.get(caller, initial.id),
    code('workflow_unavailable'),
  );
  await ctx.plugin(scopePlugin).await();
  await workflowFiber.await();
  await ctx.workflows.register(graph());
  assert.deepEqual(await ctx.workflows.get(caller, initial.id), initial);
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
  assert.equal((await workflows.history(caller, instance.id)).length, 2);
  assert.deepEqual(
    await program.transition(caller, command),
    await workflows.get(caller, instance.id),
  );
});

test('an awaited assignment provider cannot survive its own withdrawal', async (t) => {
  const { state, workflows, caller } = await callbackFixture(t);
  const gate = barrier();
  const definition: WorkflowDefinition = {
    name: 'awaited_assignment',
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
        instruction: 'Finish.',
        check: async () => {},
      },
    ],
    assignments: [
      {
        state: 'work',
        check: async () => {},
        async build({ snapshot, tx }) {
          await gate.wait();
          assert.ok(await tx.get('SELECT id FROM wf_instances WHERE id=?', snapshot.id));
          return {
            role: 'producer',
            label: 'Work',
            brief: 'Work.',
            references: [],
            handoff: { instruction: 'Finish.', tools: [] },
            execution: { readOnly: false, tools: [] },
            context: null,
          };
        },
        execution: {
          readOnly: false,
          tools: [
            {
              name: 'artifact.read',
              alternatives: [{ artifactId: { kind: 'oneOf', name: 'artifacts' } }],
            },
          ],
        },
        references: async ({ tx, snapshot }) => {
          assert.ok(await tx.get('SELECT id FROM wf_instances WHERE id=?', snapshot.id));
          return { artifacts: ['own-output'] };
        },
      },
    ],
  };
  const first = await workflows.register(definition, policy);
  const instance = await first.start(caller, {
    workflow: definition.name,
    requestId: 'assignment-start',
  });
  const pending = workflows.begin(caller, { instanceId: instance.id, expectedRevision: 0 });
  await gate.entered;
  first.dispose();
  gate.release();
  await assert.rejects(pending, { code: 'workflow_unavailable' });
  assert.deepEqual(await workflows.workStarts(caller, instance.id), []);
  await workflows.register(definition, policy);
  assert.equal(
    (await workflows.begin(caller, { instanceId: instance.id, expectedRevision: 0 })).workStart
      ?.revision,
    0,
  );
});
