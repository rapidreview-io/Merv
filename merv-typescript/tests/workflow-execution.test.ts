import {
  createService,
  type Caller,
  type Data,
  type WorkflowDefinition,
  type WorkflowExecutionPolicy,
  type WorkflowLeaseOffer,
  type WorkflowPolicy,
} from '@merv/contracts';
import { admitDispatch } from '@merv/workflows/execution';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ProjectScope } from '@merv/scope';
import type { PostgresState } from '@merv/state';
import { WorkflowsService } from '@merv/workflows';

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
  scope.registerSessionAuthority({ require: async () => ({ source }) });
  const sessionId = `lease-${randomBytes(4).toString('hex')}`;
  const actor = await state.transaction(
    async (tx) =>
      await scope.createSessionActor(
        source,
        { threadId: sessionId, role: 'producer', name: 'Worker' },
        tx,
      ),
  );
  const worker: Caller = {
    projectId: actor.projectId,
    actorId: actor.id,
    session: { id: sessionId, threadId: sessionId },
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
  const boot = await scope.credentials.bootstrap({ projectName: 'Execution', actorName: 'Owner' });
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
  const boot = await scope.credentials.bootstrap({ projectName: 'Durable', actorName: 'Owner' });
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
