import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { conversationRules } from '../packages/pi/src/conversation-rules.js';
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
    dispatch: {
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
          stuck: {
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
          },
        };
      },
    },
    statusSections: async () => ({}),
  } as unknown as Sessions;
  const result = await systemStatus(caller, sessions);
  assert.equal(result.scope, 'project');
  if (result.scope !== 'project') throw new Error('Expected project status');
  assert.deepEqual(seen, ['project-a']);
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
  tools.registerCallerRules('conversation', conversationRules);
  const sessions = {
    dispatch: {
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
        stuck: { total: 0, counts: {}, items: [], truncated: false },
      }),
    },
    statusSections: async () => ({}),
  } as unknown as Sessions;
  sessionsToolsPlugin.apply({
    tools,
    sessions,
    effect: (register: () => unknown) => register(),
  } as unknown as Context);
  const listed = await tools.describe(caller);
  assert.equal(
    listed.find((tool) => tool.name === 'system.status')?.annotations?.readOnlyHint,
    true,
  );
  const value = await tools.call('system.status', caller, {});
  assert.equal((value as { dispatch: { state: string } }).dispatch.state, 'paused');
  allowed = false;
  await assert.rejects(tools.call('system.status', caller, {}), { code: 'forbidden' });
});
