import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { plain } from '@merv/contracts';

export type LaunchStatus =
  'reserved' | 'starting' | 'running' | 'stopping' | 'exited' | 'stopped' | 'uncertain';
export type LocalJson =
  null | boolean | number | string | LocalJson[] | { [key: string]: LocalJson };
export type LaunchMetadata = Record<string, LocalJson>;
export interface LaunchPlatform {
  name: string;
  harness: string;
  model?: string;
  effort?: string;
}
export interface PendingLaunchRequest {
  platform: LaunchPlatform;
  requestId: string;
  secret: string;
}
export interface LaunchRecord {
  id: string;
  sessionId: string;
  deadline: number;
  status: LaunchStatus;
  metadata: LaunchMetadata;
  createdAt: number;
  updatedAt: number;
  exitCode: number | null;
  exitSignal: string | null;
  reason: string | null;
  runDirectory: string;
}
export interface LedgerBinding {
  baseUrl: string;
  sourceId: string;
  projectId: string;
}
type Row = Record<string, string | number | null>;

/** Refuse symlinks and files belonging to another account before opening local secrets. */
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('Unsafe runner directory');
  }
  chmodSync(path, 0o700);
}
function privateFile(path: string): void {
  try {
    const fd = openSync(path, 'wx', 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('Unsafe runner file');
  }
  chmodSync(path, 0o600);
}
export function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function launchRecord(row: Row): LaunchRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    deadline: Number(row.deadline),
    status: row.status as LaunchStatus,
    metadata: JSON.parse(String(row.metadata_json)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    exitSignal: row.exit_signal === null ? null : String(row.exit_signal),
    reason: row.reason === null ? null : String(row.reason),
    runDirectory: String(row.run_directory),
  };
}
const limits = { depth: 32, nodes: 524288, bytes: 524288, keys: 'any', strings: 'json' } as const;
function safeData<T>(value: T): T {
  const detached = plain<T>(value, 'invalid_runner_metadata', limits);
  const encoded = JSON.stringify(detached, (key, item: unknown) => {
    if (
      /^(token|secret|authorization|password|bearer|env|sourceToken|sessionToken|__proto__|constructor|prototype)$/i.test(
        key,
      ) ||
      (typeof item === 'string' &&
        /m[sk]_[A-Za-z0-9_-]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(item))
    )
      throw new Error('Credentials must not be persisted in runner metadata');
    return item;
  });
  if (Buffer.byteLength(encoded) > limits.bytes) throw new Error('Runner metadata is too large');
  return detached;
}
export const terminalLaunch = (record: LaunchRecord): boolean =>
  record.status === 'exited' || record.status === 'stopped';

/** Machine-local launch intent; deliberately independent of the server's State plugin. */
export class LocalLedger {
  readonly directory: string;
  readonly path: string;
  readonly runnerId: string;
  private readonly db: DatabaseSync;
  private readonly machineKey: Buffer;
  private lock?: DatabaseSync;

