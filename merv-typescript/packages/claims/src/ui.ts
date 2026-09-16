import type { Context } from 'cordis';
import type {} from '@merv/ui/types';

export const claimsUiPlugin = {
  name: 'merv-claims-ui',
  inject: ['claims', 'ui'],
  apply(ctx: Context) {
    // A claim book is consulted, not worked through, so the row carries no count:
    // every number in the chrome means open against the project.
    ctx.effect(() =>
      ctx.ui.register({
        id: 'claims',
        label: 'Claims',
        group: 'work',
        order: 15,
        path: '/claims',
        view: { kind: 'claims' },
      }),
    );
  },
};
export default claimsUiPlugin;
