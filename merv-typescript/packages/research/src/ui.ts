import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
export const researchUiPlugin = {
  name: 'merv-research-ui',
  inject: ['research', 'ui'],
  apply(ctx: Context) {
    const research = ctx.research;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'research',
        label: 'Cycles',
        group: 'work',
        order: 14,
        path: '/research',
        view: { kind: 'research' },
        read: async (caller) => JSON.parse(JSON.stringify(await research.list(caller))) as Json,
        status: async (caller) => ({
          count: (await research.list(caller)).filter(
            (record) => record.workflow.state !== 'complete',
          ).length,
        }),
      }),
    );
  },
};
export default researchUiPlugin;
