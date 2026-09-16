import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/ui/types';

export const reviewUiPlugin = {
  name: 'merv-review-ui',
  inject: ['reviews', 'ui'],
  apply(ctx: Context) {
    const reviews = ctx.reviews;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'reviews',
        label: 'Reviews',
        group: 'work',
        order: 21,
        path: '/reviews',
        view: { kind: 'reviews' },
        status: async (caller: Caller) => ({
          count: (await reviews.list(caller)).filter(
            (review) => review.status === 'requested' || review.status === 'started',
          ).length,
        }),
      }),
    );
  },
};
export default reviewUiPlugin;
