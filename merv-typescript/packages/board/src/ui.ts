import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
export const boardUiPlugin = {
  name: 'merv-board-ui',
  inject: ['board', 'ui'],
  apply(ctx: Context) {
    const board = ctx.board;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'boards',
        label: 'Board',
        group: 'research',
        order: 33,
        path: '/boards',
        // A board's id opens on this row's page wherever it is named.
        opens: 'board_',
        view: { kind: 'boards' },
        read: async (caller) => ({ boards: await board.list(caller) }) as unknown as Json,
      }),
    );
  },
};
export default boardUiPlugin;
