import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import '@merv/contracts';

/** Assessment reads and claiming; target programs own verdict application tools. */
export const reviewToolsPlugin = {
  name: 'merv-review-tools',
  inject: ['tools', 'reviews'],
  apply(ctx: Context) {
    for (const tool of [
      {
        name: 'review.list',
        description:
          'List immutable review requests and their claim/verdict status in the current project.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: (caller: Parameters<typeof ctx.reviews.list>[0]) => ctx.reviews.list(caller),
      },
      {
        name: 'review.get',
        description:
          'Read a review’s pinned artifact IDs, criteria, target revision, and snapshot hash.',
        inputSchema: z.object({ reviewId: z.string().min(1) }).strict(),
        readOnly: true,
        handler: (caller: Parameters<typeof ctx.reviews.get>[0], input: { reviewId: string }) =>
          ctx.reviews.get(caller, input.reviewId),
      },
      {
        name: 'review.start',
        description:
          'Claim a review as an independent reviewer. Retrying with the same reviewer is safe; a different reviewer cannot take over.',
        inputSchema: z.object({ reviewId: z.string().min(1) }).strict(),
        handler: (caller: Parameters<typeof ctx.reviews.start>[0], input: { reviewId: string }) =>
          ctx.reviews.start(caller, input.reviewId),
      },
    ])
      ctx.effect(() => ctx.tools.register(tool));
  },
};
export default reviewToolsPlugin;
