import { createService, type Caller, type WorkflowPolicy } from '@merv/contracts';
import { DurableEvents } from '@merv/domain-events';
import { ProjectScope } from '@merv/scope';
import { LeasedSessions } from '@merv/sessions';
import { systemStatus } from '@merv/sessions/system-status';
import { WorkflowsService } from '@merv/workflows';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { countWrites, openState } from './fixtures/state.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const platform = { name: 'codex', harness: 'codex' as const, model: 'fixture-model' };

async function fixture(t: TestContext) {
  let clock = Date.now();
  const state = await openState();
  const scope = await createService(new ProjectScope(state, () => clock));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const assignment = (
    phase: string,
    role: 'producer' | 'reviewer',
  ): NonNullable<WorkflowPolicy['assignments']>[number] => ({
    state: phase,
    check: async ({ caller, tx }) => {
      await scope.require(caller, role === 'reviewer' ? 'review' : 'write', tx);
    },
    build: () => ({
      role,
      label: `${phase} work`,
      brief: 'Do the work',
      references: [],
      handoff: { instruction: 'Submit', tools: [] },
      execution: { readOnly: role === 'reviewer', tools: [] },
      context: null,
    }),
    execution: { readOnly: role === 'reviewer', tools: [] },
    lease: { role: () => role, acquire: ({ leaseId }) => ({ leaseId }), check() {}, release() {} },
  });
  const handle = await workflows.register(
    {
      name: 'budget-visibility',
      version: 1,
      initial: 'working',
      states: ['working', 'review', 'done'],
      terminal: ['done'],
      edges: [
        { from: 'working', action: 'submit', to: 'review' },
        { from: 'review', action: 'approve', to: 'done' },
      ],
    },
    {
      successStates: ['done'],
      actions: ['submit', 'approve'].map((name) => ({
        name,
        states: [name === 'submit' ? 'working' : 'review'],
        transitions: [name],
        tool: name,
        instruction: name,
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
      })),
      assignments: [assignment('working', 'producer'), assignment('review', 'reviewer')],
    },
  );
  const boot = await scope.credentials.bootstrap({ projectName: 'Budget', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      clock: () => clock,
      sweepIntervalMs: 60_000,
    }),
  );
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  await sessions.dispatch.setDispatch(owner, { enabled: true, ownMachines: false });
  const daily = { blocked: false };
  sessions.contributeStatus('modelBudget', async () => daily);
  const heartbeat = () =>
    sessions.dispatch.heartbeatRunner(owner, {
      runnerId: 'machine',
      machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
      platforms: [{ ...platform, enabled: true, parallelism: 4 }],
      capacity: 4,
    });
  await heartbeat();
  const status = async () => {
    // This is the project.read status handler; no Fleet or runner decision supplies its budgets.
    const result = await systemStatus(owner, sessions);
    assert.equal(result.scope, 'project');
    if (result.scope !== 'project') throw new Error('Expected project status');
    return result;
  };
  const lease = async () => {
    await heartbeat();
    return sessions.dispatch.lease(owner, {
      runnerId: 'machine',
      requestId: randomUUID(),
      secret: secret(),
      platform,
    });
  };
  return {
    state,
    owner,
    sessions,
    status,
    lease,
    heartbeat,
    daily,
    advance: (ms: number) => (clock += ms),
    start: (dependsOn?: string[]) =>
      handle.start(owner, { workflow: 'budget-visibility', requestId: randomUUID(), dependsOn }),
    async move(instanceId: string, action: string) {
      const { revision } = await workflows.get(owner, instanceId);
      await state.transaction((tx) =>
        handle.transition(
          owner,
          { instanceId, expectedRevision: revision, action, requestId: randomUUID() },
          tx,
        ),
      );
    },
    async active(instanceId: string) {
      const { revision } = await workflows.get(owner, instanceId);
      const token = secret();
      const session = await sessions.offer(owner, {
        instanceId,
        expectedRevision: revision,
        runnerId: 'machine',
        requestId: randomUUID(),
        secret: token,
      });
      const control = { sessionId: session.id, runnerId: 'machine' };
      await sessions.attach(owner, { ...control, hostRef: randomUUID() });
      await sessions.authenticate(token);
      return control;
    },
    async demand() {
      return (
        await sessions.dispatch.dispatchDemand(owner, {
          platform: { ...platform, enabled: true, parallelism: 4 },
        })
      ).candidates.map((item) => item.instanceId);
    },
  };
}

