import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import {
  check,
  digest,
  type Caller,
  type WorkflowAssignmentContent,
  type WorkflowCheckContext,
  type WorkflowDefinition,
  type WorkflowPolicy,
} from '@merv/contracts';
import { openState, schemaFor } from './fixtures/state.js';
import { raceWriters } from './fixtures/writer-race.js';
import type { PostgresState } from '@merv/state';

const graph: WorkflowDefinition = {
  name: 'assignment_test',
  version: 1,
  initial: 'work',
  states: ['work', 'done'],
  terminal: ['done'],
  edges: [
    { from: 'work', action: 'restart', to: 'work' },
    { from: 'work', action: 'finish', to: 'done' },
  ],
};

async function setup(path = ':memory:') {
  const state = await openState(path);
  const scope = await createService(new ProjectScope(state));
  const credentials = await scope.bootstrap({ projectName: 'Assignments', actorName: 'Operator' });
  const caller = { projectId: credentials.project.id, actorId: credentials.actor.id };
  const workflows = await createService(new WorkflowsService(state, scope));
  let builds = 0;
  let admitted = true;
  let label = 'Initial assignment';
  let failBuild = false;
  const build = async (context: WorkflowCheckContext): Promise<WorkflowAssignmentContent> => {
    builds++;
    check(!failBuild, 'context_failed', 'Cannot render this context', 409);
    const next = (await workflows.evaluate(context.caller, context.snapshot.id, {}, context.tx))
      .nextAction;
    const body = {
      projectId: context.caller.projectId,
      actorId: context.caller.actorId,
      type: 'test.work',
      typeVersion: 1,
      recipeHash: 'a'.repeat(64),
      subject: { id: context.snapshot.id, revision: context.snapshot.revision },
      prompt: `Assignment ${label}; next ${next?.tool ?? 'none'}.`,
      sources: [],
      omitted: [],
    };
    return {
      role: 'worker',
      label,
      brief: 'Complete the calibration and submit a measured result.',
      references: [{ kind: 'workflow', id: context.snapshot.id, label: 'Calibration' }],
      handoff: { instruction: 'Submit the measured result.', tools: ['test.finish'] },
      execution: { readOnly: false, tools: [{ name: 'test.measure', arguments: { samples: 2 } }] },
      context: { ...body, hash: digest(body) },
    };
  };
  const policy: WorkflowPolicy = {
    actions: [
      {
        name: 'finish',
        states: ['work'],
        transitions: ['finish'],
        tool: 'test.finish',
        instruction: 'Submit the measured result.',
        requiredInput: ['result'],
        check: async ({ caller: actor, tx }) => {
          await scope.require(actor, 'write', tx);
        },
      },
      {
        name: 'restart',
        states: ['work'],
        transitions: ['restart'],
        suggested: false,
        tool: 'test.restart',
        instruction: 'Start a new revision.',
        check: async ({ caller: actor, tx }) => {
          await scope.require(actor, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'work',
        check: async (context) => {
          await scope.require(context.caller, 'write', context.tx);
          check(admitted, 'assignment_denied', 'This actor cannot begin this step.', 403);
          assert.ok(Object.isFrozen(context));
          assert.ok(Object.isFrozen(context.caller));
          assert.ok(Object.isFrozen(context.snapshot.data));
        },
        build,
      },
    ],
  };
  const registration = await workflows.register(graph, policy);
  const instance = await workflows.start(caller, { workflow: graph.name, requestId: 'create' });
  return {
    state,
    scope,
    caller,
    workflows,
    registration,
    policy,
    instance,
    builds: () => builds,
    admit: (value: boolean) => {
      admitted = value;
    },
    label: (value: string) => {
      label = value;
    },
    failBuild: (value: boolean) => {
      failBuild = value;
    },
  };
}

test('assignment reads are pure; begin records first activation before rendering current guidance', async (t) => {
  const f = await setup();
  t.after(async () => await f.state.close());
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const foreign = { projectId: other.project.id, actorId: other.actor.id };
  const caller = { ...f.caller };
  const head = await f.state.eventHead();
  const before = await f.workflows.get(f.caller, f.instance.id);
  const guidance = await f.workflows.evaluate(f.caller, f.instance.id);
  assert.equal(f.builds(), 0, 'Guidance must never build context');
  assert.equal(guidance.nextAction?.tool, 'workflow.begin');
  assert.equal(guidance.workStart, null);
  assert.equal(guidance.actions.find((action) => action.action === 'begin')?.status, 'ready');
  const preflight = await f.workflows.evaluate(f.caller, f.instance.id, {
    action: 'begin',
    input: { expectedRevision: 0 },
  });
  assert.equal(preflight.nextAction?.tool, 'workflow.begin');
  assert.equal(f.builds(), 0);
  const completion = await f.workflows.evaluate(f.caller, f.instance.id, { action: 'finish' });
  assert.equal(completion.nextAction?.tool, 'test.finish');
  assert.equal(completion.nextAction?.status, 'needs_input');
  const previewing = f.workflows.assignment(caller, f.instance.id);
  Object.assign(caller, foreign);
  const preview = await previewing;
  assert.equal(preview.actorId, f.caller.actorId);
  assert.match(preview.context!.prompt, /workflow.begin/);
  assert.equal(preview.workStart, null);
  assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), []);
  assert.equal(await f.state.eventHead(), head);
  assert.deepEqual(await f.workflows.get(f.caller, f.instance.id), before);
  Object.assign(caller, f.caller);
  const beginning = f.workflows.begin(caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  Object.assign(caller, foreign);
  const begun = await beginning;
  assert.equal(begun.workStart?.actorId, f.caller.actorId);
  assert.equal(begun.workStart?.revision, 0);
  assert.match(begun.context!.prompt, /test.finish/);
  assert.doesNotMatch(begun.context!.prompt, /workflow.begin/);
  assert.equal((await f.workflows.history(f.caller, f.instance.id)).length, 1);
  assert.deepEqual(await f.workflows.get(f.caller, f.instance.id), before);
  const events = await f.state.events(f.caller.projectId, head);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'workflow.work_started');
  assert.equal(events[0].id, begun.workStart?.eventId);
  assert.equal(events[0].createdAt, begun.workStart?.startedAt);
  f.label('Updated assignment');
  const repeated = await f.workflows.begin(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  assert.equal(repeated.label, 'Updated assignment');
  assert.deepEqual(repeated.workStart, begun.workStart);
  assert.equal((await f.state.events(f.caller.projectId, head)).length, 1);
  repeated.references[0].label = 'Modified by consumer';
  repeated.execution.tools[0].arguments.samples = 100;
  repeated.workStart!.actorId = 'forged';
  repeated.context!.subject.revision = 100;
  const fresh = await f.workflows.assignment(f.caller, f.instance.id);
  assert.equal(fresh.references[0].label, 'Calibration');
  assert.equal(fresh.execution.tools[0].arguments.samples, 2);
  assert.equal(fresh.workStart?.actorId, f.caller.actorId);
  assert.equal(fresh.context?.subject.revision, 0);
});

test('every assignment and begin rechecks admission, tenant identity and current revision', async (t) => {
  const f = await setup();
  t.after(async () => await f.state.close());
  const input = { instanceId: f.instance.id, expectedRevision: 0 };
  const first = await f.workflows.begin(f.caller, input);
  const actor = (await f.scope.issueActor(f.caller, { name: 'Replacement', role: 'producer' }))
    .actor;
  const replacement: Caller = { projectId: actor.projectId, actorId: actor.id };
  const later = await f.workflows.begin(replacement, input);
  assert.equal(later.actorId, actor.id);
  assert.equal(later.context?.actorId, actor.id);
  assert.deepEqual(later.workStart, first.workStart, 'First activation is not current ownership');
  f.admit(false);
  for (const action of [
    async () => await f.workflows.assignment(f.caller, f.instance.id),
    async () => await f.workflows.begin(f.caller, input),
  ])
    await assert.rejects(action, { code: 'assignment_denied' });
  assert.equal(
    (await f.workflows.evaluate(f.caller, f.instance.id, { action: 'begin' })).blockers[0].code,
    'assignment_denied',
  );
  const builds = f.builds();
  await assert.rejects(
    async () => await f.workflows.begin(f.caller, { ...input, expectedRevision: 1 }),
    {
      code: 'revision_conflict',
    },
  );
  assert.equal(f.builds(), builds);
  f.admit(true);
  await f.scope.revokeActor(f.caller, actor.id);
  await assert.rejects(async () => await f.workflows.begin(replacement, input), {
    code: 'forbidden',
  });
  const other = await f.scope.bootstrap({ projectName: 'Elsewhere', actorName: 'Other' });
  const stranger = { projectId: other.project.id, actorId: other.actor.id };
  for (const action of [
    async () => await f.workflows.assignment(stranger, f.instance.id),
    async () => await f.workflows.begin(stranger, input),
    async () => await f.workflows.workStarts(stranger, f.instance.id),
  ])
    await assert.rejects(action, { code: 'not_found' });
  await assert.rejects(
    async () => await f.workflows.begin(f.caller, { ...input, expectedRevision: -1 }),
    {
      code: 'invalid_revision',
    },
  );
});

test('failed context projection rolls back its activation event and start, including caller transactions', async (t) => {
  const f = await setup();
  t.after(async () => await f.state.close());
  const head = await f.state.eventHead();
  f.failBuild(true);
  for (const action of [
    async () =>
      await f.workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 0 }),
    async () =>
      await f.state.transaction(
        async (tx) =>
          await f.workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 0 }, tx),
      ),
  ]) {
    await assert.rejects(action, { code: 'context_failed' });
    assert.equal(await f.state.eventHead(), head);
    assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), []);
  }
  f.failBuild(false);
  const begun = await f.workflows.begin(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  // PostgreSQL does not reuse identity values of rolled-back inserts, so the start's event is not
  // head + 1; it is still the one and only event committed after the failed attempts.
  assert.deepEqual(
    (await f.state.eventBatch(head, 10)).map((event) => event.id),
    [begun.workStart?.eventId],
  );
});

