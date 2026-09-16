import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
export const consolidationUiPlugin = {
  name: 'merv-consolidation-ui',
  inject: ['consolidation', 'ui'],
  apply(ctx: Context) {
    const service = ctx.consolidation;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'consolidation',
        label: 'Consolidation',
        group: 'work',
        order: 19,
        path: '/consolidation',
        view: { kind: 'consolidation' },
        read: async (caller) => JSON.parse(JSON.stringify(await service.list(caller))) as Json,
        status: async (caller) => ({
          count: (await service.list(caller)).filter((r) => r.workflow.state !== 'complete').length,
        }),
      }),
    );
  },
};
export default consolidationUiPlugin;
