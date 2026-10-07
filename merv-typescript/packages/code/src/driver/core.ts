import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory } from '@merv/contracts/private-directory';
import {
  WorkspaceDeferred,
  type WorkspaceDriverHost,
  type WorkspaceHandle,
  type WorkspaceTransport,
} from '@merv/contracts';
import { DriverGit, hash, identity, pathStat, WorkspaceError } from './git.js';

export interface CodeDriverOptions {
  /** How often an admission that outlasts its request is asked about again. */
  pollMs?: number;
  /** How long one call waits for an admission before it gives the cycle back. */
  admissionMs?: number;
}
export interface WorkspaceRow {
  launch_id: string;
  session_id: string;
  runner_id: string;
  project_ref: string;
  unit_id: string;
  generation: number | null;
  path: string;
  policy_json: string;
  read_only: number;
  base_oid: string;
  head_oid: string;
  branch: string | null;
  repository_id: string;
  status: WorkspaceHandle['status'];
  attachment_json: string | null;
  result_json: string | null;
  canceled: number;
  pending_merge: string | null;
}
export interface TransferRow {
  request_id: string;
  launch_id: string;
  kind: 'checkpoint' | 'final';
  command_json: string | null;
  expected_head: string;
  tree_oid: string | null;
  merge_tree: string | null;
  target_oid: string | null;
  index_path: string | null;
  bundle_path: string | null;
  bundle_hash: string | null;
  bundle_bytes: number | null;
  operation_id: string | null;
  receipt_json: string | null;
  error: string | null;
  acknowledged: number;
}
export type TransportFailure = { code?: unknown; status?: unknown };

/** The driver's own storage under the runner's ledger, refused as a foreign path when unsafe. */
export const driverDirectory = (path: string) =>
  privateDirectory(path, () => new WorkspaceError('workspace_foreign_path'));
/** Pin one assignment-produced bundle as a private regular file before root Git parses it. */
export const stageAssignmentBundle = (source: string, target: string, owner?: number): void => {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(input);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      ![process.getuid?.(), owner].includes(info.uid) ||
      info.size > 8 * 1024 * 1024 * 1024
    )
      throw new WorkspaceError('workspace_foreign_path');
    const output = openSync(target, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let copied = 0;
      for (;;) {
        const count = readSync(input, buffer, 0, buffer.length, null);
        if (!count) break;
        copied += count;
        if (copied > info.size) throw new WorkspaceError('workspace_foreign_path');
        let offset = 0;
        while (offset < count) offset += writeSync(output, buffer, offset, count - offset);
      }
      if (copied !== info.size) throw new WorkspaceError('workspace_foreign_path');
      fsyncSync(output);
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
};
/** Code examined the upload and did not admit it. */
export class UploadRefused extends WorkspaceError {}
/** Refusals that end an upload for good; everything else is tried again. */
export const terminal = [
  // Every replay sends the identical request, so a refusal of its shape — a bundle larger
  // than one transfer may be, above all — is the same refusal however often it is sent.
  'invalid_code_input',
  'code_generation_stale',
  'code_writer_closed',
  'code_head_conflict',
  'code_capture_quarantined',
  'request_conflict',
  'session_closed',
  'session_forbidden',
  'session_not_found',
  'code_command_not_found',
  'code_unit_not_found',
];
/**
 * Refusals of this checkout's own content. They are read from the files that are lying there,
 * so every later attempt on the same checkout finds exactly the same answer.
 */
export const uncapturable = ['workspace_file_too_large', 'workspace_foreign_path'];
/** How long a final capture may keep failing locally before the generation is handed over. */
export const CAPTURE_FAILING_MS = 10 * 60_000;
/**
 * A pause this long between a failed capture and the next attempt's start means nothing was
 * trying: the bound restarts. How long an attempt itself takes to fail never counts as a pause.
 */
export const CAPTURE_GAP_MS = 2 * 60_000;
/** The lock files under a directory, descending only into real directories, never links. */
export function lockFiles(directory: string): string[] {
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return lockFiles(path);
    return entry.name.endsWith('.lock') ? [path] : [];
  });
}
/** Why the place history lives could not serve now, in the closed vocabulary of a deferral. */
export function deferral(error: unknown): WorkspaceDeferred | null {
  if (error instanceof WorkspaceDeferred) return error;
  const { code, status } = (error ?? {}) as TransportFailure;
  if (typeof code !== 'string' || typeof status !== 'number') return null;
  // A download whose export Code no longer holds is asked for again from the beginning; that
  // it went is the server's business and never a fault of this launch or this machine.
  if (
    [
      'code_store_full',
      'code_store_unavailable',
      'code_operation_unresolved',
      'code_export_not_found',
    ].includes(code)
  )
    return new WorkspaceDeferred('store_busy', code);
  if (code === 'code_writer_busy' || code === 'code_base_pending')
    return new WorkspaceDeferred('base_pending', code);
  if (code === 'code_unavailable') return new WorkspaceDeferred('code_unavailable', code);
  if (status === 0 || status === 429 || status >= 500)
    return new WorkspaceDeferred('transport_unavailable', code);
  return null;
}

