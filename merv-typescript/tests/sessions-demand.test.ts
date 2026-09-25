import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  createService,
  MervError,
  type Caller,
  type Data,
  type WorkflowWorkspacePolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { postgresMigrations } from '../packages/sessions/src/dispatch.postgres.js';
import { countWrites, openState } from './fixtures/state.js';

const platform = { name: 'codex', harness: 'codex' as const, enabled: true, parallelism: 1 };
const profile = { platform };
const secret = () => `ms_${randomBytes(32).toString('base64url')}`;

async function fixture(t: TestContext, maxLaunchFailures = 3) {
  let now = Date.now();
  let rejectBuild = false;
  const state = await openState();
  const scope = await createService(new ProjectScope(state, () => now));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      clock: () => now,
      maxLaunchFailures,
      sweepIntervalMs: 60_000,
    }),
  );
  const boot = await scope.bootstrap({ projectName: 'Demand', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const producer = await scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  const source: Caller = {
    actorId: producer.actor.id,
    projectId: owner.projectId,
    credentialId: producer.credential.id,
  };
  let sequence = 0;
  const register = async (name: string, workspace?: WorkflowWorkspacePolicy) => {
    const handle = await workflows.register(
      {
        name,
        version: 1,
        initial: 'work',
        states: ['work', 'done'],
        terminal: ['done'],
        edges: [{ from: 'work', action: 'finish', to: 'done' }],
      },
      {
        successStates: ['done'],
        actions: [
          {
            name: 'finish',
            states: ['work'],
            transitions: ['finish'],
            tool: 'finish',
            instruction: 'Finish',
            check: async ({ caller, tx }) => {
              await scope.require(caller, 'write', tx);
            },
          },
        ],
        assignments: [
          {
            state: 'work',
            requiresDependencies: true,
            check: async ({ caller, tx }) => {
              await scope.require(caller, 'write', tx);
            },
            build: async () => {
              if (rejectBuild) throw new MervError('context_too_large', 'Context too large', 400);
              return {
                role: 'producer' as const,
                label: 'Work',
                brief: 'Do the work.',
                references: [],
                handoff: { instruction: 'Finish', tools: ['finish'] },
                execution: { readOnly: false, tools: [], ...(workspace ? { workspace } : {}) },
                context: null,
              };
            },
            execution: { readOnly: false, tools: [], ...(workspace ? { workspace } : {}) },
            lease: {
              role: async ({ caller, tx }) => {
                await scope.require(caller, 'write', tx);
                return 'producer' as const;
              },
              acquire: async () => ({}),
              check: async () => {},
              release: async () => {},
            },
          },
        ],
      },
    );
    const start = async (data: Data = {}, dependsOn?: string[]) =>
      await handle.start(source, {
        workflow: name,
        requestId: `start-${++sequence}`,
        data,
        ...(dependsOn ? { dependsOn } : {}),
      });
    return { handle, start };
  };
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  return {
    state,
    scope,
    workflows,
    events,
    sessions,
    owner,
    source,
    register,
    advance(ms: number) {
      now += ms;
    },
    rejectBuild(value: boolean) {
      rejectBuild = value;
    },
    async runner() {
      await sessions.heartbeatRunner(source, {
        runnerId: 'machine',
        machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
        platforms: [platform],
        capacity: 1,
      });
    },
    lease() {
      return sessions.lease(source, {
        runnerId: 'machine',
        requestId: randomBytes(10).toString('hex'),
        secret: secret(),
        platform: { name: 'codex', harness: 'codex' },
      });
    },
  };
}

test('prospective demand shares dispatch, source, dependency, and workspace eligibility without a runner', async (t) => {
  const f = await fixture(t);
  const plain = await f.register('plain');
  const checkout = await f.register('checkout', {
    mode: 'ephemeral',
    namespace: 'demand',
    base: 'central',
    retain: false,
    driver: 'code.v2',
  });
  const first = await plain.start();
  const blocked = await plain.start({}, [first.id]);
  const driven = await checkout.start();
  const demand = () => f.sessions.dispatchDemand(f.source, profile);
  assert.deepEqual(await demand(), { candidates: [] });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.events.drain();
  const writes = countWrites(f.state);
  const before = writes();
  assert.deepEqual(await demand(), { candidates: [{ instanceId: first.id, expectedRevision: 0 }] });
  assert.equal(writes(), before, 'prospective demand does not reserve or write');
  assert.deepEqual(
    await f.sessions.dispatchDemand(f.source, { ...profile, capabilities: ['code.v2'] }),
    {
      candidates: [
        { instanceId: first.id, expectedRevision: 0 },
        { instanceId: driven.id, expectedRevision: 0 },
      ],
    },
  );
  const reader = await f.scope.issueActor(f.owner, { name: 'Reader', role: 'reader' });
  assert.deepEqual(
    await f.sessions.dispatchDemand(
      { ...f.source, actorId: reader.actor.id, credentialId: reader.credential.id },
      profile,
    ),
    { candidates: [] },
  );
  await plain.handle.transition(f.source, {
    instanceId: first.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'finish-first',
  });
  assert.deepEqual(await demand(), {
    candidates: [{ instanceId: blocked.id, expectedRevision: 0 }],
  });
});

test('prospective demand respects offer failure backoff without a runner-specific history', async (t) => {
  const f = await fixture(t);
  const work = await f.register('failing-offer');
  const target = await work.start();
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.runner();
  f.rejectBuild(true);
  await assert.rejects(f.lease(), { code: 'context_too_large' });
  f.rejectBuild(false);
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), { candidates: [] });
  f.advance(30_001);
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), {
    candidates: [{ instanceId: target.id, expectedRevision: 0 }],
  });
});

