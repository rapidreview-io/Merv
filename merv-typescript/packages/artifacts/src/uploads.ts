import {
  check,
  forRead,
  MervError,
  MAX_ARTIFACT_BYTES,
  MAX_OBJECT_BYTES,
  newId,
  now,
  plain,
  sha256Hex,
  type Artifact,
  type ArtifactUploadInput,
  type ArtifactUploadStatus,
  type Caller,
  type LargeArtifactStorage,
  type Scope,
  type State,
} from '@merv/contracts';
import { META, fromRow, insert, meta, verified } from './content.js';

type UploadRow = {
  upload_id: string;
  project_id: string;
  created_by: string;
  title: string;
  media_type: string;
  hash: string;
  size: number;
  object_id: string | null;
  artifact_id: string | null;
};

/** A completed upload: its artifact, and nothing left to send. */
const done = (row: UploadRow): ArtifactUploadStatus => ({
  uploadId: row.upload_id,
  artifactId: row.artifact_id!,
  partSize: 0,
  partCount: 0,
  parts: [],
  completedParts: [],
  nextPart: null,
});

/** Resumable uploads of large files into bound large storage, each owned by the actor that began it. */
export class Uploads {
  constructor(
    private state: State,
    private scope: Scope,
    private storage: () => LargeArtifactStorage,
    private get: (caller: Caller, artifactId: string) => Promise<Artifact>,
  ) {}

  async begin(caller: Caller, input: ArtifactUploadInput): Promise<ArtifactUploadStatus> {
    caller = structuredClone(caller);
    input = plain<ArtifactUploadInput>(input, 'invalid_artifact');
    const { title, mediaType } = meta(input.title, input.mediaType);
    check(
      Number.isSafeInteger(input.size) && input.size > 0 && input.size <= MAX_OBJECT_BYTES,
      'artifact_size',
      'Artifact size must be 1 byte to 512 MiB',
    );
    check(
      typeof input.sha256 === 'string' && /^[0-9a-f]{64}$/.test(input.sha256),
      'invalid_artifact',
      'Artifact requires a lowercase SHA-256 digest',
    );
    const { requestId } = input;
    // The tool schema's rule and no stricter, because the value is only hashed.
    check(
      requestId === undefined ||
        (typeof requestId === 'string' && requestId.length >= 1 && requestId.length <= 128),
      'invalid_artifact',
      'requestId must be a string of 1-128 characters',
    );
    // Before any transaction: with storage unbound there is no row and no lock.
    const storage = this.storage();
    // A retry finds its actor's upload; another actor's same requestId begins its own.
    const uploadId =
      requestId === undefined
        ? newId('aup')
        : `aup_${sha256Hex(JSON.stringify([caller.projectId, caller.actorId, requestId]))}`;
    const row = await this.state.transaction(async (tx) => {
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
      const row = await tx.get<UploadRow>(
        'SELECT * FROM artifact_uploads WHERE upload_id=?',
        uploadId,
      );
      check(
        row &&
          row.project_id === caller.projectId &&
          row.created_by === caller.actorId &&
          row.title === title &&
          row.media_type === mediaType &&
          row.hash === input.sha256 &&
          Number(row.size) === input.size,
        'upload_conflict',
        'Upload request ID was reused with different details',
        409,
      );
      return row;
    });
    if (row.artifact_id) return done(row);
    const { objectId, plan } = await storage.begin(caller.projectId, uploadId, {
      size: input.size,
      sha256: input.sha256,
    });
    // Signed part URLs are a write capability: authorise again before handing them out.
    await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const { changes } = await tx.run(
        'UPDATE artifact_uploads SET object_id=? WHERE upload_id=? AND (object_id IS NULL OR object_id=?)',
        objectId,
        uploadId,
        objectId,
      );
      check(changes === 1, 'upload_conflict', 'Upload object changed on retry', 409);
    });
    return { ...plan, uploadId };
  }

  async resume(caller: Caller, uploadId: string, startPart = 1): Promise<ArtifactUploadStatus> {
    caller = structuredClone(caller);
    const row = await this.row(caller, uploadId);
    if (row.artifact_id) return done(row);
    check(row.object_id, 'upload_pending', 'Upload has no storage object yet', 409);
    const plan = await this.storage().resume(caller.projectId, row.object_id, startPart);
    // Signed part URLs are a write capability: a revocation while they were signed withholds them.
    await forRead(this.state, (tx) => this.scope.require(caller, 'write', tx));
    return { ...plan, uploadId: row.upload_id };
  }

  async complete(caller: Caller, uploadId: string): Promise<Artifact> {
    caller = structuredClone(caller);
    const row = await this.row(caller, uploadId);
    if (row.artifact_id) return await this.get(caller, row.artifact_id);
    check(row.object_id, 'upload_pending', 'Upload has no storage object yet', 409);
    const objectId = row.object_id;
    const size = Number(row.size);
    const storage = this.storage();
    const completed = await storage.complete(caller.projectId, objectId);
    check(
      completed.state === 'available' &&
        completed.objectId === objectId &&
        completed.size === size &&
        completed.sha256 === row.hash,
      'upload_mismatch',
      'Stored object differs from the declared artifact',
      502,
    );
    // An object within the inline limit is copied into its row, so reading it never reaches
    // storage again. Corrupt bytes fail the completion; an outage leaves the row reading through
    // the object instead. An object storage has just reported available but cannot find is not
    // what it claimed.
    let content: Buffer | null = null;
    if (size <= MAX_ARTIFACT_BYTES)
      try {
        content = verified(await storage.read(caller.projectId, objectId, size), {
          size,
          hash: row.hash,
        });
      } catch (error) {
        if (error instanceof MervError && error.code === 'blob_not_found')
          throw new MervError(
            'upload_mismatch',
            'Stored object differs from the declared artifact',
            502,
          );
        if (!(error instanceof MervError && error.code === 'blob_unavailable')) throw error;
      }
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const current = await tx.get<{ artifact_id: string | null }>(
        'SELECT artifact_id FROM artifact_uploads WHERE upload_id=? FOR UPDATE',
        uploadId,
      );
      // A concurrent completion recorded the artifact first.
      if (current?.artifact_id)
        return fromRow(
          await tx.get(`SELECT ${META} FROM artifacts WHERE id=?`, current.artifact_id),
        );
      const { title, media_type: mediaType, hash } = row;
      const artifact = await insert(
        this.state,
        tx,
        caller,
        { title, mediaType, hash, size, objectId },
        content,
      );
      await tx.run(
        'UPDATE artifact_uploads SET artifact_id=? WHERE upload_id=?',
        artifact.id,
        uploadId,
      );
      return artifact;
    });
  }

  /** The caller's own upload, looked up under write authority in one read-only transaction. */
  private async row(caller: Caller, uploadId: string): Promise<UploadRow> {
    return await forRead(this.state, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const row = await tx.get<UploadRow>(
        'SELECT * FROM artifact_uploads WHERE upload_id=? AND project_id=? AND created_by=?',
        uploadId,
        caller.projectId,
        caller.actorId,
      );
      check(row, 'not_found', 'Artifact upload not found in this project', 404);
      return row;
    });
  }
}
