import { currentTask, currentWork } from './fixtures/current-work.js';
import { admitDispatch, createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Caller,
  type Data,
  type WorkflowDefinition,
  type WorkflowExecutionPolicy,
  type WorkflowLeaseOffer,
  type WorkflowPolicy,
  type WorkflowSnapshot,
} from '@merv/contracts';

import { ProjectScope } from '@merv/scope';
import type { PostgresState } from '@merv/state';
import { WorkflowsService } from '@merv/workflows';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';
import { openState } from './fixtures/state.js';

const definition: WorkflowDefinition = {
  name: 'execution-test',
  version: 1,
  initial: 'working',
  states: ['working', 'done'],
  terminal: ['done'],
  edges: [{ from: 'working', action: 'finish', to: 'done' }],
};
const manifest = (): WorkflowExecutionPolicy => ({
  readOnly: true,
  tools: [
    {
      name: 'artifact.read',
      alternatives: [
        { artifactId: { kind: 'oneOf', name: 'taskArtifacts' } },
        { artifactId: { kind: 'oneOf', name: 'reviewArtifacts' } },
      ],
    },
    {
      name: 'native.write',
      alternatives: [
        {
          taskId: { kind: 'target', field: 'instanceId' },
          expectedRevision: { kind: 'target', field: 'revision' },
          projectId: { kind: 'target', field: 'projectId' },
          config: { kind: 'literal', value: { mode: 'checked', options: ['first', 'second'] } },
        },
      ],
    },
    {
      name: 'checkpoint',
      alternatives: [{ artifactIds: { kind: 'subset', name: 'taskArtifacts' } }],
    },
    { name: 'claim', alternatives: [{ claimId: { kind: 'reference', name: 'claim' } }] },
    {
      name: 'workflow.status_and_next',
      alternatives: [{ instanceId: { kind: 'target', field: 'instanceId' } }],
    },
    { name: '_nisa.search', alternatives: [{}] },
    {
      name: 'paired',
      alternatives: [
        {
          lane: { kind: 'literal', value: 'task' },
          artifactId: { kind: 'oneOf', name: 'taskArtifacts' },
        },
        {
          lane: { kind: 'literal', value: 'review' },
          artifactId: { kind: 'oneOf', name: 'reviewArtifacts' },
        },
      ],
    },
    {
      name: 'ambiguous',
      alternatives: [
        { choice: { kind: 'literal', value: 'first' } },
        { choice: { kind: 'literal', value: 'second' } },
      ],
    },
  ],
});
function policy(
  scope: ProjectScope,
  execution: WorkflowExecutionPolicy | undefined = manifest(),
): WorkflowPolicy {
  return {
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'finish',
        instruction: 'Finish.',
        check: async () => {},
        requiredInput: ['evidence'],
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
        build: async () => ({
          role: 'worker',
          label: 'Work',
          brief: 'Work',
          references: [],
          handoff: { instruction: 'Finish', tools: ['finish'] },
          execution: { readOnly: false, tools: [{ name: 'dynamic-tool', arguments: {} }] },
          context: null,
        }),
        ...(execution === undefined
          ? {}
          : {
              execution,
              references: () => ({
                taskArtifacts: ['task-a'],
                reviewArtifacts: ['review-b'],
                claim: 'claim-1',
              }),
              lease: {
                role: async () => 'producer' as const,
                acquire: async () => ({}),
                check: async () => {},
                release: async () => {},
              },
            }),
      },
    ],
  };
}
/**
 * A leased worker as Sessions makes one. Its tool calls are admitted as Sessions admits them:
 * the lease is checked with the execution it was offered, and the call is bound by that.
 */