test('start history is immutable and survives revisions, unload, termination and database restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-assignment-history-'));
  const path = directory;
  const f = await setup(path);
  let live: PostgresState = f.state;
  t.after(async () => {
    await live.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await f.workflows.begin(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  await f.workflows.transition(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
    action: 'restart',
    requestId: 'restart',
  });
  assert.equal(
    (await f.workflows.evaluate(f.caller, f.instance.id)).nextAction?.tool,
    'workflow.begin',
  );
  const second = await f.workflows.begin(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 1,
  });
  const starts = [first.workStart, second.workStart];
  assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), starts);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('UPDATE wf_work_starts SET actor_id=?', 'x'),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () => await f.state.transaction(async (tx) => await tx.run('DELETE FROM wf_work_starts')),
    { code: 'state_constraint' },
  );
  f.registration.dispose();
  assert.equal((await f.workflows.evaluate(f.caller, f.instance.id)).available, false);
  assert.deepEqual(
    (await f.workflows.evaluate(f.caller, f.instance.id)).workStart,
    second.workStart,
  );
  await assert.rejects(
    async () =>
      await f.workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 1 }),
    { code: 'workflow_unavailable' },
  );
  assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), starts);
  await f.workflows.register(graph, f.policy);
  await f.workflows.transition(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 1,
    action: 'finish',
    requestId: 'finish',
    input: { result: 12 },
  });
  assert.equal((await f.workflows.evaluate(f.caller, f.instance.id)).workStart, null);
  await assert.rejects(async () => await f.workflows.assignment(f.caller, f.instance.id), {
    code: 'workflow_ended',
  });
  await assert.rejects(
    async () =>
      await f.workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 2 }),
    { code: 'workflow_ended' },
  );
  await f.state.close();
  live = await openState(path);
  const workflows = await createService(
    new WorkflowsService(live, await createService(new ProjectScope(live))),
  );
  assert.deepEqual(await workflows.workStarts(f.caller, f.instance.id), starts);
});

