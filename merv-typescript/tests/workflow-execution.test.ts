import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  check,
  type Caller,
  type Data,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionPolicy,
  type WorkflowPolicy,
} from '@merv/contracts';

import { ProjectScope } from '@merv/scope';
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
            }),
      },
    ],
  };
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
    close: async () => {
      workflows.close();
      await state.close();
    },
  };
}
const dispatch = (execution: WorkflowExecution, tool: string, input: Data = {}) => ({
  instanceId: execution.instanceId,
  expectedRevision: execution.revision,
  policyHash: execution.policyHash,
  registrationId: execution.registrationId,
  tool,
  input,
});

test('fixed execution is metadata-only, detached and independent of exit readiness or assignment rendering', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const caller = { ...f.caller };
  const resolving = f.workflows.execution(caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  caller.actorId = 'replacement';
  const initial = await resolving;
  assert.equal(initial.actorId, f.caller.actorId);
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
  const stable = await f.workflows.execution(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  assert.equal(stable.policyHash, initial.policyHash);
  assert.ok(stable.policy.tools.length > 0);
  assert.deepEqual(stable.references.taskArtifacts, ['task-a']);
  f.workflows.evaluate = async () => {
    throw new Error('No guidance during authority checks');
  };
  const head = await f.state.eventHead();
  Object.assign(caller, f.caller);
  const admitting = f.workflows.authorizeDispatch(caller, dispatch(stable, 'native.write'));
  caller.actorId = 'replacement';
  const admitted = await admitting;
  assert.equal(admitted.input.expectedRevision, 0);
  assert.equal(await f.state.eventHead(), head);
  assert.deepEqual(await f.workflows.workStarts(f.caller, f.instance.id), []);
  await assert.rejects(
    async () => await f.workflows.authorizeDispatch(f.caller, dispatch(stable, 'dynamic-tool')),
    {
      code: 'execution_tool_forbidden',
    },
  );
});

test('an overview asked of the whole project is not narrowed to the session own record', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const execution = await f.workflows.execution(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  const asked = dispatch(execution, 'workflow.status_and_next', {});
  // Leaving the instance out asks what the whole project is doing. Filling it in from the
  // binding would answer for this worker's own record — a different question.
  assert.deepEqual(
    (await f.workflows.authorizeDispatch(f.caller, { ...asked, read: true })).input,
    {},
  );
  // Named, the instance still has to be this worker's own.
  assert.deepEqual(
    (
      await f.workflows.authorizeDispatch(f.caller, {
        ...dispatch(execution, 'workflow.status_and_next', { instanceId: f.instance.id }),
        read: true,
      })
    ).input,
    { instanceId: f.instance.id },
  );
  // Without the read mark the published binding holds, and fills what was left out.
  assert.deepEqual((await f.workflows.authorizeDispatch(f.caller, asked)).input, {
    instanceId: f.instance.id,
  });
});

test('whole-value bindings inject exact fields, preserve input, and keep OR alternatives separate', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const execution = await f.workflows.execution(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  const input: Data = { extra: 'retained' };
  const result = await f.workflows.authorizeDispatch(
    f.caller,
    dispatch(execution, 'native.write', input),
  );
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
    await assert.rejects(
      async () =>
        await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'native.write', wrong)),
      { code: 'execution_arguments_forbidden' },
    );
  for (const artifactId of ['task-a', 'review-b'])
    assert.equal(
      (
        await f.workflows.authorizeDispatch(
          f.caller,
          dispatch(execution, 'artifact.read', { artifactId }),
        )
      ).input.artifactId,
      artifactId,
    );
  // A tool marked as a read is admitted as given: a session reads whatever its project
  // holds. Without the mark, the binding holds.
  const unknown = dispatch(execution, 'artifact.read', { artifactId: 'unknown' });
  assert.equal(
    (await f.workflows.authorizeDispatch(f.caller, { ...unknown, read: true })).input.artifactId,
    'unknown',
  );
  await assert.rejects(async () => await f.workflows.authorizeDispatch(f.caller, unknown), {
    code: 'execution_arguments_forbidden',
  });
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(
        f.caller,
        dispatch(execution, 'paired', { lane: 'task', artifactId: 'review-b' }),
      ),
    { code: 'execution_arguments_forbidden' },
  );
  assert.deepEqual(
    (
      await f.workflows.authorizeDispatch(
        f.caller,
        dispatch(execution, 'paired', { artifactId: 'review-b' }),
      )
    ).input,
    { lane: 'review', artifactId: 'review-b' },
  );
  await assert.rejects(
    async () => await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'ambiguous')),
    {
      code: 'execution_arguments_ambiguous',
    },
  );
  assert.equal(
    (
      await f.workflows.authorizeDispatch(
        f.caller,
        dispatch(execution, 'ambiguous', { choice: 'first' }),
      )
    ).input.choice,
    'first',
  );
  assert.deepEqual(
    (await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'checkpoint'))).input,
    { artifactIds: [] },
  );
  assert.deepEqual(
    (
      await f.workflows.authorizeDispatch(
        f.caller,
        dispatch(execution, 'checkpoint', { artifactIds: [] }),
      )
    ).input,
    { artifactIds: [] },
  );
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(
        f.caller,
        dispatch(execution, 'checkpoint', { artifactIds: ['review-b'] }),
      ),
    { code: 'execution_arguments_forbidden' },
  );
  assert.deepEqual(
    (
      await f.workflows.authorizeDispatch(
        f.caller,
        dispatch(execution, '_nisa.search', { query: 'cordis' }),
      )
    ).input,
    { query: 'cordis' },
  );
});

