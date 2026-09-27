import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type { Fleet } from '@merv/fleet/types';
import type { Sessions } from '@merv/sessions/types';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { systemStatus } from '../packages/sessions/src/system-status.js';
import { sessionsToolsPlugin } from '../packages/sessions/src/tools.js';

const caller: Caller = {
  actorId: 'person',
  projectId: 'project-a',
  conversation: { id: 'conversation', epoch: 1, commandId: 'command', runtimeId: 'runtime' },
};

test('system status reports authoritative dispatch, waiting work, and unusable workspace blocker', async () => {
  const seen: string[] = [];
  const onlyProject = (candidate: Caller) => {
    seen.push(candidate.projectId);
    assert.equal(candidate.projectId, 'project-a');
  };
  const sessions = {
    projectStatus: async (candidate: Caller) => {
      onlyProject(candidate);
      return {
        observedAt: '2026-09-26T00:00:00Z',
        dispatch: { enabled: true, ownMachines: false, fleet: true },
        runnerTotal: 1,
        runners: [
          {
            runnerId: 'runner',
            live: false,
            capacity: 1,
            lastSeenAt: 'before',
            lastDecision: null,
            secret: 'omit',
          },
        ],
        liveSessionCount: 0,
        sessionTotal: 0,
        sessions: [],
        queueTotal: 1,
        queue: [
          {
            instanceId: 'task-1',
            expectedRevision: 2,
            workflow: 'task',
            label: 'Task',
            role: 'producer',
            updatedAt: 'before',
            workspace: { mode: 'git' },
            secret: 'omit',
          },
        ],
      };
    },
    stuck: async (candidate: Caller) => {
      onlyProject(candidate);
      return {
        total: 1,
        counts: { work_blocked: 1, dispatch_failing: 1 },
        items: [
          {
            kind: 'work_blocked',
            instanceId: 'task-1',
            code: 'runner_incompatible',
            why: 'Fleet cannot supply local Git',
            next: 'Start a project runner',
          },
          {
            kind: 'dispatch_failing',
            instanceId: 'task-2',
            code: 'retrying',
            why: 'Failed at https://private.example/secret?token=abc',
            next: 'Retry shortly',
          },
        ],
        truncated: false,
      };
    },
  } as unknown as Sessions;
  const fleet = {
    list: async (candidate: Caller) => {
      onlyProject(candidate);
      return [
        {
          id: 'allocation',
          owner: { kind: 'workflow', id: 'secret' },
          phase: 'running',
          intent: 'run',
          error: null,
          createdAt: 'before',
          source: { secret: 'omit' },
        },
      ];
    },
  } as unknown as Fleet;
  const result = await systemStatus(caller, sessions, fleet);
  assert.deepEqual(seen, ['project-a', 'project-a', 'project-a']);
  assert.equal(result.dispatch.state, 'running');
  assert.equal(result.workers.liveShown, 0);
  assert.equal(result.waiting.total, 1);
  assert.equal(result.blockers.items[0]?.code, 'runner_incompatible');
  assert.equal(result.blockers.items.length, 2);
  assert.equal(result.blockers.items[1]?.kind, 'dispatch_failing');
  assert.equal(JSON.stringify(result).includes('private.example'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('system.status is a read-only conversation tool and project access is checked', async () => {
  let allowed = true;
  const tools = new ToolRegistry({
    require: async (candidate: Caller) => {
      if (!allowed || candidate.projectId !== 'project-a')
        throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
      return { role: 'operator' } as never;
    },
  });
  const dispose = tools.registerConversationPolicy({
    allowsTool: async (_candidate, name) => !name.startsWith('pi.'),
    validate: async () => {},
  });
  const sessions = {
    projectStatus: async () => ({
      observedAt: 'now',
      dispatch: { enabled: false, ownMachines: true, fleet: false },
      runners: [],
      runnerTotal: 0,
      liveSessionCount: 0,
      sessionTotal: 0,
      sessions: [],
      queue: [],
      queueTotal: 0,
    }),
    stuck: async () => ({ total: 0, counts: {}, items: [], truncated: false }),
  } as unknown as Sessions;
  const fleet = { list: async () => [] } as unknown as Fleet;
  sessionsToolsPlugin.apply({
    tools,
    sessions,
    get: (name: string) => (name === 'fleet' ? fleet : undefined),
    effect: (register: () => unknown) => register(),
  } as unknown as Context);
  const listed = await tools.describe(caller);
  assert.equal(
    listed.find((tool) => tool.name === 'system.status')?.annotations?.readOnlyHint,
    true,
  );
  assert.equal(
    listed.some((tool) => tool.name === 'pi.send'),
    false,
  );
  const value = await tools.call('system.status', caller, {});
  assert.equal((value as { dispatch: { state: string } }).dispatch.state, 'paused');
  allowed = false;
  await assert.rejects(tools.call('system.status', caller, {}), { code: 'forbidden' });
  dispose();
});
