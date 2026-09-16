import type { Context } from 'cordis';
import type {} from '@merv/ui/types';
import type {} from './types.js';

export const claimsUiPlugin = {
  name: 'merv-claims-ui',
  inject: ['claims', 'ui'],
  apply(ctx: Context) {
    const claims = ctx.claims;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'claims',
        label: 'Claims',
        group: 'work',
        order: 15,
        path: '/claims',
        view: { kind: 'claims' },
        status: async (caller) => ({ count: (await claims.list(caller)).length }),
      }),
    );
  },
};
export default claimsUiPlugin;
