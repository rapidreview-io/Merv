import type { Context } from 'cordis';
import type {} from '@merv/ui/types';
import type {} from './types.js';

export const knowledgeUiPlugin = {
  name: 'merv-knowledge-ui',
  inject: ['knowledge', 'ui'],
  apply(ctx: Context) {
    const knowledge = ctx.knowledge;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'knowledge',
        label: 'Records',
        group: 'work',
        order: 17,
        path: '/knowledge',
        view: { kind: 'knowledge' },
        status: async (caller) => {
          const records = await knowledge.records(caller);
          return {
            count: records.claims.length + records.tasks.length + records.experiments.length,
          };
        },
      }),
    );
  },
};
export default knowledgeUiPlugin;