  constructor(options: { directory: string; binding: LedgerBinding }) {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('Runner process supervision requires Darwin or Linux');
    }
    this.directory = resolve(options.directory);
    privateDirectory(this.directory);
    this.path = join(this.directory, 'ledger.sqlite');
    privateFile(this.path);
    this.db = new DatabaseSync(this.path);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;',
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS machine (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding TEXT NOT NULL,
        runner_id TEXT NOT NULL, machine_key BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS launch_requests (
        platform TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS launches (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        deadline INTEGER NOT NULL, metadata_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','starting','running','stopping','exited','stopped','uncertain')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        command_hash TEXT, exit_code INTEGER, exit_signal TEXT, reason TEXT, run_directory TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS immutable_launch_identity BEFORE UPDATE OF id,session_id,fingerprint,created_at,run_directory ON launches
        BEGIN SELECT RAISE(ABORT,'immutable launch identity'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_launch_terminal BEFORE UPDATE OF status,deadline,command_hash,exit_code,exit_signal,reason ON launches
        WHEN OLD.status IN ('exited','stopped')
        BEGIN SELECT RAISE(ABORT,'terminal launch'); END;
      CREATE TRIGGER IF NOT EXISTS retain_launches BEFORE DELETE ON launches
        BEGIN SELECT RAISE(ABORT,'launch history is retained'); END;
    `);
    let url: URL;
    try {
      url = new URL(options.binding.baseUrl);
    } catch {
      this.db.close();
      throw new Error('Invalid runner server URL');
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      !options.binding.sourceId ||
      options.binding.sourceId.length > 512 ||
      /^(m[sk]_|eyJ)/.test(options.binding.sourceId)
    ) {
      this.db.close();
      throw new Error('Runner binding must contain a server URL and non-secret source identity');
    }
    const binding = JSON.stringify({
      baseUrl: url.toString().replace(/\/$/, ''),
      sourceId: options.binding.sourceId,
      projectId: options.binding.projectId,
    });
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db
        .prepare('INSERT OR IGNORE INTO machine VALUES(1,?,?,?)')
        .run(binding, randomUUID(), randomBytes(32));
      const row = this.db.prepare('SELECT * FROM machine WHERE singleton=1').get()!;
      if (row.binding !== binding)
        throw new Error('Runner directory belongs to a different server or source identity');
      this.runnerId = String(row.runner_id);
      this.machineKey = Buffer.from(row.machine_key as Uint8Array);
      this.db.exec('COMMIT');
      syncPath(this.directory);
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* No transaction remained. */
      }
      this.db.close();
      throw error;
    }
  }

  acquireController(): () => void {
    if (this.lock) throw new Error('Runner controller is already locked');
    const path = join(this.directory, 'controller-lock.sqlite');
    privateFile(path);
    const lock = new DatabaseSync(path);
    try {
      lock.exec(
        'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS controller(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;',
      );
    } catch {
      lock.close();
      throw new Error('Another runner controller owns this directory');
    }
    this.lock = lock;
    return () => {
      if (this.lock !== lock) return;
      this.lock = undefined;
      lock.exec('ROLLBACK');
      lock.close();
    };
  }

  request(platform: LaunchPlatform): PendingLaunchRequest {
    platform = safeData(platform);
    if (!platform.name || platform.name.length > 200 || !platform.harness)
      throw new Error('Invalid runner platform');
    const encoded = JSON.stringify({ platform });
    this.db
      .prepare('INSERT OR IGNORE INTO launch_requests VALUES(?,?,?)')
      .run(platform.name, randomUUID(), encoded);
    const row = this.db
      .prepare('SELECT * FROM launch_requests WHERE platform=?')
      .get(platform.name)!;
    const requestId = String(row.request_id);
    return {
      ...JSON.parse(String(row.request_json)),
      requestId,
      secret: this.sessionSecret(requestId),
    };
  }
  pendingRequests(): PendingLaunchRequest[] {
    return this.db
      .prepare('SELECT * FROM launch_requests ORDER BY platform')
      .all()
      .map((row) => ({
        ...JSON.parse(String(row.request_json)),
        requestId: String(row.request_id),
        secret: this.sessionSecret(String(row.request_id)),
      }));
  }
  completeRequest(platform: string, requestId: string): void {
    this.db
      .prepare('DELETE FROM launch_requests WHERE platform=? AND request_id=?')
      .run(platform, requestId);
  }
  /** Only the private machine key is persisted; bearer values are derived in memory. */
  sessionSecret(requestId: string): string {
    return `ms_${this.mac(`session:${requestId}`)}`;
  }
  ipcToken(id: string): string {
    return this.mac(`ipc:${id}`);
  }
  private mac(value: string): string {
    return createHmac('sha256', this.machineKey).update(value).digest('base64url');
  }

  reserve(input: {
    id: string;
    sessionId: string;
    deadline: number;
    metadata?: LaunchMetadata;
  }): LaunchRecord {
    if (
      !input.id ||
      input.id.length > 200 ||
      !input.sessionId ||
      input.sessionId.length > 200 ||
      !Number.isSafeInteger(input.deadline) ||
      input.deadline <= Date.now()
    )
      throw new Error('Invalid launch reservation');
    const metadata = safeData(input.metadata ?? {});
    const encodedMetadata = JSON.stringify(metadata);
    const canonical = JSON.stringify({
      id: input.id,
      sessionId: input.sessionId,
      deadline: input.deadline,
      metadata: Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))),
    });
    const fingerprint = createHash('sha256').update(canonical).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db
        .prepare('SELECT * FROM launches WHERE id=? OR session_id=?')
        .get(input.id, input.sessionId) as Row | undefined;
      if (old) {
        if (old.id !== input.id || old.fingerprint !== fingerprint)
          throw new Error('Launch reservation conflicts with an existing intent');
        this.db.exec('COMMIT');
        return launchRecord(old);
      }
      const now = Date.now();
      const runDirectory = join(
        this.directory,
        'launches',
        createHash('sha256').update(input.id).digest('hex'),
      );
      privateDirectory(runDirectory);
      syncPath(join(this.directory, 'launches'));
      this.db
        .prepare(
          `INSERT INTO launches(id,session_id,fingerprint,deadline,metadata_json,status,created_at,updated_at,run_directory)
        VALUES(?,?,?,?,?,'reserved',?,?,?)`,
        )
        .run(
          input.id,
          input.sessionId,
          fingerprint,
          input.deadline,
          encodedMetadata,
          now,
          now,
          runDirectory,
        );
      this.db.exec('COMMIT');
      return this.get(input.id)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(id: string): LaunchRecord | undefined {
    const row = this.db.prepare('SELECT * FROM launches WHERE id=?').get(id) as Row | undefined;
    return row ? launchRecord(row) : undefined;
  }
  list(): LaunchRecord[] {
    return (this.db.prepare('SELECT * FROM launches ORDER BY created_at,id').all() as Row[]).map(
      launchRecord,
    );
  }
  markUncertain(id: string, reason = 'supervisor_unreachable'): void {
    if (!/^[a-z_]{1,80}$/.test(reason)) throw new Error('Invalid uncertainty reason');
    this.db
      .prepare(
        `UPDATE launches SET status='uncertain',reason=?,updated_at=?
      WHERE id=? AND status NOT IN ('exited','stopped','uncertain')`,
      )
      .run(reason, Date.now(), id);
  }
  cancelReservation(id: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            `UPDATE launches SET status='stopped',reason='cancelled_before_spawn',updated_at=?
      WHERE id=? AND status='reserved' AND command_hash IS NULL`,
          )
          .run(Date.now(), id).changes,
      ) === 1
    );
  }
  updateMetadata(id: string, patch: LaunchMetadata): LaunchRecord {
    patch = safeData(patch);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.get(id);
      if (!record) throw new Error('Unknown launch');
      // The patch was scanned above, as the stored metadata was when it was saved. Only the
      // merged object's bounds are new.
      const encoded = JSON.stringify(
        plain({ ...record.metadata, ...patch }, 'invalid_runner_metadata', limits),
      );
      if (Buffer.byteLength(encoded) > limits.bytes)
        throw new Error('Runner metadata is too large');
      this.db
        .prepare('UPDATE launches SET metadata_json=?,updated_at=? WHERE id=?')
        .run(encoded, Date.now(), id);
      this.db.exec('COMMIT');
      return this.get(id)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    if (this.lock) {
      this.lock.exec('ROLLBACK');
      this.lock.close();
      this.lock = undefined;
    }
    this.machineKey.fill(0);
    this.db.close();
  }
}
