import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
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
