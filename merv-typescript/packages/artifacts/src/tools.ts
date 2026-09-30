import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { MervError, MAX_ARTIFACT_BYTES, MAX_OBJECT_BYTES, type Caller } from '@merv/contracts';
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
    // The hint is extra: when it cannot be found, the original refusal still stands.
    const text = await hint().catch(() => undefined);
    if (!text) throw error;
    throw new MervError(error.code, `${error.message}; ${text}`, error.status, error.details);
  }
}
const pendingHint = async () =>
  'PUT the file to the plan URL with its headers first; artifact.upload_resume signs a fresh URL';
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
      openWorld = false,
    ) =>
      ctx.effect(() =>
        ctx.tools.register({
          name,
          description,
          inputSchema,
          handler,
          readOnly,
          conversation,
          openWorld,
        }),
      );
    register(
      'artifact.create',
      'Store a completed immutable document or file (maximum 2 MB). Use utf8 for Markdown/text; use base64 for binary files. Returns an artifact ID for task briefs and deliveries. Not idempotent: after an uncertain result, list artifacts and match sha256 before retrying.',
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
      "Begin a project file upload (up to 512 MiB). For each final on-disk file, measure its exact byte count with wc -c < FILE and SHA-256 with sha256sum FILE (or shasum -a 256 FILE); never estimate size or reuse another file’s metadata. Keep the file unchanged through upload_complete. The answer gives at most one signed URL, valid 1 hour: PUT the whole file to parts[0].url sending exactly parts[0].headers, e.g. curl -fsS -T FILE -H 'x-amz-checksum-sha256: <value>' -H 'If-None-Match: *' '<url>'. Storage refuses any other bytes. Empty parts, or HTTP 412, mean the file is already stored. Then call artifact.upload_complete. Reuse requestId after an uncertain begin.",
      z
        .object({
          title: z.string().min(1).max(300),
          size: z.number().int().positive().max(MAX_OBJECT_BYTES),
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
      'Get a fresh signed URL for a pending upload.',
      z
        .object({
          uploadId: z.string().min(1),
          // Accepted and ignored: a plan has one part.
          startPart: z.number().int().min(1).max(10000).optional(),
        })
        .strict(),
      async (c, i) => await ctx.artifacts.uploadResume(c, i.uploadId),
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
        return { ...artifact, downloadAvailable: ctx.artifacts.downloadAvailable };
      },
      true,
    );
    register(
      'artifact.storage_status',
      'Whether this project can retain files up to 512 MiB.',
      z.object({}).strict(),
      async () => ({ available: ctx.artifacts.largeUploadAvailable }),
      true,
      'never',
    );
    register(
      'artifact.read',
      'Read immutable artifact content up to 2 MB: valid UTF-8 as text, anything else as base64. offset and length read part of it, in UTF-16 units of the text or base64 characters; boundaries move forward to whole characters, and the answer gives the offset it started at and the total. Continue from offset + length, or from the returned offset + content.length. Leased workers must use an explicit length of at most 8192 characters for files over 64000 bytes; use artifact.get for size and download availability. With mode download, prepare a private URL; for a collection, optional fileName selects one member and signs a fresh provider link. Without fileName, download retrieves the manifest.',
      z
        .object({
          artifactId: z.string().min(1),
          mode: z.literal('download').optional(),
          fileName: z.string().min(1).max(255).optional(),
          offset: z.number().int().min(0).optional(),
          length: z.number().int().min(1).optional(),
        })
        .strict(),
      async (c, i) => {
        if (i.mode === 'download') return await ctx.artifacts.download(c, i.artifactId, i.fileName);
        if (i.fileName !== undefined)
          throw new MervError('invalid_artifact', 'fileName requires mode download', 400);
        if (c.session) {
          const artifact = await ctx.artifacts.get(c, i.artifactId);
          if (artifact.size > workerInlineBytes && artifact.size <= MAX_ARTIFACT_BYTES) {
            if (i.length === undefined || i.length > workerRangeCharacters) {
              const downloadAvailable = ctx.artifacts.downloadAvailable;
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
        return await hinted(
          () => ctx.artifacts.read(c, i.artifactId, { offset: i.offset, length: i.length }),
          'artifact_size',
          async () =>
            ctx.artifacts.downloadAvailable ? 'use artifact.read with mode download' : undefined,
        );
      },
      true,
      // In a Pi conversation a signed URL is shown only to the person; a leased worker may
      // request its own URL to download and inspect an artifact in its workspace.
      (i) => (i.mode === 'download' ? 'secret' : undefined),
      // Open world: storage I/O (older rows' bytes, signing, the download mirror) waits holding
      // no reader snapshot, since artifacts runs each database read in a short transaction.
      true,
    );
    register(
      'artifact.list',
      'List this project’s immutable artifacts, newest first: at most limit (default and maximum 1,000). For the next page, pass before with the last artifact’s ID.',
      z
        .object({
          before: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(1000).optional(),
        })
        .strict(),
      async (c, i) =>
        (await ctx.artifacts.list(c, { before: i.before, limit: i.limit })).map((artifact) => ({
          ...artifact,
          downloadAvailable: ctx.artifacts.downloadAvailable,
        })),
      true,
    );
  },
};
export default artifactToolsPlugin;
