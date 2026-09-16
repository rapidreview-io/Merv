import type { Context } from 'cordis';
import type {} from '@merv/ui/types';

export const scopeUiPlugin = {
  name: 'merv-scope-ui',
  inject: ['scope', 'ui'],
  apply(ctx: Context) {
    // A directory of people is not a queue; counting its rows would put a number
    // in the chrome that never moves and never asks for a click.
    ctx.effect(() =>
      ctx.ui.register({
        id: 'people',
        label: 'People',
        group: 'project',
        order: 10,
        path: '/people',
        view: { kind: 'people' },
      }),
    );
  },
};
export default scopeUiPlugin;