/** The driver's state and the helpers every part of it uses. */
export abstract class DriverCore {
  protected readonly db: DatabaseSync;
  protected readonly root: string;
  protected readonly git: DriverGit;
  protected readonly pollMs: number;
  protected readonly admissionMs: number;
  protected readonly assignmentRoot?: string;
  /** The one work item a hosted machine keeps; set exactly when `assignmentRoot` is. */
  protected readonly workKey?: string;
  protected readonly serial = new Map<string, Promise<unknown>>();
  protected disposed = false;

  constructor(
    protected readonly host: WorkspaceDriverHost,
    protected readonly transport: WorkspaceTransport,
    options: CodeDriverOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 1000;
    this.admissionMs = options.admissionMs ?? 120_000;
    this.root = realpathSync(driverDirectory(join(host.directory, 'code-v2')));
    const template = driverDirectory(join(this.root, 'empty-template'));
    // A hosted machine is a work host: its assignment root holds exactly one work item.
    if (host.assignmentWorkspaceDirectory || host.workInstanceId !== undefined) {
      const assignmentRoot = host.assignmentWorkspaceDirectory;
      const key = host.workInstanceId;
      if (
        !assignmentRoot ||
        key === undefined ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(key) ||
        resolve(assignmentRoot) !== assignmentRoot ||
        realpathSync(assignmentRoot) !== assignmentRoot ||
        !lstatSync(assignmentRoot).isDirectory() ||
        (lstatSync(assignmentRoot).mode & 0o022) !== 0 ||
        !host.assignmentUser
      )
        throw new WorkspaceError('workspace_assignment_root_invalid');
      this.assignmentRoot = assignmentRoot;
      this.workKey = key;
    }
    this.git = new DriverGit(
      template,
      this.assignmentRoot ? { root: this.assignmentRoot, ...host.assignmentUser! } : undefined,
    );
    this.db = new DatabaseSync(host.path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS code_v2_repositories (
        project_ref TEXT PRIMARY KEY, repository_id TEXT NOT NULL, object_format TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('preparing','ready'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS code_v2_workspaces (
        launch_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runner_id TEXT NOT NULL,
        project_ref TEXT NOT NULL, unit_id TEXT NOT NULL, generation INTEGER, path TEXT NOT NULL,
        policy_json TEXT NOT NULL, read_only INTEGER NOT NULL, base_oid TEXT NOT NULL,
        head_oid TEXT NOT NULL, branch TEXT, repository_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('preparing','ready','capturing','captured','closing','closed')),
        attachment_json TEXT, result_json TEXT, canceled INTEGER NOT NULL DEFAULT 0, pending_merge TEXT
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS code_v2_workspaces_identity BEFORE UPDATE ON code_v2_workspaces
        WHEN NEW.launch_id IS NOT OLD.launch_id OR NEW.session_id IS NOT OLD.session_id OR NEW.project_ref IS NOT OLD.project_ref OR NEW.unit_id IS NOT OLD.unit_id OR NEW.generation IS NOT OLD.generation OR NEW.path IS NOT OLD.path OR NEW.policy_json IS NOT OLD.policy_json OR NEW.read_only IS NOT OLD.read_only OR NEW.base_oid IS NOT OLD.base_oid OR NEW.branch IS NOT OLD.branch
        BEGIN SELECT RAISE(ABORT,'immutable workspace identity'); END;
      CREATE TRIGGER IF NOT EXISTS code_v2_workspaces_attachment BEFORE UPDATE ON code_v2_workspaces
        WHEN OLD.attachment_json IS NOT NULL AND NEW.attachment_json IS NOT OLD.attachment_json
        BEGIN SELECT RAISE(ABORT,'immutable workspace attachment'); END;
      CREATE TRIGGER IF NOT EXISTS code_v2_workspaces_result BEFORE UPDATE ON code_v2_workspaces
        WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json
        BEGIN SELECT RAISE(ABORT,'immutable workspace result'); END;
      CREATE TABLE IF NOT EXISTS code_v2_transfers (
        request_id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('checkpoint','final')),
        command_json TEXT, expected_head TEXT NOT NULL, tree_oid TEXT, merge_tree TEXT, target_oid TEXT, index_path TEXT,
        bundle_path TEXT, bundle_hash TEXT, bundle_bytes INTEGER, operation_id TEXT,
        receipt_json TEXT, error TEXT, acknowledged INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      DROP TABLE IF EXISTS code_v2_capture_failing;
      CREATE TABLE IF NOT EXISTS code_v2_capture_attempts (
        launch_id TEXT PRIMARY KEY, since INTEGER NOT NULL, last INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS code_v2_review_restores (
        launch_id TEXT PRIMARY KEY, device INTEGER NOT NULL, inode INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS code_v2_transfers_identity BEFORE UPDATE ON code_v2_transfers
        WHEN NEW.request_id IS NOT OLD.request_id OR NEW.launch_id IS NOT OLD.launch_id OR NEW.kind IS NOT OLD.kind OR NEW.command_json IS NOT OLD.command_json OR NEW.expected_head IS NOT OLD.expected_head
          OR (OLD.merge_tree IS NOT NULL AND NEW.merge_tree IS NOT OLD.merge_tree)
          OR (OLD.tree_oid IS NOT NULL AND NEW.tree_oid IS NOT OLD.tree_oid)
          OR (OLD.target_oid IS NOT NULL AND NEW.target_oid IS NOT OLD.target_oid)
          OR (OLD.bundle_hash IS NOT NULL AND NEW.bundle_hash IS NOT OLD.bundle_hash)
          OR (OLD.receipt_json IS NOT NULL AND NEW.receipt_json IS NOT OLD.receipt_json)
          OR (OLD.error IS NOT NULL AND NEW.error IS NOT OLD.error)
        BEGIN SELECT RAISE(ABORT,'immutable transfer'); END;
    `);
  }

  /**
   * One operation at a time per key: a launch, or the work unit whose checkout hosted launches
   * share. A long wait of one launch holds up no other.
   */
  protected run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.serial.get(key) ?? Promise.resolve()).then(() => {
      if (this.disposed) throw new WorkspaceError('workspace_manager_closed');
      return action();
    });
    const settled = operation.catch(() => {});
    this.serial.set(key, settled);
    void settled.then(() => this.serial.get(key) === settled && this.serial.delete(key));
    return operation;
  }

  protected row(launchId: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM code_v2_workspaces WHERE launch_id=?').get(launchId) as
      WorkspaceRow | undefined;
  }

  protected transfer(requestId: string): TransferRow | undefined {
    return this.db.prepare('SELECT * FROM code_v2_transfers WHERE request_id=?').get(requestId) as
      TransferRow | undefined;
  }

  protected repository(projectRef: string): string | undefined {
    return (
      this.db
        .prepare('SELECT path FROM code_v2_repositories WHERE project_ref=?')
        .get(projectRef) as { path: string } | undefined
    )?.path;
  }

  protected preservedPath(): string {
    return join(driverDirectory(join(this.root, 'preserved')), hash(this.workKey!));
  }

  protected rejectedPath(row: WorkspaceRow): string {
    return join(driverDirectory(join(this.root, 'rejected')), hash(row.launch_id));
  }

  protected priorWriter(row: WorkspaceRow): WorkspaceRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM code_v2_workspaces WHERE path=? AND launch_id<>? AND read_only=0 AND status IN ('captured','closed') ORDER BY rowid DESC LIMIT 1",
      )
      .get(row.path, row.launch_id) as WorkspaceRow | undefined;
  }

  protected priorVisible(row: WorkspaceRow): WorkspaceRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM code_v2_workspaces WHERE path=? AND launch_id<>? AND status IN ('captured','closed') ORDER BY rowid DESC LIMIT 1",
      )
      .get(row.path, row.launch_id) as WorkspaceRow | undefined;
  }

  protected restoredReview(row: WorkspaceRow, path: string): boolean {
    if (row.status !== 'closed') return false;
    const recorded = this.db
      .prepare('SELECT device,inode FROM code_v2_review_restores WHERE launch_id=?')
      .get(row.launch_id) as { device: number; inode: number } | undefined;
    const visible = pathStat(path);
    return (
      !!recorded &&
      !!visible &&
      visible.isDirectory() &&
      recorded.device === visible.dev &&
      recorded.inode === visible.ino
    );
  }

  protected priorCaptureRefused(row: WorkspaceRow): boolean {
    const transfer = this.db
      .prepare(
        "SELECT target_oid,receipt_json,error FROM code_v2_transfers WHERE launch_id=? AND kind='final'",
      )
      .get(row.launch_id) as
      { target_oid: string | null; receipt_json: string | null; error: string | null } | undefined;
    return (
      !!transfer &&
      (!!transfer.error ||
        (!!transfer.receipt_json &&
          (JSON.parse(transfer.receipt_json) as { head: string }).head !== transfer.target_oid))
    );
  }

  protected assignmentPath(path: string): void {
    const existing = pathStat(path);
    if (
      !this.assignmentRoot ||
      dirname(path) !== this.assignmentRoot ||
      !/^[0-9a-f]{64}$/.test(path.slice(this.assignmentRoot.length + 1)) ||
      (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    )
      throw new WorkspaceError('workspace_foreign_checkout');
  }

  /** A call to Code whose failure to serve is a deferral, not a fault of this launch. */
  protected async ask<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw deferral(error) ?? error;
    }
  }
}
