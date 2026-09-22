import { canonical, check, digest, MervError } from '@merv/contracts';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { z } from 'zod';
import { hashFile } from '../files.js';
import { directoryKey, type CodeRepositories, type ObjectFormat } from './repository.js';

/** One copy, now, instead of at the next turn of the timer. */
export const codeBackupRunSchema = z
  .object({ requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/) })
  .strict();

/** One object in the bucket, as the manifest that names it describes it. */
export interface BackupObject {
  key: string;
  sha256: string;
  bytes: number;
}
/**
 * What one pass wrote for one project. It is read by a restore with the database gone, so it
 * carries the marker bytes and the ref list rather than naming rows that would have to exist.
 */
export interface BackupManifest {
  format: 1;
  deployment: string;
  projectId: string;
  repositoryId: string;
  objectFormat: ObjectFormat;
  takenAt: string;
  verifiedAt: string;
  /** The bytes of merv-project.json, which is what rebuilds the directory's identity. */
  marker: string;
  bundle: BackupObject | null;
  refs: { name: string; oid: string }[];
  refsHash: string;
  /** The database copy this repository copy is consistent with; it was taken first. */
  database: (BackupObject & { backend: 'postgres' | 'sqlite' }) | null;
}
/** What one run of the backup journals; `fingerprint` is the digest of everything above it. */
export interface CodeBackupReceipt {
  formatVersion: 1;
  deployment: string;
  takenAt: string;
  verifiedAt: string;
  bundle: (BackupObject & { reused: boolean }) | null;
  database: (BackupObject & { backend: 'postgres' | 'sqlite' }) | null;
  manifest: BackupObject | null;
  refs: number;
  refsHash: string;
  /** What this run put in the bucket; a reused bundle costs nothing and counts nothing. */
  bytes: number;
  pruned: string[];
  warnings: string[];
  fingerprint: string;
}

/**
 * Everything the backup does to a bucket it shares with artifacts. Keys are built by Code
 * alone from the deployment, the project's directory key and a timestamp, so nothing a
 * caller supplies ever reaches one.
 */
export interface BackupObjectStore {
  /** Write one object from a file; the digest travels with it so the store refuses bad bytes. */
  putFile(key: string, file: string, bytes: number, sha256: string): Promise<void>;
  putBytes(key: string, body: Buffer): Promise<void>;
  /** The object's size, or null where nothing is stored under that key. */
  head(key: string): Promise<number | null>;
  getBytes(key: string): Promise<Buffer>;
  /** Stream one object to a file, measuring it on the way in. */
  getFile(key: string, file: string): Promise<BackupObject>;
  list(prefix: string): Promise<string[]>;
  remove(keys: string[]): Promise<void>;
  close(): Promise<void>;
}

export interface S3BackupOptions {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  prefix?: string;
  timeoutMs?: number;
  /** Only for a local protocol fixture; never exposed in plugin configuration. */
  allowHttpLoopbackForTests?: boolean;
}

const DELETE_BATCH = 1000;

