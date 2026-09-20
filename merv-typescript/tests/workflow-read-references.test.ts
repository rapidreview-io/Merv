import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Caller, Data, WorkflowDefinition, WorkflowPolicy } from '@merv/contracts';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';

async function fixture(t: TestContext) {
  const state = new SqliteState(':memory:');
  const controls = { outputs: () => {} };
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
  });
  const boot = await scope.bootstrap({ projectName: 'Read references', actorName: 'Owner' });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const definition: WorkflowDefinition = {
    name: 'read-reference-test',
    version: 1,
    initial: 'working',
    states: ['working', 'done'],
    terminal: ['done'],
    edges: [{ from: 'working', action: 'finish', to: 'done' }],
  };
  const policy: WorkflowPolicy = {
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'test.finish',
        instruction: 'Finish.',
        check: async () => {},
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
        build: async () => ({
          role: 'producer',
          label: 'Read evidence',
          brief: 'Inspect available evidence.',
          references: [],
          handoff: { instruction: 'Finish.', tools: [] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        references: () => ({
          artifacts: ['own-artifact'],
          reviews: ['own-review'],
          owner: 'fixed-owner',
        }),
        execution: {
          readOnly: false,
          tools: [
            {
              name: 'artifact.read',
              alternatives: [{ artifactId: { kind: 'oneOf', name: 'artifacts' } }],
            },
            {
              name: 'artifact.get',
              alternatives: [
                {
                  artifactId: { kind: 'oneOf', name: 'artifacts' },
                  owner: { kind: 'reference', name: 'owner' },
                },
              ],
            },
            {
              name: 'review.get',
              alternatives: [{ reviewId: { kind: 'oneOf', name: 'reviews' } }],
            },
            {
              name: 'task.submit_delivery',
              alternatives: [{ artifactIds: { kind: 'subset', name: 'artifacts' } }],
            },
          ],
        },
        lease: {
          role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => 'producer',
          acquire: async ({ leaseId }) => ({ leaseId }),
          check: async (context, receipt) => {
            assert.equal(receipt.leaseId, context.caller.session!.id);
          },
          release: async () => {},
          outputs: () => {
            controls.outputs();
            return {};
          },
        },
      },
    ],
  };
  const handle = await workflows.register(definition, policy);
  const instance = await handle.start(caller, { workflow: definition.name, requestId: 'start' });
  const target = { instanceId: instance.id, expectedRevision: instance.revision };
  const requestedTarget = { ...target };
  const pendingExecution = workflows.execution(caller, requestedTarget);
  requestedTarget.expectedRevision = 99;
  const execution = await pendingExecution;
  const dispatch = async (tool: string, input: Data) =>
    await workflows.authorizeDispatch(caller, {
      ...target,
      registrationId: execution.registrationId,
      policyHash: execution.policyHash,
      tool,
      input,
    });
  return {
    state,
    scope,
    workflows,
    caller,
    handle,
    instance,
    target,
    execution,
    dispatch,
    controls,
  };
}

test('optional references supplement only otherwise-denied declared evidence reads', async (t) => {
  const f = await fixture(t);
  const lookups: string[] = [];
  f.workflows.registerReadReferences({
    id: 'research',
    resolve: async (context, tool) => {
      assert.equal(context.caller.projectId, f.caller.projectId);
      assert.equal(context.snapshot.id, f.instance.id);
      f.state.assertTransaction(context.tx);
      lookups.push(tool);
      return { artifacts: ['live-artifact'], reviews: ['live-review'] };
    },
  });
  const request = {
    ...f.target,
    registrationId: f.execution.registrationId,
    policyHash: f.execution.policyHash,
    tool: 'artifact.read',
    input: { artifactId: 'own-artifact' },
    read: false,
  };
  const dispatching = f.workflows.authorizeDispatch(f.caller, request);
  request.tool = 'undeclared.write';
  request.read = true;
  request.input.artifactId = 'changed';
  assert.deepEqual(await dispatching, {
    tool: 'artifact.read',
    input: { artifactId: 'own-artifact' },
  });
  const head = await f.state.eventHead();
  assert.equal(
    (await f.dispatch('artifact.read', { artifactId: 'own-artifact' })).input.artifactId,
    'own-artifact',
  );
  assert.equal(
    (await f.dispatch('review.get', { reviewId: 'own-review' })).input.reviewId,
    'own-review',
  );
  assert.deepEqual(lookups, [], 'existing owner permissions never need the optional provider');
  assert.equal(
    (await f.dispatch('artifact.read', { artifactId: 'live-artifact' })).input.artifactId,
    'live-artifact',
  );
  assert.equal(
    (await f.dispatch('review.get', { reviewId: 'live-review' })).input.reviewId,
    'live-review',
  );
  await assert.rejects(async () => await f.dispatch('artifact.read', { artifactId: 'unrelated' }), {
    code: 'execution_arguments_forbidden',
  });
  assert.deepEqual(lookups, ['artifact.read', 'review.get', 'artifact.read']);
  assert.equal(await f.state.eventHead(), head);
  assert.deepEqual(
    (await f.workflows.execution(f.caller, f.target)).references,
    f.execution.references,
    'a successful read does not grow the saved execution references',
  );
});