test('a just-queued reviewer exposes the reached project budget without a prior refused lease', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  await f.sessions.dispatch.setBudget(f.owner, { maxTokens: 150_000, maxWallMinutes: 60 });
  const control = await f.active(unit.id);
  f.advance(64_020);
  await f.sessions.release(f.owner, {
    ...control,
    usage: { inputTokens: 207_750, outputTokens: 2_640 },
  });
  await f.move(unit.id, 'submit');
  await f.heartbeat();

  const writes = countWrites(f.state);
  const status = await f.status();
  const stuck = await f.sessions.dispatch.stuck(f.owner);
  assert.equal(writes(), 0, 'Diagnostic reads must not mutate budget, queue, or session facts');
  assert.ok('modelBudget' in status);
  assert.deepEqual(status.modelBudget, f.daily, 'Daily Fleet spending is a separate status');
  assert.equal(status.budgets.length, 1);
  const budget = status.budgets[0]!;
  assert.equal(budget.kind, 'project');
  assert.equal(budget.scopeId, f.owner.projectId);
  assert.equal(budget.maxTokens, 150_000);
  assert.equal(budget.maxWallMs, 3_600_000);
  assert.deepEqual(budget.used, { wallMs: 64_020, tokens: 210_390 });
  assert.deepEqual(budget.exceeded, ['tokens']);
  assert.deepEqual(budget.unavailable, []);
  assert.equal(Object.hasOwn(budget, 'instanceIds'), false);
  const item = status.blockers.items.find((item) => item.instanceId === unit.id)!;
  assert.ok(item);
  assert.equal(status.blockers.total, 1);
  assert.equal(status.blockers.counts.ready_quiet, 1);
  assert.equal(item.kind, 'ready_quiet');
  assert.equal(item.code, 'budget_exceeded');
  assert.ok(item.forSeconds < stuck.thresholds.quietReadySeconds);
  assert.deepEqual(item.budgets, [budget]);
  assert.deepEqual(stuck.items.find((item) => item.instanceId === unit.id)!.budgets, [budget]);
  assert.match(item.next, /session\.write budget/);
  assert.match(item.next, /admin/i);
  assert.match(item.why, /budget/i);
  assert.equal(status.workers.runners[0]!.lastDecision, null);
  assert.deepEqual(await f.demand(), []);
  assert.equal((await f.lease()).reason, 'budget_exceeded');

  await f.sessions.dispatch.setBudget(f.owner, { maxTokens: 300_000 });
  const resumed = await f.status();
  assert.equal(resumed.workers.runners[0]!.lastDecision, 'budget_exceeded');
  assert.equal(
    resumed.blockers.items.some((item) => item.instanceId === unit.id),
    false,
  );
  assert.deepEqual(resumed.budgets[0]!.exceeded, []);
  assert.ok('modelBudget' in resumed);
  assert.deepEqual(resumed.modelBudget, f.daily);
  assert.deepEqual(await f.demand(), [unit.id]);
  assert.equal((await f.lease()).session?.role, 'reviewer');
});

test('an ancestor dependency budget names the covering scope and leaves unrelated work admissible', async (t) => {
  const f = await fixture(t);
  const child = await f.start();
  const parent = await f.start([child.id]);
  const sibling = await f.start();
  await f.sessions.dispatch.setBudget(f.owner, { instanceId: parent.id, maxTokens: 100 });
  const control = await f.active(child.id);
  await f.sessions.release(f.owner, {
    ...control,
    usage: { inputTokens: 110, outputTokens: 0 },
  });
  await f.move(child.id, 'submit');
  const status = await f.status();
  const item = status.blockers.items.find((item) => item.instanceId === child.id)!;
  assert.equal(item.code, 'budget_exceeded');
  assert.equal(item.budgets?.[0]!.scopeId, parent.id);
  assert.equal(item.budgets?.[0]!.kind, 'instance');
  assert.equal(item.budgets?.[0]!.used.tokens, 110);
  assert.equal(Object.hasOwn(item.budgets![0]!, 'instanceIds'), false);
  assert.equal(
    status.blockers.items.some((item) => item.instanceId === sibling.id),
    false,
  );
  assert.deepEqual(await f.demand(), [sibling.id]);
  await f.sessions.dispatch.setBudget(f.owner, { instanceId: parent.id, maxTokens: null });
  const cleared = await f.status();
  assert.equal(
    cleared.blockers.items.some((item) => item.code === 'budget_exceeded'),
    false,
  );
  assert.ok((await f.demand()).includes(child.id));
});