test('dispatch rechecks caller, target revision, live references and active registration even inside an existing transaction', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const execution = await f.workflows.execution(f.caller, {
    instanceId: f.instance.id,
    expectedRevision: 0,
  });
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(f.caller, {
        ...dispatch(execution, 'claim'),
        registrationId: 'other',
      }),
    { code: 'execution_changed' },
  );
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(f.caller, {
        ...dispatch(execution, 'claim'),
        policyHash: '0'.repeat(64),
      }),
    { code: 'execution_changed' },
  );
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(f.caller, {
        ...dispatch(execution, 'claim'),
        expectedRevision: 1,
      }),
    { code: 'revision_conflict' },
  );
  const reader = await f.scope.issueActor(f.caller, { name: 'Reader', role: 'reader' });
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(
        { actorId: reader.actor.id, projectId: f.caller.projectId },
        dispatch(execution, 'claim'),
      ),
    { code: 'forbidden' },
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
        await assert.rejects(
          async () =>
            await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'claim'), tx),
          { code: 'revision_conflict' },
        );
        throw new Error('Rollback');
      }),
    /Rollback/,
  );
  assert.equal(
    (await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'claim'))).input.claimId,
    'claim-1',
  );
  f.handle.dispose();
  await assert.rejects(
    async () => await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'claim')),
    {
      code: 'workflow_unavailable',
    },
  );
  await f.workflows.register(definition, policy(f.scope));
  await assert.rejects(
    async () => await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'claim')),
    {
      code: 'execution_changed',
    },
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
  const caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const handle = await workflows.register(definition, policy(scope));
  const instance = await handle.start(caller, { workflow: definition.name, requestId: 'start' });
  const captured = await workflows.execution(caller, {
    instanceId: instance.id,
    expectedRevision: 0,
  });
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
    } else changedPolicy.assignments![0].execution = changed;
    await assert.rejects(async () => await workflows.register(definition, changedPolicy), {
      code: 'workflow_version_conflict',
    });
  }
  const current = await workflows.register(definition, policy(scope));
  const refreshed = await workflows.execution(caller, {
    instanceId: instance.id,
    expectedRevision: 0,
  });
  assert.equal(refreshed.policyHash, captured.policyHash);
  assert.notEqual(refreshed.registrationId, captured.registrationId);
  await assert.rejects(
    async () => await workflows.authorizeDispatch(caller, dispatch(captured, 'claim')),
    {
      code: 'execution_changed',
    },
  );
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
  const missing = await workflows.register(absent, noExecution);
  const subject = await missing.start(caller, { workflow: absent.name, requestId: 'absent' });
  await assert.rejects(
    async () => await workflows.execution(caller, { instanceId: subject.id, expectedRevision: 0 }),
    { code: 'execution_unavailable' },
  );
  missing.dispose();
  await assert.rejects(async () => await workflows.register(absent, policy(scope)), {
    code: 'workflow_version_conflict',
  });
  const empty = await workflows.register(
    { ...definition, version: 2 },
    policy(scope, { readOnly: true, tools: [] }),
  );
  const emptySubject = await empty.start(caller, { workflow: definition.name, requestId: 'empty' });
  const emptyExecution = await workflows.execution(caller, {
    instanceId: emptySubject.id,
    expectedRevision: 0,
  });
  assert.deepEqual(emptyExecution.policy.tools, []);
  await assert.rejects(
    async () => await workflows.authorizeDispatch(caller, dispatch(emptyExecution, 'claim')),
    {
      code: 'execution_tool_forbidden',
    },
  );
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
  const current = await f.workflows.execution(f.caller, {
    instanceId: instance.id,
    expectedRevision: 0,
  });
  assert.deepEqual(current.policy.tools[0].alternatives, [
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
    (await f.workflows.execution(f.caller, { instanceId: instance.id, expectedRevision: 0 }))
      .policyHash,
    current.policyHash,
  );
});

