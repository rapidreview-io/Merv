import {
  createService,
  MervError,
  type Caller,
  type WorkflowDefinition,
  type WorkflowLoopLimit,
  type WorkflowPolicy,
  type WorkflowTransition,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import assert from 'node:assert/strict';

import test, { type TestContext } from 'node:test';
import { openState } from './fixtures/state.js';

const definition: WorkflowDefinition = {
  name: 'draft',
  version: 1,
  initial: 'drafting',
  states: ['drafting', 'in_review', 'approved', 'abandoned'],
  terminal: ['approved', 'abandoned'],
  edges: [
    { from: 'drafting', action: 'submit', to: 'in_review' },
    { from: 'drafting', action: 'abandon', to: 'abandoned' },
    { from: 'in_review', action: 'approve', to: 'approved' },
    { from: 'in_review', action: 'return', to: 'drafting' },
    { from: 'in_review', action: 'restart', to: 'drafting' },
    { from: 'in_review', action: 'reissue', to: 'in_review' },
  ],
};
const returns = (max: number): WorkflowLoopLimit => ({
  name: 'review_returns',
  from: 'in_review',
  actions: ['return', 'restart'],
  max,
});
const policy = (limits?: WorkflowLoopLimit[], lease = false): WorkflowPolicy => ({
  successStates: ['approved'],
  ...(limits ? { limits } : {}),
  actions: [
    {
      name: 'submit',
      tool: 'draft.submit',
      states: ['drafting'],
      transitions: ['submit'],
      instruction: 'Submit the draft.',
      check: () => {},
    },
    {
      name: 'abandon',
      tool: 'draft.abandon',
      states: ['drafting'],
      transitions: ['abandon'],
      suggested: false,
      instruction: 'Abandon the draft.',
      check: () => {},
    },
    // One rule owns the pass and both returns, as a review verdict does.
    {
      name: 'verdict',
      tool: 'review.submit',
      states: ['in_review'],
      transitions: ['approve', 'return', 'restart', 'reissue'],
      instruction: 'Submit a verdict.',
      check: () => {},
    },
  ],
  ...(lease
    ? {
        assignments: [
          {
            state: 'in_review',
            check: () => {},
            build: () => {
              throw new Error('Discovery must not render an assignment');
            },
            execution: { readOnly: true, tools: [] },
            lease: {
              role: () => 'reviewer' as const,
              acquire: () => {
                throw new Error('Discovery must not reserve');
              },
              check: () => {},
              release: () => {},
            },
          },
        ],
      }
    : {}),
});

async function fixture(t: TestContext) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
  });
  const boot = await scope.credentials.bootstrap({ projectName: 'Limits', actorName: 'Owner' });
  const owner: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  // Each test registers one graph, and moves its instances through that graph's handle.
  let handle: Awaited<ReturnType<typeof workflows.register>> | undefined;
  const register: typeof workflows.register = async (definition, policy) =>
    (handle = await workflows.register(definition, policy));
  const start = async (requestId: string) =>
    await handle!.start(owner, { workflow: 'draft', requestId });
  let sequence = 0;
  const move = async (instanceId: string, action: string, requestId = `move-${++sequence}`) =>
    await handle!.transition(owner, {
      instanceId,
      action,
      requestId,
      expectedRevision: (await workflows.get(owner, instanceId)).revision,
    });
  /** Submit and have the work returned, `rounds` times over, then submit once more. */
  const loop = async (instanceId: string, rounds: number, action = 'return') => {
    for (let round = 0; round < rounds; round++) {
      await move(instanceId, 'submit');
      await move(instanceId, action);
    }
    return await move(instanceId, 'submit');
  };
  const events = async (type: string) =>
    (await state.events(owner.projectId)).filter((event) => event.type === type);
  const transition = async (input: WorkflowTransition) => await handle!.transition(owner, input);
  /** How many moves wf_history records for the instance. */
  const moves = async (id: string) =>
    (await state.read((sql) => sql.all('SELECT 1 FROM wf_history WHERE instance_id=?', id))).length;
  return { state, scope, workflows, owner, register, start, move, transition, loop, events, moves };
}
const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof MervError && error.code === code && error.status === status;

test('a capped loop permits its rounds, refuses the next, and leaves the record untouched', async (t) => {
  const f = await fixture(t);
  await f.register(definition, policy([returns(2)]));
  const instance = await f.start('start');
  // The two actions of one limit are counted together.
  await f.move(instance.id, 'submit');
  await f.move(instance.id, 'return');
  await f.move(instance.id, 'submit');
  const last = await f.move(instance.id, 'restart', 'last-return');
  assert.deepEqual(await f.events('workflow.escalated'), []);
  const arrived = await f.move(instance.id, 'submit');
  const history = await f.moves(instance.id);
  const eventCount = (await f.state.events(f.owner.projectId)).length;
  for (const action of ['return', 'restart'])
    await assert.rejects(
      f.move(instance.id, action),
      (error: unknown) =>
        refused('loop_limit_reached', 409)(error) &&
        /review_returns is exhausted on this draft \(2\/2\)/.test((error as Error).message),
    );
  assert.deepEqual(await f.workflows.get(f.owner, instance.id), arrived);
  assert.equal(await f.moves(instance.id), history);
  assert.equal((await f.state.events(f.owner.projectId)).length, eventCount);
  // A retry of the last permitted return is still answered with what it recorded.
  assert.deepEqual(
    await f.transition({
      instanceId: instance.id,
      action: 'restart',
      requestId: 'last-return',
      expectedRevision: last.revision - 1,
    }),
    last,
  );
  // Arrival at the exhausted limit is recorded once; reads and a step that stays record none.
  const escalated = await f.events('workflow.escalated');
  assert.equal(escalated.length, 1);
  assert.deepEqual(escalated[0].data, {
    workflow: 'draft',
    version: 1,
    revision: arrived.revision,
    state: 'in_review',
    limit: 'review_returns',
    used: 2,
    max: 2,
  });
  await f.workflows.evaluate(f.owner, instance.id);
  await f.workflows.overview(f.owner);
  await f.move(instance.id, 'reissue');
  assert.equal((await f.events('workflow.escalated')).length, 1);
  // The work is not failed: the uncapped ending stays open.
  assert.equal((await f.move(instance.id, 'approve')).state, 'approved');
});

test('only a project admin who is not a leased worker may extend a limit', async (t) => {
  const f = await fixture(t);
  await f.register(definition, policy([returns(1)]));
  const instance = await f.start('start');
  const grant = {
    instanceId: instance.id,
    limit: 'review_returns',
    additional: 1,
    reason: 'Agreed',
    requestId: 'grant',
  };
  await assert.rejects(f.workflows.extendLimit({ ...f.owner, session: { id: 'lease' } }, grant), {
    code: 'forbidden',
    status: 403,
    message: 'A leased worker cannot raise its own limit',
  });
  for (const role of ['producer', 'reviewer'] as const) {
    const { actor } = await f.scope.credentials.issueActor(f.owner, { name: role, role });
    await assert.rejects(
      f.workflows.extendLimit({ projectId: f.owner.projectId, actorId: actor.id }, grant),
      (error: unknown) => error instanceof MervError && error.status === 403,
    );
  }
  const other = await f.scope.credentials.bootstrap({
    projectName: 'Elsewhere',
    actorName: 'Stranger',
  });
  await assert.rejects(
    f.workflows.extendLimit({ projectId: other.project.id, actorId: other.actor.id }, grant),
    refused('not_found', 404),
  );
  assert.deepEqual(await f.events('workflow.limit_extended'), []);
});
