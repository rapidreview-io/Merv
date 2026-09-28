import {
  check,
  forRead,
  MAX_ARTIFACT_BYTES,
  MAX_OBJECT_BYTES,
  newId,
  now,
  plain,
  sha256Hex,
  type Artifact,
  type ArtifactUploadInput,
  type ArtifactUploadStatus,
  type Blobs,
  type Caller,
  type Scope,
  type State,
} from '@merv/contracts';
import { META, fromRow, insert, meta } from './content.js';

type UploadRow = {
  upload_id: string;
  project_id: string;
  created_by: string;
  title: string;
  media_type: string;
  hash: string;
  size: number;
  artifact_id: string | null;
};
type Large = Blobs & Required<Pick<Blobs, 'upload' | 'stored'>>;

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

/** Resumable uploads of files into blobs by signed PUT, each owned by the actor that began it. */
export class Uploads {
  constructor(
    private state: State,
    private scope: Scope,
    private blobs: Blobs,
    private get: (caller: Caller, artifactId: string) => Promise<Artifact>,
  ) {}
  /** Before any transaction: a store that cannot sign uploads writes no row. */
  private large(): Large {
    check(
      this.blobs.upload && this.blobs.stored,
      'storage_unavailable',
      'Project large-file storage is unavailable',
      503,
    );
    return this.blobs as Large;
  }

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
    this.large();
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
    return row.artifact_id ? done(row) : await this.plan(row);
  }

  async resume(caller: Caller, uploadId: string): Promise<ArtifactUploadStatus> {
    const row = await this.row(structuredClone(caller), uploadId);
    return row.artifact_id ? done(row) : await this.plan(row);
  }

  async complete(caller: Caller, uploadId: string): Promise<Artifact> {
    caller = structuredClone(caller);
    const row = await this.row(caller, uploadId);
    if (row.artifact_id) return await this.get(caller, row.artifact_id);
    // The store accepts only bytes hashing to row.hash: a stored object of this size is the upload.
    check(await this.present(row), 'upload_pending', 'The file has not been uploaded yet', 409);
    const size = Number(row.size);
    // Inline-size files go into their row (blobs.get and the row CHECK verify); an outage is 503,
    // and a retry completes.
    const content =
      size <= MAX_ARTIFACT_BYTES ? await this.blobs.get(row.project_id, row.hash) : null;
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
        { title, mediaType, hash, size },
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

  /**
   * Whether the declared file is stored. A SHA-256 names one byte string: another stored size
   * means the declaration is wrong.
   */
  private async present(row: UploadRow) {
    const stored = await this.large().stored(row.project_id, row.hash);
    check(
      stored === null || stored === Number(row.size),
      'upload_mismatch',
      'A stored file with this SHA-256 has a different size',
      409,
    );
    return stored !== null;
  }

  /** One signed PUT, or none when the bytes are already stored. */
  private async plan(row: UploadRow): Promise<ArtifactUploadStatus> {
    const size = Number(row.size);
    const status = { uploadId: row.upload_id, partSize: size, partCount: 1, nextPart: null };
    if (await this.present(row)) return { ...status, parts: [], completedParts: [1] };
    const { url, headers } = await this.large().upload(row.project_id, row.hash, size);
    return { ...status, parts: [{ partNumber: 1, url, size, headers }], completedParts: [] };
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
