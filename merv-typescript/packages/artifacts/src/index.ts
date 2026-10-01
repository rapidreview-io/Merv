import { createService, plain } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { META, decode, fromRow, insert, isText, meta, span, view } from './content.js';
import { Uploads } from './uploads.js';
import type { Context } from 'cordis';
import {
  check,
  MervError,
  sha256Hex,
  newId,
  now,
  recorded,
  inTransaction,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_IDS,
  type Artifacts,
  type Artifact,
  type ArtifactInput,
  type ArtifactCollectionInput,
  type ArtifactFileProvider,
  type ArtifactUploadInput,
  type ArtifactUploadStatus,
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
// Collection names are logical POSIX paths, never local filesystem paths. Reject aliases
// instead of normalizing them so the signed member identity is exact and immutable.
const collectionPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\\\x00-\x1f\x7f]/.test(value) &&
  !/^[a-zA-Z]:/.test(value) &&
  value
    .split('/')
    .every((part) => part.length > 0 && part.length <= 255 && part !== '.' && part !== '..');
const COLLECTION_MANIFEST_BYTES = 16 * 1024 * 1024;
const parsed = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const canonical = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);
export class ArtifactStore implements Artifacts {
  private fileProviders = new Map<string, ArtifactFileProvider>();
  get largeUploadAvailable(): boolean {
    return typeof this.blobs.upload === 'function';
  }
  get downloadAvailable(): boolean {
    return typeof this.blobs.download === 'function';
  }
  private uploads: Uploads;
  constructor(
    private state: State,
    private scope: Scope,
    private blobs: Blobs,
  ) {
    this.uploads = new Uploads(state, scope, blobs, (caller, artifactId) =>
      this.get(caller, artifactId),
    );
  }
  /** Complete storage migrations before publishing this service. */
  async initialize() {
    await this.state.migrate(
      'artifacts',
      Object.entries(postgresMigrations).map(([version, sql]) => ({ version: +version, sql })),
    );
  }
  /**
   * Where a read runs: an explicit `tx`, else the ambient transaction, else a read-only snapshot
   * transaction of its own (reader pool, no writer lock). Scope's `within(…, 'read')` rule.
   */
  private async place<T>(tx: Transaction | undefined, fn: (tx: Transaction) => Promise<T>) {
    if (tx) this.state.assertTransaction(tx);
    const within = tx ?? this.state.ambient;
    return within ? await fn(within) : await this.state.snapshot(() => this.state.transaction(fn));
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
  uploadResume(caller: Caller, uploadId: string): Promise<ArtifactUploadStatus> {
    return this.uploads.resume(caller, uploadId);
  }
  uploadComplete(caller: Caller, uploadId: string): Promise<Artifact> {
    return this.uploads.complete(caller, uploadId);
  }
  registerFileProvider(name: string, provider: ArtifactFileProvider): () => void {
    check(
      /^[a-z][a-z0-9_-]{0,63}$/.test(name) && typeof provider?.download === 'function',
      'invalid_artifact',
      'Invalid file provider',
    );
    check(
      !this.fileProviders.has(name),
      'file_provider_exists',
      'File provider already registered',
      409,
    );
    this.fileProviders.set(name, provider);
    return () => {
      if (this.fileProviders.get(name) === provider) this.fileProviders.delete(name);
    };
  }
  async createCollection(
    caller: Caller,
    input: ArtifactCollectionInput,
    tx?: Transaction,
  ): Promise<Artifact> {
    caller = structuredClone(caller);
    input = plain<ArtifactCollectionInput>(input, 'invalid_artifact', {
      bytes: 64 * 1024 * 1024,
      nodes: 1_000_000,
    });
    const title = meta(input.title, 'application/vnd.merv.collection+json').title;
    check(
      typeof input.sourceKey === 'string' &&
        input.sourceKey.length >= 1 &&
        input.sourceKey.length <= 128,
      'invalid_artifact',
      'Collection requires a source key of at most 128 characters',
    );
    check(
      Array.isArray(input.files) && input.files.length <= 10_000,
      'invalid_artifact',
      'Collection supports at most 10,000 files',
    );
    const names = new Set<string>();
    const files = input.files.map((file) => {
      check(
        file && typeof file === 'object' && collectionPath(file.name) && !names.has(file.name),
        'invalid_artifact',
        'Collection file names must be distinct safe relative paths',
      );
      names.add(file.name);
      check(
        Number.isSafeInteger(file.size) &&
          file.size >= 0 &&
          /^[0-9a-f]{64}$/.test(file.hash) &&
          typeof file.provider === 'string' &&
          /^[a-z][a-z0-9_-]{0,63}$/.test(file.provider) &&
          typeof file.reference === 'string' &&
          file.reference.length > 0 &&
          file.reference.length <= 4096,
        'invalid_artifact',
        'Invalid collection file metadata',
      );
      return { name: file.name, size: file.size, hash: file.hash, provider: file.provider };
    });
    check(
      input.metadata === undefined ||
        (input.metadata !== null &&
          !Array.isArray(input.metadata) &&
          typeof input.metadata === 'object'),
      'invalid_artifact',
      'Collection metadata must be an object',
    );
    const refs = input.files.map(({ name, provider, reference }) => ({
      name,
      provider,
      reference,
    }));
    const fingerprint = sha256Hex(
      Buffer.from(canonical({ title, files, refs, metadata: input.metadata ?? null })),
    );
    const manifest = Buffer.from(
      canonical({
        kind: 'file_collection',
        files,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }),
    );
    check(
      manifest.length <= COLLECTION_MANIFEST_BYTES,
      'artifact_size',
      'Collection manifest exceeds 16 MiB',
    );
    return await inTransaction(this.state, tx ?? this.state.ambient, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const artifact: Artifact = {
        id: newId('art'),
        projectId: caller.projectId,
        createdBy: caller.actorId,
        title,
        mediaType: 'application/vnd.merv.collection+json',
        hash: sha256Hex(manifest),
        size: manifest.length,
        createdAt: now(),
        files,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
      const inserted = await tx.get<{ id: string }>(
        `INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,content,session_id,source_key,collection_input_hash,files_json,file_refs_json,metadata_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb)
         ON CONFLICT (project_id,source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING id`,
        artifact.id,
        artifact.projectId,
        artifact.createdBy,
        artifact.title,
        artifact.mediaType,
        artifact.hash,
        artifact.size,
        artifact.createdAt,
        manifest,
        caller.session?.id ?? null,
        input.sourceKey,
        fingerprint,
        JSON.stringify(files),
        JSON.stringify(refs),
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      );
      if (inserted) {
        await recorded(this.state, tx, caller, 'artifact.created', artifact.id, {
          hash: artifact.hash,
          size: artifact.size,
        });
        return artifact;
      }
      const existing = await tx.get<Record<string, unknown>>(
        `SELECT ${META},collection_input_hash FROM artifacts WHERE project_id=? AND source_key=?`,
        caller.projectId,
        input.sourceKey,
      );
      check(
        existing?.collection_input_hash === fingerprint,
        'artifact_source_conflict',
        'Collection source key already identifies different content',
        409,
      );
      return fromRow(existing);
    });
  }
  async create(caller: Caller, input: ArtifactInput, tx?: Transaction): Promise<Artifact> {
    caller = structuredClone(caller);
    input = plain<ArtifactInput>(input, 'invalid_artifact');
    const bytes = decode(input);
    // Without a declared type, bytes that read back as text are Markdown; others are opaque.
    const type = input.mediaType ?? (isText(bytes) ? 'text/markdown' : 'application/octet-stream');
    const fields = { ...meta(input.title, type), hash: sha256Hex(bytes), size: bytes.length };
    // Database only: the bytes go in the row, so the caller's transaction does no network I/O.
    return await inTransaction(this.state, tx ?? this.state.ambient, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await insert(this.state, tx, caller, fields, bytes);
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
  async download(caller: Caller, artifactId: string, fileName?: string) {
    caller = structuredClone(caller);
    if (fileName !== undefined) {
      check(collectionPath(fileName), 'invalid_artifact', 'Invalid collection file name');
      const row = await this.one(caller, undefined, (tx) =>
        tx.get<Record<string, unknown>>(
          `SELECT ${META},file_refs_json FROM artifacts WHERE id=? AND project_id=?`,
          artifactId,
          caller.projectId,
        ),
      );
      check(row, 'not_found', 'Artifact not found in this project', 404);
      const artifact = fromRow(row);
      const file = artifact.files?.find((member) => member.name === fileName);
      const ref = (
        parsed(row.file_refs_json) as { name: string; provider: string; reference: string }[] | null
      )?.find((member) => member.name === fileName);
      check(
        file && ref && file.provider === ref.provider,
        'not_found',
        'Collection file not found',
        404,
      );
      const provider = this.fileProviders.get(file.provider);
      check(provider, 'download_unsupported', 'Collection file provider is unavailable', 503);
      return { artifact, download: await provider.download(caller.projectId, ref.reference) };
    }
    const artifact = await this.get(caller, artifactId);
    check(
      this.blobs.download,
      'download_unsupported',
      'This storage provider does not support direct downloads',
      501,
    );
    const sign = () =>
      this.blobs.download!(caller.projectId, artifact.hash, artifact.size, artifact.title);
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
    check(row.content, 'artifact_bytes_missing', 'Stored artifact bytes are missing', 500);
    return { artifact, bytes: row.content };
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