test('assignment dependencies gate entry independently of completion readiness', async (t) => {
  const f = await setup();
  t.after(async () => await f.state.close());
  f.registration.dispose();
  const owner = await f.workflows.register(graph, {
    ...f.policy,
    successStates: ['done'],
    assignments: [{ ...f.policy.assignments![0], requiresDependencies: true }],
  });
  const downstream = await owner.start(f.caller, {
    workflow: graph.name,
    requestId: 'downstream',
    dependsOn: [f.instance.id],
  });
  for (const action of [
    async () => await f.workflows.assignment(f.caller, downstream.id),
    async () =>
      await f.workflows.begin(f.caller, { instanceId: downstream.id, expectedRevision: 0 }),
  ])
    await assert.rejects(action, { code: 'dependencies_pending' });
  assert.equal(
    (await f.workflows.evaluate(f.caller, downstream.id, { action: 'begin' })).blockers[0].code,
    'dependencies_pending',
  );
  assert.deepEqual(await f.workflows.workStarts(f.caller, downstream.id), []);
  await owner.transition(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'upstream-done',
    input: { result: 1 },
  });
  assert.ok(
    (await f.workflows.begin(f.caller, { instanceId: downstream.id, expectedRevision: 0 }))
      .workStart,
  );
});

test('assignment declarations and output fail closed while installed policy stays detached', async (t) => {
  const f = await setup();
  t.after(async () => await f.state.close());
  const rule = f.policy.assignments![0];
  for (const assignments of [
    [rule, rule],
    [{ ...rule, state: 'done' }],
    [{ ...rule, state: 'unknown' }],
    [{ ...rule, requiresDependencies: 'yes' }],
  ])
    await assert.rejects(
      async () =>
        await f.workflows.register({ ...graph, name: 'invalid_assignment' }, {
          ...f.policy,
          assignments,
        } as WorkflowPolicy),
      { code: 'invalid_workflow_policy' },
    );
  await assert.rejects(
    async () =>
      await f.workflows.register(
        { ...graph, name: 'reserved_begin' },
        {
          ...f.policy,
          actions: f.policy.actions.map((action, index) =>
            index ? action : { ...action, name: 'begin' },
          ),
        },
      ),
    { code: 'invalid_workflow_policy' },
  );
  f.registration.dispose();
  const without = await f.workflows.register(graph, { actions: f.policy.actions });
  await assert.rejects(async () => await f.workflows.assignment(f.caller, f.instance.id), {
    code: 'assignment_unavailable',
  });
  without.dispose();
  const original = rule.build;
  let malformed: unknown;
  let owner = await f.workflows.register(graph, {
    ...f.policy,
    assignments: [
      {
        ...rule,
        build: async () => {
          if (malformed === undefined) throw new Error('No unhandled rejection');
          return malformed as WorkflowAssignmentContent;
        },
      },
    ],
  });
  const head = await f.state.eventHead();
  await assert.rejects(
    async () =>
      await f.workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 0 }),
    { message: 'No unhandled rejection' },
  );
  let callbacks = 0;
  const unexpected = () => {
    callbacks++;
    throw new Error('Assignment validation executed provider code');
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (malformed of [
    { role: 'worker' },
    { value: Number.NaN },
    Object.defineProperty({}, 'role', { enumerable: true, get: unexpected }),
    new Proxy({}, { ownKeys: unexpected }),
    Object.setPrototypeOf([], { map: unexpected }),
    { value: revoked.proxy },
  ]) {
    await assert.rejects(async () => await f.workflows.assignment(f.caller, f.instance.id), {
      code: 'invalid_workflow_policy',
      status: 500,
    });
    assert.equal(callbacks, 0);
  }
  assert.equal(await f.state.eventHead(), head);
  owner.dispose();
  owner = await f.workflows.register(graph, {
    ...f.policy,
    assignments: [
      {
        ...rule,
        build: async (context) => {
          const packet = await original(context);
          packet.context!.subject.revision++;
          return packet;
        },
      },
    ],
  });
  await assert.rejects(
    async () =>
      await f.workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 0 }),
    { code: 'invalid_workflow_policy' },
  );
  assert.equal(await f.state.eventHead(), head);
  owner.dispose();
  await f.workflows.register(graph, f.policy);
  rule.state = 'done';
  rule.build = async () => {
    throw new Error('Changed outside registration');
  };
  f.policy.assignments!.length = 0;
  assert.equal((await f.workflows.assignment(f.caller, f.instance.id)).label, 'Initial assignment');
});

