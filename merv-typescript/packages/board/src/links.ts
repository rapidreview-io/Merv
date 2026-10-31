import type { Context } from 'cordis';
import type { StoredEvent } from '@merv/contracts';

/**
 * What a send to Fleet became. Pi makes the task and is asked to name the frozen file in its goal,
 * as the worker needs it to; Tasks' event says which files a goal names. A separate entry, as Board
 * itself requires State and Scope alone: without this one a send simply never learns its task.
 */
export const boardLinksPlugin = {
  name: 'merv-board-links',
  inject: ['board', 'domainEvents'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      yield await ctx.domainEvents.subscribe({
        id: 'board.outcome-tasks.v1',
        types: ['task.created'],
        from: 'now',
        handle: ({ projectId, subjectId, data }: StoredEvent, tx) =>
          ctx.board.taskMade(projectId, subjectId, (data.files as string[]) ?? [], tx),
      });
    });
  },
};
export default boardLinksPlugin;