for (const kind of ['project', 'ancestor'] as const)
  test(`${kind} budget: unreported usage stays unknown and increasing a bound does not promise recovery`, async (t) => {
    const f = await fixture(t);
    const unit = await f.start();
    const parent = kind === 'ancestor' ? await f.start([unit.id]) : null;
    const scope = parent ? { instanceId: parent.id } : {};
    await f.sessions.dispatch.setBudget(f.owner, { ...scope, maxTokens: 100 });
    const control = await f.active(unit.id);
    await f.sessions.release(f.owner, control);
    await f.move(unit.id, 'submit');
    const status = await f.status();
    const budget = status.budgets[0]!;
    assert.equal(budget.scopeId, parent?.id ?? f.owner.projectId);
    assert.equal(budget.kind, parent ? 'instance' : 'project');
    assert.equal(budget.used.tokens, null);
    assert.equal(budget.unreportedSessions, 1);
    assert.deepEqual(budget.exceeded, []);
    assert.deepEqual(budget.unavailable, ['tokens']);
    const item = status.blockers.items.find((item) => item.instanceId === unit.id)!;
    assert.equal(item.code, 'usage_unavailable');
    assert.deepEqual(item.budgets, [budget]);
    assert.match(item.next, /account|report/i);
    assert.match(item.next, /clear/i);
    assert.equal((await f.lease()).reason, 'usage_unavailable');
    await f.sessions.dispatch.setBudget(f.owner, { ...scope, maxTokens: 1000 });
    assert.equal((await f.lease()).reason, 'usage_unavailable');
    await f.sessions.release(f.owner, { ...control, usage: { inputTokens: 10, outputTokens: 5 } });
    const reported = await f.status();
    assert.equal(reported.budgets[0]!.used.tokens, 15);
    assert.equal(reported.budgets[0]!.unreportedSessions, 0);
    assert.deepEqual(reported.budgets[0]!.unavailable, []);
    assert.equal(
      reported.blockers.items.some((item) => item.instanceId === unit.id),
      false,
    );
    assert.deepEqual(new Set(await f.demand()), new Set([unit.id, ...(parent ? [parent.id] : [])]));
  });

test('known budgets do not turn fresh allowed work, active sessions, or paused dispatch into budget blockers', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  await f.sessions.dispatch.setBudget(f.owner, { maxTokens: 100 });
  assert.equal(
    (await f.status()).blockers.items.some((item) => item.instanceId === unit.id),
    false,
  );
  assert.deepEqual(await f.demand(), [unit.id]);
  const first = await f.active(unit.id);
  await f.sessions.release(f.owner, { ...first, usage: { inputTokens: 1, outputTokens: 0 } });
  await f.move(unit.id, 'submit');
  const control = await f.active(unit.id);
  await f.sessions.dispatch.setBudget(f.owner, { maxTokens: 1 });
  const active = await f.status();
  assert.equal(active.sessions.live, 1, 'A budget does not end an existing visit');
  assert.equal(
    active.blockers.items.some((item) => item.instanceId === unit.id),
    false,
  );
  await f.sessions.release(f.owner, { ...control, usage: { inputTokens: 0, outputTokens: 0 } });
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: false });
  const paused = await f.status();
  assert.equal(paused.budgets[0]!.exceeded.includes('tokens'), true);
  assert.equal(
    paused.blockers.items.some((item) => item.code === 'budget_exceeded'),
    false,
  );
  assert.equal((await f.lease()).reason, 'dispatch_disabled');
});

test('overlapping unknown project and exceeded instance limits expose both without changing project-first admission', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const other = await f.start();
  const known = await f.active(unit.id);
  await f.sessions.release(f.owner, { ...known, usage: { inputTokens: 110, outputTokens: 0 } });
  const unknown = await f.active(other.id);
  await f.sessions.release(f.owner, unknown);
  await f.sessions.dispatch.setBudget(f.owner, { maxTokens: 1000 });
  await f.sessions.dispatch.setBudget(f.owner, { instanceId: unit.id, maxTokens: 100 });
  const item = (await f.status()).blockers.items.find((item) => item.instanceId === unit.id)!;
  assert.equal(item.code, 'budget_exceeded');
  assert.equal(item.budgets?.length, 2);
  assert.deepEqual(item.budgets!.find((budget) => budget.kind === 'project')!.unavailable, [
    'tokens',
  ]);
  assert.deepEqual(item.budgets!.find((budget) => budget.kind === 'instance')!.exceeded, [
    'tokens',
  ]);
  assert.equal((await f.lease()).reason, 'usage_unavailable');
});
