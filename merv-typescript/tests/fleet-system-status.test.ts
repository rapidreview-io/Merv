import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Context } from 'cordis';
import type { Caller, Scope, State } from '@merv/contracts';
import { LeasedSessions } from '@merv/sessions';
import type { Sessions } from '@merv/sessions/types';
import { sessionsToolsPlugin } from '@merv/sessions/tools';
import type { Fleet } from '@merv/fleet/types';
import { FleetWorkflowAdapter } from '../packages/fleet/src/workflow.js';

const person: Caller = { actorId: 'person', projectId: 'project-a' };
const worker: Caller = { ...person, actorId: 'worker', session: { id: 'session-1' } };
const queue = [
  { instanceId: 'task-1', expectedRevision: 2 },
  { instanceId: 'task-2', expectedRevision: 5 },
];
const budget = (blocked: boolean) => ({
  blocked,
  blockReason: blocked ? 'last_refused_reservation_unaffordable' : null,
  resetsAt: '2026-09-27T00:00:00.000Z',
});

/** system.status over Sessions' own seam and a stub of its reads, with a started workflow
 * adapter whose Fleet, model budget and retry reads are stubbed. */
async function status(t: TestContext) {
  const listed: number[] = [];
  const retried: unknown[] = [];
  const sessions = {
    sections: new Map(),
    contributeStatus: LeasedSessions.prototype.contributeStatus,
    statusSections: LeasedSessions.prototype.statusSections,
    managed: { registerValidator: () => () => undefined },
    dispatch: {
      projectStatus: async () => ({
        observedAt: 'now',
        dispatch: { enabled: true, ownMachines: false, fleet: true },
        runnerTotal: 0,
        runners: [],
        liveSessionCount: 0,
        sessionTotal: 0,
        sessions: [],
        queueTotal: 3,
        queue: queue.map((item) => ({ ...item, workspace: { mode: 'none' } })),
        stuck: { total: 0, counts: {}, items: [], truncated: false },
      }),
    },
    session: async () => ({ id: 'session-1', projectId: 'project-a', assignment: {} }),
  } as unknown as Sessions;
  const fleet = {
    registerOwner: () => () => undefined,
    list: async (caller: Caller, limit: number) => {
      assert.equal(caller, person);
      listed.push(limit);
      return [
        {
          id: 'open',
          owner: { kind: 'workflow', id: 'secret' },
          phase: 'running',
          intent: 'run',
          error: null,
          createdAt: 'before',
          source: { secret: 'omit' },
        },
        { id: 'gone', owner: { kind: 'chat' }, phase: 'released', intent: null, error: null },
        {
          id: 'failed',
          owner: { kind: 'chat', id: 'secret' },
          phase: 'releasing',
          intent: 'stop',
          error: 'boom',
          createdAt: 'later',
        },
      ];
    },
  } as unknown as Fleet;
  const adapter = new FleetWorkflowAdapter(
    fleet,
    sessions,
    {} as Scope,
    {
      enabled: true,
      people: ['*'],
      // Unset, so the adapter's first pass rents nothing.
      modelApiKeyEnv: 'MERV_FLEET_STATUS_TEST_UNSET',
      baseUrl: 'https://merv.example.test',
      pollIntervalMs: 60_000,
    },
    Date.now,
    { migrate: async () => undefined } as unknown as State,
  );
  t.after(() => adapter.close());
  await adapter.start();
  const workflow = { budget: budget(true) as ReturnType<typeof budget> | null, retryFails: false };
  adapter.modelBudget = async () =>
    workflow.budget && ({ ...workflow.budget, tokens: 20_000_000 } as typeof workflow.budget);
  adapter.retryStatus = async (_caller, targets) => {
    retried.push(
      targets.map(({ instanceId, expectedRevision }) => ({ instanceId, expectedRevision })),
    );
    if (workflow.retryFails) throw new Error('down');
    return [
      {
        instanceId: 'task-1',
        expectedRevision: 2,
        state: 'exhausted_unclaimed',
        unclaimedAttempts: 2,
        attemptLimit: 2,
        retryAvailable: true,
        next: 'An administrator may retry this exact revision.',
      },
      { ...queue[1], state: 'exhausted_unclaimed', unclaimedAttempts: 1, attemptLimit: 1 },
      { ...queue[0], state: 'retrying', unclaimedAttempts: 1, attemptLimit: 2 },
    ].map((item) => ({ retryAvailable: false, next: 'Wait.', ...item })) as never;
  };
  let handler!: (caller: Caller, input: object) => Promise<unknown>;
  sessionsToolsPlugin.apply({
    sessions,
    tools: {
      register: (tool: { name: string; handler: typeof handler }) => {
        if (tool.name === 'system.status') handler = tool.handler;
      },
      contributeInstructions: () => () => {},
    },
    effect: (register: () => unknown) => register(),
  } as unknown as Context);
  const read = async (caller: Caller) =>
    JSON.parse(JSON.stringify(await handler(caller, {}))) as Record<string, unknown>;
  return { read, listed, retried, workflow, adapter, sessions };
}