test('independent database connections converge on one first activation and reject stale begin', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-assignment-connections-'));
  const path = directory;
  const f = await setup(path);
  const secondState = await openState(path);
  const secondScope = await createService(new ProjectScope(secondState));
  const second = await createService(new WorkflowsService(secondState, secondScope));
  t.after(async () => {
    await secondState.close();
    await f.state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const replacement = (
    await f.scope.issueActor(f.caller, {
      name: 'Another worker',
      role: 'producer',
    })
  ).actor;
  const caller = { actorId: replacement.id, projectId: replacement.projectId };
  const packet = await f.workflows.assignment(f.caller, f.instance.id);
  await second.register(graph, {
    actions: f.policy.actions.map((action) => ({
      ...action,
      check: async ({ caller: actor, tx }) => {
        await secondScope.require(actor, 'write', tx);
      },
    })),
    assignments: [
      {
        state: 'work',
        check: async ({ caller: actor, tx }) => {
          await secondScope.require(actor, 'write', tx);
        },
        build: async () => ({
          role: packet.role,
          label: packet.label,
          brief: packet.brief,
          references: packet.references,
          execution: packet.execution,
          handoff: packet.handoff,
          context: null,
        }),
      },
    ],
  });
  const input = { instanceId: f.instance.id, expectedRevision: 0 };
  const first = await f.workflows.begin(f.caller, input);
  assert.deepEqual((await second.begin(caller, input)).workStart, first.workStart);
  assert.equal(
    (await secondState.events(caller.projectId)).filter(
      (event) => event.type === 'workflow.work_started',
    ).length,
    1,
  );
  await f.workflows.transition(f.caller, {
    ...input,
    action: 'restart',
    requestId: 'advance',
  });
  await assert.rejects(async () => await second.begin(caller, input), {
    code: 'revision_conflict',
  });
  const latest = await second.begin(caller, { ...input, expectedRevision: 1 });
  assert.equal(latest.workStart?.actorId, caller.actorId);
  assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), [
    first.workStart,
    latest.workStart,
  ]);
});