test('metadata callbacks never need assignment/exit callbacks and fail closed for invalid output or withdrawal', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let references: unknown = { claim: 'first', taskArtifacts: ['a'], reviewArtifacts: [] };
  const rules = policy(f.scope);
  rules.actions[0].check = async () => {
    throw new Error('Exit callbacks are not authority');
  };
  rules.describe = () => {
    throw new Error('Guidance is not authority');
  };
  rules.assignments![0].build = async () => {
    throw new Error('Prompt rendering is not authority');
  };
  rules.assignments![0].references = () => references as any;
  const handle = await f.workflows.register({ ...definition, name: 'pure-metadata' }, rules);
  const instance = await handle.start(f.caller, { workflow: 'pure-metadata', requestId: 'pure' });
  const execution = await f.workflows.execution(f.caller, {
    instanceId: instance.id,
    expectedRevision: 0,
  });
  references = { claim: 'second', taskArtifacts: ['new'], reviewArtifacts: [] };
  assert.equal(
    (await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'claim'))).input.claimId,
    'second',
  );
  await assert.rejects(
    async () =>
      await f.workflows.authorizeDispatch(
        f.caller,
        dispatch(execution, 'claim', { claimId: 'first' }),
      ),
    { code: 'execution_arguments_forbidden' },
  );
  for (const invalid of [
    null,
    { claim: 42 },
    { claim: '' },
    { taskArtifacts: ['a', null] },
    Promise.resolve({ claim: 42 }),
  ]) {
    references = invalid;
    await assert.rejects(
      async () =>
        await f.workflows.execution(f.caller, { instanceId: instance.id, expectedRevision: 0 }),
      { code: 'invalid_workflow_policy' },
    );
  }
  references = { taskArtifacts: [], reviewArtifacts: [] };
  await assert.rejects(
    async () => await f.workflows.authorizeDispatch(f.caller, dispatch(execution, 'claim')),
    {
      code: 'execution_reference_unavailable',
    },
  );
  let withdraw = false;
  const disappearing = policy(f.scope);
  disappearing.assignments![0].references = () => {
    if (withdraw) live.dispose();
    return {};
  };
  const live = await f.workflows.register({ ...definition, name: 'withdraw' }, disappearing);
  const subject = await live.start(f.caller, { workflow: 'withdraw', requestId: 'withdraw' });
  withdraw = true;
  await assert.rejects(
    async () =>
      await f.workflows.execution(f.caller, { instanceId: subject.id, expectedRevision: 0 }),
    { code: 'workflow_unavailable' },
  );
});

