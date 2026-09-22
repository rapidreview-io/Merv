import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';

export const codeUiPlugin = {
  name: 'merv-code-ui',
  inject: ['codeResearch', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'code',
        label: 'Code',
        group: 'work',
        order: 25,
        path: '/code',
        view: { kind: 'code' },
        // `commands` are the commit receipts; the store transfers of the same name are
        // inside status. A sealed proposal is read on the record that made it, not here.
        read: async (caller) =>
          ({
            commands: await ctx.codeResearch.list(caller),
            status: await ctx.codeResearch.status(caller),
          }) as unknown as Json,
      }),
    );
  },
};
export default codeUiPlugin;
