/**
 * How the engine authorizes a caller and fences its callbacks: one Scope decision per caller at
 * a method's entry, and after every group of callbacks one reread of the instance's stored
 * columns, skipped only where State already refuses every write.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  createService,
  type Caller,
  type Transaction,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowLease,
  type WorkflowPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { openState } from './fixtures/state.js';

const graph: WorkflowDefinition = {
  name: 'authorized',
  version: 1,
  initial: 'open',
  states: ['open', 'done'],
  terminal: ['done'],
  edges: [{ from: 'open', action: 'finish', to: 'done' }],
};

async function fixture(t: TestContext) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
  });
  const boot = await scope.bootstrap({ projectName: 'Authority', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const source = await scope.delegationSource(owner);
  scope.registerSessionAuthority({ require: async () => source });
  const worker = async (sessionId: string): Promise<Caller> => {
    const actor = await state.transaction((tx) =>
      scope.createSessionActor(source, { sessionId, name: 'Worker', role: 'producer' }, tx),
    );
    return { actorId: actor.id, projectId: actor.projectId, session: { id: sessionId } };
  };
  /** What the guard does to the instance it checks, on the transaction it is given. */
  const fault: { write?: (tx: Transaction, id: string) => Promise<unknown> } = {};
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    actions: [
      {
        name: 'finish',
        states: ['open'],
        transitions: ['finish'],
        tool: 'authorized.finish',
        instruction: 'Finish.',
        check: async ({ tx, snapshot }) => void (await fault.write?.(tx, snapshot.id)),
      },
    ],
    assignments: [
      {
        state: 'open',
        check: () => {},
        build: () => ({
          role: 'producer',
          label: 'Work',
          brief: 'Work.',
          references: [],
          handoff: { instruction: 'Finish.', tools: ['authorized.finish'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: { readOnly: false, tools: [] },
        lease: {
          role: () => 'producer' as const,
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const handle = await workflows.register(graph, policy);
  let sequence = 0;
  const start = async () =>
    await handle.start(owner, { workflow: graph.name, requestId: `start-${++sequence}` });
  return { state, scope, workflows, owner, worker, fault, handle, start };
}

test('each caller method authorizes its caller once, at entry', async (t) => {
  const f = await fixture(t);
  const [first] = [await f.start(), await f.start(), await f.start()];
  const require = t.mock.method(f.scope, 'require');
  /** Scope decisions `operation` made, per caller. */
  const decisions = async (operation: () => Promise<unknown>) => {
    require.mock.resetCalls();
    await operation();
    const counts: Record<string, number> = {};
    for (const call of require.mock.calls) {
      const { actorId } = call.arguments[0] as Caller;
      counts[actorId] = (counts[actorId] ?? 0) + 1;
    }
    return counts;
  };
  const owner = (count: number) => ({ [f.owner.actorId]: count });
  assert.deepEqual(await decisions(() => f.workflows.evaluate(f.owner, first.id)), owner(1));
  assert.deepEqual(
    await decisions(() => f.workflows.evaluate(f.owner, first.id, { action: 'finish', input: {} })),
    owner(1),
  );
  assert.deepEqual(await decisions(() => f.workflows.process(f.owner, first.id)), owner(1));
  assert.deepEqual(await decisions(() => f.workflows.overview(f.owner)), owner(1));
  assert.deepEqual(await decisions(() => f.workflows.assignment(f.owner, first.id)), owner(1));
  // Discovery authorizes its source at entry and once more after every row's callbacks.
  assert.deepEqual(await decisions(() => f.workflows.dispatchCandidates(f.owner)), owner(2));
  assert.deepEqual(
    await decisions(() =>
      f.workflows.leaseRole(f.owner, { instanceId: first.id, expectedRevision: 0 }),
    ),
    owner(1),
  );
  const worker = await f.worker('lease_counted');
  let lease: WorkflowLease | undefined;
  let execution: WorkflowExecution | undefined;
  assert.deepEqual(
    await decisions(async () => {
      ({ lease, execution } = await f.workflows.offerLease(f.owner, worker, {
        instanceId: first.id,
        expectedRevision: 0,
        leaseId: 'lease_counted',
      }));
    }),
    { ...owner(2), [worker.actorId]: 1 },
  );
  const once = { [worker.actorId]: 1 };
  assert.deepEqual(await decisions(() => f.workflows.checkLease(worker, lease!)), once);
  assert.deepEqual(
    await decisions(() =>
      f.workflows.authorizeLeaseDispatch(worker, lease!, execution!, {
        tool: 'workflow.status_and_next',
        input: {},
        read: true,
      }),
    ),
    once,
  );
  assert.deepEqual(await decisions(() => f.workflows.activateLease(worker, lease!)), once);
  assert.deepEqual(
    await decisions(() =>
      f.workflows.begin(f.owner, { instanceId: first.id, expectedRevision: 0 }),
    ),
    owner(1),
  );
  assert.deepEqual(
    await decisions(() =>
      f.handle.transition(f.owner, {
        instanceId: first.id,
        expectedRevision: 0,
        action: 'finish',
        requestId: 'finish',
      }),
    ),
    owner(1),
  );
});

test('a callback that writes the instance fails the call; under a snapshot State refuses the write', async (t) => {
  const f = await fixture(t);
  const instance = await f.start();
  const tampered = { code: 'invalid_workflow_policy', status: 500 };
  const rewrite = (data: string) => async (tx: Transaction, id: string) =>
    await tx.run('UPDATE wf_instances SET data_json=? WHERE id=?', data, id);
  const transition = (tx?: Transaction) =>
    f.handle.transition(
      f.owner,
      { instanceId: instance.id, expectedRevision: 0, action: 'finish', requestId: 'finish' },
      tx,
    );
  // The stored columns are compared as read: equal data in other bytes is a write too.
  for (const data of ['{"tampered":true}', '{ }']) {
    f.fault.write = rewrite(data);
    await assert.rejects(
      f.state.transaction((tx) => f.workflows.evaluate(f.owner, instance.id, {}, tx)),
      tampered,
      data,
    );
    await assert.rejects(transition(), tampered, data);
  }
  // In a snapshot the reread is skipped: State refuses the write itself.
  f.fault.write = rewrite('{"tampered":true}');
  await assert.rejects(
    f.state.snapshot(() => f.workflows.evaluate(f.owner, instance.id)),
    tampered,
  );
  // The write rolled back each time.
  f.fault.write = undefined;
  const current = await f.workflows.get(f.owner, instance.id);
  assert.deepEqual([current.revision, current.data], [0, {}]);
  // A command in a bare snapshot writes nothing.
  await assert.rejects(
    f.state.snapshot(() => transition()),
    { code: 'read_only_scope' },
  );
  await assert.rejects(
    f.state.snapshot(() => f.start()),
    { code: 'read_only_scope' },
  );
  assert.equal((await transition()).state, 'done');
});