test('cached provider output is detached; async checks and workflow-changing projections roll back', async (t) => {
  const f = await setup();
  t.after(async () => await f.state.close());
  f.registration.dispose();
  const shared: WorkflowAssignmentContent = {
    role: 'worker',
    label: 'Shared packet',
    brief: 'Complete the measurement.',
    references: [{ kind: 'workflow', id: f.instance.id, label: 'Reference' }],
    handoff: { instruction: 'Submit the result.', tools: ['test.finish'] },
    execution: {
      readOnly: true,
      tools: [{ name: 'test.read', arguments: { nested: { limit: 1 } } }],
    },
    context: null,
  };
  let owner = await f.workflows.register(graph, {
    ...f.policy,
    assignments: [{ ...f.policy.assignments![0], build: async () => shared }],
  });
  const returned = await f.workflows.assignment(f.caller, f.instance.id);
  returned.references[0].label = 'Changed';
  returned.handoff.tools.push('injected.tool');
  (returned.execution.tools[0].arguments.nested as { limit: number }).limit = 99;
  assert.equal(shared.references[0].label, 'Reference');
  assert.deepEqual(shared.handoff.tools, ['test.finish']);
  assert.deepEqual(shared.execution.tools[0].arguments.nested, { limit: 1 });
  owner.dispose();
  owner = await f.workflows.register(graph, {
    ...f.policy,
    assignments: [
      {
        ...f.policy.assignments![0],
        check: async () => {
          await Promise.reject(new Error('Async check'));
        },
        build: async () => shared,
      },
    ],
  });
  await assert.rejects(async () => await f.workflows.evaluate(f.caller, f.instance.id), {
    message: 'Async check',
  });
  await assert.rejects(
    async () =>
      await f.workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 0 }),
    { message: 'Async check' },
  );
  owner.dispose();
  await f.workflows.register(graph, {
    ...f.policy,
    assignments: [
      {
        ...f.policy.assignments![0],
        build: async ({ tx, snapshot }) => {
          await tx.run(
            'UPDATE wf_instances SET data_json=? WHERE id=?',
            '{"tampered":true}',
            snapshot.id,
          );
          return shared;
        },
      },
    ],
  });
  const head = await f.state.eventHead();
  const snapshot = await f.workflows.get(f.caller, f.instance.id);
  await assert.rejects(
    async () =>
      await f.workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 0 }),
    { code: 'invalid_workflow_policy' },
  );
  assert.deepEqual(await f.workflows.get(f.caller, f.instance.id), snapshot);
  assert.equal(await f.state.eventHead(), head);
  assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), []);
});

