import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import {
  check,
  createService,
  type Caller,
  type Data,
  type Transaction,
  type WorkflowDefinition,
  type WorkflowExecutionPolicy,
  type WorkflowPolicy,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';

import { openState } from './fixtures/state.js';

const definition = (name: string, version = 1): WorkflowDefinition => ({
  name,
  version,
  initial: 'work',
  states: ['work', 'done'],
  terminal: ['done'],
  edges: [{ from: 'work', action: 'finish', to: 'done' }],
});
const poison = (): never => {
  throw new Error('Discovery must not render, resolve inputs, reserve, or evaluate exit actions');
};
async function fixture(t: TestContext) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
  });
  const boot = await scope.credentials.bootstrap({ projectName: 'Dispatch', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  let exitsAllowed = true;
  const rules = (
    execution: WorkflowExecutionPolicy,
    sourceCheck?: (tx: Transaction) => void | Promise<void>,
  ): WorkflowPolicy => ({
    successStates: ['done'],
    describe: poison,
    actions: [
      {
        name: 'finish',
        tool: 'finish',
        states: ['work'],
        transitions: ['finish'],
        instruction: 'Finish',
        check: () => {
          if (!exitsAllowed) poison();
        },
      },
    ],
    assignments: [
      {
        state: 'work',
        requiresDependencies: true,
        check: poison,
        build: poison,
        references: poison,
        execution,
        lease: {
          label: ({ snapshot }) => String(snapshot.data.title || snapshot.workflow),
          role: async ({ caller, snapshot, tx }) => {
            await scope.require(caller, execution.readOnly ? 'review' : 'write', tx);
            check(snapshot.data.allowed !== false, 'not_ready', 'Inputs are not ready', 409);
            await sourceCheck?.(tx);
            return execution.readOnly ? 'reviewer' : 'producer';
          },
          acquire: poison,
          check: poison,
          outputs: poison,
          release: poison,
        },
      },
    ],
  });
  let sequence = 0;
  const register = async (name: string, readOnly = false, workspace?: WorkflowWorkspacePolicy) => {
    const policy = rules({ readOnly, tools: [], ...(workspace ? { workspace } : {}) });
    const handle = await workflows.register(definition(name), policy);
    const start = async (data: Data = {}, dependsOn?: string[]) =>
      await handle.start(source, {
        workflow: name,
        requestId: `start-${++sequence}`,
        data,
        ...(dependsOn ? { dependsOn } : {}),
      });
    return { handle, policy, start };
  };
  return {
    state,
    scope,
    workflows,
    source,
    rules,
    register,
    forbidExits: () => {
      exitsAllowed = false;
    },
  };
}

test('discovery uses the real source authority and transaction; revoked or cross-project callers cannot enumerate', async (t) => {
  const f = await fixture(t);
  const work = await f.register('scoped-work');
  const instance = await work.start();
  const reader = await f.scope.credentials.issueActor(f.source, { name: 'Reader', role: 'reader' });
  const readerCaller: Caller = {
    ...f.source,
    actorId: reader.actor.id,
    credentialId: reader.credential.id,
  };
  assert.deepEqual(await f.workflows.dispatchCandidates(readerCaller), []);
  const producer = await f.scope.credentials.issueActor(f.source, {
    name: 'Producer',
    role: 'producer',
  });
  const producerCaller: Caller = {
    ...f.source,
    actorId: producer.actor.id,
    credentialId: producer.credential.id,
  };
  assert.equal((await f.workflows.dispatchCandidates(producerCaller))[0].instanceId, instance.id);
  const foreign = await f.scope.credentials.bootstrap({
    projectName: 'Foreign',
    actorName: 'Other owner',
  });
  const foreignCaller: Caller = { actorId: foreign.actor.id, projectId: foreign.project.id };
  assert.deepEqual(await f.workflows.dispatchCandidates(foreignCaller), []);
  const pendingCaller = { ...foreignCaller };
  const discovering = f.workflows.dispatchCandidates(pendingCaller);
  Object.assign(pendingCaller, f.source);
  assert.deepEqual(await discovering, []);
  await assert.rejects(
    async () =>
      await f.workflows.dispatchCandidates({ ...producerCaller, projectId: foreign.project.id }),
    { code: 'forbidden' },
  );
  await f.state.transaction(async (tx) => {
    await tx.run('UPDATE actors SET active=0 WHERE id=?', producer.actor.id);
    await assert.rejects(async () => await f.workflows.dispatchCandidates(producerCaller, tx), {
      code: 'forbidden',
    });
  });
  await assert.rejects(async () => await f.workflows.dispatchCandidates(producerCaller), {
    code: 'forbidden',
  });
  const malicious = f.rules({ readOnly: false, tools: [] }, async (tx) => {
    await tx.run('UPDATE actors SET active=0 WHERE id=?', f.source.actorId);
  });
  const handle = await f.workflows.register(definition('caller-revoked-mid-scan'), malicious);
  await handle.start(f.source, { workflow: 'caller-revoked-mid-scan', requestId: 'mid-scan' });
  // In the caller's transaction the revocation lands, and the closing decision refuses it.
  await assert.rejects(
    f.state.transaction(async (tx) => await f.workflows.dispatchCandidates(f.source, tx)),
    { code: 'forbidden' },
  );
  // On its own, discovery is a read: State refuses the write itself.
  await assert.rejects(async () => await f.workflows.dispatchCandidates(f.source), {
    code: 'invalid_workflow_policy',
  });
  await assert.doesNotReject(
    async () => await f.scope.require(f.source, 'read'),
    'Failed discovery rolls back callback writes',
  );
});

test('a dispatch callback that moves the instance fails the scan, excluded or refused', async (t) => {
  const f = await fixture(t);
  const move = async (tx: Transaction, id: string) =>
    await tx.run(`UPDATE wf_instances SET data_json='{"moved":true}' WHERE id=?`, id);
  const excluding = f.rules({ readOnly: false, tools: [] });
  excluding.assignments![0].lease!.role = () => 'producer';
  excluding.assignments![0].lease!.excludes = async ({ snapshot, tx }) => {
    await move(tx, snapshot.id);
    return true;
  };
  const first = await f.workflows.register(definition('moved-by-excludes'), excluding);
  const excluded = await first.start(f.source, {
    workflow: 'moved-by-excludes',
    requestId: 'excluded',
  });
  // In the caller's transaction the write lands, and the recheck after every row refuses it;
  // on its own, discovery is a read and State refuses the write itself.
  await assert.rejects(
    f.state.transaction(async (tx) => await f.workflows.dispatchCandidates(f.source, tx, 'w')),
    { code: 'invalid_workflow_policy', status: 500 },
  );
  await assert.rejects(f.workflows.dispatchCandidates(f.source, undefined, 'w'), {
    code: 'invalid_workflow_policy',
    status: 500,
  });
  // Without a worker nothing is excluded, so the callback never runs.
  assert.deepEqual(
    (await f.workflows.dispatchCandidates(f.source)).map((item) => item.instanceId),
    [excluded.id],
  );
  first.dispose();
  // A refusal still skips the row, but not a write made before it.
  const refusing = f.rules({ readOnly: false, tools: [] });
  refusing.assignments![0].lease!.role = async ({ snapshot, tx }): Promise<'producer'> => {
    await move(tx, snapshot.id);
    check(false, 'not_ready', 'Inputs are not ready', 409);
    return 'producer';
  };
  const second = await f.workflows.register(definition('moved-then-refused'), refusing);
  await second.start(f.source, { workflow: 'moved-then-refused', requestId: 'refused' });
  await assert.rejects(
    f.state.transaction(async (tx) => await f.workflows.dispatchCandidates(f.source, tx)),
    { code: 'invalid_workflow_policy', status: 500 },
  );
  await assert.rejects(f.workflows.dispatchCandidates(f.source), {
    code: 'invalid_workflow_policy',
    status: 500,
  });
  const stored = await f.state.read(
    async (sql) =>
      await sql.all<{ data_json: string }>(
        'SELECT data_json FROM wf_instances WHERE workflow IN (?,?)',
        'moved-by-excludes',
        'moved-then-refused',
      ),
  );
  assert.ok(
    stored.every((row) => !row.data_json.includes('moved')),
    'failed scans roll back',
  );
});
