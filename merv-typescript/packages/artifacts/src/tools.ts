import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { check, isAgentCaller, MervError, MAX_OBJECT_BYTES, type Artifact } from '@merv/contracts';
import { boardViewSchema, type Caller } from '@merv/contracts';
import { pictured } from '@merv/contracts/pictured';
import type { View } from '@merv/contracts/board-view';
import type { ArtifactFile } from '@merv/contracts/artifact-models';
import { z } from 'zod';
import { ArtifactPicture } from './picture.js';
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
async function hinted<T>(run: Promise<T>, code: string, hint?: string): Promise<T> {
  try {
    return await run;
  } catch (error) {
    if (!(error instanceof MervError) || error.code !== code || !hint) throw error;
    throw new MervError(error.code, `${error.message}; ${hint}`, error.status, error.details);
  }
}
const id = z.string().min(1);
const requestId = z.string().min(1).max(128).optional();
const upload = z.object({ uploadId: id }).strict();
const names = z.array(z.string().min(1).max(4096)).min(1).max(100);
const named = z.object({ artifactId: id, fileName: z.string().min(1).max(4096).optional() });
const int = z.number().int();
const read = named
  .extend({ offset: int.min(0).optional(), length: int.min(1).optional() })
  .strict();
const download = named.extend({ fileNames: names.optional() }).strict();
/** The flat input artifact.read took before its actions, in its order. */
const flat = z.object({ artifactId: id, mode: z.literal('download').optional() });
export const artifactToolsPlugin = {
  name: 'merv-artifact-tools',
  inject: ['artifacts', 'tools'],
  apply(ctx: Context) {
    const pictures = new ArtifactPicture();
    ctx.effect(() => () => pictures.close());
    const picture = async (caller: Caller, id: string, view?: View) => {
      const artifact = await ctx.artifacts.get(caller, id);
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(artifact.mediaType)) return undefined;
      check(
        artifact.size <= MAX_STORED_READ_BYTES,
        'artifact_picture_size',
        'Reference images must be at most 16 MiB',
      );
      const content = await ctx.artifacts.readStored(caller, id, {
        length: Math.ceil(artifact.size / 3) * 4,
      });
      check(
        content.encoding === 'base64',
        'artifact_picture_type',
        'Expected binary image content',
      );
      const image = await pictures.render(content.content, artifact.mediaType, view);
      return { ...image, html: '', path: `/ui/artifacts/${id}` };
    };
    ctx.effect(() =>
      ctx.tools.contributePicture('art_', (caller, id, _focus, view) => picture(caller, id, view)),
    );
    const store = ctx.artifacts;
    ctx.effect(() =>
      ctx.tools.noun('artifact.write', {
        tier: 'core',
        summary: 'Store immutable project files, inline or by upload.',
        description:
          'Store project files: create (a finished file given inline, up to 2 MB), and upload_begin, upload_resume and upload_complete (a file on disk, up to 512 MiB, PUT to a signed URL).',
        actions: {
          create: {
            summary:
              'Store immutable inline content ≤2 MB: utf8 text/Markdown or base64 binary; returns artifact ID. On-disk files: use artifact.upload_begin and curl PUT (≤512 MiB), never paste/base64 into content. Same requestId/input safely replays after uncertain responses.',
            description:
              'Store a completed immutable document or file given inline (maximum 2 MB). Use utf8 for Markdown/text; use base64 for binary files. For a file already on disk, do not cat or base64 it into content: artifact.upload_begin stores it from disk with one curl PUT (any size up to 512 MiB). Returns an artifact ID other records can reference. Pass a requestId so a retry after an uncertain result (a timeout, an HTTP 502) is safe: the same call returns the artifact already stored.',
            input: z.strictObject({
              title: z.string().min(1).max(300),
              content: z.string().min(1).max(2_700_000),
              mediaType: z.string().optional(),
              encoding: z.enum(['utf8', 'base64']).optional(),
              requestId,
            }),
            was: ['artifact.create'],
            handler: async (c, i) => await store.create(c, i),
          },
          upload_begin: {
            summary:
              'Upload ≤512 MiB from disk. Measure exact bytes (wc -c < FILE) and SHA-256 (sha256sum FILE or shasum -a 256 FILE); never estimate/reuse metadata; keep unchanged through completion. At most one URL, valid 1 hour: curl -fsS -T FILE to parts[0].url with exactly parts[0].headers (checksum and If-None-Match); other bytes are refused. Empty parts/HTTP 412 means already stored. Then artifact.upload_complete. Retry uncertain begin with same requestId.',
            description:
              "Begin a project file upload (up to 512 MiB). For each final on-disk file, measure its exact byte count with wc -c < FILE and SHA-256 with sha256sum FILE (or shasum -a 256 FILE); never estimate size or reuse another file’s metadata. Keep the file unchanged through upload_complete. The answer gives at most one signed URL, valid 1 hour: PUT the whole file to parts[0].url sending exactly parts[0].headers, e.g. curl -fsS -T FILE -H 'x-amz-checksum-sha256: <value>' -H 'If-None-Match: *' '<url>'. Storage refuses any other bytes. Empty parts, or HTTP 412, mean the file is already stored. Then call artifact.upload_complete. Reuse requestId after an uncertain begin.",
            input: z.strictObject({
              title: z.string().min(1).max(300),
              size: z.number().int().positive().max(MAX_OBJECT_BYTES),
              sha256: z.string().regex(/^[0-9a-f]{64}$/),
              mediaType: z.string().min(3).max(150),
              requestId,
            }),
            was: ['artifact.upload_begin'],
            handler: async (c, i) => await store.uploadBegin(c, i),
          },
          upload_resume: {
            description: 'Get a fresh signed URL for a pending upload.',
            // startPart is accepted and ignored: a plan has one part.
            input: upload.extend({ startPart: z.number().int().min(1).max(10000).optional() }),
            was: ['artifact.upload_resume'],
            handler: async (c, i) => await store.uploadResume(c, i.uploadId),
          },
          upload_complete: {
            description:
              'Verify the uploaded bytes and retain an immutable artifact. Safe to retry with the same uploadId.',
            input: upload,
            was: ['artifact.upload_complete'],
            handler: async (c, i) =>
              await hinted(
                store.uploadComplete(c, i.uploadId),
                'upload_pending',
                'PUT the file to the plan URL with its headers first; artifact.upload_resume signs a fresh URL',
              ),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('artifact.read', {
        tier: 'core',
        readOnly: true,
        summary: 'Read project files and collection members.',
        description:
          "Read project files: list (newest first, a page at a time), get (one file's metadata, a collection's members a page at a time), content (text or base64, whole or by range), download (private URLs to fetch with curl), storage (whether files up to 512 MiB can be kept), and look (an image in source pixels).",
        legacy: {
          inputSchema: flat.merge(download).merge(read),
          description:
            'Read immutable artifact content: valid UTF-8 as text, anything else as base64. offset and length read part of it, in UTF-16 units of the text or base64 characters; boundaries move forward to whole characters, and the answer gives the offset it started at and the total. Continue from the returned offset + content.length. A file of up to 2 MB reads whole; a larger one, up to 16 MiB, only by a range with a length. Leased workers read files over 64,000 bytes only by a range with a length; a length over 8192 characters is cut to 8192. For a collection, fileName reads one member the same way, by its exact path from the collection’s files (artifact.get). With mode download, get private URLs to fetch with curl instead: of the file, of one collection member by fileName, or of up to 100 members at once by fileNames; for a collection without either, of its manifest.',
          // A download takes no range, which the flat tool ignored.
          route: ({ mode, ...args }) => {
            const { offset: _offset, length: _length, ...unranged } = args;
            return mode === 'download' ? ['download', unranged] : ['content', args];
          },
        },
        actions: {
          list: {
            description:
              'List this project’s immutable artifacts, newest first: at most limit (default and maximum 1,000). For the next page, pass before with the last artifact’s ID. For an agent a collection shows fileCount instead of its files; artifact.get lists them a page at a time.',
            input: z.strictObject({
              before: z.string().min(1).optional(),
              limit: z.number().int().min(1).max(1000).optional(),
            }),
            was: ['artifact.list'],
            handler: async (c, i) =>
              (await store.list(c, { before: i.before, limit: i.limit })).map((artifact) => ({
                // An agent's context holds every row; a person's Files page shows a collection's
                // members.
                ...(isAgentCaller(c) ? brief(artifact) : artifact),
                downloadAvailable: store.downloadAvailable,
              })),
          },
          get: {
            description:
              'Read immutable artifact metadata. For a collection, files lists its members (name, size, SHA-256) in order: limit of them (default 100 for an agent) from offset; fileCount is the total and nextOffset is set when more follow. prefix keeps names starting with it, such as "run-a/"; matchCount counts them.',
            input: z.strictObject({
              artifactId: id,
              prefix: z.string().min(1).max(4096).optional(),
              offset: z.number().int().min(0).optional(),
              limit: z.number().int().min(1).max(1000).optional(),
            }),
            was: ['artifact.get'],
            handler: async (c, i) => {
              const artifact = await store.get(c, i.artifactId);
              // An agent's context holds the whole answer; a person's Files page shows every
              // member.
              const limit = i.limit ?? (isAgentCaller(c) ? agentMembers : undefined);
              return {
                ...artifact,
                ...(artifact.files ? membersPage(artifact.files, { ...i, limit }) : {}),
                downloadAvailable: store.downloadAvailable,
              };
            },
          },
          content: {
            description:
              'UTF-8 text or base64. offset/length count UTF-16 text units or base64 characters; boundaries advance to whole characters. Returns actual offset/total; continue at offset+content.length. Whole reads ≤2 MB; larger files ≤16 MiB need a length-bounded range. Collection: exact fileName from get. Workers reading >64,000 bytes need ranges ≤8192 characters.',
            input: read,
            // Open world: a stored read's fetch waits holding no reader snapshot, since artifacts
            // runs each database read in a short transaction.
            openWorld: true,
            handler: async (c, { artifactId, fileName, offset, length }) => {
              const range = { fileName, offset, length };
              // Only a worker's unbounded or wide read is refused or cut, so only it reads the
              // size first.
              if (c.session && (length === undefined || length > workerRangeCharacters)) {
                const artifact = await store.get(c, artifactId);
                const file =
                  fileName === undefined
                    ? artifact
                    : artifact.files?.find((member) => member.name === fileName);
                // A member that is not there, or a file too large for any range, is the read's
                // to refuse.
                if (file && file.size > workerInlineBytes && file.size <= MAX_STORED_READ_BYTES) {
                  if (length === undefined) {
                    const downloadAvailable = fileName !== undefined || store.downloadAvailable;
                    throw new MervError(
                      'artifact_read_requires_range',
                      `${fileName === undefined ? 'Artifact' : 'Collection file'} is ${file.size} bytes; no content was returned. Read a bounded range with offset and length at most ${workerRangeCharacters} characters${downloadAvailable ? ', or use artifact.read mode download and inspect the file locally' : ''}.`,
                      413,
                      {
                        artifactId: artifact.id,
                        ...(fileName === undefined ? {} : { fileName }),
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
              const whole = fileName !== undefined || store.downloadAvailable;
              const stored = await hinted(
                store.readStored(c, artifactId, range),
                'artifact_size',
                whole ? 'artifact.read with mode download fetches it whole' : undefined,
              );
              return { ...stored, artifact: brief(stored.artifact) };
            },
          },
          download: {
            description:
              'Private curl URLs: file, collection fileName, up to 100 fileNames, or collection manifest if neither is given.',
            input: download,
            // Any agent may fetch a signed URL for any project file, as it may read it (founder,
            // 2026-10-20). Open world: signing and the download mirror are storage I/O.
            openWorld: true,
            handler: async (c, { artifactId, fileName, fileNames }) => {
              if (!fileNames) {
                const { artifact, download } = await store.download(c, artifactId, fileName);
                return { artifact: brief(artifact), download };
              }
              check(!fileName, 'invalid_artifact', 'Give fileName or fileNames, not both');
              const { artifact, downloads } = await store.downloadFiles(c, artifactId, fileNames);
              return { artifact: brief(artifact), downloads };
            },
          },
          look: {
            description:
              'See a JPEG, PNG or WebP artifact as an image without anyone’s screen. view controls fit, region (source pixels), pan or zoom. Does not change the artifact.',
            input: z.object({ artifactId: id, view: boardViewSchema.optional() }).strict(),
            openWorld: false,
            handler: async (caller, { artifactId, view }) => {
              const drawn = await picture(caller, artifactId, view);
              check(
                drawn,
                'invalid_input',
                'record.look sees boards and JPEG, PNG or WebP image artifacts',
              );
              return {
                page: drawn.path,
                seen: 'Actual reference image. Viewport coordinates are source pixels; use region for readable details.',
                image: drawn.image,
                viewport: drawn.viewport,
              };
            },
            present: pictured,
          },
          storage: {
            description: 'Whether this project can retain files up to 512 MiB.',
            input: z.object({}).strict(),
            was: ['artifact.storage_status'],
            handler: async () => ({ available: store.largeUploadAvailable }),
          },
        },
      }),
    );
  },
};
export default artifactToolsPlugin;
