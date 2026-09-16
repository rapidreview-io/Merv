import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/ui/types';

export const scopeUiPlugin = {
  name: 'merv-scope-ui',
  inject: ['scope', 'ui'],
  apply(ctx: Context) {
    const scope = ctx.scope;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'people',
        label: 'People and agents',
        group: 'project',
        order: 10,
        path: '/people',
        view: { kind: 'people' },
        status: async (caller: Caller) => {
          const actor = await scope.require(caller, 'read');
          if (caller.human && actor.role !== 'operator') return {};
          return { count: (await scope.actors(caller)).length };
        },
      }),
    );
  },
};
export default scopeUiPlugin;
