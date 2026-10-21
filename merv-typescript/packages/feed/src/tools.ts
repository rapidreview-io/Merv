import { visible } from '@merv/contracts';
import type { Context } from 'cordis';
import { z } from 'zod';
import type {} from '@merv/api/types';
import type {} from './types.js';

const after = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
export const feedToolsPlugin = {
  name: 'merv-feed-tools',
  inject: ['feed', 'tools'],
  apply(ctx: Context) {
    // Capture this provider so an already admitted call finishes on its original instance.
    const feed = ctx.feed;
    ctx.effect(() =>
      ctx.tools.noun('feed.write', {
        description: 'Post to the project feed: post (an immutable message with attachments).',
        actions: {
          post: {
            description:
              'Post an immutable project message with up to 10 artifact attachments. Producers, reviewers, and operators may post. An identical requestId retry returns the original post.',
            input: z.strictObject({
              body: z.string().min(1).max(8000).refine(visible, 'Post body must be nonblank'),
              artifactIds: z.array(z.string().min(1)).max(10).optional(),
              requestId: z.string().min(1).max(200),
            }),
            was: ['feed.post'],
            handler: async (caller, input) => await feed.post(caller, input),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('feed.read', {
        readOnly: true,
        description:
          'Read the project feed: list (posts in sequence order, a page at a time), get (one post) and activity (durable activity events).',
        actions: {
          list: {
            description:
              'Read project posts in ascending sequence order: the newest page without a cursor, or the page after the exclusive post sequence cursor `after`. limit defaults to 50 and is capped at 100.',
            input: z.object({ after, limit: z.number().int().min(1).max(100).optional() }).strict(),
            was: ['feed.list'],
            handler: async (caller, input) => await feed.list(caller, input),
          },
          get: {
            description: 'Read an immutable post in the current project.',
            input: z.object({ postId: z.string().min(1) }).strict(),
            was: ['feed.get'],
            handler: async (caller, { postId }) => await feed.get(caller, postId),
          },
          activity: {
            description:
              'Read durable activity events for the current project: the newest 1,000 without a cursor, or the 1,000 after the exclusive event ID cursor `after`, which is independent of the feed post sequence.',
            input: z.object({ after }).strict(),
            was: ['feed.activity'],
            handler: async (caller, { after }) => await feed.activity(caller, after),
          },
        },
      }),
    );
  },
};
export default feedToolsPlugin;
