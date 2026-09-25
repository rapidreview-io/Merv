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
      conversation?: (input: z.infer<S>) => 'secret' | 'propose' | undefined,
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
      'artifact.upload_begin',
      'Begin a project large-file upload. The answer gives signed part URLs; PUT each exact part directly from your machine, then call artifact.upload_complete. Reuse requestId after an uncertain begin.',
      z
        .object({
          title: z.string().min(1).max(300),
          size: z.number().int().positive(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          mediaType: z.string().min(3).max(150),
          requestId: z.string().min(1).max(128).optional(),
        })
        .strict(),
      async (c, i) => await ctx.artifacts.uploadBegin(c, i),
      false,
      () => 'secret',
    );
    register(
      'artifact.upload_resume',
      'Get fresh signed URLs for a pending multipart upload, starting at one-based startPart.',
      z
        .object({
          uploadId: z.string().min(1),
          startPart: z.number().int().min(1).max(10000).optional(),
        })
        .strict(),
      async (c, i) => await ctx.artifacts.uploadResume(c, i.uploadId, i.startPart),
      false,
      () => 'secret',
    );
    register(
      'artifact.upload_complete',
      'Verify the uploaded bytes and retain an immutable artifact. Safe to retry with the same uploadId.',
      z.object({ uploadId: z.string().min(1) }).strict(),
      async (c, i) => await ctx.artifacts.uploadComplete(c, i.uploadId),
      false,
      () => 'propose',
    );
    register(
      'artifact.get',
      'Read immutable artifact metadata.',
      z.object({ artifactId: z.string().min(1) }).strict(),
      async (c, i) => {
        const artifact = await ctx.artifacts.get(c, i.artifactId);
        return { ...artifact, downloadAvailable: ctx.artifacts.canDownload(artifact) };
      },
      true,
    );
    register(
      'artifact.storage_status',
      'Whether this project can retain large files in Sandboxes object storage.',
      z.object({}).strict(),
      async () => ({ available: ctx.artifacts.largeUploadAvailable }),
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
      async (c) =>
        (await ctx.artifacts.list(c)).map((artifact) => ({
          ...artifact,
          downloadAvailable: ctx.artifacts.canDownload(artifact),
        })),
      true,
    );
  },
};
export default artifactToolsPlugin;