async function leasing(
  state: PostgresState,
  scope: ProjectScope,
  workflows: WorkflowsService,
  caller: Caller,
) {
  const source = await scope.delegationSource(caller);
  scope.registerSessionAuthority({ require: async () => source });
  const sessionId = `lease-${randomBytes(4).toString('hex')}`;
  const actor = await state.transaction(
    async (tx) =>
      await scope.createSessionActor(source, { sessionId, role: 'producer', name: 'Worker' }, tx),
  );
  const worker: Caller = {
    projectId: actor.projectId,
    actorId: actor.id,
    session: { id: sessionId },
  };
  const offer = async (instance: WorkflowSnapshot) =>
    await workflows.offerLease(caller, worker, {
      instanceId: instance.id,
      expectedRevision: instance.revision,
      leaseId: sessionId,
    });
  const admit = async (
    { lease, execution }: WorkflowLeaseOffer,
    tool: string,
    input: Data = {},
  ) => {
    const { references } = await workflows.checkLease(worker, lease, undefined, execution);
    return admitDispatch({ ...execution, references: references! }, tool, input);
  };
  return { worker, offer, admit };
}
async function fixture() {
  const state = await openState(':memory:'),
    scope = await createService(new ProjectScope(state)),
    workflows = await createService(new WorkflowsService(state, scope));
  const boot = await scope.bootstrap({ projectName: 'Execution', actorName: 'Owner' });
  const caller: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const rules = policy(scope),
    handle = await workflows.register(definition, rules);
  const instance = await handle.start(caller, { workflow: definition.name, requestId: 'start' });
  return {
    state,
    scope,
    workflows,
    caller,
    rules,
    handle,
    instance,
    ...(await leasing(state, scope, workflows, caller)),
    close: async () => {
      workflows.close();
      await state.close();
    },
  };
}

test('a lease is offered fixed, detached execution metadata, and its calls are admitted without guidance', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const initial = (await f.offer(f.instance)).execution;
  assert.equal(initial.actorId, f.worker.actorId);
  const assignment = await f.workflows.assignment(f.caller, f.instance.id);
  assert.deepEqual(assignment.execution.policy, initial.policy);
  assert.deepEqual(
    assignment.execution.tools.map((tool) => tool.name),
    initial.policy.tools.map((tool) => tool.name),
  );
  assert.equal(assignment.execution.readOnly, true);
  assert.ok(!assignment.execution.tools.some((tool) => tool.name === 'dynamic-tool'));
  // Mutating caller-owned declarations or returned data cannot change the installed policy.
  f.rules.assignments![0].execution!.tools.length = 0;
  initial.policy.tools.length = 0;
  initial.references.taskArtifacts = ['unrelated'];
  const stable = await f.offer(f.instance);
  assert.equal(stable.execution.policyHash, initial.policyHash);
  assert.ok(stable.execution.policy.tools.length > 0);
  assert.deepEqual(stable.execution.references.taskArtifacts, ['task-a']);
  f.workflows.evaluate = async () => {
    throw new Error('No guidance during authority checks');
  };
  const head = await f.state.eventHead();
  assert.equal((await f.admit(stable, 'native.write')).input.expectedRevision, 0);
  assert.equal(await f.state.eventHead(), head);
  assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), []);
  await assert.rejects(async () => await f.admit(stable, 'dynamic-tool'), {
    code: 'execution_tool_forbidden',
  });
});

test('whole-value bindings inject exact fields, preserve input, and keep OR alternatives separate', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const offered = await f.offer(f.instance);
  const input: Data = { extra: 'retained' };
  const result = await f.admit(offered, 'native.write', input);
  assert.deepEqual(input, { extra: 'retained' });
  assert.deepEqual(result.input, {
    extra: 'retained',
    taskId: f.instance.id,
    expectedRevision: 0,
    projectId: f.caller.projectId,
    config: { mode: 'checked', options: ['first', 'second'] },
  });
  const badInputs: Data[] = [
    { taskId: 'other' },
    { expectedRevision: '0' },
    { config: { mode: 'checked' } },
    { config: { mode: 'checked', options: ['second', 'first'] } },
  ];
  for (const wrong of badInputs)
    await assert.rejects(async () => await f.admit(offered, 'native.write', wrong), {
      code: 'execution_arguments_forbidden',
    });
  for (const artifactId of ['task-a', 'review-b'])
    assert.equal(
      (await f.admit(offered, 'artifact.read', { artifactId })).input.artifactId,
      artifactId,
    );
  await assert.rejects(
    async () => await f.admit(offered, 'artifact.read', { artifactId: 'unknown' }),
    {
      code: 'execution_arguments_forbidden',
    },
  );
  await assert.rejects(
    async () => await f.admit(offered, 'paired', { lane: 'task', artifactId: 'review-b' }),
    { code: 'execution_arguments_forbidden' },
  );
  assert.deepEqual((await f.admit(offered, 'paired', { artifactId: 'review-b' })).input, {
    lane: 'review',
    artifactId: 'review-b',
  });
  await assert.rejects(async () => await f.admit(offered, 'ambiguous'), {
    code: 'execution_arguments_ambiguous',
  });
  assert.equal((await f.admit(offered, 'ambiguous', { choice: 'first' })).input.choice, 'first');
  assert.deepEqual((await f.admit(offered, 'checkpoint')).input, { artifactIds: [] });
  assert.deepEqual((await f.admit(offered, 'checkpoint', { artifactIds: [] })).input, {
    artifactIds: [],
  });
  await assert.rejects(
    async () => await f.admit(offered, 'checkpoint', { artifactIds: ['review-b'] }),
    { code: 'execution_arguments_forbidden' },
  );
  assert.deepEqual((await f.admit(offered, '_nisa.search', { query: 'cordis' })).input, {
    query: 'cordis',
  });
});

