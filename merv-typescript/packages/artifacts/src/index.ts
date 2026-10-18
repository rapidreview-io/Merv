import { canonical, createService, plain, record } from '@merv/contracts';
import type { ArtifactFile } from '@merv/contracts/artifact-models';
import { postgresMigrations } from './index.postgres.js';
import {
  META,
  MAX_STORED_READ_BYTES,
  decode,
  fromRow,
  insert,
  isText,
  json,
  meta,
  requestIdOf,
  span,
  view,
} from './content.js';
import { Uploads } from './uploads.js';
import type { Context } from 'cordis';
import {
  check,
  forRead,
  MervError,
  sha256Hex,
  newId,
  now,
  readCapped,
  recorded,
  inTransaction,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_IDS,
  type Artifacts,
  type Artifact,
  type ArtifactInput,
  type ArtifactCollectionInput,
  type ArtifactContent,
  type ArtifactFileProvider,
  type ArtifactReadRule,
  type ArtifactUploadInput,
  type ArtifactUploadStatus,
  type Caller,
  type State,
  type Scope,
  type Blobs,
  type Transaction,
} from '@merv/contracts';
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
/** A member's provider reference, which stays server-side. */
type FileRef = { name: string; provider: string; reference: string };
type Member = { file: ArtifactFile; ref: FileRef };
/** The most members one call links; each link is a few calls to the member's provider. */
const MAX_MEMBER_LINKS = 100;
const LINKS_IN_FLIGHT = 8;
/** `fn` over `values`, at most `width` at a time, in input order; a failure stops the rest. */
async function pooled<T, U>(values: readonly T[], width: number, fn: (value: T) => Promise<U>) {
  const results: U[] = [];
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]!).catch((error: unknown) => {
        failed = true;
        throw error;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, lane));
  return results;
}
/** Not found, with the members the caller most likely meant: those that share the last part of
 * the name asked for. Names are never resolved for it: a member's name is its exact identity. */
