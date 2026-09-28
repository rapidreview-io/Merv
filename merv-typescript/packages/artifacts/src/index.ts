import { recorded, createService, plain } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { decode, isText, meta, request, span, view } from './content.js';
import type { Context } from 'cordis';
import { createHash } from 'node:crypto';
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
  type Sql,
  type Blobs,
  type Transaction,
} from '@merv/contracts';
const fromRow = (row: any): Artifact => ({
  id: row.id,
  projectId: row.project_id,
  createdBy: row.created_by,
  title: row.title,
  mediaType: row.media_type,
  hash: row.hash,
  size: row.size,
  createdAt: row.created_at,
  ...(row.object_id ? { objectId: row.object_id } : {}),
});
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
type UploadRow = {
  project_id: string;
  created_by: string;
  title: string;
  media_type: string;
  hash: string;
  size: number;
  object_id: string | null;
  artifact_id: string | null;
};
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
  constructor(
    private state: State,
    private scope: Scope,
    private blobs: Blobs,
  ) {
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
  private async pending(caller: Caller, uploadId: string) {
    await this.scope.require(caller, 'write');
    const row = await this.state.read((sql) =>
      sql.get(
        'SELECT * FROM artifact_uploads WHERE upload_id=? AND project_id=? AND created_by=?',
        uploadId,
        caller.projectId,
        caller.actorId,
      ),
    );
    check(row, 'not_found', 'Artifact upload not found in this project', 404);
    return row as unknown as UploadRow;
  }
  async uploadBegin(caller: Caller, input: ArtifactUploadInput): Promise<ArtifactUploadStatus> {
    caller = structuredClone(caller);
    input = plain<ArtifactUploadInput>(input, 'invalid_artifact');
    const storage = this.storage();
    await this.scope.require(caller, 'write');
    const { title, mediaType } = meta(input.title, input.mediaType);
    check(
      Number.isSafeInteger(input.size) && input.size > 0,
      'artifact_size',
      'Artifact size must be a positive safe integer',
    );
    check(
      typeof input.sha256 === 'string' && /^[0-9a-f]{64}$/.test(input.sha256),
      'invalid_artifact',
      'Artifact requires a lowercase SHA-256 digest',
    );
    const requestId = request(input.requestId);
    const uploadId =
      requestId !== undefined
        ? `aup_${createHash('sha256')
            .update(JSON.stringify([caller.projectId, requestId]))
            .digest('hex')}`
        : newId('aup');
    await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      await tx.run(
        'INSERT INTO artifact_uploads(upload_id,project_id,created_by,title,media_type,hash,size,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT (upload_id) DO NOTHING',
        uploadId,
        caller.projectId,
        caller.actorId,
        title,
        mediaType,
        input.sha256,
        input.size,
        now(),
      );
      const row = await tx.get('SELECT * FROM artifact_uploads WHERE upload_id=?', uploadId);
      check(
        row?.project_id === caller.projectId &&
          row?.created_by === caller.actorId &&
          row?.title === title &&
          row?.media_type === mediaType &&
          row?.hash === input.sha256 &&
          Number(row?.size) === input.size,
        'upload_conflict',
        'Upload request ID was reused with different details',
        409,
      );
    });
    const result = await storage.begin(caller.projectId, uploadId, {
      size: input.size,
      sha256: input.sha256,
    });
    await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const row = await tx.get(
        'SELECT * FROM artifact_uploads WHERE upload_id=? FOR UPDATE',
        uploadId,
      );
      check(
        row?.project_id === caller.projectId && row?.created_by === caller.actorId,
        'not_found',
        'Artifact upload not found in this project',
        404,
      );
      check(
        !row.object_id || row.object_id === result.objectId,
        'upload_conflict',
        'Upload object changed on retry',
        409,
      );
      if (!row.object_id)
        await tx.run(
          'UPDATE artifact_uploads SET object_id=? WHERE upload_id=?',
          result.objectId,
          uploadId,
        );
    });
    return { uploadId, ...result.plan };
  }
  async uploadResume(
    caller: Caller,
    uploadId: string,
    startPart = 1,
  ): Promise<ArtifactUploadStatus> {
    caller = structuredClone(caller);
    const storage = this.storage();
    const row = await this.pending(caller, uploadId);
    check(
      row.object_id,
      'upload_pending',
      'Retry artifact.upload_begin to recover the upload',
      409,
    );
    return { uploadId, ...(await storage.resume(caller.projectId, row.object_id, startPart)) };
  }
  async uploadComplete(caller: Caller, uploadId: string): Promise<Artifact> {
    caller = structuredClone(caller);
    const storage = this.storage();
    const row = await this.pending(caller, uploadId);
    if (row.artifact_id) return this.get(caller, row.artifact_id);
    check(
      row.object_id,
      'upload_pending',
      'Retry artifact.upload_begin to recover the upload',
      409,
    );
    const completed = await storage.complete(caller.projectId, row.object_id);
    check(
      completed.state === 'available' &&
        completed.objectId === row.object_id &&
        completed.size === Number(row.size) &&
        completed.sha256 === row.hash,
      'upload_mismatch',
      'Stored object differs from the declared artifact',
      502,
    );
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const current = (await tx.get(
        'SELECT * FROM artifact_uploads WHERE upload_id=? FOR UPDATE',
        uploadId,
      )) as unknown as UploadRow | undefined;
      check(
        current?.project_id === caller.projectId && current?.created_by === caller.actorId,
        'not_found',
        'Artifact upload not found in this project',
        404,
      );
      if (current.artifact_id)
        return fromRow(await tx.get('SELECT * FROM artifacts WHERE id=?', current.artifact_id));
      const artifact: Artifact = {
        id: newId('art'),
        projectId: caller.projectId,
        createdBy: caller.actorId,
        title: row.title,
        mediaType: row.media_type,
        hash: row.hash,
        size: Number(row.size),
        objectId: row.object_id!,
        createdAt: now(),
      };
      await tx.run(
        'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,object_id) VALUES(?,?,?,?,?,?,?,?,?)',
        artifact.id,
        artifact.projectId,
        artifact.createdBy,
        artifact.title,
        artifact.mediaType,
        artifact.hash,
        artifact.size,
        artifact.createdAt,
        row.object_id,
      );
      await tx.run(
        'UPDATE artifact_uploads SET artifact_id=? WHERE upload_id=?',
        artifact.id,
        uploadId,
      );
      await recorded(this.state, tx, caller, 'artifact.created', artifact.id, {
        hash: artifact.hash,
        size: artifact.size,
      });
      return artifact;
    });
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
    await this.scope.require(caller, 'read', tx);
    const lookup = async (sql: Sql) =>
      await sql.get(
        'SELECT * FROM artifacts WHERE id=? AND project_id=?',
        artifactId,
        caller.projectId,
      );
    const row = await (tx ? lookup(tx) : this.state.read(lookup));
    check(row, 'not_found', 'Artifact not found in this project', 404);
    return fromRow(row);
  }
  async authored(caller: Caller, transaction?: Transaction): Promise<Artifact[]> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      check(
        caller.session && actor.sessionId === (caller.session.agentSessionId ?? caller.session.id),
        'forbidden',
        'Output receipts require an authenticated session worker',
        403,
      );
      return (
        await tx.all(
          `SELECT a.* FROM artifacts a WHERE a.project_id=? AND a.created_by=? AND EXISTS(SELECT 1 FROM events e WHERE e.project_id=a.project_id AND e.subject_id=a.id AND e.type='artifact.created' AND (e.data_json::jsonb #>> '{source,sessionId}')=?) ORDER BY a.created_at,a.id`,
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
      await this.get(caller, artifactId);
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
    // Signing can wait for remote storage. Revocation during that wait must prevent issuance.
    await this.get(caller, artifactId);
    return { artifact, download };
  }
  async read(caller: Caller, artifactId: string, range: { offset?: number; length?: number } = {}) {
    caller = structuredClone(caller);
    span(range);
    const artifact = await this.get(caller, artifactId);
    check(
      artifact.size <= MAX_ARTIFACT_BYTES,
      'artifact_size',
      'Artifact exceeds the inline limit; use artifact.read with mode download',
    );
    const bytes = await this.fetch(caller.projectId, artifact);
    await this.get(caller, artifactId);
    return view(artifact, bytes, range);
  }
  async list(caller: Caller): Promise<Artifact[]> {
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read');
    return await this.state.read(async (sql) =>
      (
        await sql.all(
          'SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1000',
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
