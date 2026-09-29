import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import { LeasedSessions } from '@merv/sessions';
import { sessionsToolsPlugin } from '@merv/sessions/tools';
import { fleetToolsPlugin } from '../packages/fleet/src/tools.js';

const person: Caller = { actorId: 'person', projectId: 'project-a' };
const worker: Caller = { ...person, actorId: 'worker', session: { id: 'session-1' } };
const queue = [
  { instanceId: 'task-1', expectedRevision: 2 },
  { instanceId: 'task-2', expectedRevision: 5 },
];

async function status(t: TestContext, workflow?: { blocked: boolean; retryFails?: boolean }) {
  const listed: number[] = [];
  const retried: unknown[] = [];
  const handlers = new Map<string, (caller: Caller, input: object) => Promise<unknown>>();
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('tools', {
    register: (tool: {
      name: string;
      handler: (caller: Caller, input: object) => Promise<unknown>;
    }) => {
      handlers.set(tool.name, tool.handler);
      return () => handlers.delete(tool.name);
    },
  });
  // Sessions' own seam over a stub of the reads system.status makes.
  ctx.provide('sessions', {
    statusSections: new Map(),
    contributeStatus: LeasedSessions.prototype.contributeStatus,
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
    }),
    stuck: async () => ({ total: 0, counts: {}, items: [], truncated: false }),
    describe: async () => ({ id: 'session-1', projectId: 'project-a', assignment: {} }),
  });
  ctx.provide('fleet', {
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
  });
  if (workflow)
    ctx.provide('fleetWorkflow', {
      modelBudget: async () => ({
        blocked: workflow.blocked,
        blockReason: workflow.blocked ? 'last_refused_reservation_unaffordable' : null,
        resetsAt: '2026-09-27T00:00:00.000Z',
        tokens: 20_000_000,
      }),
      retryStatus: async (_caller: Caller, targets: typeof queue) => {
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
        ].map((item) => ({ retryAvailable: false, next: 'Wait.', ...item }));
      },
    });
  await ctx.plugin(sessionsToolsPlugin);
  const fleetTools = ctx.plugin(fleetToolsPlugin);
  await fleetTools;
  // One plugin per key: a second 'fleet' section is refused.
  assert.throws(() => ctx.sessions.contributeStatus('fleet', async () => null), {
    code: 'status_section_registered',
  });
  const read = async (caller: Caller) =>
    JSON.parse(JSON.stringify(await handlers.get('system.status')!(caller, {}))) as Record<
      string,
      unknown
    >;
  return { read, listed, retried, fleetTools };
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
const projectKeys = ['scope', 'projectId', 'observedAt', 'dispatch', 'workers', 'fleet'];
const blocked = {
  blocked: true,
  reason: 'last_refused_reservation_unaffordable',
  resetsAt: '2026-09-27T00:00:00.000Z',
  next: 'Raise the Fleet daily token limit in Settings or wait for the UTC reset.',
};

test('Fleet contributes its system.status sections where Sessions put them', async (t) => {
  const { read, listed, retried } = await status(t, { blocked: true });
  const project = await read(person);
  assert.deepEqual(Object.keys(project), [...projectKeys, 'sessions', 'waiting', 'blockers']);
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
  assert.deepEqual(Object.keys(session), ['scope', 'projectId', 'session', 'modelBudget']);
  assert.deepEqual(session.modelBudget, blocked);
  assert.deepEqual(listed, [0]);
});

test('without the workflow Fleet reports allocations alone, and nothing once unloaded', async (t) => {
  const open = await status(t, { blocked: false, retryFails: true });
  assert.deepEqual((await open.read(person)).fleet, {
    available: true,
    modelBudget: { blocked: false, reason: null, resetsAt: '2026-09-27T00:00:00.000Z' },
    retryBlocked: { available: false, truncated: true, items: [] },
    allocations,
  });
  const alone = await status(t);
  const project = await alone.read(person);
  assert.deepEqual(project.fleet, {
    available: true,
    modelBudget: null,
    retryBlocked: { available: false, truncated: true, items: [] },
    allocations,
  });
  assert.equal((await alone.read(worker)).modelBudget, null);
  await alone.fleetTools.dispose();
  assert.deepEqual(Object.keys(await alone.read(person)), [
    ...projectKeys.slice(0, -1),
    'sessions',
    'waiting',
    'blockers',
  ]);
  assert.deepEqual(Object.keys(await alone.read(worker)), ['scope', 'projectId', 'session']);
});