test('supplemental references cannot authorize writes, undeclared tools or override scalar bindings', async (t) => {
  const f = await fixture(t);
  let lookups = 0;
  f.workflows.registerReadReferences({
    id: 'research',
    resolve: async () => {
      lookups++;
      return { artifacts: ['live-artifact'], owner: 'different-owner', undeclared: ['any'] };
    },
  });
  await assert.rejects(
    async () => await f.dispatch('task.submit_delivery', { artifactIds: ['live-artifact'] }),
    {
      code: 'execution_arguments_forbidden',
    },
  );
  await assert.rejects(
    async () => await f.dispatch('artifact.delete', { artifactId: 'live-artifact' }),
    {
      code: 'execution_tool_forbidden',
    },
  );
  assert.equal(lookups, 0);
  assert.deepEqual((await f.dispatch('artifact.get', { artifactId: 'live-artifact' })).input, {
    artifactId: 'live-artifact',
    owner: 'fixed-owner',
  });
  await assert.rejects(
    async () =>
      await f.dispatch('artifact.get', { artifactId: 'live-artifact', owner: 'different-owner' }),
    { code: 'execution_arguments_forbidden' },
  );
  assert.deepEqual(
    (await f.dispatch('task.submit_delivery', { artifactIds: ['own-artifact'] })).input.artifactIds,
    ['own-artifact'],
  );
  assert.equal(lookups, 2, 'only the denied declared reads reached the optional provider');
});

test('reference provider disposal restores denial and stale cleanup cannot remove a replacement', async (t) => {
  const f = await fixture(t);
  const first = f.workflows.registerReadReferences({
    id: 'research',
    resolve: async () => ({ artifacts: ['first'] }),
  });
  assert.equal(
    (await f.dispatch('artifact.read', { artifactId: 'first' })).input.artifactId,
    'first',
  );
  assert.throws(
    () => f.workflows.registerReadReferences({ id: 'research', resolve: async () => null }),
    {
      code: 'read_provider_exists',
    },
  );
  first();
  await assert.rejects(async () => await f.dispatch('artifact.read', { artifactId: 'first' }), {
    code: 'execution_arguments_forbidden',
  });
  const second = f.workflows.registerReadReferences({
    id: 'research',
    resolve: async () => ({ artifacts: ['second'] }),
  });
  first();
  assert.equal(
    (await f.dispatch('artifact.read', { artifactId: 'second' })).input.artifactId,
    'second',
  );
  await assert.rejects(async () => await f.dispatch('artifact.read', { artifactId: 'first' }), {
    code: 'execution_arguments_forbidden',
  });
  second();
  await assert.rejects(async () => await f.dispatch('artifact.read', { artifactId: 'second' }), {
    code: 'execution_arguments_forbidden',
  });
  assert.equal(
    (await f.dispatch('artifact.read', { artifactId: 'own-artifact' })).input.artifactId,
    'own-artifact',
  );
});

test('unavailable research reads do not interrupt assignment or lease lifecycle', async (t) => {
  const f = await fixture(t);
  f.workflows.registerReadReferences({
    id: 'unavailable-research',
    resolve: async () => {
      throw new Error('Research lookup unavailable');
    },
  });
  assert.ok(await f.workflows.assignment(f.caller, f.instance.id));
  assert.equal((await f.workflows.dispatchCandidates(f.caller))[0]!.instanceId, f.instance.id);
  const roleTarget = { ...f.target };
  const selectingRole = f.workflows.leaseRole(f.caller, roleTarget);
  roleTarget.expectedRevision = 99;
  assert.equal(await selectingRole, 'producer');
  const source = await f.scope.delegationSource(f.caller);
  f.scope.registerSessionAuthority({ require: async () => source });
  const actor = await f.state.transaction(
    async (tx) =>
      await f.scope.createSessionActor(
        source,
        {
          sessionId: 'lease-test',
          role: 'producer',
          name: 'Worker',
        },
        tx,
      ),
  );
  const worker: Caller = {
    projectId: actor.projectId,
    actorId: actor.id,
    session: { id: 'lease-test' },
  };
  const offerTarget = { ...f.target, leaseId: 'lease-test' };
  const offering = f.workflows.offerLease(f.caller, worker, offerTarget);
  offerTarget.leaseId = 'changed';
  offerTarget.instanceId = 'changed';
  const offered = await offering;
  const checkedLease = structuredClone(offered.lease);
  const checking = f.workflows.checkLease(worker, checkedLease);
  checkedLease.actorId = 'changed';
  checkedLease.receipt.leaseId = 'changed';
  assert.ok(await checking);
  const activatedLease = structuredClone(offered.lease);
  const activating = f.workflows.activateLease(worker, activatedLease);
  activatedLease.instanceId = 'changed';
  assert.ok(await activating);
  assert.equal(
    (
      await f.workflows.authorizeLeaseDispatch(worker, offered.lease, offered.execution, {
        tool: 'artifact.read',
        input: { artifactId: 'own-artifact' },
      })
    ).input.artifactId,
    'own-artifact',
  );
  await assert.rejects(
    async () =>
      await f.workflows.authorizeLeaseDispatch(worker, offered.lease, offered.execution, {
        tool: 'artifact.read',
        input: { artifactId: 'live-artifact' },
      }),
    /Research lookup unavailable/,
  );
  for (const change of ['policy', 'read classification']) {
    const frozen = structuredClone(offered.execution);
    const request = { tool: 'undeclared.write', input: {}, read: false };
    f.controls.outputs = () => {
      if (change === 'policy') frozen.policy.tools.push({ name: request.tool, alternatives: [{}] });
      else request.read = true;
    };
    await assert.rejects(
      () => f.workflows.authorizeLeaseDispatch(worker, offered.lease, frozen, request),
      { code: 'execution_tool_forbidden' },
    );
  }
  const release = { reason: 'Completed' };
  const releasing = f.workflows.releaseLease(offered.lease, release);
  release.reason = '';
  await releasing;
});
