import type { Context } from 'cordis';
import { check } from '@merv/contracts';
import type { Caller, Json } from '@merv/contracts';
import type {} from '@merv/ui/types';

export const taskUiPlugin = {
  name: 'merv-task-ui',
  inject: ['tasks', 'ui'],
  apply(ctx: Context) {
    const tasks = ctx.tasks;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'tasks',
        label: 'Tasks',
        group: 'work',
        order: 15,
        path: '/tasks',
        view: { kind: 'tasks' },
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
            }),
          ) as Json;
        },
        status: async (caller: Caller) => ({
          count: (await tasks.list(caller)).filter(
            (task) => !['done', 'failed'].includes(task.workflow.state),
          ).length,
        }),
      }),
    );
  },
};
export default taskUiPlugin;
