import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
export const paperUiPlugin = {
  name: 'merv-paper-ui',
  inject: ['paper', 'ui'],
  apply(ctx: Context) {
    const paper = ctx.paper;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'paper',
        label: 'Paper',
        group: 'work',
        order: 16,
        path: '/paper',
        view: { kind: 'paper' },
        read: async (caller) => (await paper.read(caller)) as unknown as Json,
      }),
    );
  },
};
export default paperUiPlugin;
