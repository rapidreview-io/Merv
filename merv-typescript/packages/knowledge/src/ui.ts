import type { Context } from 'cordis';
import type {} from '@merv/ui/types';

export const knowledgeUiPlugin = {
  name: 'merv-knowledge-ui',
  inject: ['knowledge', 'ui'],
  apply(ctx: Context) {
    // An inventory of everything recorded is not a queue, so it reports no
    // number: a count in the chrome always means work still open.
    ctx.effect(() =>
      ctx.ui.register({
        id: 'knowledge',
        label: 'Records',
        group: 'work',
        order: 17,
        path: '/knowledge',
        view: { kind: 'knowledge' },
      }),
    );
  },
};
export default knowledgeUiPlugin;