test('a lease check fences its worker, revision, policy and active registration, even inside an existing transaction', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const offered = await f.offer(f.instance);
  const { lease } = offered;
  await assert.rejects(
    async () => await f.workflows.checkLease(f.worker, { ...lease, policyHash: '0'.repeat(64) }),
    { code: 'execution_changed' },
  );
  await assert.rejects(
    async () => await f.workflows.checkLease(f.worker, { ...lease, expectedRevision: 1 }),
    { code: 'revision_conflict' },
  );
  await assert.rejects(
    async () => await f.workflows.checkLease({ ...f.worker, actorId: f.caller.actorId }, lease),
    { code: 'invalid_lease' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.handle.transition(
          f.caller,
          {
            instanceId: f.instance.id,
            expectedRevision: 0,
            action: 'finish',
            input: { evidence: 'yes' },
            requestId: 'finish',
          },
          tx,
        );
        await assert.rejects(async () => await f.workflows.checkLease(f.worker, lease, tx), {
          code: 'revision_conflict',
        });
        throw new Error('Rollback');
      }),
    /Rollback/,
  );
  // A record moved by the worker's own hand is the same conflict: what it means is Sessions'.
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.handle.transition(
          f.worker,
          {
            instanceId: f.instance.id,
            expectedRevision: 0,
            action: 'finish',
            input: { evidence: 'yes' },
            requestId: 'handoff',
          },
          tx,
        );
        await assert.rejects(async () => await f.workflows.checkLease(f.worker, lease, tx), {
          code: 'revision_conflict',
        });
        throw new Error('Rollback');
      }),
    /Rollback/,
  );
  assert.equal((await f.admit(offered, 'claim')).input.claimId, 'claim-1');
  f.handle.dispose();
  await assert.rejects(async () => await f.workflows.checkLease(f.worker, lease), {
    code: 'workflow_unavailable',
  });
  await f.workflows.register(definition, policy(f.scope));
  // A reload keeps the lease under a new generation; Sessions fences each invocation by it.
  assert.notEqual(
    (await f.workflows.checkLease(f.worker, lease)).registrationId,
    lease.registrationId,
  );
});

