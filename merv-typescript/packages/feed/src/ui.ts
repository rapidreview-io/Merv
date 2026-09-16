import type { Context } from 'cordis';
import type {} from '@merv/ui/types';

export const feedUiPlugin = {
  name: 'merv-feed-ui',
  inject: ['feed', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'feed',
        label: 'Feed',
        group: 'activity',
        order: 30,
        path: '/feed',
        view: { kind: 'feed' },
      }),
    );
  },
};
export default feedUiPlugin;