test('Tasks use fixed producer/reviewer policies and metadata pins without rendering or checkpoint grant expansion', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-execution-'));
  const app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { scope, tasks, artifacts, workflows, reviews } = app.ctx;
  const boot = await scope.bootstrap({ projectName: 'Tasks', actorName: 'Operator' });
  const operator = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer') => ({
    actorId: (await scope.issueActor(operator, { name: role, role })).actor.id,
    projectId: operator.projectId,
  });
  const producer = await issue('producer'),
    reviewer = await issue('reviewer');
  const task = await tasks.create(producer, {
    title: 'Task',
    goal: 'Prove it.',
    checks: ['It passed.'],
    requestId: 'task',
  });
  const initial = await workflows.execution(producer, { instanceId: task.id, expectedRevision: 0 });
  for (const tool of ['workflow.begin', 'task.create']) {
    await assert.rejects(
      async () => await workflows.authorizeDispatch(producer, dispatch(initial, tool)),
      {
        code: 'execution_tool_forbidden',
      },
    );
  }
  const unrelated = await artifacts.create(producer, {
    title: 'Unrelated',
    content: 'Not pinned.',
  });
  const helper = await workflows.execution(operator, { instanceId: task.id, expectedRevision: 0 });
  await assert.rejects(
    async () =>
      await workflows.authorizeDispatch(operator, dispatch(helper, 'task.submit_delivery')),
    { code: 'execution_reference_unavailable' },
  );
  await assert.rejects(
    async () =>
      await workflows.authorizeDispatch(
        producer,
        dispatch(initial, 'task.checkpoint', { notes: 'Attach', artifactIds: [unrelated.id] }),
      ),
    { code: 'execution_arguments_forbidden' },
  );
  assert.deepEqual(
    (
      await workflows.authorizeDispatch(
        producer,
        dispatch(initial, 'task.checkpoint', { notes: 'Text only' }),
      )
    ).input.artifactIds,
    [],
  );
  await tasks.checkpoint(producer, {
    taskId: task.id,
    expectedRevision: 0,
    purpose: 'work',
    notes: 'Ordinary credentials remain broad.',
    artifactIds: [unrelated.id],
    requestId: 'checkpoint',
  });
  const after = await workflows.execution(producer, { instanceId: task.id, expectedRevision: 0 });
  assert.equal(after.policyHash, initial.policyHash);
  assert.ok(!(after.references.artifacts as string[]).includes(unrelated.id));
  await assert.rejects(
    async () =>
      await workflows.authorizeDispatch(
        producer,
        dispatch(after, 'artifact.read', { artifactId: unrelated.id }),
      ),
    { code: 'execution_arguments_forbidden' },
  );
  const proof = await artifacts.create(producer, { title: 'Proof', content: 'It passed.' });
  const pending = await tasks.submitDelivery(
    producer,
    confirmedDelivery({
      taskId: task.id,
      expectedRevision: 0,
      artifactIds: [proof.id],
      requestId: 'delivery',
    }),
  );
  const read = artifacts.read.bind(artifacts),
    evaluate = workflows.evaluate.bind(workflows);
  artifacts.read = async () => {
    throw new Error('No artifact bytes during execution checks');
  };
  workflows.evaluate = async () => {
    throw new Error('No readiness-derived grants');
  };
  const beforeClaim = await workflows.execution(reviewer, {
    instanceId: task.id,
    expectedRevision: 1,
  });
  assert.equal(
    (await workflows.authorizeDispatch(reviewer, dispatch(beforeClaim, 'review.start'))).input
      .reviewId,
    pending.reviewId,
  );
  await assert.rejects(
    async () => await workflows.authorizeDispatch(reviewer, dispatch(beforeClaim, 'review.submit')),
    { code: 'execution_reference_unavailable' },
  );
  const claim = await reviews.start(reviewer, pending.reviewId!);
  const claimed = await workflows.execution(reviewer, { instanceId: task.id, expectedRevision: 1 });
  assert.equal(claimed.policyHash, beforeClaim.policyHash);
  assert.deepEqual(
    claimed.policy.tools.map((tool) => tool.name),
    beforeClaim.policy.tools.map((tool) => tool.name),
  );
  assert.equal(
    (await workflows.authorizeDispatch(reviewer, dispatch(claimed, 'review.submit'))).input.claimId,
    claim.claimId,
  );
  assert.equal(
    (
      await workflows.authorizeDispatch(
        reviewer,
        dispatch(claimed, 'artifact.read', { artifactId: proof.id }),
      )
    ).input.artifactId,
    proof.id,
  );
  await assert.rejects(
    async () =>
      await workflows.authorizeDispatch(reviewer, dispatch(claimed, 'task.submit_delivery')),
    { code: 'execution_tool_forbidden' },
  );
  artifacts.read = read;
  workflows.evaluate = evaluate;
});
