import { createService } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import { isUtf8 } from 'node:buffer';
import {
  eventSource,
  check,
  newId,
  now,
  inTransaction,
  type Artifacts,
  type Artifact,
  type ArtifactInput,
  type Caller,
  type State,
  type Scope,
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
});
export class ArtifactStore implements Artifacts {
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
          postgres: postgresMigrations[1],
          sql: `CREATE TABLE artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_by TEXT NOT NULL,title TEXT NOT NULL,media_type TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX artifacts_project ON artifacts(project_id);
      CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'Artifacts are immutable'); END;
      CREATE TRIGGER artifacts_immutable_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT,'Artifacts are immutable'); END;`,
        },
      ]);
    };
  }
  async create(caller: Caller, input: ArtifactInput, tx?: Transaction): Promise<Artifact> {
    await this.scope.require(caller, 'write', tx);
    check(
      typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 300,
      'invalid_artifact',
      'Artifact requires a title of at most 300 characters',
    );
    check(typeof input.content === 'string', 'invalid_artifact', 'Content must be a string');
    check(
      input.encoding === undefined || ['utf8', 'base64'].includes(input.encoding),
      'invalid_encoding',
      'Encoding must be utf8 or base64',
    );
    if (input.encoding === 'base64')
      check(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content),
        'invalid_encoding',
        'Invalid base64 content',
      );
    // Media types are case-insensitive; one spelling keeps every text/ test honest.
    const mediaType = (input.mediaType ?? 'text/markdown').toLowerCase();
    check(
      /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mediaType) && mediaType.length <= 150,
      'invalid_media_type',
      'Invalid media type',
    );
    const bytes = Buffer.from(input.content, input.encoding ?? 'utf8');
    check(
      bytes.length > 0 && bytes.length <= 2_000_000,
      'artifact_size',
      'Artifact must contain 1–2,000,000 bytes',
    );
    const stored = await this.blobs.put(caller.projectId, bytes);
    return await inTransaction(this.state, tx, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const artifact: Artifact = {
        id: newId('art'),
        projectId: caller.projectId,
        createdBy: caller.actorId,
        title: input.title.trim(),
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
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'artifact.created',
        subjectId: artifact.id,
        data: { hash: artifact.hash, size: artifact.size, ...eventSource(caller) },
      });
      return artifact;
    });
  }
  async get(caller: Caller, artifactId: string, tx?: Transaction): Promise<Artifact> {
    await this.scope.require(caller, 'read', tx);
    const row = tx
      ? await tx.get(
          'SELECT * FROM artifacts WHERE id=? AND project_id=?',
          artifactId,
          caller.projectId,
        )
      : await this.state.read(
          async (sql) =>
            await sql.get(
              'SELECT * FROM artifacts WHERE id=? AND project_id=?',
              artifactId,
              caller.projectId,
            ),
        );
    check(row, 'not_found', 'Artifact not found in this project', 404);
    return fromRow(row);
  }
  async authored(caller: Caller, transaction?: Transaction): Promise<Artifact[]> {
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
          tx.dialect === 'postgres'
            ? `SELECT a.* FROM artifacts a WHERE a.project_id=? AND a.created_by=? AND EXISTS(SELECT 1 FROM events e WHERE e.project_id=a.project_id AND e.subject_id=a.id AND e.type='artifact.created' AND (e.data_json::jsonb #>> '{source,sessionId}')=?) ORDER BY a.created_at,a.id`
            : `SELECT a.* FROM artifacts a WHERE a.project_id=? AND a.created_by=? AND EXISTS(SELECT 1 FROM events e WHERE e.project_id=a.project_id AND e.subject_id=a.id AND e.type='artifact.created' AND json_extract(e.data_json,'$.source.sessionId')=?) ORDER BY a.created_at,a.id`,
          caller.projectId,
          caller.actorId,
          caller.session.id,
        )
      ).map(fromRow);
    });
  }
  get downloadSupported() {
    return typeof this.blobs.download === 'function';
  }
  async download(caller: Caller, artifactId: string) {
    const artifact = await this.get(caller, artifactId);
    check(
      this.blobs.download,
      'download_unsupported',
      'This storage provider does not support direct downloads',
      501,
    );
    const download = await this.blobs.download(caller.projectId, artifact.hash, artifact.size);
    // Signing can wait for remote storage. Revocation during that wait must prevent issuance.
    await this.get(caller, artifactId);
    return { artifact, download };
  }
  async read(caller: Caller, artifactId: string) {
    const artifact = await this.get(caller, artifactId);
    check(
      artifact.size <= 2_000_000,
      'artifact_size',
      'Artifact exceeds the inline limit; use artifact.read with mode download',
    );
    const bytes = await this.blobs.get(caller.projectId, artifact.hash);
    await this.get(caller, artifactId);
    const encoding =
      (artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json') &&
      isUtf8(bytes)
        ? ('utf8' as const)
        : ('base64' as const);
    return { artifact, content: bytes.toString(encoding), encoding };
  }
  async list(caller: Caller): Promise<Artifact[]> {
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
