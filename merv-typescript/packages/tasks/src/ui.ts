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
        // One record, with the gate it stands at: the process graph is derived from the
        // same record, so the page reads both in one answer rather than two.
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
              process: await tasks.process(caller, id),
              codeUnit: await tasks.codeUnit(caller, id),
              // Its history as its sidebar tells it.
              history: (await tasks.runningPanel(caller, id))?.unit?.history ?? [],
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
