import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type { Caller } from '@merv/contracts';
import { z } from 'zod';
export const artifactToolsPlugin = {
  name: 'merv-artifact-tools',
  inject: ['artifacts', 'tools'],
  apply(ctx: Context) {
    const register = <S extends z.ZodTypeAny>(
      name: string,
      description: string,
      inputSchema: S,
      handler: (caller: Caller, input: z.infer<S>) => unknown,
      readOnly = false,
      conversation?: (input: z.infer<S>) => 'secret' | undefined,
    ) =>
      ctx.effect(() =>
        ctx.tools.register({ name, description, inputSchema, handler, readOnly, conversation }),
      );
    register(
      'artifact.create',
      'Store a completed immutable document or file (maximum 2 MB). Use utf8 for Markdown/text; use base64 for binary files. Returns an artifact ID for task briefs and deliveries.',
      z
        .object({
          title: z.string().min(1).max(300),
          content: z.string().min(1).max(2_700_000),
          mediaType: z.string().optional(),
          encoding: z.enum(['utf8', 'base64']).optional(),
        })
        .strict(),
      async (c, i) => await ctx.artifacts.create(c, i),
    );
    register(
      'artifact.get',
      'Read immutable artifact metadata.',
      z.object({ artifactId: z.string().min(1) }).strict(),
      async (c, i) => ({
        ...(await ctx.artifacts.get(c, i.artifactId)),
        downloadAvailable: ctx.artifacts.downloadSupported,
      }),
      true,
    );
    register(
      'artifact.read',
      'Read immutable artifact content up to 2 MB: valid UTF-8 as text, anything else as base64. offset and length read part of it, in characters of the content, and the answer then gives offset and total. With mode download, prepare a private single-file URL valid for 60 seconds when storage supports it.',
      z
        .object({
          artifactId: z.string().min(1),
          mode: z.literal('download').optional(),
          offset: z.number().int().min(0).optional(),
          length: z.number().int().min(1).optional(),
        })
        .strict(),
      async (c, i) =>
        i.mode === 'download'
          ? await ctx.artifacts.download(c, i.artifactId)
          : await ctx.artifacts.read(c, i.artifactId, { offset: i.offset, length: i.length }),
      true,
      // A download URL is a bearer secret: only the person sees it.
      (i) => (i.mode === 'download' ? 'secret' : undefined),
    );
    register(
      'artifact.list',
      'List this project’s immutable artifacts, newest first (at most 1,000).',
      z.object({}).strict(),
      async (c) => await ctx.artifacts.list(c),
      true,
    );
  },
};
export default artifactToolsPlugin;
