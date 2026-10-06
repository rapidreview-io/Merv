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
        // Reached from the Work page and its records; the rail does not list it.
        group: 'hidden',
        order: 17,
        path: '/reviews',
        view: { kind: 'reviews' },
        home: {
          tool: 'review.list',
          keep: [
            'id',
            'subjectId',
            'subjectRevision',
            'status',
            'reviewerId',
            'claimable',
            'verdict',
            'returnTo',
            'findings',
            'createdAt',
            'open',
            'returned',
          ],
        },
        status: async (caller: Caller) => ({ count: await reviews.open(caller) }),
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