test('fixed manifests including absence are durable and immutable across registration and cold restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-policy-'));
  const path = directory;
  let state = await openState(path),
    scope = await createService(new ProjectScope(state)),
    workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await scope.bootstrap({ projectName: 'Durable', actorName: 'Owner' });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const handle = await workflows.register(definition, policy(scope));
  const instance = await handle.start(caller, { workflow: definition.name, requestId: 'start' });
  const captured = (await workflows.assignment(caller, instance.id)).execution;
  workflows.close();
  await state.close();
  state = await openState(path);
  scope = await createService(new ProjectScope(state));
  workflows = await createService(new WorkflowsService(state, scope));
  for (const changed of [
    undefined,
    { readOnly: true, tools: [] },
    { ...manifest(), readOnly: false },
  ]) {
    const changedPolicy = policy(scope);
    if (changed === undefined) {
      delete changedPolicy.assignments![0].execution;
      delete changedPolicy.assignments![0].references;
      delete changedPolicy.assignments![0].lease;
    } else changedPolicy.assignments![0].execution = changed;
    await assert.rejects(async () => await workflows.register(definition, changedPolicy), {
      code: 'workflow_version_conflict',
    });
  }
  const current = await workflows.register(definition, policy(scope));
  const refreshed = (await workflows.assignment(caller, instance.id)).execution;
  assert.equal(refreshed.policyHash, captured.policyHash);
  assert.deepEqual(refreshed.policy, captured.policy);
  assert.notEqual(refreshed.registrationId, captured.registrationId);
  await assert.rejects(
    async () =>
      await state.transaction(
        async (tx) => await tx.run('UPDATE wf_execution_policies SET manifest_json=?', '{}'),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await state.transaction(async (tx) => await tx.run('DELETE FROM wf_execution_policies')),
    { code: 'state_constraint' },
  );
  const absent = { ...definition, name: 'absent' };
  const noExecution = policy(scope);
  delete noExecution.assignments![0].execution;
  delete noExecution.assignments![0].references;
  delete noExecution.assignments![0].lease;
  const missing = await workflows.register(absent, noExecution);
  const subject = await missing.start(caller, { workflow: absent.name, requestId: 'absent' });
  // With no fixed policy the assignment shows only what the program builds, and grants nothing.
  assert.equal((await workflows.assignment(caller, subject.id)).execution.policyHash, undefined);
  missing.dispose();
  await assert.rejects(async () => await workflows.register(absent, policy(scope)), {
    code: 'workflow_version_conflict',
  });
  const empty = await workflows.register(
    { ...definition, version: 2 },
    policy(scope, { readOnly: true, tools: [] }),
  );
  const emptySubject = await empty.start(caller, { workflow: definition.name, requestId: 'empty' });
  const leased = await leasing(state, scope, workflows, caller);
  const emptyOffer = await leased.offer(emptySubject);
  assert.deepEqual(emptyOffer.execution.policy.tools, []);
  await assert.rejects(async () => await leased.admit(emptyOffer, 'claim'), {
    code: 'execution_tool_forbidden',
  });
  current.dispose();
});

test('malformed declarations, unsafe keys, accessors and sparse arrays fail before registration', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const badArray = new Array(1);
  (badArray as unknown as { extra: string }).extra = 'hidden-hole';
  const unexpected = () => {
    throw new Error('Validation must not execute caller code');
  };
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: unexpected });
  const trapped = new Proxy({}, { ownKeys: unexpected });
  const foreignArray = Object.setPrototypeOf([], { map: unexpected });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const badBindings = [
    { kind: 'literal' },
    { kind: 'literal', value: undefined },
    { kind: 'literal', value: badArray },
    { kind: 'literal', value: accessor },
    { kind: 'literal', value: new Date() },
    ...[trapped, foreignArray, revoked.proxy, Object.create(null)].map((value) => ({
      kind: 'literal',
      value,
    })),
    { kind: 'target', field: 'missing' },
    { kind: 'target', field: 'revision', unknown: true },
  ];
  for (const [i, bad] of badBindings.entries()) {
    const invalid = {
      readOnly: false,
      tools: [{ name: 'tool', alternatives: [{ value: bad }] }],
    } as unknown as WorkflowExecutionPolicy;
    await assert.rejects(
      async () =>
        await f.workflows.register({ ...definition, name: `bad-${i}` }, policy(f.scope, invalid)),
      { code: 'invalid_workflow_policy' },
    );
  }
  for (const name of ['__proto__', 'constructor', 'prototype', 'nested.value', 'array[0]']) {
    const alternative = JSON.parse(`{"${name}":{"kind":"literal","value":null}}`);
    await assert.rejects(
      async () =>
        await f.workflows.register(
          { ...definition, name: 'unsafe' },
          policy(f.scope, {
            readOnly: false,
            tools: [{ name: 'tool', alternatives: [alternative] }],
          }),
        ),
      { code: 'invalid_workflow_policy' },
    );
  }
  for (const tools of [
    [{ name: 'tool', alternatives: [] }],
    [
      { name: 'tool', alternatives: [{}] },
      { name: 'tool', alternatives: [{}] },
    ],
    [{ name: 'tool', alternatives: [{}, {}] }],
  ])
    await assert.rejects(
      async () =>
        await f.workflows.register(
          { ...definition, name: 'invalid' },
          policy(f.scope, { readOnly: false, tools }),
        ),
      { code: 'invalid_workflow_policy' },
    );
  assert.equal(f.workflows.catalog().length, 1);
  assert.equal(
    (await f.state.read(async (sql) => await sql.all('SELECT * FROM wf_definitions'))).length,
    1,
  );
});

