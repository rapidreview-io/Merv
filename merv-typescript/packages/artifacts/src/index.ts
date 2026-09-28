import { recorded, createService, plain } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { META, decode, fromRow, isText, meta, span, view } from './content.js';
import { Uploads } from './uploads.js';
import type { Context } from 'cordis';
import {
  check,
  MervError,
  newId,
  sha256Hex,
  now,
  inTransaction,
  MAX_ARTIFACT_BYTES,
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
/** Large storage returns unverified bytes; blobs.get verifies its own. */
const verified = (bytes: Buffer, artifact: Artifact): Buffer => {
  check(
    bytes.length === artifact.size && sha256Hex(bytes) === artifact.hash,
    'blob_corrupt',
    'Stored artifact bytes do not match their metadata',
    500,
  );
  return bytes;
};
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
export class ArtifactStore implements Artifacts {
  private large?: LargeArtifactStorage;
  bindLarge(storage: LargeArtifactStorage): () => void {
    this.large = storage;
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
    // Metadata must come from the same validated input as the bytes handed to storage.
    input = plain<ArtifactInput>(input, 'invalid_artifact');
    await this.scope.require(caller, 'write', tx);
    const bytes = decode(input);
    // Without a declared type, bytes that read back as text are Markdown; others are opaque.
    const { title, mediaType } = meta(
      input.title,
      input.mediaType ?? (isText(bytes) ? 'text/markdown' : 'application/octet-stream'),
    );
    const stored = await this.blobs.put(caller.projectId, bytes);
    return await inTransaction(this.state, tx, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const artifact: Artifact = {
        id: newId('art'),
        projectId: caller.projectId,
        createdBy: caller.actorId,
        title,
        mediaType,
        hash: stored.hash,
        size: stored.size,
        createdAt: now(),
      };
      await tx.run(
        'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at) VALUES(?,?,?,?,?,?,?,?)',
        artifact.id,
        artifact.projectId,
        artifact.createdBy,
        artifact.title,
        artifact.mediaType,
        artifact.hash,
        artifact.size,
        artifact.createdAt,
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
  async authored(caller: Caller, tx?: Transaction): Promise<Artifact[]> {
    caller = structuredClone(caller);
    return await this.place(tx, async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      check(
        caller.session && actor.sessionId === (caller.session.agentSessionId ?? caller.session.id),
        'forbidden',
        'Output receipts require an authenticated session worker',
        403,
      );
      return (
        await tx.all(
          `SELECT ${META} FROM artifacts a WHERE a.project_id=? AND a.created_by=? AND EXISTS(SELECT 1 FROM events e WHERE e.project_id=a.project_id AND e.subject_id=a.id AND e.type='artifact.created' AND (e.data_json::jsonb #>> '{source,sessionId}')=?) ORDER BY a.created_at,a.id`,
          caller.projectId,
          caller.actorId,
          caller.session.id,
        )
      ).map(fromRow);
    });
  }
  /** The bytes behind a row: large-storage bytes are verified here, blob bytes by blobs.get. */
  private async fetch(projectId: string, artifact: Artifact): Promise<Buffer> {
    if (!artifact.objectId) return await missing(() => this.blobs.get(projectId, artifact.hash));
    const storage = this.storage();
    return verified(
      await missing(() => storage.read(projectId, artifact.objectId!, artifact.size)),
      artifact,
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
    const download = await missing(() =>
      this.blobs.download!(caller.projectId, artifact.hash, artifact.size),
    );
    return { artifact, download };
  }
  async read(caller: Caller, artifactId: string, range: { offset?: number; length?: number } = {}) {
    caller = structuredClone(caller);
    span(range);
    const artifact = await this.get(caller, artifactId);
    if (artifact.size > MAX_ARTIFACT_BYTES)
      throw new MervError(
        'artifact_size',
        'Artifact exceeds the 2,000,000-byte inline limit',
        400,
        { artifactId: artifact.id, size: artifact.size },
      );
    return view(artifact, await this.fetch(caller.projectId, artifact), range);
  }
  async list(caller: Caller): Promise<Artifact[]> {
    caller = structuredClone(caller);
    return await this.one(caller, undefined, async (tx) =>
      (
        await tx.all(
          `SELECT ${META} FROM artifacts WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1000`,
          caller.projectId,
        )
      ).map(fromRow),
    );
  }
}
export const artifactsPlugin = {
  name: 'merv-artifacts',
  inject: ['state', 'scope', 'blobs'],
  async apply(ctx: Context) {
    ctx.provide(
      'artifacts',
      await createService(new ArtifactStore(ctx.state, ctx.scope, ctx.blobs)),
    );
  },
};
export default artifactsPlugin;
