import type { Context } from 'cordis';
import { z } from 'zod';
import type { Caller, FeedInput, FeedListInput, ToolDefinition } from '@merv/contracts';

export const feedToolsPlugin = {
  name: 'merv-feed-tools',
  inject: ['feed', 'tools'],
  apply(ctx: Context) {
    // Capture this provider so an already admitted call finishes on its original instance.
    const feed = ctx.feed;
    const definitions: ToolDefinition[] = [
      {
        name: 'feed.post',
        description:
          'Post an immutable project message with up to 10 artifact attachments. Producers, reviewers, and operators may post. An identical requestId retry returns the original post.',
        inputSchema: z
          .object({
            body: z
              .string()
              .min(1)
              .max(8000)
              .refine((body) => body.trim().length > 0, 'Post body must be nonblank'),
            artifactIds: z.array(z.string().min(1)).max(10).optional(),
            requestId: z.string().min(1).max(200),
          })
          .strict(),
        handler: (caller: Caller, input: FeedInput) => feed.post(caller, input),
      },
      {
        name: 'feed.get',
        description: 'Read an immutable post in the current project.',
        inputSchema: z.object({ postId: z.string().min(1) }).strict(),
        readOnly: true,
        handler: (caller: Caller, input: { postId: string }) => feed.get(caller, input.postId),
      },
      {
        name: 'feed.list',
        description:
          'Read project posts in ascending sequence order. after is an exclusive post sequence cursor; limit defaults to 50 and is capped at 100.',
        inputSchema: z
          .object({
            after: z.number().int().nonnegative().optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .strict(),
        readOnly: true,
        handler: (caller: Caller, input: FeedListInput) => feed.list(caller, input),
      },
      {
        name: 'feed.activity',
        description:
          'Read durable activity events for the current project. after is an exclusive event ID cursor, independent of the feed post sequence.',
        inputSchema: z.object({ after: z.number().int().nonnegative().optional() }).strict(),
        readOnly: true,
        handler: (caller: Caller, input: { after?: number }) => feed.activity(caller, input.after),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default feedToolsPlugin;