test('manifest alternatives use locale-independent code-unit ordering', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const declaration: WorkflowExecutionPolicy = {
    readOnly: false,
    tools: [
      {
        name: 'choose',
        alternatives: [
          { value: { kind: 'literal', value: 'ä' } },
          { value: { kind: 'literal', value: 'z' } },
        ],
      },
    ],
  };
  const handle = await f.workflows.register(
    { ...definition, name: 'code-unit-order' },
    policy(f.scope, declaration),
  );
  const instance = await handle.start(f.caller, {
    workflow: 'code-unit-order',
    requestId: 'order',
  });
  const current = (await f.workflows.assignment(f.caller, instance.id)).execution;
  assert.deepEqual(current.policy!.tools[0].alternatives, [
    { value: { kind: 'literal', value: 'z' } },
    { value: { kind: 'literal', value: 'ä' } },
  ]);
  handle.dispose();
  declaration.tools[0].alternatives.reverse();
  await f.workflows.register(
    { ...definition, name: 'code-unit-order' },
    policy(f.scope, declaration),
  );
  assert.equal(
    (await f.workflows.assignment(f.caller, instance.id)).execution.policyHash,
    current.policyHash,
  );
});

test('references are read once, at the offer: a lease check needs no program callback beyond its own, and an offer fails closed', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let references: unknown = { claim: 'first', taskArtifacts: ['a'], reviewArtifacts: [] };
  const rules = policy(f.scope);
  rules.assignments![0].references = () => references as any;
  const handle = await f.workflows.register({ ...definition, name: 'pure-metadata' }, rules);
  const instance = await handle.start(f.caller, { workflow: 'pure-metadata', requestId: 'pure' });
  const offered = await f.offer(instance);
  const { check } = rules.actions[0];
  const { build } = rules.assignments![0];
  rules.actions[0].check = async () => {
    throw new Error('Exit callbacks are not authority');
  };
  rules.describe = () => {
    throw new Error('Guidance is not authority');
  };
  rules.assignments![0].build = async () => {
    throw new Error('Prompt rendering is not authority');
  };
  references = { claim: 'second', taskArtifacts: ['new'], reviewArtifacts: [] };
  assert.equal((await f.admit(offered, 'claim')).input.claimId, 'first');
  await assert.rejects(async () => await f.admit(offered, 'claim', { claimId: 'second' }), {
    code: 'execution_arguments_forbidden',
  });
  rules.actions[0].check = check;
  delete rules.describe;
  rules.assignments![0].build = build;
  for (const invalid of [
    null,
    { claim: 42 },
    { claim: '' },
    { taskArtifacts: ['a', null] },
    Promise.resolve({ claim: 42 }),
  ]) {
    references = invalid;
    await assert.rejects(async () => await f.offer(instance), {
      code: 'invalid_workflow_policy',
    });
  }
  references = { taskArtifacts: [], reviewArtifacts: [] };
  await assert.rejects(async () => await f.admit(await f.offer(instance), 'claim'), {
    code: 'execution_reference_unavailable',
  });
  let withdraw = false;
  const disappearing = policy(f.scope);
  disappearing.assignments![0].references = () => {
    if (withdraw) live.dispose();
    return {};
  };
  const live = await f.workflows.register({ ...definition, name: 'withdraw' }, disappearing);
  const subject = await live.start(f.caller, { workflow: 'withdraw', requestId: 'withdraw' });
  withdraw = true;
  await assert.rejects(async () => await f.offer(subject), { code: 'workflow_unavailable' });
});

