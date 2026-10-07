import type { Context } from 'cordis';
import { check, keyId, keyKind } from '@merv/contracts';
import type { Caller, Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import { TASK_STATES } from './running.js';

export const taskUiPlugin = {
  name: 'merv-task-ui',
  inject: ['tasks', 'ui'],
  apply(ctx: Context) {
    const tasks = ctx.tasks;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'tasks',
        label: 'Tasks',
        // Reached from the Work page and its records; the rail does not list it.
        group: 'hidden',
        order: 15,
        path: '/tasks',
        workflow: 'task',
        states: TASK_STATES,
        view: { kind: 'tasks' },
        home: {
          tool: 'task.list',
          keep: [
            'id',
            'title',
            'goal',
            'producerId',
            'dependencies',
            'dependents',
            'failure',
            'workflow',
            'settled',
            'failed',
          ],
        },
        needs: { name: 'title', owner: 'producerId', reads: { in_review: 'Review this delivery' } },
        // One record, with the stage it stands at and its history, both from one graph read
        // without running an action's check: the page polls this and draws no action.
        read: async (caller: Caller, params) => {
          const id = params?.id;
          check(
            typeof id === 'string' && id.length > 0,
            'invalid_input',
            'params.id names the record',
          );
          return JSON.parse(
            JSON.stringify({
              task: await tasks.get(caller, id),
              ...(await tasks.page(caller, id)),
              codeUnit: await tasks.codeUnit(caller, id),
            }),
          ) as Json;
        },
        status: async (caller: Caller) => ({ count: await tasks.active(caller) }),
      }),
    );
    // The work lane's tasks and a task's sidebar on the Running page, as the service reads them.
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'tasks',
        kinds: ['work'],
        workflows: ['task'],
        lanes: ['work'],
        nodes: async (read) => ({ nodes: await tasks.running(read.caller, read.include) }),
        panel: async (read, key) =>
          keyKind(key) === 'work'
            ? await tasks.runningPanel(read.caller, keyId(key), read.route)
            : null,
      }),
    );
  },
};
export default taskUiPlugin;