test('prospective demand applies budgets, live leases, and durable holds', async (t) => {
  const f = await fixture(t, 1);
  const work = await f.register('work');
  const first = await work.start();
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.sessions.setBudget(f.owner, { instanceId: first.id, maxTokens: 1 });
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), {
    candidates: [{ instanceId: first.id, expectedRevision: 0 }],
  });
  await f.sessions.setBudget(f.owner, { instanceId: first.id, maxTokens: null });
  await f.sessions.setBudget(f.owner, { maxWallMinutes: 1 });
  await f.runner();
  const offered = (await f.lease()).session!;
  assert.ok(offered);
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), { candidates: [] });
  await f.sessions.release(f.source, {
    sessionId: offered.id,
    runnerId: 'machine',
    outcome: 'host_failed',
  });
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), { candidates: [] });
  // Choosing the hardware is not the go-ahead that clears a hold; only the switch is.
  await f.sessions.setDispatch(f.owner, { ownMachines: true });
  await f.sessions.setDispatch(f.owner, { ownMachines: false });
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), { candidates: [] });
  await f.sessions.releaseHold(f.owner, {
    instanceId: first.id,
    expectedRevision: 0,
    reason: 'Fixed',
    requestId: 'release-hold',
  });
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), {
    candidates: [{ instanceId: first.id, expectedRevision: 0 }],
  });
  await f.sessions.setBudget(f.owner, { maxWallMinutes: null, maxTokens: 1 });
  assert.deepEqual(
    await f.sessions.dispatchDemand(f.source, profile),
    { candidates: [] },
    'unreported usage withholds a project budget',
  );
});

test('a project on its own machines shows Fleet no demand, and its own runner still leases', async (t) => {
  const f = await fixture(t);
  const target = await (await f.register('own')).start();
  await f.sessions.setDispatch(f.owner, { enabled: true, ownMachines: true });
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), { candidates: [] });
  await f.sessions.setDispatch(f.owner, { ownMachines: false });
  assert.deepEqual(await f.sessions.dispatchDemand(f.source, profile), {
    candidates: [{ instanceId: target.id, expectedRevision: 0 }],
  });
  await f.sessions.setDispatch(f.owner, { ownMachines: true });
  await f.runner();
  const leased = await f.lease();
  assert.equal(leased.session?.instanceId, target.id, leased.reason);
});

test('a project whose dispatch was on before the upgrade keeps its own machines', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  // The release before: session_dispatch stops at version 4.
  const migrate = state.migrate.bind(state);
  state.migrate = (component, migrations) =>
    migrate(
      component,
      migrations.filter((m) => component !== 'session_dispatch' || m.version < 5),
    );
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  state.migrate = migrate;
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  const projects = [];
  for (const enabled of [1, 0]) {
    const boot = await scope.bootstrap({ projectName: `Before ${enabled}`, actorName: 'Owner' });
    await state.transaction((tx) =>
      tx.run(
        'INSERT INTO project_session_dispatch(project_id,enabled,updated_at,updated_by) VALUES(?,?,?,?)',
        boot.project.id,
        enabled,
        new Date().toISOString(),
        boot.actor.id,
      ),
    );
    projects.push({
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    });
  }
  await state.migrate(
    'session_dispatch',
    Object.entries(postgresMigrations).map(([version, sql]) => ({ version: +version, sql })),
  );
  const read = async (caller: Caller) => {
    const { enabled, ownMachines } = (await sessions.projectStatus(caller)).dispatch;
    return [enabled, ownMachines];
  };
  assert.deepEqual(await Promise.all(projects.map(read)), [
    [true, true],
    [false, false],
  ]);
});
