import { recorded, createService, plain } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { META, decode, fromRow, isText, meta, span, verified, view } from './content.js';
import { Uploads } from './uploads.js';
import { Backfill } from './backfill.js';
import { fileURLToPath } from 'node:url';
import type { Context } from 'cordis';
import { z } from 'zod';
import {
  check,
  MervError,
  newId,
  sha256Hex,
  now,
  inTransaction,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_IDS,
  type Artifacts,
  type Artifact,
  type ArtifactInput,
  type ArtifactUploadInput,
  type ArtifactUploadStatus,
  type LargeArtifactStorage,
  type Caller,
  type State,
  type Scope,
  type Blobs,
  type Transaction,
} from '@merv/contracts';
/** A row implies its bytes: storage that has lost them is a server fault, never a 404. */
async function missing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MervError && error.code === 'blob_not_found')
      throw new MervError('artifact_bytes_missing', 'Stored artifact bytes are missing', 500);
    throw error;
  }
}
/** An id argument: a nonempty string. */
const named = (id: unknown): id is string => typeof id === 'string' && id.length > 0;
/** This package's own source, whose stack frames are never the call site that is reported. */
const OWN = [new URL('.', import.meta.url).href, fileURLToPath(new URL('.', import.meta.url))];
export class ArtifactStore implements Artifacts {
  private large?: LargeArtifactStorage;
  bindLarge(storage: LargeArtifactStorage): () => void {
    this.large = storage;
    // Large storage binds after this service is provided: the fill then reaches its objects.
    this.filling?.kick();
    return () => {
      if (this.large === storage) this.large = undefined;
    };
  }
  get largeUploadAvailable(): boolean {
    return !!this.large;
  }
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  private uploads: Uploads;
  constructor(
    private state: State,
    private scope: Scope,
    private blobs: Blobs,
  ) {
    this.uploads = new Uploads(
      state,
      scope,
      () => this.storage(),
      (caller, artifactId) => this.get(caller, artifactId),
    );
    this.initialize = async () => {
      await state.migrate('artifacts', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
        { version: 2, sql: postgresMigrations[2] },
        { version: 3, sql: postgresMigrations[3] },
        { version: 4, sql: postgresMigrations[4] },
        { version: 5, sql: postgresMigrations[5] },
      ]);
    };
  }
  private storage(): LargeArtifactStorage {
    check(this.large, 'storage_unavailable', 'Project large-file storage is unavailable', 503);
    return this.large;
  }
  /**
   * Where a read runs: an explicit `tx`, else the ambient transaction, else a read-only snapshot
   * transaction of its own (reader pool, no writer lock). Scope's `within(…, 'read')` rule.
   */
  private async place<T>(tx: Transaction | undefined, fn: (tx: Transaction) => Promise<T>) {
    if (tx) {
      this.state.assertTransaction(tx);
      return await fn(tx);
    }
    const ambient = this.state.ambient;
    return ambient
      ? await fn(ambient)
      : await this.state.snapshot(() => this.state.transaction(fn));
  }
  /** A read authorised once, in the transaction it queries. */
  private async one<T>(
    caller: Caller,
    tx: Transaction | undefined,
    fn: (tx: Transaction) => Promise<T>,
  ) {
    return await this.place(tx, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await fn(tx);
    });
  }
  uploadBegin(caller: Caller, input: ArtifactUploadInput): Promise<ArtifactUploadStatus> {
    return this.uploads.begin(caller, input);
  }
  uploadResume(
    caller: Caller,
    uploadId: string,
    startPart?: number,
  ): Promise<ArtifactUploadStatus> {
    return this.uploads.resume(caller, uploadId, startPart);
  }
  uploadComplete(caller: Caller, uploadId: string): Promise<Artifact> {
    return this.uploads.complete(caller, uploadId);
  }
  async create(caller: Caller, input: ArtifactInput, tx?: Transaction): Promise<Artifact> {
    caller = structuredClone(caller);
    input = plain<ArtifactInput>(input, 'invalid_artifact');
    const bytes = decode(input);
    // Without a declared type, bytes that read back as text are Markdown; others are opaque.
    const { title, mediaType } = meta(
      input.title,
      input.mediaType ?? (isText(bytes) ? 'text/markdown' : 'application/octet-stream'),
    );
    const hash = sha256Hex(bytes);
    // Database only: the bytes go in the row, so the caller's transaction does no network I/O.
    return await inTransaction(this.state, tx ?? this.state.ambient, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const artifact: Artifact = {
        id: newId('art'),
        projectId: caller.projectId,
        createdBy: caller.actorId,
        title,
        mediaType,
        hash,
        size: bytes.length,
        createdAt: now(),
      };
      await tx.run(
        `INSERT INTO artifacts(${META},content,session_id) VALUES(?,?,?,?,?,?,?,?,NULL,?,?)`,
        artifact.id,
        artifact.projectId,
        artifact.createdBy,
        artifact.title,
        artifact.mediaType,
        artifact.hash,
        artifact.size,
        artifact.createdAt,
        bytes,
        caller.session?.id ?? null,
      );
      await recorded(this.state, tx, caller, 'artifact.created', artifact.id, {
        hash: artifact.hash,
        size: artifact.size,
      });
      return artifact;
    });
  }
  async get(caller: Caller, artifactId: string, tx?: Transaction): Promise<Artifact> {
    caller = structuredClone(caller);
    const row = await this.one(caller, tx, (tx) =>
      tx.get(
        `SELECT ${META} FROM artifacts WHERE id=? AND project_id=?`,
        artifactId,
        caller.projectId,
      ),
    );
    check(row, 'not_found', 'Artifact not found in this project', 404);
    return fromRow(row);
  }
  /**
   * The bytes behind a row created before they were kept in it: large-storage bytes are verified
   * here, blob bytes by blobs.get.
   */
  private async fetch(projectId: string, artifact: Artifact, tx?: Transaction): Promise<Buffer> {
    this.offLock(tx);
    if (!artifact.objectId) return await missing(() => this.blobs.get(projectId, artifact.hash));
    const storage = this.storage();
    return verified(
      await missing(() => storage.read(projectId, artifact.objectId!, artifact.size)),
      artifact,
    );
  }
  private filling?: Backfill;
  /**
   * Starts filling the rows written before bytes were kept in the row (temporary; the server
   * turns it on in its config). Returns its stop, which waits for the row in hand.
   */
  backfill(): () => Promise<void> {
    const fill = new Backfill(
      this.state,
      (artifact) => this.fetch(artifact.projectId, artifact),
      () => !!this.large,
    );
    this.filling = fill;
    fill.kick();
    return async () => {
      if (this.filling === fill) this.filling = undefined;
      await fill.stop();
    };
  }
  private sites = new Set<string>();
  /**
   * Phase A: each call site that does storage I/O inside a write transaction is logged once. The
   * site is the first frame outside this package; the whole stack goes with it as evidence.
   */
  private offLock(tx?: Transaction) {
    if (!(tx ?? this.state.ambient) || this.state.readScope) return;
    const frames = (new Error().stack?.split('\n').slice(2) ?? []).map((frame) => frame.trim());
    const stack = frames.join('\n');
    const site =
      frames.find(
        (frame) =>
          /:\d+:\d+\)?$/.test(frame) &&
          !frame.includes('(node:') &&
          !OWN.some((own) => frame.includes(own)),
      ) ?? stack;
    if (this.sites.has(site)) return;
    this.sites.add(site);
    process.stderr.write(
      `${JSON.stringify({ event: 'artifacts.io_in_transaction', site, stack })}\n`,
    );
  }
  get downloadSupported() {
    return typeof this.blobs.download === 'function';
  }
  canDownload(artifact: Artifact): boolean {
    return artifact.objectId ? !!this.large : this.downloadSupported;
  }
  async download(caller: Caller, artifactId: string) {
    caller = structuredClone(caller);
    this.offLock();
    const artifact = await this.get(caller, artifactId);
    if (artifact.objectId) {
      const storage = this.storage();
      const download = await missing(() => storage.download(caller.projectId, artifact.objectId!));
      return { artifact, download };
    }
    check(
      this.blobs.download,
      'download_unsupported',
      'This storage provider does not support direct downloads',
      501,
    );
    const sign = () => this.blobs.download!(caller.projectId, artifact.hash, artifact.size);
    try {
      return { artifact, download: await sign() };
    } catch (error) {
      if (!(error instanceof MervError && error.code === 'blob_not_found')) throw error;
    }
    // The first download of bytes kept in the row mirrors them into blobs: content-addressed,
    // so a repeat or a race writes the same object.
    const row = await this.place(undefined, (tx) =>
      tx.get<{ content: Buffer | null }>(
        'SELECT content FROM artifacts WHERE id=? AND project_id=?',
        artifact.id,
        caller.projectId,
      ),
    );
    check(row?.content, 'artifact_bytes_missing', 'Stored artifact bytes are missing', 500);
    await this.blobs.put(caller.projectId, row.content);
    return { artifact, download: await missing(sign) };
  }
  async bytes(
    caller: Caller,
    artifactId: string,
    tx?: Transaction,
  ): Promise<{ artifact: Artifact; bytes: Buffer }> {
    caller = structuredClone(caller);
    const row = await this.one(caller, tx, (tx) =>
      tx.get<Record<string, unknown> & { content: Buffer | null }>(
        `SELECT ${META},content FROM artifacts WHERE id=? AND project_id=?`,
        artifactId,
        caller.projectId,
      ),
    );
    check(row, 'not_found', 'Artifact not found in this project', 404);
    const artifact = fromRow(row);
    if (artifact.size > MAX_ARTIFACT_BYTES)
      throw new MervError(
        'artifact_size',
        'Artifact exceeds the 2,000,000-byte inline limit',
        400,
        { artifactId: artifact.id, size: artifact.size },
      );
    return { artifact, bytes: row.content ?? (await this.fetch(caller.projectId, artifact, tx)) };
  }
  async read(
    caller: Caller,
    artifactId: string,
    range: { offset?: number; length?: number } = {},
    tx?: Transaction,
  ) {
    span(range);
    const { artifact, bytes } = await this.bytes(caller, artifactId, tx);
    return view(artifact, bytes, range);
  }
  async getMany(caller: Caller, ids: readonly string[], tx?: Transaction): Promise<Artifact[]> {
    caller = structuredClone(caller);
    check(
      Array.isArray(ids) && ids.length <= MAX_ARTIFACT_IDS && ids.every(named),
      'invalid_artifact',
      `Expected up to ${MAX_ARTIFACT_IDS} artifact ids`,
    );
    ids = [...ids];
    if (!ids.length) return [];
    const rows = await this.one(caller, tx, (tx) =>
      tx.all(
        `SELECT ${META} FROM artifacts WHERE project_id=? AND id IN (SELECT jsonb_array_elements_text(?::jsonb))`,
        caller.projectId,
        JSON.stringify([...new Set(ids)]),
      ),
    );
    const byId = new Map(rows.map((row) => [row.id as string, fromRow(row)]));
    return ids.map((id) => {
      const artifact = byId.get(id);
      check(artifact, 'not_found', 'Artifact not found in this project', 404);
      return artifact;
    });
  }
  async list(
    caller: Caller,
    { before, limit = 1000, session }: { before?: string; limit?: number; session?: string } = {},
    tx?: Transaction,
  ): Promise<Artifact[]> {
    caller = structuredClone(caller);
    check(before === undefined || named(before), 'invalid_artifact', 'Invalid before artifact id');
    check(session === undefined || named(session), 'invalid_artifact', 'Invalid session id');
    check(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000,
      'invalid_artifact',
      'limit must be 1-1000',
    );
    return await this.one(caller, tx, async (tx) => {
      const where = ['project_id=?'];
      const params: string[] = [caller.projectId];
      if (session !== undefined) {
        where.push('session_id=?');
        params.push(session);
      }
      if (before !== undefined) {
        const cursor = await tx.get<{ created_at: string; id: string }>(
          'SELECT created_at,id FROM artifacts WHERE id=? AND project_id=?',
          before,
          caller.projectId,
        );
        check(cursor, 'not_found', 'Artifact not found in this project', 404);
        where.push('(created_at,id) < (?,?)');
        params.push(cursor.created_at, cursor.id);
      }
      return (
        await tx.all(
          `SELECT ${META} FROM artifacts WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`,
          ...params,
          limit,
        )
      ).map(fromRow);
    });
  }
}
const configuration = z
  .object({
    /** Temporary: fill legacy rows' bytes into the row. Only the server's config turns it on. */
    backfill: z.boolean().default(false),
  })
  .strict()
  .default({});
export const artifactsPlugin = {
  name: 'merv-artifacts',
  inject: ['state', 'scope', 'blobs'],
  Config: configuration,
  async apply(ctx: Context, config: z.infer<typeof configuration> = { backfill: false }) {
    const artifacts = await createService(new ArtifactStore(ctx.state, ctx.scope, ctx.blobs));
    ctx.provide('artifacts', artifacts);
    if (config.backfill) ctx.effect(() => artifacts.backfill());
  },
};
export default artifactsPlugin;
