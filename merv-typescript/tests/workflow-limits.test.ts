import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MervError,
  type Caller,
  type WorkflowDefinition,
  type WorkflowLoopLimit,
  type WorkflowPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
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
  const boot = await scope.bootstrap({ projectName: 'Limits', actorName: 'Owner' });
  const owner: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  let sequence = 0;
  const move = async (instanceId: string, action: string, requestId = `move-${++sequence}`) =>
    await workflows.transition(owner, {
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
  return { state, scope, workflows, owner, move, loop, events };
}
const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof MervError && error.code === code && error.status === status;

test('a policy may only cap declared returning edges, each once, within bounds', async (t) => {
  const f = await fixture(t);
  const invalid: [string, WorkflowLoopLimit[]][] = [
    ['an undeclared state', [{ ...returns(2), from: 'nowhere' }]],
    ['a terminal state', [{ ...returns(2), from: 'approved' }]],
    ['an action that does not leave the state', [{ ...returns(2), actions: ['submit'] }]],
    ['a step that stays where it is', [{ ...returns(2), actions: ['reissue'] }]],
    ['no actions', [{ ...returns(2), actions: [] }]],
    ['a repeated action', [{ ...returns(2), actions: ['return', 'return'] }]],
    ['an edge in two limits', [returns(2), { ...returns(2), name: 'again', actions: ['return'] }]],
    ['a duplicate name', [returns(2), { ...returns(2), from: 'drafting', actions: ['submit'] }]],
    ['a blank name', [{ ...returns(2), name: '' }]],
    ['a zero cap', [returns(0)]],
    ['a fractional cap', [returns(1.5)]],
    ['a cap above a thousand', [returns(1001)]],
  ];
  for (const [label, limits] of invalid)
    await assert.rejects(
      f.workflows.register(definition, policy(limits)),
      refused('invalid_workflow_policy', 400),
      label,
    );
  // The engine writes its own bookkeeping into history under these names.
  await assert.rejects(
    f.workflows.register(
      {
        ...definition,
        name: 'reserved',
        edges: [
          ...definition.edges,
          { from: 'in_review', action: 'add_dependencies', to: 'drafting' },
        ],
      },
      {
        ...policy([{ ...returns(2), actions: ['add_dependencies'] }]),
        actions: policy().actions.map((rule) =>
          rule.name === 'verdict'
            ? { ...rule, transitions: [...rule.transitions!, 'add_dependencies'] }
            : rule,
        ),
      },
    ),
    refused('invalid_workflow_policy', 400),
  );
  const limits = [returns(2)];
  await f.workflows.register(definition, policy(limits));
  // The installed cap is a copy: changing the caller's object changes nothing.
  limits[0].max = 1;
  limits[0].actions.push('approve');
  const instance = await f.workflows.start(f.owner, { workflow: 'draft', requestId: 'start' });
  await f.move(instance.id, 'submit');
  const [status] = (await f.workflows.evaluate(f.owner, instance.id)).limits;
  assert.deepEqual([status.base, status.actions], [2, ['return', 'restart']]);
});

test('a capped loop permits its rounds, refuses the next, and leaves the record untouched', async (t) => {
  const f = await fixture(t);
  await f.workflows.register(definition, policy([returns(2)]));
  const instance = await f.workflows.start(f.owner, { workflow: 'draft', requestId: 'start' });
  // The two actions of one limit are counted together.
  await f.move(instance.id, 'submit');
  await f.move(instance.id, 'return');
  await f.move(instance.id, 'submit');
  const last = await f.move(instance.id, 'restart', 'last-return');
  assert.deepEqual(await f.events('workflow.escalated'), []);
  const arrived = await f.move(instance.id, 'submit');
  const history = (await f.workflows.history(f.owner, instance.id)).length;
  const eventCount = (await f.state.events(f.owner.projectId)).length;
  for (const action of ['return', 'restart'])
    await assert.rejects(
      f.move(instance.id, action),
      (error: unknown) =>
        refused('loop_limit_reached', 409)(error) &&
        /review_returns is exhausted on this draft \(2\/2\)/.test((error as Error).message),
    );
  assert.deepEqual(await f.workflows.get(f.owner, instance.id), arrived);
  assert.equal((await f.workflows.history(f.owner, instance.id)).length, history);
  assert.equal((await f.state.events(f.owner.projectId)).length, eventCount);
  // A retry of the last permitted return is still answered with what it recorded.
  assert.deepEqual(
    await f.workflows.transition(f.owner, {
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

test('guidance names the exhausted limit, keeps the human action, and the overview escalates', async (t) => {
  const f = await fixture(t);
  await f.workflows.register(definition, policy([returns(1)], true));
  const instance = await f.workflows.start(f.owner, { workflow: 'draft', requestId: 'start' });
  const open = await f.workflows.start(f.owner, { workflow: 'draft', requestId: 'open' });
  await f.move(open.id, 'submit');
  assert.deepEqual((await f.workflows.evaluate(f.owner, instance.id)).limits, []);
  await f.move(instance.id, 'submit');
  const fresh = await f.workflows.evaluate(f.owner, instance.id);
  assert.deepEqual(fresh.limits, [
    {
      name: 'review_returns',
      from: 'in_review',
      actions: ['return', 'restart'],
      base: 1,
      granted: 0,
      max: 1,
      used: 0,
      remaining: 1,
      exhausted: false,
    },
  ]);
  assert.equal(fresh.currentGate, 'in_review');
  assert.deepEqual(
    (await f.workflows.dispatchCandidates(f.owner)).map((item) => item.instanceId).sort(),
    [instance.id, open.id].sort(),
  );
  await f.move(instance.id, 'return');
  await f.move(instance.id, 'submit');

  // A human opening the review sees the limit while `begin` stays available to them.
  const decision = await f.workflows.evaluate(f.owner, instance.id);
  assert.equal(decision.currentGate, 'loop_limit_reached');
  assert.equal(decision.nextAction?.action, 'begin');
  assert.equal(decision.nextAction?.status, 'ready');
  assert.deepEqual(
    decision.blockers.map((blocker) => [blocker.code, blocker.status]),
    [['loop_limit_reached', 409]],
  );
  assert.match(decision.instruction, /^review_returns is exhausted on this draft \(1\/1\)/);
  assert.equal(decision.actions.find((action) => action.action === 'verdict')?.status, 'ready');
  assert.deepEqual(
    decision.limits.map((limit) => [limit.used, limit.max, limit.remaining, limit.exhausted]),
    [[1, 1, 0, true]],
  );
  // A question about one action is answered for that action.
  assert.equal(
    (await f.workflows.evaluate(f.owner, instance.id, { action: 'verdict' })).currentGate,
    'in_review',
  );

  const overview = await f.workflows.overview(f.owner);
  assert.deepEqual(overview.escalated, [instance.id]);
  assert.deepEqual(overview.ready, [open.id]);
  assert.deepEqual(overview.blocked, []);
  assert.deepEqual(overview.stalled, []);

  // Nothing is dispatched for it until an admin allows another round.
  assert.deepEqual(
    (await f.workflows.dispatchCandidates(f.owner)).map((item) => item.instanceId),
    [open.id],
  );
  const status = await f.workflows.extendLimit(f.owner, {
    instanceId: instance.id,
    limit: 'review_returns',
    additional: 1,
    reason: 'One more round was agreed',
    requestId: 'grant',
  });
  assert.equal(status.exhausted, false);
  assert.deepEqual(
    (await f.workflows.dispatchCandidates(f.owner)).map((item) => item.instanceId).sort(),
    [instance.id, open.id].sort(),
  );
  const after = await f.workflows.overview(f.owner);
  assert.deepEqual(after.escalated, []);
  assert.deepEqual(after.ready.sort(), [instance.id, open.id].sort());
  assert.equal((await f.move(instance.id, 'return')).state, 'drafting');
});

test('only a project admin who is not a leased worker may extend a limit', async (t) => {
  const f = await fixture(t);
  await f.workflows.register(definition, policy([returns(1)]));
  const instance = await f.workflows.start(f.owner, { workflow: 'draft', requestId: 'start' });
  const grant = {
    instanceId: instance.id,
    limit: 'review_returns',
    additional: 1,
    reason: 'Agreed',
    requestId: 'grant',
  };
  await assert.rejects(
    f.workflows.extendLimit({ ...f.owner, session: { id: 'lease' } }, grant),
    refused('forbidden', 403),
  );
  for (const role of ['producer', 'reviewer'] as const) {
    const { actor } = await f.scope.issueActor(f.owner, { name: role, role });
    await assert.rejects(
      f.workflows.extendLimit({ projectId: f.owner.projectId, actorId: actor.id }, grant),
      (error: unknown) => error instanceof MervError && error.status === 403,
    );
  }
  const other = await f.scope.bootstrap({ projectName: 'Elsewhere', actorName: 'Stranger' });
  await assert.rejects(
    f.workflows.extendLimit({ projectId: other.project.id, actorId: other.actor.id }, grant),
    refused('not_found', 404),
  );
  assert.deepEqual(await f.events('workflow.limit_extended'), []);
});

test('a grant is idempotent, append-only, additive, and changes no revision', async (t) => {
  const f = await fixture(t);
  await f.workflows.register(definition, policy([returns(1)]));
  const instance = await f.workflows.start(f.owner, { workflow: 'draft', requestId: 'start' });
  const arrived = await f.loop(instance.id, 1);
  const grant = {
    instanceId: instance.id,
    limit: 'review_returns',
    additional: 2,
    reason: '  The reviewer asked for one more pass  ',
    requestId: 'grant-1',
  };
  await assert.rejects(
    f.workflows.extendLimit(f.owner, { ...grant, limit: 'unheard_of' }),
    refused('unknown_limit', 404),
  );
  for (const additional of [0, 1.5, 101])
    await assert.rejects(
      f.workflows.extendLimit(f.owner, { ...grant, additional }),
      refused('invalid_input', 400),
    );
  await assert.rejects(
    f.workflows.extendLimit(f.owner, { ...grant, reason: '   ' }),
    refused('invalid_input', 400),
  );
  const history = (await f.workflows.history(f.owner, instance.id)).length;
  const first = await f.workflows.extendLimit(f.owner, grant);
  assert.deepEqual(
    [first.base, first.granted, first.max, first.used, first.remaining, first.exhausted],
    [1, 2, 3, 1, 2, false],
  );
  assert.deepEqual(await f.workflows.extendLimit(f.owner, grant), first);
  await assert.rejects(
    f.workflows.extendLimit(f.owner, { ...grant, additional: 3 }),
    refused('request_conflict', 409),
  );
  // A request id belongs to one command across the whole engine.
  await assert.rejects(
    f.workflows.extendLimit(f.owner, { ...grant, requestId: 'start' }),
    refused('request_conflict', 409),
  );
  const second = await f.workflows.extendLimit(f.owner, { ...grant, requestId: 'grant-2' });
  assert.deepEqual([second.granted, second.max], [4, 5]);
  assert.equal(typeof second.max, 'number');

  assert.deepEqual(await f.workflows.get(f.owner, instance.id), arrived);
  assert.equal((await f.workflows.history(f.owner, instance.id)).length, history);
  const extended = await f.events('workflow.limit_extended');
  assert.deepEqual(
    extended.map((event) => event.data),
    [3, 5].map((max) => ({
      workflow: 'draft',
      version: 1,
      limit: 'review_returns',
      additional: 2,
      max,
      used: 1,
      reason: 'The reviewer asked for one more pass',
    })),
  );
  await assert.rejects(
    f.state.transaction(
      async (tx) => await tx.run('UPDATE wf_limit_grants SET additional=additional+100'),
    ),
    // PostgreSQL's trigger refuses it too, but State never forwards a server's own words.
    { code: 'state_constraint' },
  );
  await assert.rejects(
    f.state.transaction(async (tx) => await tx.run('DELETE FROM wf_limit_grants')),
    { code: 'state_constraint' },
  );

  await f.move(instance.id, 'approve');
  await assert.rejects(
    f.workflows.extendLimit(f.owner, { ...grant, requestId: 'too-late' }),
    refused('invalid_transition', 409),
  );
  // What was granted while it lived is still answered after it ended.
  assert.equal((await f.workflows.extendLimit(f.owner, grant)).granted, 4);
});

test('a lower cap deployed on the same version escalates live work from its history', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-limits-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'merv.db');
  const state = await openState(path);
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const boot = await scope.bootstrap({ projectName: 'Limits', actorName: 'Owner' });
  const owner: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  await workflows.register(definition, policy());
  const instance = await workflows.start(owner, { workflow: 'draft', requestId: 'start' });
  let revision = 0;
  for (const action of ['submit', 'return', 'submit', 'return', 'submit'])
    await workflows.transition(owner, {
      instanceId: instance.id,
      action,
      requestId: `move-${revision}`,
      expectedRevision: revision++,
    });
  assert.deepEqual((await workflows.overview(owner)).escalated, []);
  workflows.close();
  await state.close();

  const restarted = await openState(path);
  const next = await createService(
    new WorkflowsService(restarted, await createService(new ProjectScope(restarted))),
  );
  t.after(async () => {
    next.close();
    await restarted.close();
  });
  // The same definition version: a cap is policy, so nothing is republished or upgraded.
  await next.register(definition, policy([returns(1)]));
  const decision = await next.evaluate(owner, instance.id);
  assert.equal(decision.version, 1);
  assert.equal(decision.currentGate, 'loop_limit_reached');
  assert.deepEqual(
    decision.limits.map((limit) => [limit.used, limit.max, limit.exhausted]),
    [[2, 1, true]],
  );
  assert.deepEqual((await next.overview(owner)).escalated, [instance.id]);
  await assert.rejects(
    next.transition(owner, {
      instanceId: instance.id,
      action: 'return',
      requestId: 'one-too-many',
      expectedRevision: revision,
    }),
    refused('loop_limit_reached', 409),
  );
});
