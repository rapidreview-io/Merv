import type { Context } from 'cordis';
import type { ToolAct } from '@merv/api/types';
import { check, MervError, MAX_OBJECT_BYTES, type Artifact, type Caller } from '@merv/contracts';
import type { ArtifactFile } from '@merv/contracts/artifact-models';
import { z } from 'zod';
import { MAX_STORED_READ_BYTES } from './content.js';

/** A leased worker should inspect a large file on disk or ask for a deliberate small range. */
const workerInlineBytes = 64_000;
const workerRangeCharacters = 8_192;
/** A collection's record without its member list, which artifact.get pages: an answer about
 * one member, or a listing, should not repeat every member of it. */
const brief = (artifact: Artifact) => {
  if (!artifact.files) return artifact;
  const { files, ...rest } = artifact;
  return { ...rest, fileCount: files.length };
};
/** The members artifact.get gives an agent that names no limit: a capture can hold thousands. */
const agentMembers = 100;
/** One page of a collection's members: those under `prefix`, from `offset`, at most `limit`. */
function membersPage(
  files: ArtifactFile[],
  { prefix, offset = 0, limit }: { prefix?: string; offset?: number; limit?: number },
) {
  const matching =
    prefix === undefined ? files : files.filter((file) => file.name.startsWith(prefix));
  const end = limit === undefined ? matching.length : Math.min(matching.length, offset + limit);
  return {
    files: matching.slice(offset, end),
    fileCount: files.length,
    ...(prefix === undefined ? {} : { matchCount: matching.length }),
    ...(end < matching.length ? { nextOffset: end } : {}),
  };
}
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
      act?: ToolAct,
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
          act,
        }),
      );
    register(
      'artifact.create',
      'Store a completed immutable document or file given inline (maximum 2 MB). Use utf8 for Markdown/text; use base64 for binary files. For a file already on disk, do not cat or base64 it into content: artifact.upload_begin stores it from disk with one curl PUT (any size up to 512 MiB). Returns an artifact ID other records can reference. Give a requestId of your own (1-128 characters) so a retry after an uncertain result, such as a timeout or an HTTP 502, is safe: the same call with the same requestId returns the artifact already stored instead of a second copy, and other title, mediaType or content under it is refused.',
      z
        .object({
          title: z.string().min(1).max(300),
          content: z.string().min(1).max(2_700_000),
          mediaType: z.string().optional(),
          encoding: z.enum(['utf8', 'base64']).optional(),
          requestId: z.string().min(1).max(128).optional(),
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
      'Read immutable artifact metadata. For a collection, files lists its members (name, size and SHA-256) in the collection’s order, and fileCount says how many it has. An agent gets 100 members unless it gives a limit (1-1,000); offset skips that many, and when more follow, nextOffset is the offset of the next page. prefix keeps only the members whose names start with it, such as "run-a/", and matchCount says how many do.',
      z
        .object({
          artifactId: z.string().min(1),
          prefix: z.string().min(1).max(4096).optional(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(1000).optional(),
        })
        .strict(),
      async (c, i) => {
        const artifact = await ctx.artifacts.get(c, i.artifactId);
        // An agent's context holds the whole answer; a person's Files page shows every member.
        const limit = i.limit ?? (c.session || c.conversation ? agentMembers : undefined);
        return {
          ...artifact,
          ...(artifact.files ? membersPage(artifact.files, { ...i, limit }) : {}),
          downloadAvailable: ctx.artifacts.downloadAvailable,
        };
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
      'Read immutable artifact content: valid UTF-8 as text, anything else as base64. offset and length read part of it, in UTF-16 units of the text or base64 characters; boundaries move forward to whole characters, and the answer gives the offset it started at and the total. Continue from the returned offset + content.length. A file of up to 2 MB reads whole; a larger one, up to 16 MiB, only by a range with a length. Leased workers read files over 64,000 bytes only by a range with a length; a length over 8192 characters is cut to 8192. For a collection, fileName reads one member the same way, by its exact path from the collection’s files (artifact.get). With mode download, get private URLs to fetch with curl instead: of the file, of one collection member by fileName, or of up to 100 members at once by fileNames; for a collection without either, of its manifest.',
      z
        .object({
          artifactId: z.string().min(1),
          mode: z.literal('download').optional(),
          fileName: z.string().min(1).max(4096).optional(),
          fileNames: z.array(z.string().min(1).max(4096)).min(1).max(100).optional(),
          offset: z.number().int().min(0).optional(),
          length: z.number().int().min(1).optional(),
        })
        .strict(),
      async (c, i) => {
        if (i.mode === 'download') {
          if (i.fileNames !== undefined) {
            check(
              i.fileName === undefined,
              'invalid_artifact',
              'Give fileName or fileNames, not both',
            );
            const { artifact, downloads } = await ctx.artifacts.downloadFiles(
              c,
              i.artifactId,
              i.fileNames,
            );
            return { artifact: brief(artifact), downloads };
          }
          const { artifact, download } = await ctx.artifacts.download(c, i.artifactId, i.fileName);
          return { artifact: brief(artifact), download };
        }
        check(
          i.fileNames === undefined,
          'invalid_artifact',
          'fileNames requires mode download; read one member inline with fileName',
        );
        const range = { fileName: i.fileName, offset: i.offset, length: i.length };
        // Only a worker's unbounded or wide read is refused or cut, so only it reads the size first.
        if (c.session && (i.length === undefined || i.length > workerRangeCharacters)) {
          const artifact = await ctx.artifacts.get(c, i.artifactId);
          const file =
            i.fileName === undefined
              ? { size: artifact.size, hash: artifact.hash }
              : artifact.files?.find((member) => member.name === i.fileName);
          // A member that is not there, or a file too large for any range, is the read's to refuse.
          if (file && file.size > workerInlineBytes && file.size <= MAX_STORED_READ_BYTES) {
            if (i.length === undefined) {
              const downloadAvailable = i.fileName !== undefined || ctx.artifacts.downloadAvailable;
              throw new MervError(
                'artifact_read_requires_range',
                `${i.fileName === undefined ? 'Artifact' : 'Collection file'} is ${file.size} bytes; no content was returned. Read a bounded range with offset and length at most ${workerRangeCharacters} characters${downloadAvailable ? ', or use artifact.read mode download and inspect the file locally' : ''}.`,
                413,
                {
                  artifactId: artifact.id,
                  ...(i.fileName === undefined ? {} : { fileName: i.fileName }),
                  size: file.size,
                  sha256: file.hash,
                  downloadAvailable,
                  maxRangeCharacters: workerRangeCharacters,
                },
              );
            }
            range.length = workerRangeCharacters;
          }
        }
        const read = await hinted(
          () => ctx.artifacts.readStored(c, i.artifactId, range),
          'artifact_size',
          async () =>
            i.fileName !== undefined || ctx.artifacts.downloadAvailable
              ? 'artifact.read with mode download fetches it whole'
              : undefined,
        );
        return { ...read, artifact: brief(read.artifact) };
      },
      true,
      // In a Pi conversation a signed URL is shown only to the person; a leased worker may
      // request its own URL to download and inspect an artifact in its workspace.
      (i) => (i.mode === 'download' ? 'secret' : undefined),
      // Open world: download's storage I/O (signing, the download mirror) and a stored read's
      // fetch wait holding no reader snapshot, since artifacts runs each database read in a
      // short transaction.
      true,
      { title: ({ mode }) => (mode === 'download' ? 'Download file' : 'Read file'), says: 'mode' },
    );
    register(
      'artifact.list',
      'List this project’s immutable artifacts, newest first: at most limit (default and maximum 1,000). For the next page, pass before with the last artifact’s ID. For an agent a collection shows fileCount instead of its files; artifact.get lists them a page at a time.',
      z
        .object({
          before: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(1000).optional(),
        })
        .strict(),
      async (c, i) =>
        (await ctx.artifacts.list(c, { before: i.before, limit: i.limit })).map((artifact) => ({
          // An agent's context holds every row; a person's Files page shows a collection's members.
          ...(c.session || c.conversation ? brief(artifact) : artifact),
          downloadAvailable: ctx.artifacts.downloadAvailable,
        })),
      true,
    );
  },
};
export default artifactToolsPlugin;
