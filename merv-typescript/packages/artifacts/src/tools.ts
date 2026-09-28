import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { MervError, type Caller } from '@merv/contracts';
import { z } from 'zod';

/** A leased worker should inspect a large file on disk or ask for a deliberate small range. */
const workerInlineBytes = 64_000;
const workerRangeCharacters = 8_192;
/** Service errors name no tools; the tool adds how to go on after a refusal with this code. */
async function hinted<T>(
  run: () => Promise<T>,
  code: string,
  hint: () => Promise<string | undefined>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof MervError) || error.code !== code) throw error;
    const text = await hint();
    if (!text) throw error;
    throw new MervError(error.code, `${error.message}; ${text}`, error.status, error.details);
  }
}
const pendingHint = async () => 'retry artifact.upload_begin with the same requestId';
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
      conversation?: 'never' | ((input: z.infer<S>) => 'secret' | 'propose' | undefined),
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
      'Begin a project large-file upload. For each final on-disk file, measure its exact byte count with wc -c < FILE and SHA-256 with sha256sum FILE (or shasum -a 256 FILE); never estimate size or reuse another file’s metadata. Keep the file unchanged through upload_complete. The answer gives signed part URLs; PUT each exact part directly from your machine, then call artifact.upload_complete. Reuse requestId after an uncertain begin.',
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
      async (c, i) =>
        await hinted(
          () => ctx.artifacts.uploadResume(c, i.uploadId, i.startPart),
          'upload_pending',
          pendingHint,
        ),
      false,
      () => 'secret',
    );
    register(
      'artifact.upload_complete',
      'Verify the uploaded bytes and retain an immutable artifact. Safe to retry with the same uploadId.',
      z.object({ uploadId: z.string().min(1) }).strict(),
      async (c, i) =>
        await hinted(
          () => ctx.artifacts.uploadComplete(c, i.uploadId),
          'upload_pending',
          pendingHint,
        ),
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
      'never',
    );
    register(
      'artifact.read',
      'Read immutable artifact content up to 2 MB: valid UTF-8 as text, anything else as base64. offset and length read part of it, in UTF-16 units of the text or base64 characters; boundaries move forward to whole characters, and the answer gives the offset it started at and the total. Continue from offset + length, or from the returned offset + content.length. Leased workers must use an explicit length of at most 8192 characters for files over 64000 bytes; use artifact.get for size and download availability. With mode download, prepare a private single-file URL valid for 60 seconds when storage supports it; download and inspect large files locally, reporting derived results rather than their full contents.',
      z
        .object({
          artifactId: z.string().min(1),
          mode: z.literal('download').optional(),
          offset: z.number().int().min(0).optional(),
          length: z.number().int().min(1).optional(),
        })
        .strict(),
      async (c, i) => {
        if (i.mode === 'download') return await ctx.artifacts.download(c, i.artifactId);
        if (c.session) {
          const artifact = await ctx.artifacts.get(c, i.artifactId);
          if (artifact.size > workerInlineBytes && artifact.size <= 2_000_000) {
            if (i.length === undefined || i.length > workerRangeCharacters) {
              const downloadAvailable = ctx.artifacts.canDownload(artifact);
              throw new MervError(
                'artifact_read_requires_range',
                `Artifact is ${artifact.size} bytes; no content was returned. Read a bounded range with offset and length at most ${workerRangeCharacters} characters${downloadAvailable ? ', or use artifact.read mode download and inspect the file locally' : ''}.`,
                413,
                {
                  artifactId: artifact.id,
                  size: artifact.size,
                  sha256: artifact.hash,
                  downloadAvailable,
                  maxRangeCharacters: workerRangeCharacters,
                },
              );
            }
          }
        }
        // Only on the error path: whether this artifact can be downloaded instead.
        return await hinted(
          () => ctx.artifacts.read(c, i.artifactId, { offset: i.offset, length: i.length }),
          'artifact_size',
          async () =>
            ctx.artifacts.canDownload(await ctx.artifacts.get(c, i.artifactId))
              ? 'use artifact.read with mode download'
              : undefined,
        );
      },
      true,
      // In a Pi conversation a signed URL is shown only to the person; a leased worker may
      // request its own URL to download and inspect an artifact in its workspace.
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