/** The bucket, addressed directly. Blobs owns artifacts and caps them at 2 MB; a bundle is not one. */
export class S3BackupStore implements BackupObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;

  constructor(options: S3BackupOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new MervError('invalid_backup_config', 'Backup endpoint must be an HTTPS origin');
    }
    // Verbatim the rule S3Blobs keeps: only a plain HTTPS origin, and loopback only for a test.
    const testLoopback =
      options.allowHttpLoopbackForTests === true &&
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
    check(
      (endpoint.protocol === 'https:' || testLoopback) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash &&
        endpoint.pathname === '/',
      'invalid_backup_config',
      'Backup endpoint must be an HTTPS origin',
    );
    check(
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket),
      'invalid_backup_config',
      'Invalid backup bucket',
    );
    check(
      !!options.accessKeyId?.trim() && !!options.secretAccessKey?.trim(),
      'invalid_backup_config',
      'Backup credentials must be configured',
    );
    this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
    check(
      !this.prefix ||
        this.prefix.split('/').every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '..'),
      'invalid_backup_config',
      'Invalid backup prefix',
    );
    this.bucket = options.bucket;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.client = new S3Client({
      endpoint: endpoint.origin,
      region: options.region ?? 'auto',
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 3,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private at(key: string): string {
    return [this.prefix, key].filter(Boolean).join('/');
  }
  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }
  private failed(what: string, error: unknown): never {
    if (error instanceof MervError) throw error;
    // The provider's own message can carry the request's signed headers, so only what
    // Code was doing is said; the status is enough to tell a refusal from an outage.
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    throw new MervError(
      'code_backup_unavailable',
      `Backup storage could not ${what}${status ? ` (HTTP ${status})` : ''}`,
      503,
    );
  }

  async putFile(key: string, file: string, bytes: number, sha256: string): Promise<void> {
    const signal = this.signal();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.at(key),
          Body: createReadStream(file),
          ContentLength: bytes,
          ContentType: 'application/octet-stream',
          // The store itself refuses bytes that did not arrive intact.
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      this.failed('take an object', error);
    }
  }

  async putBytes(key: string, body: Buffer): Promise<void> {
    const signal = this.signal();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.at(key),
          Body: body,
          ContentType: 'application/json',
          ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      this.failed('take an object', error);
    }
  }

  async head(key: string): Promise<number | null> {
    const signal = this.signal();
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.at(key) }),
        { abortSignal: signal },
      );
      return head.ContentLength ?? null;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return null;
      this.failed('read an object', error);
    }
  }

  private async body(key: string): Promise<Readable> {
    const signal = this.signal();
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.at(key) }),
        { abortSignal: signal },
      );
      const body = response.Body as Readable | undefined;
      check(
        body && typeof body[Symbol.asyncIterator] === 'function',
        'code_backup_unavailable',
        'Backup storage returned no object body',
        503,
      );
      return body!;
    } catch (error) {
      this.failed('read an object', error);
    }
  }

  async getBytes(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.body(key)) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  async getFile(key: string, file: string): Promise<BackupObject> {
    const hash = createHash('sha256');
    let bytes = 0;
    const source = await this.body(key);
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      hash.update(chunk);
    });
    await pipeline(source, createWriteStream(file, { mode: 0o600 }));
    return { key, bytes, sha256: hash.digest('hex') };
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    try {
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.at(prefix),
            ContinuationToken: token,
          }),
          { abortSignal: this.signal() },
        );
        for (const object of page.Contents ?? [])
          if (object.Key)
            keys.push(this.prefix ? object.Key.slice(this.prefix.length + 1) : object.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    } catch (error) {
      this.failed('list objects', error);
    }
    return keys;
  }

  async remove(keys: string[]): Promise<void> {
    for (let at = 0; at < keys.length; at += DELETE_BATCH)
      try {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: keys.slice(at, at + DELETE_BATCH).map((key) => ({ Key: this.at(key) })),
            },
          }),
          { abortSignal: this.signal() },
        );
      } catch (error) {
        this.failed('remove an object', error);
      }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}

/** One consistent copy of the database, taken by the database's own tool and never by a query. */
export interface DatabaseCopy {
  backend: 'postgres' | 'sqlite';
  /** What the object key ends in, so a restore knows what it is holding. */
  extension: string;
  write(file: string): Promise<void>;
}

/**
 * `pg_dump` of one schema. Merv's own connection is not used and no table is read through
 * SQL: the schema is exported by PostgreSQL's tool under a snapshot of its own, which is why
 * this needs neither the writer lock nor a project's turn. The password reaches the child
 * through its environment, never through an argument, which `ps` would show.
 */
