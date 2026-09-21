import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';

export const codeUiPlugin = {
  name: 'merv-code-ui',
  inject: ['code', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'code',
        label: 'Code',
        group: 'work',
        order: 25,
        path: '/code',
        view: { kind: 'code' },
        read: async (caller) =>
          ({
            operations: await ctx.code.list(caller),
            proposals: await ctx.code.proposals(caller),
            status: await ctx.code.status(caller),
          }) as unknown as Json,
      }),
    );
  },
};
export default codeUiPlugin;