test('Tasks sessions are admitted by fixed producer and reviewer policies, without rendering or checkpoint grant expansion', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-execution-'));
  const app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { scope, tasks, artifacts, workflows, sessions } = app.ctx;
  const boot = await scope.bootstrap({ projectName: 'Tasks', actorName: 'Operator' });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  await sessions.dispatch.heartbeatRunner(operator, {
    runnerId: 'test',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 4 }],
    capacity: 4,
    capabilities: ['code.v2'],
  });
  const codeWork = currentWork(app.ctx, { directory: join(directory, 'work'), source: operator });
  let sequence = 0;
  const offer = async (target: { id: string; workflow: { revision: number } }) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(operator, {
      instanceId: target.id,
      expectedRevision: target.workflow.revision,
      runnerId: 'test',
      requestId: `offer-${++sequence}`,
      secret,
    });
    const held = await codeWork.attach(session);
    held.worker = await sessions.authenticate(secret);
    return { session, worker: held.worker, held };
  };
  const task = await currentTask(app.ctx, operator, {
    title: 'Task',
    goal: 'Prove it.',
    checks: ['It passed.'],
    requestId: 'task',
  });
  const unrelated = await artifacts.create(operator, {
    title: 'Unrelated',
    content: 'Not pinned.',
  });
  const work = await offer(task);
  const producer = work.worker;
  for (const tool of ['workflow.begin', 'task.create'])
    await assert.rejects(async () => await sessions.invocations.prepare(producer, tool, {}), {
      code: 'execution_tool_forbidden',
    });
  await assert.rejects(
    async () =>
      await sessions.invocations.prepare(producer, 'task.checkpoint', {
        notes: 'Attach',
        artifactIds: [unrelated.id],
      }),
    { code: 'execution_arguments_forbidden' },
  );
  assert.deepEqual(
    (await sessions.invocations.prepare(producer, 'task.checkpoint', { notes: 'Text only' })).input
      .artifactIds,
    [],
  );
  // Ordinary credentials remain broad, and what they attach later grants the session nothing.
  await tasks.checkpoint(operator, {
    taskId: task.id,
    expectedRevision: 0,
    purpose: 'work',
    notes: 'Ordinary credentials remain broad.',
    artifactIds: [unrelated.id],
    requestId: 'checkpoint',
  });
  await assert.rejects(
    async () =>
      await sessions.invocations.prepare(producer, 'artifact.read', { artifactId: unrelated.id }),
    { code: 'execution_arguments_forbidden' },
  );
  const proof = await sessions.invocations.run(
    await sessions.invocations.prepare(producer, 'artifact.create', {
      title: 'Proof',
      content: 'It passed.',
    }),
    async (caller, input) =>
      await artifacts.create(caller, input as unknown as { title: string; content: string }),
  );
  const held = work.held;
  held.worker = producer;
  const commandId = await codeWork.commit(held);
  const pending = await sessions.invocations.run(
    await sessions.invocations.prepare(
      producer,
      'task.submit_delivery',
      confirmedDelivery({ artifactIds: [proof.id], requestId: 'delivery', commandId }),
    ),
    async (caller, input) => await tasks.submitDelivery(caller, input as never),
  );
  await codeWork.release(held);
  const review = await offer(pending);
  const reviewer = review.worker;
  assert.notEqual(review.session.execution.policyHash, work.session.execution.policyHash);
  const read = artifacts.read.bind(artifacts),
    evaluate = workflows.evaluate.bind(workflows);
  artifacts.read = async () => {
    throw new Error('No artifact bytes during execution checks');
  };
  workflows.evaluate = async () => {
    throw new Error('No readiness-derived grants');
  };
  const claimId = (await app.ctx.reviews.get(operator, pending.reviewId!)).claimId;
  assert.ok(claimId);
  assert.equal(
    (await sessions.invocations.prepare(reviewer, 'review.submit', {})).input.claimId,
    claimId,
  );
  assert.equal(
    (await sessions.invocations.prepare(reviewer, 'artifact.read', { artifactId: proof.id })).input
      .artifactId,
    proof.id,
  );
  await assert.rejects(
    async () => await sessions.invocations.prepare(reviewer, 'task.submit_delivery', {}),
    {
      code: 'execution_tool_forbidden',
    },
  );
  artifacts.read = read;
  workflows.evaluate = evaluate;
  await codeWork.release(review.held);
});