export function postgresDump(connectionString: string, schema: string): DatabaseCopy {
  check(
    /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema),
    'invalid_backup_config',
    'The backup database schema is not a schema name',
  );
  return {
    backend: 'postgres',
    extension: '.sql.gz',
    async write(file) {
      let url: URL;
      try {
        url = new URL(connectionString);
      } catch {
        throw new MervError(
          'invalid_backup_config',
          'The backup database connection string is not a URI',
        );
      }
      const environment: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        PGCONNECT_TIMEOUT: '10',
        LC_ALL: 'C',
      };
      if (url.hostname) environment.PGHOST = decodeURIComponent(url.hostname);
      if (url.port) environment.PGPORT = url.port;
      if (url.username) environment.PGUSER = decodeURIComponent(url.username);
      if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
      const database = url.pathname.replace(/^\//, '');
      if (database) environment.PGDATABASE = decodeURIComponent(database);
      const mode = url.searchParams.get('sslmode');
      if (mode) environment.PGSSLMODE = mode;
      const child = spawn(
        'pg_dump',
        ['--schema', schema, '--no-owner', '--no-privileges', '--format', 'plain'],
        { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      // Drained and dropped: an unread pipe fills and stops the child, and nothing in what
      // libpq writes there may reach a caller (see the refusal below).
      child.stderr.resume();
      const ended = new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      });
      await pipeline(child.stdout, createGzip(), createWriteStream(file, { mode: 0o600 }));
      const code = await ended.catch(() => 1);
      // Never libpq's own message. Its first line on a connection failure names the database
      // host, its port and the role, and this error is answered to the project administrator
      // who asked for the copy — the same reason the S3 path keeps only the HTTP status.
      check(code === 0, 'code_backup_database_failed', `pg_dump exited ${code}`, 500);
    },
  };
}

/**
 * A copy of a SQLite database file. `VACUUM INTO` on a read-only connection of its own writes
 * one consistent file while the server keeps writing, which a plain file copy would not.
 */
export function sqliteCopy(path: string): DatabaseCopy {
  return {
    backend: 'sqlite',
    extension: '.sqlite',
    async write(file) {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        database.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
      } finally {
        database.close();
      }
    },
  };
}

export interface CodeBackupSettings {
  /** The one segment that keeps two deployments sharing a bucket apart; usually the schema. */
  deployment: string;
  store: BackupObjectStore;
  /** How often a pass runs, and how much acknowledged work a disk failure may cost. */
  everySeconds: number;
  keepDays: number;
  /** Above this a single PutObject is refused by S3 and R2 alike, so nothing is sent. */
  maxBytes: number;
  database?: DatabaseCopy;
}
export const defaultBackupSettings = {
  everySeconds: 86_400,
  keepDays: 30,
  maxBytes: 4 * 1024 * 1024 * 1024,
};

