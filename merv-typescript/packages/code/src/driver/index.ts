import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  codeCommitCommandSchema,
  codeWorkspaceManifestSchema,
  effectiveWorkspace,
  WorkspaceDeferred,
  type CodeCommitCommand,
  type CodeCommitReceipt,
  type CodeStoreOperation,
  type CodeWorkspaceManifest,
  type SessionWorkspace,
  type WorkflowWorkspacePolicy,
  type WorkspaceDriver,
  type WorkspaceDriverFactory,
  type WorkspaceDriverHost,
  type WorkspaceHandle,
  type WorkspaceLaunch,
  type WorkspaceSession,
  type WorkspaceTransport,
} from '@merv/contracts';
import { MERGE_SETTINGS } from '../merge-settings.js';
import { DriverGit, WorkspaceError } from './git.js';

export { WorkspaceError } from './git.js';
/** The capability a runner that carries this driver advertises, and the policy key it serves. */
export const CODE_DRIVER = 'code.v2';

export interface CodeDriverOptions {
  /** How often an admission that outlasts its request is asked about again. */
  pollMs?: number;
  /** How long one call waits for an admission before it gives the cycle back. */
  admissionMs?: number;
}
interface WorkspaceRow {
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
interface TransferRow {
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
type TransportFailure = { code?: unknown; status?: unknown };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const oid = (value: string): string => {
  const result = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result))
    throw new WorkspaceError('workspace_invalid_oid');
  return result;
};
const privateDirectory = (path: string) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new WorkspaceError('workspace_foreign_path');
  return path;
};
const identity = {
  GIT_AUTHOR_NAME: 'Merv Agent Runner',
  GIT_AUTHOR_EMAIL: 'merv@localhost',
  GIT_COMMITTER_NAME: 'Merv Agent Runner',
  GIT_COMMITTER_EMAIL: 'merv@localhost',
};
/** Code examined the upload and did not admit it. */
class UploadRefused extends WorkspaceError {}
/** Refusals that end an upload for good; everything else is tried again. */
const terminal = [
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
const uncapturable = ['workspace_file_too_large', 'workspace_foreign_path'];
/** Why the place history lives could not serve now, in the closed vocabulary of a deferral. */
function deferral(error: unknown): WorkspaceDeferred | null {
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

/**
 * The workspace driver for projects whose history lives in Code's repository on the server.
 * A machine keeps only a cache: before a session it downloads exactly the commit Code names,
 * every commit and the final capture are uploaded as bundles, and the local branch moves only
 * after Code has acknowledged the upload. Nothing here knows a remote, a central ref or a
 * GitHub credential, and the runner's own repository and ledger tables are never touched.
 */
export class CodeWorkspaceDriver implements WorkspaceDriver {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly git: DriverGit;
  private readonly pollMs: number;
  private readonly admissionMs: number;
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly host: WorkspaceDriverHost,
    private readonly transport: WorkspaceTransport,
    options: CodeDriverOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 1000;
    this.admissionMs = options.admissionMs ?? 120_000;
    this.root = realpathSync(privateDirectory(join(host.directory, 'code-v2')));
    const template = privateDirectory(join(this.root, 'empty-template'));
    this.git = new DriverGit(template);
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

  get(launchId: string): WorkspaceHandle | undefined {
    const row = this.row(launchId);
    if (!row) return undefined;
    const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
    const encoded = row.result_json ?? row.attachment_json;
    return {
      path: row.path,
      ...(encoded ? { snapshot: JSON.parse(encoded) as SessionWorkspace } : {}),
      retain: policy.mode === 'none' || policy.retain,
      readOnly: !!row.read_only,
      status: row.status,
    };
  }

  /**
   * Make the checkout stand on exactly the commit Code names for this session: the newest one
   * it admitted for a writer, the referenced one for a reader. Asking Code changes nothing, so
   * a preparation that fails half-way leaves nothing behind that anyone must clean up.
   */
  prepare(launch: WorkspaceLaunch, session: WorkspaceSession): Promise<WorkspaceHandle> {
    return this.run(async () => {
      if (launch.sessionId !== session.id) throw new WorkspaceError('workspace_session_mismatch');
      const policy = effectiveWorkspace(session.execution.policy);
      if (policy.mode === 'none' || policy.driver !== CODE_DRIVER)
        throw new WorkspaceError('workspace_driver_mismatch');
      const existing = this.row(launch.id);
      if (existing) {
        if (
          existing.policy_json !== JSON.stringify(policy) ||
          !!existing.read_only !== session.execution.policy.readOnly
        )
          throw new WorkspaceError('workspace_policy_changed');
        if (existing.status !== 'preparing') return this.get(launch.id)!;
      }
      if (this.host.terminal(launch.id)) throw new WorkspaceError('workspace_launch_closed');
      const control = { sessionId: session.id, runnerId: session.runnerId, hostRef: launch.id };
      const parsed = codeWorkspaceManifestSchema.safeParse(
        await this.ask(() => this.transport.call('workspace', control)),
      );
      if (
        !parsed.success ||
        parsed.data.unitId !== session.instanceId ||
        (parsed.data.mode === 'read') !== session.execution.policy.readOnly
      )
        throw new WorkspaceError('workspace_invalid_manifest');
      const manifest = parsed.data;
      const cache = await this.cache(manifest);
      await this.fetch(cache, manifest, control);
      const path =
        manifest.mode === 'write'
          ? join(dirname(cache), 'checkouts', 'work', hash(manifest.unitId).slice(0, 32))
          : join(dirname(cache), 'checkouts', 'read', hash(launch.id).slice(0, 32));
      if (!existing) {
        const owner = this.db
          .prepare(
            "SELECT launch_id FROM code_v2_workspaces WHERE path=? AND launch_id<>? AND canceled=0 AND status NOT IN ('captured','closed')",
          )
          .get(path, launch.id);
        if (owner) throw new WorkspaceError('workspace_owned_by_another_launch');
        this.db
          .prepare(
            "INSERT INTO code_v2_workspaces (launch_id,session_id,runner_id,project_ref,unit_id,generation,path,policy_json,read_only,base_oid,head_oid,branch,repository_id,pending_merge,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing')",
          )
          .run(
            launch.id,
            session.id,
            session.runnerId,
            manifest.projectRef,
            manifest.unitId,
            manifest.generation,
            path,
            JSON.stringify(policy),
            session.execution.policy.readOnly ? 1 : 0,
            manifest.base,
            manifest.head,
            manifest.branch,
            manifest.repositoryId,
            manifest.pendingMerge ? JSON.stringify(manifest.pendingMerge) : null,
          );
      }
      const row = this.row(launch.id)!;
      if (row.head_oid !== manifest.head || row.base_oid !== manifest.base)
        throw new WorkspaceError('workspace_recorded_base_changed');
      await this.checkout(cache, row);
      const snapshot = await this.snapshot(row, manifest.head);
      this.db
        .prepare(
          "UPDATE code_v2_workspaces SET status='ready',attachment_json=? WHERE launch_id=? AND status='preparing'",
        )
        .run(JSON.stringify(snapshot), launch.id);
      return this.get(launch.id)!;
    });
  }

  /**
   * Commit the checkout deterministically, exactly as the runner's own driver does, but keep
   * the commit aside until Code has admitted it: HEAD moves only on that acknowledgement, so
   * the local branch never runs ahead of the one everybody else resumes from.
   */
  checkpointCommit(launch: WorkspaceLaunch, input: CodeCommitCommand): Promise<CodeCommitReceipt> {
    const parsed = codeCommitCommandSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new WorkspaceError('workspace_invalid_command'));
    const command = parsed.data;
    return this.run(async () => {
      const row = this.row(launch.id);
      if (
        !row ||
        !row.attachment_json ||
        row.read_only ||
        command.sessionId !== row.session_id ||
        command.hostRef !== launch.id ||
        command.runnerId !== row.runner_id ||
        JSON.stringify(command.workspace) !== row.attachment_json
      )
        throw new WorkspaceError('workspace_command_mismatch');
      let journal = this.transfer(command.id);
      if (!journal) {
        this.db
          .prepare(
            "INSERT INTO code_v2_transfers (request_id,launch_id,kind,command_json,expected_head) VALUES (?,?,'checkpoint',?,?)",
          )
          .run(command.id, launch.id, JSON.stringify(command), command.expectedHead);
        journal = this.transfer(command.id)!;
      } else if (journal.command_json !== JSON.stringify(command))
        throw new WorkspaceError('workspace_command_conflict');
      if (journal.receipt_json) return JSON.parse(journal.receipt_json) as CodeCommitReceipt;
      if (journal.error) throw new WorkspaceError(journal.error);
      try {
        return await this.commit(row, command, journal);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        // Before there is a commit, a failure is this checkout's and ends the command, as it
        // does in the runner's own driver. Once Code is involved only a refusal that time
        // cannot change ends it; everything else is tried again with the same journal.
        const ended =
          error instanceof UploadRefused ||
          (typeof code === 'string' && terminal.includes(code)) ||
          (!this.transfer(command.id)?.target_oid && !deferral(error));
        if (ended) {
          await this.dropPending(row, command.id);
          this.db
            .prepare('UPDATE code_v2_transfers SET error=? WHERE request_id=? AND error IS NULL')
            .run(
              typeof code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(code)
                ? code
                : 'workspace_commit_failed',
              command.id,
            );
        }
        throw error;
      }
    });
  }

  pendingCommits(launchId: string): CodeCommitCommand[] {
    return (
      this.db
        .prepare(
          "SELECT command_json FROM code_v2_transfers WHERE launch_id=? AND kind='checkpoint' AND acknowledged=0 ORDER BY rowid",
        )
        .all(launchId) as { command_json: string }[]
    ).map((row) => JSON.parse(row.command_json) as CodeCommitCommand);
  }

  commitOutcome(commandId: string): { receipt: CodeCommitReceipt } | { error: string } | null {
    const row = this.transfer(commandId);
    if (row?.receipt_json) return { receipt: JSON.parse(row.receipt_json) as CodeCommitReceipt };
    return row?.error ? { error: row.error } : null;
  }

  acknowledgeCommit(commandId: string): void {
    if (!this.commitOutcome(commandId))
      throw new WorkspaceError('workspace_commit_outcome_required');
    this.db
      .prepare('UPDATE code_v2_transfers SET acknowledged=1 WHERE request_id=?')
      .run(commandId);
  }

  /**
   * What the session left, handed to Code as the one final capture of its writer generation.
   * The capture is journalled before Code hears of it, so a restart replays that exact commit
   * and never builds another; what Code does not admit stays here and in Code's held bundles.
   */
  capture(launch: WorkspaceLaunch): Promise<SessionWorkspace | undefined> {
    return this.run(async () => {
      if (!this.host.terminal(launch.id))
        throw new WorkspaceError('workspace_process_stop_unconfirmed');
      let row = this.row(launch.id);
      if (!row) return undefined;
      if (row.result_json) return JSON.parse(row.result_json) as SessionWorkspace;
      if (row.canceled || row.status === 'captured' || row.status === 'closed') return undefined;
      if (row.status === 'preparing') {
        // Nothing was attached and no process ran here; Code was only ever asked, never told.
        this.db
          .prepare("UPDATE code_v2_workspaces SET status='captured',canceled=1 WHERE launch_id=?")
          .run(launch.id);
        return undefined;
      }
      this.db
        .prepare("UPDATE code_v2_workspaces SET status='capturing' WHERE launch_id=?")
        .run(launch.id);
      const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
      const attached = JSON.parse(row.attachment_json!) as SessionWorkspace;
      let head: string;
      if (row.read_only) {
        head = oid(
          await this.git.ok(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: row.path }),
        );
        if (head !== attached.headOid) throw new WorkspaceError('workspace_readonly_head_changed');
        const status = await this.git.ok(['status', '--porcelain', '--untracked-files=all'], {
          cwd: row.path,
        });
        const dirty =
          policy.mode !== 'none' && policy.retain
            ? status.trim()
            : status
                .split('\n')
                .filter((line) => line.trim() && !line.startsWith('??'))
                .join('\n');
        if (dirty) throw new WorkspaceError('workspace_readonly_dirty');
      } else head = await this.finalize(row);
      row = this.row(launch.id)!;
      const snapshot = await this.snapshot(row, head);
      this.db
        .prepare("UPDATE code_v2_workspaces SET status='captured',result_json=? WHERE launch_id=?")
        .run(JSON.stringify(snapshot), launch.id);
      return snapshot;
    });
  }

  close(launch: WorkspaceLaunch): Promise<void> {
    return this.run(async () => {
      const row = this.row(launch.id);
      if (!row || row.status === 'closed') return;
      if (!['captured', 'closing'].includes(row.status))
        throw new WorkspaceError('workspace_capture_required');
      this.db
        .prepare("UPDATE code_v2_workspaces SET status='closing' WHERE launch_id=?")
        .run(launch.id);
      const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
      if (!row.canceled && policy.mode !== 'none' && !policy.retain && existsSync(row.path)) {
        const cache = this.repository(row.project_ref)!;
        await this.git.ok(['--git-dir', cache, 'worktree', 'remove', '--force', row.path]);
      }
      for (const transfer of this.db
        .prepare('SELECT bundle_path FROM code_v2_transfers WHERE launch_id=?')
        .all(launch.id) as { bundle_path: string | null }[])
        if (transfer.bundle_path) rmSync(transfer.bundle_path, { force: true });
      this.db
        .prepare("UPDATE code_v2_workspaces SET status='closed' WHERE launch_id=?")
        .run(launch.id);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.db.close();
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.serial.then(() => {
      if (this.disposed) throw new WorkspaceError('workspace_manager_closed');
      return action();
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  private row(launchId: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM code_v2_workspaces WHERE launch_id=?').get(launchId) as
      WorkspaceRow | undefined;
  }

  private transfer(requestId: string): TransferRow | undefined {
    return this.db.prepare('SELECT * FROM code_v2_transfers WHERE request_id=?').get(requestId) as
      TransferRow | undefined;
  }

  private repository(projectRef: string): string | undefined {
    return (
      this.db
        .prepare('SELECT path FROM code_v2_repositories WHERE project_ref=?')
        .get(projectRef) as { path: string } | undefined
    )?.path;
  }

  /** A call to Code whose failure to serve is a deferral, not a fault of this launch. */
  private async ask<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw deferral(error) ?? error;
    }
  }

  /** The project's cache repository: bare, without a remote, made from an empty template. */
  private async cache(manifest: CodeWorkspaceManifest): Promise<string> {
    const known = this.db
      .prepare('SELECT * FROM code_v2_repositories WHERE project_ref=?')
      .get(manifest.projectRef) as
      { repository_id: string; object_format: string; path: string; status: string } | undefined;
    if (known) {
      if (
        known.repository_id !== manifest.repositoryId ||
        known.object_format !== manifest.objectFormat
      )
        throw new WorkspaceError('workspace_repository_changed');
      if (known.status === 'ready') return known.path;
    }
    const directory = privateDirectory(join(this.root, hash(manifest.projectRef).slice(0, 32)));
    const path = join(directory, 'cache.git');
    if (!known)
      this.db
        .prepare(
          "INSERT INTO code_v2_repositories (project_ref,repository_id,object_format,path,status) VALUES (?,?,?,?,'preparing')",
        )
        .run(manifest.projectRef, manifest.repositoryId, manifest.objectFormat, path);
    rmSync(path, { recursive: true, force: true });
    await this.git.ok([
      'init',
      '--quiet',
      '--bare',
      `--object-format=${manifest.objectFormat}`,
      `--template=${join(this.root, 'empty-template')}`,
      path,
    ]);
    this.db
      .prepare("UPDATE code_v2_repositories SET status='ready' WHERE project_ref=?")
      .run(manifest.projectRef);
    return path;
  }

  private async has(cache: string, commit: string): Promise<boolean> {
    return (
      (await this.git.run(['--git-dir', cache, 'cat-file', '-e', `${commit}^{commit}`])).code === 0
    );
  }

  /**
   * Bring the named commit into the cache. Code is told which commits are already here so it
   * sends less; should that ever be wrong the import fails, and the one retry claims nothing.
   */
  private async fetch(
    cache: string,
    manifest: CodeWorkspaceManifest,
    control: { sessionId: string; runnerId: string; hostRef: string },
  ): Promise<void> {
    const present = async () =>
      (await this.has(cache, manifest.head)) &&
      (!manifest.pendingMerge || (await this.has(cache, manifest.pendingMerge.secondParent)));
    if (await present()) return;
    const haves = (
      await this.git.ok([
        '--git-dir',
        cache,
        'for-each-ref',
        '--sort=-creatordate',
        '--count=256',
        '--format=%(objectname)',
        'refs/merv/known',
      ])
    )
      .split('\n')
      .filter(Boolean);
    const downloads = privateDirectory(join(dirname(cache), 'downloads'));
    const file = join(downloads, `${hash(control.hostRef).slice(0, 32)}.bundle`);
    for (const claimed of haves.length ? [haves, []] : [[]]) {
      const { download } = (await this.ask(() =>
        this.transport.call('downloads', { ...control, haves: claimed }),
      )) as {
        download:
          | { upToDate: true }
          | { exportId: string; sha256: string; bytes: number; head: string; partBytes: number };
      };
      if ('upToDate' in download) continue;
      if (download.head !== manifest.head) throw new WorkspaceError('workspace_invalid_manifest');
      const digest = createHash('sha256');
      const fd = openSync(file, 'w', 0o600);
      try {
        for (let offset = 0; offset < download.bytes;) {
          const part = await this.ask(() =>
            this.transport.readPart(download.exportId, {
              ...control,
              offset,
              length: Math.min(download.partBytes, download.bytes - offset),
            }),
          );
          if (!part.length) throw new WorkspaceError('workspace_download_failed');
          digest.update(part);
          writeSync(fd, part);
          offset += part.length;
        }
      } finally {
        closeSync(fd);
      }
      const intact = digest.digest('hex') === download.sha256;
      const imported =
        intact && (await this.git.run(['--git-dir', cache, 'bundle', 'unbundle', file])).code === 0;
      rmSync(file, { force: true });
      if (imported && (await present())) break;
    }
    if (!(await present())) throw new WorkspaceError('workspace_download_failed');
    await this.know(cache, manifest.head);
    if (manifest.pendingMerge) await this.know(cache, manifest.pendingMerge.secondParent);
  }

  /** Remember a commit Code holds, so the next download can build on it. */
  private async know(cache: string, commit: string): Promise<void> {
    await this.git.ok(['--git-dir', cache, 'update-ref', `refs/merv/known/${commit}`, commit]);
  }

  private async checkout(cache: string, row: WorkspaceRow): Promise<void> {
    privateDirectory(dirname(row.path));
    await this.git.ok(['--git-dir', cache, 'worktree', 'prune']);
    if (!existsSync(join(row.path, '.git'))) {
      rmSync(row.path, { recursive: true, force: true });
      await this.git.ok([
        '--git-dir',
        cache,
        'worktree',
        'add',
        '--quiet',
        ...(row.branch ? ['-B', row.branch] : ['--detach']),
        row.path,
        row.head_oid,
      ]);
      return;
    }
    // Code is the authority and this branch a cache of it: a checkout kept from an earlier
    // generation is put on exactly the head Code names, whatever that generation left.
    if (!row.branch) throw new WorkspaceError('workspace_foreign_checkout');
    await this.git.ok(['checkout', '--quiet', '--force', '-B', row.branch, row.head_oid], {
      cwd: row.path,
    });
    await this.git.ok(['clean', '-fdq'], { cwd: row.path });
  }

  private async snapshot(row: WorkspaceRow, head: string): Promise<SessionWorkspace> {
    const policy = JSON.parse(row.policy_json) as Exclude<
      WorkflowWorkspacePolicy,
      { mode: 'none' }
    >;
    const cache = this.repository(row.project_ref)!;
    const git = (args: string[]) => this.git.ok(['--git-dir', cache, ...args]);
    const changes = await git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-z',
      row.base_oid,
      head,
    ]);
    let filesChanged = 0,
      insertions = 0,
      deletions = 0;
    for (const entry of changes.split('\0').filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
      if (!match) continue;
      filesChanged++;
      insertions += match[1] === '-' ? 0 : Number(match[1]);
      deletions += match[2] === '-' ? 0 : Number(match[2]);
    }
    const pending = this.mergeMetadata(row);
    return {
      repositoryId: row.repository_id,
      workspaceId: `workspace_${hash(`${CODE_DRIVER}:${row.project_ref}:${row.unit_id}:${row.read_only ? row.launch_id : 'work'}`)}`,
      mode: policy.mode,
      branch: row.branch,
      baseOid: row.base_oid,
      headOid: head,
      treeOid: oid(await git(['rev-parse', '--verify', `${head}^{tree}`])),
      ...(pending ? { pendingMerge: { ...pending, checkpoint: head } } : {}),
      stats: {
        commitCount: Number(
          (await git(['rev-list', '--count', `${row.base_oid}..${head}`])).trim(),
        ),
        filesChanged,
        insertions,
        deletions,
      },
    };
  }

  private mergeMetadata(row: WorkspaceRow): SessionWorkspace['pendingMerge'] {
    return row.pending_merge ? JSON.parse(row.pending_merge) : undefined;
  }

  /** Journal the merge tree before materialising it, so an interrupted start repeats exactly. */
  private async startMerge(
    row: WorkspaceRow,
    command: CodeCommitCommand,
    journal: TransferRow,
  ): Promise<CodeCommitReceipt> {
    const pending = command.workspace.pendingMerge;
    if (!pending || pending.firstMerge || command.expectedHead !== pending.firstParent)
      throw new WorkspaceError('workspace_merge_already_started');
    let mergeTree = journal.merge_tree;
    if (!mergeTree) {
      if (
        (
          await this.git.ok(['status', '--porcelain', '--untracked-files=all'], { cwd: row.path })
        ).trim()
      )
        throw new WorkspaceError('workspace_merge_dirty');
      const merged = await this.git.run(
        [
          ...MERGE_SETTINGS,
          'merge-tree',
          '--write-tree',
          pending.firstParent,
          pending.secondParent,
        ],
        { cwd: row.path },
      );
      if (merged.code !== 0 && merged.code !== 1)
        throw new WorkspaceError('workspace_merge_failed');
      const tree = oid(merged.stdout.split('\n')[0]);
      this.db
        .prepare('UPDATE code_v2_transfers SET merge_tree=? WHERE request_id=?')
        .run(tree, command.id);
      mergeTree = tree;
    }
    await this.git.ok(['read-tree', '--reset', '-u', mergeTree], { cwd: row.path });
    const tree = oid(
      await this.git.ok(['rev-parse', `${command.expectedHead}^{tree}`], { cwd: row.path }),
    );
    if (!journal.target_oid)
      this.db
        .prepare('UPDATE code_v2_transfers SET tree_oid=?,target_oid=? WHERE request_id=?')
        .run(tree, command.expectedHead, command.id);
    journal = this.transfer(command.id)!;
    const operation = await this.upload(row, journal, {
      kind: 'checkpoint',
      commandId: command.id,
      requestId: command.id,
    });
    if (operation.status !== 'completed')
      throw new UploadRefused(operation.error ?? 'code_upload_failed');
    const receipt: CodeCommitReceipt = {
      commandId: command.id,
      repositoryId: row.repository_id,
      workspaceId: command.workspace.workspaceId,
      baseOid: row.base_oid,
      parentOid: command.expectedHead,
      headOid: command.expectedHead,
      treeOid: tree,
      stats: (await this.snapshot(row, command.expectedHead)).stats,
    };
    this.db
      .prepare('UPDATE code_v2_transfers SET receipt_json=? WHERE request_id=?')
      .run(JSON.stringify(receipt), command.id);
    return receipt;
  }

  private pendingRef(requestId: string): string {
    return `refs/merv/pending/${hash(requestId)}`;
  }

  private async dropPending(row: WorkspaceRow, requestId: string): Promise<void> {
    const cache = this.repository(row.project_ref)!;
    // A refused commit must not ride along in the next bundle, so nothing keeps it reachable.
    await this.git.run(['--git-dir', cache, 'update-ref', '-d', this.pendingRef(requestId)]);
  }

  /** Refuse a file no repository of Code's would keep, before Git spends time on it. */
  private async checkFiles(row: WorkspaceRow, env?: Record<string, string>): Promise<void> {
    const root = realpathSync(row.path);
    const listed =
      (await this.git.ok(['ls-files', '--modified', '--others', '--exclude-standard', '-z'], {
        cwd: row.path,
        env,
      })) +
      (await this.git.ok(
        ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z'],
        { cwd: row.path, env },
      ));
    for (const name of new Set(listed.split('\0').filter(Boolean))) {
      const file = resolve(root, name);
      // A tracked final-component symlink is Git data. Never traverse a symlink parent.
      const parent = existsSync(dirname(file)) ? realpathSync(dirname(file)) : dirname(file);
      if (parent !== root && !parent.startsWith(root + sep))
        throw new WorkspaceError('workspace_foreign_path');
      let stat;
      try {
        stat = lstatSync(file);
      } catch {
        continue;
      }
      if (stat.isFile() && stat.size > 50 * 1024 * 1024)
        throw new WorkspaceError('workspace_file_too_large');
    }
  }

  private async commit(
    row: WorkspaceRow,
    command: CodeCommitCommand,
    journal: TransferRow,
  ): Promise<CodeCommitReceipt> {
    const cache = this.repository(row.project_ref)!;
    const head = oid(
      await this.git.ok(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: row.path }),
    );
    if (!journal.target_oid || head !== journal.target_oid) {
      if (row.status !== 'ready') throw new WorkspaceError('workspace_commit_fenced');
      if (head !== command.expectedHead) throw new WorkspaceError('workspace_head_conflict');
    }
    if (command.merge === 'start') return await this.startMerge(row, command, journal);
    const pending = command.workspace.pendingMerge;
    if (
      command.merge === 'complete' &&
      (!pending || pending.firstMerge || this.mergeMetadata(row)?.plan !== pending.plan)
    )
      throw new WorkspaceError('workspace_merge_closed');
    if (!journal.tree_oid) {
      // Each attempt owns a fresh index, so a crashed Git child never touches the checkout's.
      const directory = privateDirectory(
        join(
          dirname(cache),
          'operations',
          hash(row.launch_id).slice(0, 32),
          hash(command.id).slice(0, 32),
        ),
      );
      const index = join(directory, `index-${randomUUID()}`);
      const env = { GIT_INDEX_FILE: index };
      await this.git.ok(['read-tree', command.expectedHead], { cwd: row.path, env });
      await this.checkFiles(row, env);
      await this.git.ok(['add', '-A', '--', '.'], { cwd: row.path, env });
      const tree = oid(await this.git.ok(['write-tree'], { cwd: row.path, env }));
      this.db
        .prepare(
          'UPDATE code_v2_transfers SET tree_oid=?,index_path=? WHERE request_id=? AND tree_oid IS NULL',
        )
        .run(tree, index, command.id);
      journal = this.transfer(command.id)!;
    }
    if (!journal.target_oid) {
      const parentTree = oid(
        await this.git.ok(['rev-parse', `${command.expectedHead}^{tree}`], { cwd: row.path }),
      );
      const timestamp = `${Math.floor(Date.parse(command.createdAt) / 1000)} +0000`;
      const target =
        parentTree === journal.tree_oid && command.merge !== 'complete'
          ? command.expectedHead
          : oid(
              await this.git.ok(
                [
                  'commit-tree',
                  journal.tree_oid!,
                  '-p',
                  command.expectedHead,
                  ...(command.merge === 'complete' ? ['-p', pending!.secondParent] : []),
                ],
                {
                  cwd: row.path,
                  env: { ...identity, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp },
                  stdin: command.message.endsWith('\n') ? command.message : `${command.message}\n`,
                },
              ),
            );
      await this.git.ok(['--git-dir', cache, 'update-ref', this.pendingRef(command.id), target]);
      this.db
        .prepare(
          'UPDATE code_v2_transfers SET target_oid=? WHERE request_id=? AND target_oid IS NULL',
        )
        .run(target, command.id);
      journal = this.transfer(command.id)!;
    }
    const operation = await this.upload(row, journal, {
      kind: 'checkpoint',
      commandId: command.id,
      requestId: command.id,
    });
    if (operation.status !== 'completed')
      throw new UploadRefused(operation.error ?? 'code_upload_failed');
    await this.advance(row, journal);
    const stats = (await this.snapshot(row, journal.target_oid!)).stats;
    const receipt: CodeCommitReceipt = {
      commandId: command.id,
      repositoryId: command.workspace.repositoryId,
      workspaceId: command.workspace.workspaceId,
      baseOid: command.workspace.baseOid,
      parentOid: command.expectedHead,
      headOid: journal.target_oid!,
      treeOid: journal.tree_oid!,
      stats,
    };
    this.db
      .prepare(
        'UPDATE code_v2_transfers SET receipt_json=? WHERE request_id=? AND receipt_json IS NULL',
      )
      .run(JSON.stringify(receipt), command.id);
    return receipt;
  }

  /** Code acknowledged the commit: only now does the local branch move to it. */
  private async advance(row: WorkspaceRow, journal: TransferRow): Promise<void> {
    const cache = this.repository(row.project_ref)!;
    const target = journal.target_oid!;
    const head = oid(
      await this.git.ok(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: row.path }),
    );
    if (head !== target) {
      await this.git.ok(['update-ref', '--stdin'], {
        cwd: row.path,
        stdin: `start\nupdate HEAD ${target} ${journal.expected_head}\nprepare\ncommit\n`,
      });
      if (journal.index_path && existsSync(journal.index_path)) {
        // The frozen index is the tree that was committed; the checkout's index becomes it.
        const index = (
          await this.git.ok(['rev-parse', '--path-format=absolute', '--git-path', 'index'], {
            cwd: row.path,
          })
        ).trim();
        const temporary = `${index}.merv-${randomUUID()}`;
        copyFileSync(journal.index_path, temporary);
        const fd = openSync(temporary, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, index);
      }
    }
    await this.git.run([
      '--git-dir',
      cache,
      'update-ref',
      '-d',
      this.pendingRef(journal.request_id),
    ]);
    await this.know(cache, target);
    const command = journal.command_json
      ? (JSON.parse(journal.command_json) as CodeCommitCommand)
      : null;
    if (command?.merge === 'complete')
      this.db.prepare('UPDATE code_v2_workspaces SET pending_merge=? WHERE launch_id=?').run(
        JSON.stringify({
          ...command.workspace.pendingMerge,
          firstMerge: target,
          checkpoint: target,
        }),
        row.launch_id,
      );
    this.db
      .prepare('UPDATE code_v2_workspaces SET head_oid=? WHERE launch_id=?')
      .run(target, row.launch_id);
  }

  /**
   * Hand one journalled commit to Code: begin under the writer fence, send the bundle from
   * wherever Code says it stands, and ask until the admission has ended. Everything is
   * replayable, so a restart anywhere continues rather than starts again.
   */
  private async upload(
    row: WorkspaceRow,
    journal: TransferRow,
    request: { kind: 'checkpoint'; commandId: string; requestId: string } | { kind: 'final' },
  ): Promise<CodeStoreOperation> {
    const cache = this.repository(row.project_ref)!;
    const target = journal.target_oid!;
    if (target !== journal.expected_head && !journal.bundle_hash) {
      const transfers = privateDirectory(join(dirname(cache), 'transfers'));
      const file = join(transfers, `${hash(journal.request_id).slice(0, 32)}.bundle`);
      const ref = this.pendingRef(journal.request_id);
      await this.git.ok(['--git-dir', cache, 'update-ref', ref, target]);
      rmSync(file, { force: true });
      await this.git.ok([
        '--git-dir',
        cache,
        'bundle',
        'create',
        '--quiet',
        file,
        ref,
        '--not',
        journal.expected_head,
      ]);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
      this.db
        .prepare(
          'UPDATE code_v2_transfers SET bundle_path=?,bundle_hash=?,bundle_bytes=? WHERE request_id=? AND bundle_hash IS NULL',
        )
        .run(file, digest.digest('hex'), lstatSync(file).size, journal.request_id);
      journal = this.transfer(journal.request_id)!;
    }
    const sending = journal.bundle_hash !== null;
    if (sending && !existsSync(journal.bundle_path!))
      throw new WorkspaceError('workspace_transfer_lost');
    const begin = {
      sessionId: row.session_id,
      runnerId: row.runner_id,
      hostRef: row.launch_id,
      unitId: row.unit_id,
      generation: row.generation,
      leaseId: row.session_id,
      expectedHead: journal.expected_head,
      proposedHead: target,
      treeOid: journal.tree_oid,
      bundle: sending ? { sha256: journal.bundle_hash, bytes: journal.bundle_bytes } : null,
      ...request,
    };
    let { operation } = (await this.ask(() =>
      this.transport.call(request.kind === 'final' ? 'finalize' : 'uploads', begin),
    )) as { operation: CodeStoreOperation };
    if (operation.id !== journal.operation_id)
      this.db
        .prepare('UPDATE code_v2_transfers SET operation_id=? WHERE request_id=?')
        .run(operation.id, journal.request_id);
    const deadline = Date.now() + this.admissionMs;
    while (operation.status === 'prepared') {
      if (operation.phase === 'receiving' && operation.received < journal.bundle_bytes!) {
        const bytes = readFileSync(journal.bundle_path!);
        try {
          for (
            let offset = operation.received;
            offset < bytes.length;
            offset += operation.partBytes
          )
            await this.ask(() =>
              this.transport.putPart(
                operation.id,
                offset,
                bytes.subarray(offset, offset + operation.partBytes),
              ),
            );
        } catch (error) {
          const code = (error as TransportFailure).code;
          if (code === 'code_upload_offset') {
            // Code holds more or less than was assumed: read where it stands and go on there.
            ({ operation } = (await this.ask(() =>
              this.transport.call(`uploads/${operation.id}`, {}),
            )) as { operation: CodeStoreOperation });
            continue;
          }
          if (code !== 'code_upload_closed') throw error;
        }
      }
      try {
        ({ operation } = (await this.ask(() =>
          this.transport.call(`uploads/${operation.id}/complete`, {}),
        )) as { operation: CodeStoreOperation });
      } catch (error) {
        // The bytes did not have the promised hash and were dropped: they are sent again.
        if ((error as TransportFailure).code !== 'code_bundle_hash_mismatch') throw error;
        ({ operation } = (await this.ask(() =>
          this.transport.call(`uploads/${operation.id}`, {}),
        )) as { operation: CodeStoreOperation });
      }
      if (operation.status !== 'prepared') break;
      if (Date.now() > deadline)
        throw new WorkspaceDeferred('store_busy', 'code_admission_pending');
      await new Promise((done) => setTimeout(done, this.pollMs));
    }
    return operation;
  }

  /**
   * The final capture of a writable session. A commit command that was still in flight is
   * settled first, because the final must continue from the head Code really has.
   */
  private async finalize(row: WorkspaceRow): Promise<string> {
    const requestId = `final:${row.session_id}`;
    let journal = this.transfer(requestId);
    if (!journal) {
      await this.settle(row);
      row = this.row(row.launch_id)!;
      let target: string,
        tree: string,
        refused: string | null = null;
      try {
        await this.checkFiles(row);
        await this.git.ok(['add', '-A', '--', '.'], { cwd: row.path });
        const staged = await this.git.ok(
          ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only'],
          { cwd: row.path },
        );
        if (staged.trim())
          await this.git.ok(
            ['commit', '--quiet', '--no-verify', '-m', `merv: capture ${row.session_id}`],
            {
              cwd: row.path,
              env: identity,
            },
          );
        target = oid(
          await this.git.ok(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: row.path }),
        );
        tree = oid(await this.git.ok(['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: row.path }));
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (!(typeof code === 'string' && uncapturable.includes(code))) throw error;
        // The checkout holds something no capture may carry, and no later attempt finds it
        // different, exactly as such a refusal ends a checkpoint command. The generation is
        // handed over at the commit Code already has instead of being asked for a capture
        // that can never be built; what the session left stays in the checkout.
        refused = code;
        target = row.head_oid;
        tree = oid(
          await this.git.ok(['rev-parse', '--verify', `${row.head_oid}^{tree}`], { cwd: row.path }),
        );
      }
      this.db
        .prepare(
          "INSERT INTO code_v2_transfers (request_id,launch_id,kind,expected_head,tree_oid,target_oid,error) VALUES (?,?,'final',?,?,?,?)",
        )
        .run(requestId, row.launch_id, row.head_oid, tree, target, refused);
      journal = this.transfer(requestId)!;
    }
    if (journal.receipt_json) return (JSON.parse(journal.receipt_json) as { head: string }).head;
    let head = journal.expected_head;
    try {
      const operation = await this.upload(row, journal, { kind: 'final' });
      if (operation.status === 'completed') {
        head = journal.target_oid!;
        await this.know(this.repository(row.project_ref)!, head);
      }
    } catch (error) {
      const code = (error as TransportFailure).code;
      if (typeof code !== 'string' || !terminal.includes(code)) throw error;
    }
    // What Code did not take stays in this checkout and its branch; the result names only
    // the head Code acknowledged, which is where the next writer continues.
    this.db
      .prepare(
        'UPDATE code_v2_transfers SET receipt_json=?,acknowledged=1 WHERE request_id=? AND receipt_json IS NULL',
      )
      .run(JSON.stringify({ head }), requestId);
    return head;
  }

  /** Learn how every commit command that was still uploading ended, and apply what Code admitted. */
  private async settle(row: WorkspaceRow): Promise<void> {
    for (const journal of this.db
      .prepare(
        "SELECT * FROM code_v2_transfers WHERE launch_id=? AND kind='checkpoint' AND receipt_json IS NULL AND error IS NULL ORDER BY rowid",
      )
      .all(row.launch_id) as unknown as TransferRow[]) {
      let outcome = 'workspace_commit_fenced';
      if (journal.operation_id && journal.target_oid) {
        const deadline = Date.now() + this.admissionMs;
        for (;;) {
          const { operation } = (await this.ask(() =>
            this.transport.call(`uploads/${journal.operation_id}`, {}),
          ).catch((error: unknown) => {
            const code = (error as TransportFailure).code;
            if (typeof code === 'string' && terminal.includes(code))
              return { operation: { status: 'failed', phase: null, error: code } };
            throw error;
          })) as { operation: Pick<CodeStoreOperation, 'status' | 'phase' | 'error'> };
          if (operation.status === 'completed') {
            await this.advance(row, journal);
            const command = JSON.parse(journal.command_json!) as CodeCommitCommand;
            const receipt: CodeCommitReceipt = {
              commandId: command.id,
              repositoryId: command.workspace.repositoryId,
              workspaceId: command.workspace.workspaceId,
              baseOid: command.workspace.baseOid,
              parentOid: command.expectedHead,
              headOid: journal.target_oid,
              treeOid: journal.tree_oid!,
              stats: (await this.snapshot(row, journal.target_oid)).stats,
            };
            this.db
              .prepare('UPDATE code_v2_transfers SET receipt_json=? WHERE request_id=?')
              .run(JSON.stringify(receipt), journal.request_id);
            outcome = '';
            break;
          }
          // Still only receiving: nobody will send the rest, and the final supersedes it.
          if (operation.status === 'failed' || operation.phase === 'receiving') {
            outcome = operation.error ?? 'code_upload_superseded';
            break;
          }
          if (Date.now() > deadline)
            throw new WorkspaceDeferred('store_busy', 'code_admission_pending');
          await new Promise((done) => setTimeout(done, this.pollMs));
        }
      }
      if (outcome) {
        await this.dropPending(row, journal.request_id);
        this.db
          .prepare('UPDATE code_v2_transfers SET error=? WHERE request_id=? AND error IS NULL')
          .run(outcome, journal.request_id);
      }
    }
  }
}

/** What a composition hands the runner. Only Code knows that this driver needs Git at all. */
export const codeWorkspaceDriver: WorkspaceDriverFactory = {
  name: CODE_DRIVER,
  create(host, transport) {
    if (!existsSync('/usr/bin/git')) throw new WorkspaceError('workspace_git_missing');
    return new CodeWorkspaceDriver(host, transport);
  },
};