test('simultaneous writers serialize begin while the first transaction remains open', async (t) => {
  const f = await setup('assignment-concurrent');
  t.after(async () => await f.state.close());
  const actor = (
    await f.scope.issueActor(f.caller, {
      name: 'Concurrent worker',
      role: 'producer',
    })
  ).actor;
  const otherCaller = { actorId: actor.id, projectId: actor.projectId };
  const race = await raceWriters({
    schema: schemaFor('assignment-concurrent'),
    service: async (state, writer) => {
      const scope = await createService(new ProjectScope(state));
      const workflows = await createService(new WorkflowsService(state, scope));
      await workflows.register(graph, {
        actions: graph.edges.map((edge) => ({
          name: edge.action,
          states: [edge.from],
          transitions: [edge.action],
          tool: `test.${edge.action}`,
          instruction: 'Complete the workflow step.',
          check: async ({ caller, tx }) => void (await scope.require(caller, 'write', tx)),
        })),
        assignments: [
          {
            state: 'work',
            check: async ({ caller, tx }) => {
              await scope.require(caller, 'write', tx);
              writer.entered();
            },
            // This runs inside the open database write transaction, after its start insert.
            build: async () => {
              await writer.hold();
              return {
                role: 'worker',
                label: 'Concurrent assignment',
                brief: 'Measure the instrument.',
                references: [],
                handoff: { instruction: 'Submit the result.', tools: ['test.finish'] },
                execution: { readOnly: false, tools: [] },
                context: null,
              };
            },
          },
        ],
      });
      return workflows;
    },
    first: async (workflows) =>
      (await workflows.begin(f.caller, { instanceId: f.instance.id, expectedRevision: 0 }))
        .workStart,
    second: async (workflows) =>
      (await workflows.begin(otherCaller, { instanceId: f.instance.id, expectedRevision: 0 }))
        .workStart,
  });
  assert.equal(
    race.secondEnteredWhileHeld,
    false,
    'Second begin cannot reach admission before the lock releases',
  );
  assert.ok(race.first.ok && race.first.value);
  assert.deepEqual(race.second, race.first);
  assert.equal(race.first.value.actorId, f.caller.actorId);
  assert.equal(race.secondEntered, true, 'Second begin enters after the first commits');
  assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), [race.first.value]);
  assert.equal(
    (await f.state.events(f.caller.projectId)).filter(
      (event) => event.type === 'workflow.work_started',
    ).length,
    1,
  );
  assert.equal((await f.workflows.get(f.caller, f.instance.id)).revision, 0);
});
