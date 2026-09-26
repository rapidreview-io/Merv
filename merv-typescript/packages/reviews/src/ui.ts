import type { Context } from 'cordis';
import { keyId, keyKind, type Caller } from '@merv/contracts';
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
        order: 17,
        path: '/reviews',
        view: { kind: 'reviews' },
        status: async (caller: Caller) => ({
          count: (await reviews.list(caller)).filter(
            (review) => review.status === 'requested' || review.status === 'started',
          ).length,
        }),
      }),
    );
    // A review is not a node of its own: it is a section on the work it judges.
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'reviews',
        sections: async (read, keys) =>
          await reviews.running(
            read.caller,
            keys.filter((key) => keyKind(key) === 'work').map(keyId),
          ),
      }),
    );
  },
};
export default reviewUiPlugin;