const allocations = [
  {
    id: 'open',
    owner: 'workflow',
    phase: 'running',
    intent: 'run',
    error: null,
    createdAt: 'before',
  },
  {
    id: 'failed',
    owner: 'chat',
    phase: 'releasing',
    intent: 'stop',
    error: 'boom',
    createdAt: 'later',
  },
];
const blocked = {
  blocked: true,
  reason: 'last_refused_reservation_unaffordable',
  resetsAt: '2026-09-27T00:00:00.000Z',
  next: 'Raise the Fleet daily token limit in Settings or wait for the UTC reset.',
};
const projectKeys = ['scope', 'projectId', 'observedAt', 'dispatch', 'workers'];
const sessionKeys = ['scope', 'projectId', 'session'];
const rest = ['sessions', 'waiting', 'blockers'];

test('Fleet contributes its system.status sections where Sessions put them', async (t) => {
  const { read, listed, retried, sessions } = await status(t);
  const project = await read(person);
  assert.deepEqual(Object.keys(project), [...projectKeys, 'fleet', ...rest]);
  assert.deepEqual(project.fleet, {
    available: true,
    modelBudget: blocked,
    retryBlocked: {
      available: true,
      truncated: true,
      items: [
        {
          instanceId: 'task-1',
          expectedRevision: 2,
          reason: '2/2 created Fleet machines ended before claiming work.',
          next: 'An administrator may retry this exact revision.',
          tool: 'fleet.workflow_retry',
        },
        {
          instanceId: 'task-2',
          expectedRevision: 5,
          reason: '1/1 created Fleet machines ended before claiming work.',
          next: 'Wait.',
        },
      ],
    },
    allocations,
  });
  assert.deepEqual(retried, [queue]);
  assert.equal(JSON.stringify(project).includes('secret'), false);
  assert.equal(JSON.stringify(project).includes('20000000'), false);
  // A leased worker reads its own model budget, never the project's machines.
  const session = await read(worker);
  assert.deepEqual(Object.keys(session), [...sessionKeys, 'modelBudget']);
  assert.deepEqual(session.modelBudget, blocked);
  assert.deepEqual(listed, [0]);
  // One plugin per key.
  assert.throws(() => sessions.contributeStatus('fleet', async () => null), {
    code: 'status_section_registered',
  });
});

test('Fleet reports what it cannot read, and nothing once its adapter closes', async (t) => {
  const { read, workflow, adapter } = await status(t);
  workflow.budget = budget(false);
  workflow.retryFails = true;
  assert.deepEqual((await read(person)).fleet, {
    available: true,
    modelBudget: { blocked: false, reason: null, resetsAt: '2026-09-27T00:00:00.000Z' },
    retryBlocked: { available: false, truncated: true, items: [] },
    allocations,
  });
  workflow.budget = null;
  assert.equal((await read(worker)).modelBudget, null);
  await adapter.close();
  assert.deepEqual(Object.keys(await read(person)), [...projectKeys, ...rest]);
  assert.deepEqual(Object.keys(await read(worker)), sessionKeys);
});