const DAY_MS = 86_400_000;
const BUNDLE_TIMEOUT_MS = 10 * 60_000;
/** `20260922T110240Z`: the stamp every key of one pass is named by, and pruned by. */
export const stampOf = (at: string) => at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const stampMs = (key: string) => {
  const stamp = /(\d{8})T(\d{6})Z/.exec(key);
  if (!stamp) return NaN;
  const [, date, time] = stamp;
  return Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}Z`,
  );
};
/** Where a project's copies live; the directory key is the one the disk already uses. */
export const codePrefix = (deployment: string, projectId: string) =>
  `${deployment}/code/${directoryKey(projectId)}/`;
export const databasePrefix = (deployment: string) => `${deployment}/db/`;
export const LATEST = 'latest.json';

/**
 * The verified copy of what Code keeps on disk. Nothing here runs inside a database
 * transaction: it cuts a bundle, hashes it, writes it to the bucket and reads it back. The
 * disk stays authoritative — a bare repository needs a filesystem no bucket provides — so
 * this is a copy that can be restored, never the place Git works.
 */
export class CodeBackups {
  constructor(
    readonly settings: CodeBackupSettings,
    private readonly repositories: CodeRepositories,
  ) {}

  /**
   * The database first, the repositories second. A repository ahead of its database holds
   * objects no row names, which is harmless and recoverable; a database ahead of its
   * repository names commits that are simply gone, which is not.
   */
  async database(
    takenAt: string,
  ): Promise<(BackupObject & { backend: 'postgres' | 'sqlite' }) | null> {
    const copy = this.settings.database;
    if (!copy) return null;
    await this.repositories.assertVolume();
    // The stamp alone has second resolution, so two passes begun in the same second would
    // write, hash and delete one another's file; a name nothing else can guess cannot.
    const file = join(
      this.repositories.config.root,
      'tmp',
      `backup-${stampOf(takenAt)}-${randomUUID()}${copy.extension}`,
    );
    try {
      await copy.write(file);
      const bytes = (await stat(file)).size;
      const sha256 = await hashFile(file);
      const key = `${databasePrefix(this.settings.deployment)}${stampOf(takenAt)}${copy.extension}`;
      check(
        bytes <= this.settings.maxBytes,
        'code_backup_too_large',
        'The database copy is larger than one object may be',
        507,
      );
      await this.settings.store.putFile(key, file, bytes, sha256);
      await this.verify(key, bytes);
      return { key, bytes, sha256, backend: copy.backend };
    } finally {
      await rm(file, { force: true });
    }
  }

  /**
   * Proof the object is readable, not merely that the store accepted it. A bundle or a dump
   * is sized and not read back — pulling gigabytes down again would double every pass — so
   * what stands behind its content is the sha256 that travelled with the write.
   */
  private async verify(key: string, bytes: number): Promise<void> {
    const stored = await this.settings.store.head(key);
    check(
      stored === bytes,
      'code_backup_unverified',
      'The backup store does not hold the object that was just written',
      500,
    );
  }

  /** The manifest and the pointer are small and are what a restore reads first, so they are
   *  read back byte for byte rather than sized. */
  private async verifyBytes(key: string, body: Buffer): Promise<void> {
    check(
      (await this.settings.store.getBytes(key)).equals(body),
      'code_backup_unverified',
      'The backup store does not hold the object that was just written',
      500,
    );
  }

  /** The manifest the bucket holds for this project now, or null when it holds none. */
  async manifest(projectId: string, at?: string): Promise<BackupManifest | null> {
    const prefix = codePrefix(this.settings.deployment, projectId);
    const key = `${prefix}${at ? `${at}.manifest.json` : LATEST}`;
    if ((await this.settings.store.head(key)) === null) return null;
    return JSON.parse((await this.settings.store.getBytes(key)).toString('utf8')) as BackupManifest;
  }

  /**
   * One project's copy. Nothing in a Code repository is ever pruned — objects only arrive and
   * the sweep never touches a pack or an authoritative ref — so unchanged refs mean unchanged
   * objects, and an unchanged project rewrites only its pointer.
   */
  async project(
    projectId: string,
    repositoryId: string,
    takenAt: string,
    database: (BackupObject & { backend: 'postgres' | 'sqlite' }) | null,
    /** Runs its job in this project's own turn and in one of the deployment's transfer slots. */
    turn: <T>(job: () => Promise<T>) => Promise<T>,
  ): Promise<{
    receipt: Omit<CodeBackupReceipt, 'fingerprint'>;
    manifest: BackupManifest | null;
    /** The objects retention must leave alone, said in every branch and never inferred. */
    keep: string[];
  }> {
    const store = this.settings.store;
    const paths = this.repositories.paths(projectId);
    const prefix = codePrefix(this.settings.deployment, projectId);
    const held = await this.manifest(projectId);
    // A pointer is only kept when the object it names is still there: a bundle that retention
    // or the bucket lost must be cut again rather than promised in a newer manifest. Asked
    // before the turn, because a project's queue is no place for a call to the bucket.
    const standing =
      held?.bundle && (await store.head(held.bundle.key)) === held.bundle.bytes
        ? held.bundle
        : null;
    // What the last pass wrote, which is what a pass that writes no new pointer must leave.
    const heldKeep = held
      ? [standing?.key, `${prefix}${stampOf(held.takenAt)}.manifest.json`].filter(
          (key): key is string => !!key,
        )
      : [];
    // Only this much needs the project to hold still. The bundle on disk is already a
    // consistent snapshot of the refs that were hashed, so the upload that follows costs
    // this project's machines — and the deployment's two transfer slots — nothing.
    const cut = await turn(async () => {
      const env = this.repositories.environment(projectId);
      const git = this.repositories.git;
      const listed = (await git.ok(['for-each-ref', '--format=%(refname) %(objectname)'], { env }))
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf(' ');
          return { name: line.slice(0, at), oid: line.slice(at + 1) };
        });
      const refsHash = digest(listed);
      const reusable = held?.refsHash === refsHash ? standing : null;
      const shape = {
        listed,
        refsHash,
        reusable,
        objectFormat: await this.repositories.objectFormat(projectId),
        marker: await readFile(paths.marker, 'utf8'),
      };
      if (!listed.length || reusable) return { ...shape, file: null, bytes: 0, sha256: '' };
      // Named so that nothing else can be cutting under it, now that the lock is released
      // before the upload reads the file back.
      const file = join(paths.directory, `backup-${stampOf(takenAt)}-${randomUUID()}.bundle`);
      const measured = await git.ok(['rev-list', '--disk-usage', '--objects', '--all'], {
        env,
        timeoutMs: BUNDLE_TIMEOUT_MS,
      });
      // The volume's floor, not the project's quota: the bundle is deleted at the end of this
      // pass, and charging a transient file to the quota would refuse a copy to every project
      // past half of it — the large repositories whose copy matters most.
      await this.repositories.assertVolume(Number(measured.toString('utf8').trim()) || 0);
      await git.ok(['bundle', 'create', file, '--all'], { env, timeoutMs: BUNDLE_TIMEOUT_MS });
      const verified = await git.run(['bundle', 'verify', file], {
        env,
        timeoutMs: BUNDLE_TIMEOUT_MS,
      });
      check(
        verified.code === 0,
        'code_backup_unverified',
        'Git refused the bundle it had just written',
        500,
      );
      return { ...shape, file, bytes: (await stat(file)).size, sha256: await hashFile(file) };
    });
    const warnings: string[] = [];
    let bundle: BackupObject | null = cut.reusable;
    let wrote = 0;
    try {
      if (cut.file) {
        if (cut.bytes > this.settings.maxBytes) {
          // Half a copy is worse than none: the pointer is left naming the last good bundle
          // and the warning stands on the project until a pass writes a smaller one.
          warnings.push('code_backup_too_large');
        } else {
          const key = `${prefix}${stampOf(takenAt)}-${cut.sha256.slice(0, 16)}.bundle`;
          await store.putFile(key, cut.file, cut.bytes, cut.sha256);
          await this.verify(key, cut.bytes);
          bundle = { key, bytes: cut.bytes, sha256: cut.sha256 };
          wrote += cut.bytes;
        }
      }
    } finally {
      if (cut.file) await rm(cut.file, { force: true });
    }
    const receipt = {
      formatVersion: 1 as const,
      deployment: this.settings.deployment,
      takenAt,
      verifiedAt: new Date().toISOString(),
      bundle: bundle && { ...bundle, reused: bundle === cut.reusable },
      database,
      manifest: null as BackupObject | null,
      refs: cut.listed.length,
      refsHash: cut.refsHash,
      bytes: wrote,
      pruned: [] as string[],
      warnings,
    };
    if (warnings.includes('code_backup_too_large'))
      return { receipt, manifest: null, keep: heldKeep };
    const manifest: BackupManifest = {
      format: 1,
      deployment: this.settings.deployment,
      projectId,
      repositoryId,
      objectFormat: cut.objectFormat,
      takenAt,
      verifiedAt: receipt.verifiedAt,
      marker: cut.marker,
      bundle,
      refs: cut.listed,
      refsHash: cut.refsHash,
      database,
    };
    const body = Buffer.from(canonical(manifest), 'utf8');
    const manifestKey = `${prefix}${stampOf(takenAt)}.manifest.json`;
    await store.putBytes(manifestKey, body);
    await this.verifyBytes(manifestKey, body);
    // Last, because it is the only mutable key: until it moves, a restore reads the old copy.
    await store.putBytes(`${prefix}${LATEST}`, body);
    await this.verifyBytes(`${prefix}${LATEST}`, body);
    receipt.manifest = {
      key: manifestKey,
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    receipt.bytes += body.byteLength * 2;
    return {
      receipt,
      manifest,
      keep: [bundle?.key, manifestKey].filter((key): key is string => !!key),
    };
  }

  /**
   * Remove what is older than `keepDays`, never the objects a live manifest names. An idle
   * project keeps its only bundle however old it is: pruning it would leave the pointer
   * naming nothing.
   */
  async prune(prefix: string, keep: string[], nowMs = Date.now()): Promise<string[]> {
    const floor = nowMs - this.settings.keepDays * DAY_MS;
    const stale = (await this.settings.store.list(prefix)).filter(
      (key) => !keep.includes(key) && !key.endsWith(LATEST) && stampMs(key) < floor,
    );
    if (stale.length) await this.settings.store.remove(stale);
    return stale.sort();
  }
}

/** What a run says about itself, fingerprinted so a receipt cannot be edited unnoticed. */
export const fingerprinted = (
  receipt: Omit<CodeBackupReceipt, 'fingerprint'>,
): CodeBackupReceipt => ({
  ...receipt,
  fingerprint: digest(receipt),
});