function missingMember(files: readonly ArtifactFile[], name: string) {
  const last = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const likely = files
    .map((file) => file.name)
    .filter((member) => last(member) === last(name))
    .slice(0, 5);
  const hint = likely.length
    ? `did you mean ${likely.map((member) => JSON.stringify(member)).join(' or ')}?`
    : `members are named by their whole path in the collection${files[0] ? `, such as ${JSON.stringify(files[0].name)}` : ''}`;
  return new MervError(
    'not_found',
    `Collection file ${JSON.stringify(name)} not found; ${hint}`,
    404,
    {
      fileName: name,
      fileCount: files.length,
      ...(likely.length ? { candidates: likely } : {}),
    },
  );
}
/** Above the inline limit a file is read only by a range, and only up to MAX_STORED_READ_BYTES. */
function readable(
  what: string,
  size: number,
  range: { length?: number },
  details: Record<string, unknown>,
) {
  if (size <= MAX_ARTIFACT_BYTES) return;
  if (size > MAX_STORED_READ_BYTES)
    throw new MervError(
      'artifact_size',
      `${what} exceeds the ${MAX_STORED_READ_BYTES.toLocaleString('en-US')}-byte limit of a ranged read`,
      400,
      details,
    );
  if (range.length === undefined)
    throw new MervError(
      'artifact_size',
      `${what} exceeds the 2,000,000-byte inline limit; give a length to read a range of it`,
      400,
      details,
    );
}
/** A row implies its bytes: storage that has lost them is a server fault, never a 404. */
const bytesLost = (error: unknown) => {
  throw error instanceof MervError && error.code === 'blob_not_found'
    ? new MervError('artifact_bytes_missing', 'Stored artifact bytes are missing', 500)
    : error;
};
/** The rows a read may return: a SQL condition on `artifacts` and its parameters. */
type Visible = { sql: string; params: string[] };
const EVERY: Visible = { sql: 'TRUE', params: [] };
export class ArtifactStore implements Artifacts {
  private fileProviders = new Map<string, ArtifactFileProvider>();
  private readRules = new Map<string, ArtifactReadRule>();
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
    await this.state.migrate('artifacts', postgresMigrations);
  }
  /** A read, authorised once in the transaction forRead picks, of the rows its caller may see. */
  private async one<T>(
    caller: Caller,
    tx: Transaction | undefined,
    fn: (tx: Transaction, visible: Visible) => Promise<T>,
  ) {
    return await forRead(
      this.state,
      async (tx) => {
        await this.scope.require(caller, 'read', tx);
        return await fn(tx, await this.visible(caller, tx));
      },
      tx,
    );
  }
  /** One row the caller may see, with `columns` beside the metadata; not_found when none. */
  private async row<T extends object = object>(
    caller: Caller,
    artifactId: string,
    tx: Transaction | undefined,
    columns = '',
  ) {
    const row = await this.one(caller, tx, (tx, visible) =>
      tx.get<Record<string, unknown> & T>(
        `SELECT ${META}${columns} FROM artifacts WHERE id=? AND project_id=? AND ${visible.sql}`,
        artifactId,
        caller.projectId,
        ...visible.params,
      ),
    );
    check(row, 'not_found', 'Artifact not found in this project', 404);
    return row;
  }
  /** What every owner's read rule leaves a session caller; anyone else sees every row. */
  private async visible(caller: Caller, tx: Transaction): Promise<Visible> {
    if (!caller.session) return EVERY;
    const artifacts: string[] = [];
    const sessions: string[] = [];
    for (const rule of [...this.readRules.values()]) {
      const withheld = await rule(caller, tx);
      artifacts.push(...(withheld?.artifacts ?? []));
      sessions.push(...(withheld?.sessions ?? []));
    }
    if (!artifacts.length && !sessions.length) return EVERY;
    return {
      sql: 'id NOT IN (SELECT jsonb_array_elements_text(?::jsonb)) AND (session_id IS NULL OR session_id NOT IN (SELECT jsonb_array_elements_text(?::jsonb)))',
      params: [JSON.stringify(artifacts), JSON.stringify(sessions)],
    };
  }
  registerReadRule(name: string, rule: ArtifactReadRule): () => void {
    check(
      /^[a-z][a-z0-9_-]{0,63}$/.test(name) && typeof rule === 'function',
      'invalid_artifact',
      'Invalid read rule',
    );
    check(!this.readRules.has(name), 'read_rule_exists', 'Read rule already registered', 409);
    this.readRules.set(name, rule);
    return () => {
      if (this.readRules.get(name) === rule) this.readRules.delete(name);
    };
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
      input.metadata === undefined || record(input.metadata),
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
    const requestId = requestIdOf(input.requestId);
    // A retry finds its actor's artifact by this key; another actor's same requestId stores its
    // own. It shares the project-unique source keys of collections, none of which is request:.
    const sourceKey =
      requestId === undefined
        ? null
        : `request:${sha256Hex(JSON.stringify([caller.actorId, requestId]))}`;
    // Database only: the bytes go in the row, so the caller's transaction does no network I/O.
    return await inTransaction(this.state, tx ?? this.state.ambient, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      // Write transactions take the writer lock, so a concurrent retry waits and then finds it.
      const stored =
        sourceKey &&
        (await tx.get(
          `SELECT ${META} FROM artifacts WHERE project_id=? AND source_key=?`,
          caller.projectId,
          sourceKey,
        ));
      if (!stored) return await insert(this.state, tx, caller, fields, bytes, sourceKey);
      const artifact = fromRow(stored);
      if (
        artifact.title !== fields.title ||
        artifact.mediaType !== fields.mediaType ||
        artifact.hash !== fields.hash
      )
        throw new MervError(
          'artifact_request_conflict',
          `requestId ${JSON.stringify(requestId)} already stored artifact ${artifact.id} with another title, media type or content; give a new requestId to store a different artifact`,
          409,
          { requestId, artifactId: artifact.id },
        );
      return artifact;
    });
  }
  async get(caller: Caller, artifactId: string, tx?: Transaction): Promise<Artifact> {
    return fromRow(await this.row(structuredClone(caller), artifactId, tx));
  }
  /** A collection and its named members, from one read of its row. */
  private async members(caller: Caller, artifactId: string, names: readonly string[]) {
    for (const name of names)
      check(collectionPath(name), 'invalid_artifact', 'Invalid collection file name');
    const row = await this.row(caller, artifactId, undefined, ',file_refs_json');
    const artifact = fromRow(row);
    const { files } = artifact;
    check(files, 'invalid_artifact', 'Artifact is not a collection; only a collection has files');
    const byName = new Map(files.map((file) => [file.name, file]));
    const refs = new Map(
      ((json(row.file_refs_json) as FileRef[] | null) ?? []).map((ref) => [ref.name, ref]),
    );
    const members = names.map((name): Member => {
      const file = byName.get(name);
      const ref = refs.get(name);
      if (!file || !ref || file.provider !== ref.provider) throw missingMember(files, name);
      return { file, ref };
    });
    return { artifact, members };
  }
  /** A fresh link to one member, signed by its provider. */
  private async link(caller: Caller, { file, ref }: Member) {
    const provider = this.fileProviders.get(file.provider);
    check(provider, 'download_unsupported', 'Collection file provider is unavailable', 503);
    return await provider.download(caller.projectId, ref.reference);
  }
  /** The file at a signed link, refused unless it is exactly `size` bytes whose SHA-256 is `hash`. */
  private async fetched(url: string, size: number, hash: string): Promise<Buffer> {
    const unavailable = () =>
      new MervError('blob_unavailable', 'Stored file could not be read', 503);
    const corrupt = () =>
      new MervError(
        'blob_corrupt',
        'Stored file does not match its retained size and SHA-256',
        500,
      );
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    }).catch(() => {
      throw unavailable();
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    const reader = response.body.getReader();
    const bytes = await readCapped(reader, size, corrupt)
      .catch((error: unknown) => {
        throw error instanceof MervError ? error : unavailable();
      })
      .finally(() => reader.releaseLock());
    if (bytes.length !== size || sha256Hex(bytes) !== hash) throw corrupt();
    return bytes;
  }
  async downloadFiles(caller: Caller, artifactId: string, fileNames: readonly string[]) {
    caller = structuredClone(caller);
    check(
      Array.isArray(fileNames) &&
        fileNames.length >= 1 &&
        fileNames.length <= MAX_MEMBER_LINKS &&
        new Set(fileNames).size === fileNames.length,
      'invalid_artifact',
      `Name 1-${MAX_MEMBER_LINKS} distinct collection files`,
    );
    const { artifact, members } = await this.members(caller, artifactId, fileNames);
    const downloads = await pooled(members, LINKS_IN_FLIGHT, async (member) => ({
      name: member.file.name,
      size: member.file.size,
      hash: member.file.hash,
      ...(await this.link(caller, member)),
    }));
    return { artifact, downloads };
  }
  async readStored(
    caller: Caller,
    artifactId: string,
    range: { fileName?: string; offset?: number; length?: number } = {},
  ): Promise<ArtifactContent & { fileName?: string }> {
    caller = structuredClone(caller);
    span(range);
    if (range.fileName !== undefined) {
      const { artifact, members } = await this.members(caller, artifactId, [range.fileName]);
      const member = members[0]!;
      const { name, size, hash } = member.file;
      readable('Collection file', size, range, { artifactId: artifact.id, fileName: name, size });
      const { url } = await this.link(caller, member);
      return { ...view(artifact, await this.fetched(url, size, hash), range), fileName: name };
    }
    const row = await this.row<{ content: Buffer | null }>(
      caller,
      artifactId,
      undefined,
      ',content',
    );
    const artifact = fromRow(row);
    readable('Artifact', artifact.size, range, { artifactId: artifact.id, size: artifact.size });
    if (row.content) return view(artifact, row.content, range);
    // Bytes kept only in blobs: above the inline limit, which only a signed link reads.
    check(
      artifact.size > MAX_ARTIFACT_BYTES,
      'artifact_bytes_missing',
      'Stored artifact bytes are missing',
      500,
    );
    if (!this.blobs.download)
      throw new MervError(
        'artifact_size',
        'Artifact exceeds the 2,000,000-byte inline limit',
        400,
        { artifactId: artifact.id, size: artifact.size },
      );
    const { url } = await this.blobs
      .download(caller.projectId, artifact.hash, artifact.size)
      .catch(bytesLost);
    return view(artifact, await this.fetched(url, artifact.size, artifact.hash), range);
  }
  /** `saveAs` names the downloaded file; it defaults to the artifact's title. */
  async download(caller: Caller, artifactId: string, fileName?: string, saveAs?: string) {
    caller = structuredClone(caller);
    if (fileName !== undefined) {
      const { artifact, members } = await this.members(caller, artifactId, [fileName]);
      return { artifact, download: await this.link(caller, members[0]!) };
    }
    const artifact = await this.get(caller, artifactId);
    check(
      this.blobs.download,
      'download_unsupported',
      'This storage provider does not support direct downloads',
      501,
    );
    // A leased worker saves the file under a name of its own (curl -o), so its link names it by
    // the title's plain form: one short signed parameter, not the whole title encoded twice.
    const short = artifact.title.replace(/[^A-Za-z0-9._-]+/g, '_');
    const name =
      saveAs ??
      (!caller.session ? artifact.title : /[A-Za-z0-9]/.test(short) ? short : artifact.id);
    const sign = () => this.blobs.download!(caller.projectId, artifact.hash, artifact.size, name);
    try {
      return { artifact, download: await sign() };
    } catch (error) {
      if (!(error instanceof MervError && error.code === 'blob_not_found')) throw error;
    }
    // The first download of bytes kept in the row mirrors them into blobs: content-addressed,
    // so a repeat or a race writes the same object.
    const row = await forRead(this.state, (tx) =>
      tx.get<{ content: Buffer | null }>(
        'SELECT content FROM artifacts WHERE id=? AND project_id=?',
        artifact.id,
        caller.projectId,
      ),
    );
    check(row?.content, 'artifact_bytes_missing', 'Stored artifact bytes are missing', 500);
    if (row.content.length <= MAX_ARTIFACT_BYTES || !this.blobs.upload)
      await this.blobs.put(caller.projectId, row.content);
    else {
      // A collection manifest above the inline blob limit goes up by signed PUT; 412 means
      // the same content-addressed object is already there.
      const put = await this.blobs.upload(caller.projectId, artifact.hash, row.content.length);
      const sent = await fetch(put.url, {
        method: 'PUT',
        headers: put.headers,
        body: new Uint8Array(row.content),
        signal: AbortSignal.timeout(60_000),
      }).catch(() => undefined);
      await sent?.body?.cancel();
      check(
        sent && (sent.ok || sent.status === 412),
        'blob_unavailable',
        'Blob upload failed',
        503,
      );
    }
    return { artifact, download: await sign().catch(bytesLost) };
  }
  async bytes(
    caller: Caller,
    artifactId: string,
    tx?: Transaction,
  ): Promise<{ artifact: Artifact; bytes: Buffer }> {
    caller = structuredClone(caller);
    const row = await this.row<{ content: Buffer | null }>(caller, artifactId, tx, ',content');
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
  async find(
    caller: Caller,
    ids: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, Artifact>> {
    caller = structuredClone(caller);
    check(
      Array.isArray(ids) && ids.length <= MAX_ARTIFACT_IDS && ids.every(named),
      'invalid_artifact',
      `Expected up to ${MAX_ARTIFACT_IDS} artifact ids`,
    );
    if (!ids.length) return new Map();
    const rows = await this.one(caller, tx, (tx, visible) =>
      tx.all(
        `SELECT ${META} FROM artifacts WHERE project_id=? AND id IN (SELECT jsonb_array_elements_text(?::jsonb)) AND ${visible.sql}`,
        caller.projectId,
        JSON.stringify([...new Set(ids)]),
        ...visible.params,
      ),
    );
    return new Map(rows.map((row) => [row.id as string, fromRow(row)]));
  }
  async getMany(caller: Caller, ids: readonly string[], tx?: Transaction): Promise<Artifact[]> {
    ids = Array.isArray(ids) ? [...ids] : ids;
    const byId = await this.find(caller, ids, tx);
    return ids.map((id) => {
      const artifact = byId.get(id);
      check(artifact, 'not_found', 'Artifact not found in this project', 404);
      return artifact;
    });
  }
  async getAll(caller: Caller, ids: readonly string[], tx?: Transaction): Promise<Artifact[]> {
    const found: Artifact[] = [];
    for (let start = 0; start < ids.length; start += MAX_ARTIFACT_IDS)
      found.push(...(await this.getMany(caller, ids.slice(start, start + MAX_ARTIFACT_IDS), tx)));
    return found;
  }
  async list(
    caller: Caller,
    {
      before,
      limit = 1000,
      sessions,
    }: { before?: string; limit?: number; sessions?: readonly string[] } = {},
    tx?: Transaction,
  ): Promise<Artifact[]> {
    caller = structuredClone(caller);
    check(before === undefined || named(before), 'invalid_artifact', 'Invalid before artifact id');
    check(
      sessions === undefined || (Array.isArray(sessions) && sessions.every(named)),
      'invalid_artifact',
      'Invalid session id',
    );
    check(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000,
      'invalid_artifact',
      'limit must be 1-1000',
    );
    return await this.one(caller, tx, async (tx, visible) => {
      const where = ['project_id=?', visible.sql];
      const params: string[] = [caller.projectId, ...visible.params];
      // One session walks its own index in order; several are one bounded read, sorted.
      if (sessions?.length === 1) {
        where.push('session_id=?');
        params.push(sessions[0]!);
      } else if (sessions !== undefined) {
        where.push('session_id IN (SELECT jsonb_array_elements_text(?::jsonb))');
        params.push(JSON.stringify(sessions));
      }
      if (before !== undefined) {
        const cursor = await tx.get<{ created_at: string; id: string }>(
          `SELECT created_at,id FROM artifacts WHERE id=? AND project_id=? AND ${visible.sql}`,
          before,
          caller.projectId,
          ...visible.params,
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
  async executionOutputs(caller: Caller, tx?: Transaction): Promise<Artifact[]> {
    // The session and actor are read after awaits.
    caller = structuredClone(caller);
    check(
      caller.session,
      'forbidden',
      'Output receipts require an authenticated session worker',
      403,
    );
    const outputs: Artifact[] = [];
    const limit = 1000;
    let page: Artifact[] = [];
    do {
      const before = page.at(-1)?.id;
      page = await this.list(caller, { sessions: [caller.session.id], before, limit }, tx);
      outputs.push(...page.filter((artifact) => artifact.createdBy === caller.actorId));
    } while (page.length === limit);
    return outputs.reverse();
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
