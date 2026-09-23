import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  codeCommitCommandSchema,
  effectiveWorkspace,
  type CodeCommitCommand,
  type CodeCommitReceipt,
  type WorkflowWorkspacePolicy,
  codeTransportGrantSchema,
  type CodeTransportGrant,
  type WorkspaceHandle,
} from '@merv/contracts';
import type { Session, SessionWorkspace } from '@merv/sessions/types';
import {
  LocalLedger,
  privateDirectory,
  syncPath,
  terminalLaunch,
  type LaunchRecord,
} from './ledger.js';

export type GitWorkspaceConfig = { repository: string; baseRef: string } | { github: true };
export type { WorkspaceHandle } from '@merv/contracts';
type WorkspaceRow = {
  launch_id: string;
  slot_id: string;
  epoch: number;
  path: string;
  policy_json: string;
  read_only: number;
  base_oid: string;
  branch: string | null;
  repository_id: string | null;
  status: WorkspaceHandle['status'];
  attachment_json: string | null;
  result_json: string | null;
  canceled: number;
};
type RepositoryRow = {
  repository_id: string;
  source_path: string;
  base_ref: string;
  initial_oid: string;
  bare_path: string;
  status: 'preparing' | 'ready';
};
type CommitRow = {
  command_id: string;
  launch_id: string;
  command_json: string;
  tree_oid: string | null;
  target_oid: string | null;
  index_path: string | null;
  receipt_json: string | null;
  error: string | null;
  acknowledged: number;
};
type FenceRow = { owner_oid: string; status: 'preparing' | 'armed' | 'revoked' };
const execute = promisify(execFile);
class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const statIfPresent = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Changed files above this size are refused at capture and commit. */
const MAX_FILE = 50 * 1024 * 1024;
const repositoryIdentity = (row: RepositoryRow) => ({
  repositoryId: row.repository_id,
  sourcePath: row.source_path,
  baseRef: row.base_ref,
  initialOid: row.initial_oid,
});
const oid = (value: string): string => {
  const result = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result))
    throw new WorkspaceError('workspace_invalid_oid');
  return result;
};
const segment = (value: string): string => {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}$/.test(value) || value === '.' || value === '..')
    throw new WorkspaceError('workspace_invalid_segment');
  return value;
};
// Declaration namespaces allow dots; Git refs also forbid '..', trailing dots and '.lock'.
// Reserve the encoded prefix so a literal namespace cannot collide with an encoded one.
const refSegment = (value: string): string =>
  value.includes('..') ||
  value.endsWith('.') ||
  value.endsWith('.lock') ||
  value.startsWith('encoded-')
    ? `encoded-${Buffer.from(value).toString('base64url')}`
    : value;
const marker = (path: string, value: unknown) => {
  const encoded = JSON.stringify(value);
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || readFileSync(path, 'utf8') !== encoded)
      throw new WorkspaceError('workspace_foreign_marker');
    return;
  }
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, encoded);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncPath(dirname(path));
};

/** Local checkout ownership and immutable per-launch captures, independent of server persistence. */
export class GitWorkspaceManager {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly assignmentWorkspaceDirectory?: string;
  private readonly emptyTemplate: string;
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private closedOwnerOid?: string;

  constructor(
    private readonly ledger: LocalLedger,
    private readonly config?: GitWorkspaceConfig,
    assignmentWorkspaceDirectory?: string,
  ) {
    privateDirectory(join(ledger.directory, 'workspaces'));
    this.root = realpathSync(join(ledger.directory, 'workspaces'));
    if (assignmentWorkspaceDirectory) {
      if (
        !isAbsolute(assignmentWorkspaceDirectory) ||
        resolve(assignmentWorkspaceDirectory) !== assignmentWorkspaceDirectory
      )
        throw new WorkspaceError('workspace_assignment_root_invalid');
      const info = lstatSync(assignmentWorkspaceDirectory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o022) !== 0 ||
        realpathSync(assignmentWorkspaceDirectory) !== assignmentWorkspaceDirectory
      )
        throw new WorkspaceError('workspace_assignment_root_invalid');
    }
    this.assignmentWorkspaceDirectory = assignmentWorkspaceDirectory;
    this.emptyTemplate = join(this.root, 'empty-template');
    this.safeDirectory(this.emptyTemplate);
    this.db = new DatabaseSync(ledger.path);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;
      CREATE TABLE IF NOT EXISTS runner_repository (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),repository_id TEXT NOT NULL,
        source_path TEXT NOT NULL,base_ref TEXT NOT NULL,initial_oid TEXT NOT NULL,
        bare_path TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('preparing','ready'))
      );
      CREATE TABLE IF NOT EXISTS runner_checkout_slots (
        slot_id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,branch TEXT,base_oid TEXT NOT NULL,
        owner_launch_id TEXT UNIQUE,epoch INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_workspaces (
        launch_id TEXT PRIMARY KEY REFERENCES launches(id),slot_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,path TEXT NOT NULL,policy_json TEXT NOT NULL,read_only INTEGER NOT NULL,
        base_oid TEXT NOT NULL,branch TEXT,repository_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('preparing','ready','capturing','captured','closing','closed')),
        attachment_json TEXT,result_json TEXT,canceled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TRIGGER IF NOT EXISTS immutable_workspace_identity
        BEFORE UPDATE OF launch_id,slot_id,epoch,path,policy_json,read_only,base_oid,branch,repository_id ON runner_workspaces
        BEGIN SELECT RAISE(ABORT,'immutable workspace identity'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_workspace_attachment BEFORE UPDATE OF attachment_json ON runner_workspaces
        WHEN OLD.attachment_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable workspace attachment'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_workspace_result BEFORE UPDATE OF result_json ON runner_workspaces
        WHEN OLD.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable workspace result'); END;
      CREATE TABLE IF NOT EXISTS runner_workspace_fences (
        launch_id TEXT PRIMARY KEY REFERENCES launches(id),owner_oid TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('preparing','armed','revoked'))
      );
      CREATE TRIGGER IF NOT EXISTS immutable_workspace_fence BEFORE UPDATE ON runner_workspace_fences
        WHEN NEW.launch_id<>OLD.launch_id OR NEW.owner_oid<>OLD.owner_oid
          OR (OLD.status='revoked' AND NEW.status<>'revoked')
        BEGIN SELECT RAISE(ABORT,'immutable workspace fence'); END;
      CREATE TABLE IF NOT EXISTS runner_code_commits (
        command_id TEXT PRIMARY KEY,launch_id TEXT NOT NULL REFERENCES launches(id),
        command_json TEXT NOT NULL,tree_oid TEXT,target_oid TEXT,index_path TEXT,receipt_json TEXT,
        error TEXT,acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TRIGGER IF NOT EXISTS immutable_code_commit BEFORE UPDATE ON runner_code_commits
        WHEN NEW.command_id<>OLD.command_id OR NEW.launch_id<>OLD.launch_id OR NEW.command_json<>OLD.command_json
          OR (OLD.tree_oid IS NOT NULL AND NEW.tree_oid IS NOT OLD.tree_oid)
          OR (OLD.target_oid IS NOT NULL AND NEW.target_oid IS NOT OLD.target_oid)
          OR (OLD.index_path IS NOT NULL AND NEW.index_path IS NOT OLD.index_path)
          OR (OLD.receipt_json IS NOT NULL AND NEW.receipt_json IS NOT OLD.receipt_json)
          OR (OLD.error IS NOT NULL AND NEW.error IS NOT OLD.error)
          OR (OLD.acknowledged=1 AND NEW.acknowledged<>1)
        BEGIN SELECT RAISE(ABORT,'immutable code commit'); END;
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
  prepare(record: LaunchRecord, session: Session): Promise<WorkspaceHandle> {
    return this.run({ record, session }, async ({ record, session }) => {
      this.requireLaunch(record);
      if (record.sessionId !== session.id) throw new WorkspaceError('workspace_session_mismatch');
      const policy = effectiveWorkspace(session.execution.policy);
      const existing = this.row(record.id);
      if (existing) {
        if (
          existing.policy_json !== JSON.stringify(policy) ||
          !!existing.read_only !== session.execution.policy.readOnly
        )
          throw new WorkspaceError('workspace_policy_changed');
        if (existing.status !== 'preparing') {
          if (existing.status === 'ready') {
            await this.validateCheckout(existing);
            await this.armFence(existing);
          }
          return this.get(record.id)!;
        }
        await this.prepareCheckout(existing);
        return this.get(record.id)!;
      }
      if (terminalLaunch(this.ledger.get(record.id)!))
        throw new WorkspaceError('workspace_launch_closed');
      let repository: RepositoryRow | undefined;
      let base = '',
        branch: string | null = null,
        path: string,
        slotId: string;
      if (policy.mode === 'none') {
        path = this.assignmentWorkspaceDirectory
          ? join(this.assignmentWorkspaceDirectory, hash(record.id))
          : join(realpathSync(record.runDirectory), 'workspace');
        slotId = `scratch:${record.id}`;
      } else {
        repository = await this.repository();
        const namespace = segment(policy.namespace),
          project = segment(session.projectId),
          instance = segment(session.instanceId);
        const reference = policy.base.startsWith('reference:')
          ? session.execution.references[policy.base.slice(10)]
          : undefined;
        if (policy.base !== 'central' && (typeof reference !== 'string' || !reference))
          throw new WorkspaceError('workspace_base_reference_required');
        const pinned = typeof reference === 'string' ? oid(reference) : undefined;
        const lineage = `${namespace}/${project}/${instance}`;
        base = pinned ?? (await this.rev(repository.bare_path, 'refs/merv/central'));
        if (pinned && (await this.rev(repository.bare_path, pinned)) !== pinned)
          throw new WorkspaceError('workspace_base_missing');
        const suffix =
          policy.mode === 'ephemeral' ? `/${hash(record.id)}` : policy.perBase ? `/${base}` : '';
        const layout =
          policy.mode === 'ephemeral'
            ? 'ephemeral'
            : policy.perBase
              ? 'persistent/per-base'
              : 'persistent/shared';
        slotId = `${policy.mode}:${repository.repository_id}:${lineage}${suffix}`;
        path = join(this.root, 'checkouts', layout, lineage + suffix);
        branch =
          policy.mode === 'persistent'
            ? `codex/merv/${policy.perBase ? 'per-base' : 'shared'}/${[namespace, project, instance].map(refSegment).join('/')}${suffix}`
            : null;
        const slot = this.db
          .prepare('SELECT base_oid FROM runner_checkout_slots WHERE slot_id=?')
          .get(slotId);
        if (slot && policy.mode === 'persistent' && !policy.perBase) {
          if (pinned && slot.base_oid !== pinned)
            throw new WorkspaceError('workspace_base_changed');
          base = String(slot.base_oid);
        }
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const slot = this.db
          .prepare('SELECT * FROM runner_checkout_slots WHERE slot_id=?')
          .get(slotId);
        if (slot?.owner_launch_id) throw new WorkspaceError('workspace_owned_by_another_launch');
        if (!slot && statIfPresent(path)) throw new WorkspaceError('workspace_foreign_checkout');
        const epoch = Number(slot?.epoch ?? 0) + 1;
        this.db
          .prepare(
            `INSERT INTO runner_checkout_slots VALUES(?,?,?,?,?,?)
          ON CONFLICT(slot_id) DO UPDATE SET owner_launch_id=excluded.owner_launch_id,epoch=excluded.epoch`,
          )
          .run(slotId, path, branch, base, record.id, epoch);
        this.db
          .prepare(
            `INSERT INTO runner_workspaces(launch_id,slot_id,epoch,path,policy_json,read_only,base_oid,branch,repository_id,status)
          VALUES(?,?,?,?,?,?,?,?,?,'preparing')`,
          )
          .run(
            record.id,
            slotId,
            epoch,
            path,
            JSON.stringify(policy),
            Number(session.execution.policy.readOnly),
            base,
            branch,
            repository?.repository_id ?? null,
          );
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      await this.prepareCheckout(this.row(record.id)!);
      return this.get(record.id)!;
    });
  }
  /** Commit the current checkout through a replayable, path-free server command. */
  checkpointCommit(record: LaunchRecord, input: CodeCommitCommand): Promise<CodeCommitReceipt> {
    const parsed = codeCommitCommandSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new WorkspaceError('workspace_invalid_command'));
    const command = parsed.data;
    return this.run({ record, command }, async ({ record, command }) => {
      try {
        return await this.applyCheckpointCommit(record, command);
      } catch (error) {
        await this.recordCommitError(record, command, error);
        throw error;
      }
    });
  }
  pendingCommits(launchId: string): CodeCommitCommand[] {
    return (
      this.db
        .prepare(
          'SELECT command_json FROM runner_code_commits WHERE launch_id=? AND acknowledged=0 ORDER BY rowid',
        )
        .all(launchId) as { command_json: string }[]
    ).map((row) => JSON.parse(row.command_json) as CodeCommitCommand);
  }
  commitOutcome(commandId: string): { receipt: CodeCommitReceipt } | { error: string } | null {
    const row = this.commitRow(commandId);
    if (row?.receipt_json) return { receipt: JSON.parse(row.receipt_json) as CodeCommitReceipt };
    return row?.error ? { error: row.error } : null;
  }
  acknowledgeCommit(commandId: string): void {
    if (!this.commitOutcome(commandId))
      throw new WorkspaceError('workspace_commit_outcome_required');
    this.db
      .prepare('UPDATE runner_code_commits SET acknowledged=1 WHERE command_id=?')
      .run(commandId);
  }
  private async applyCheckpointCommit(
    record: LaunchRecord,
    command: CodeCommitCommand,
  ): Promise<CodeCommitReceipt> {
    this.requireLaunch(record);
    const row = this.row(record.id);
    if (!row?.attachment_json || !row.repository_id)
      throw new WorkspaceError('workspace_git_attachment_required');
    const attached = JSON.parse(row.attachment_json) as SessionWorkspace;
    const storedSession = this.ledger.get(record.id)!.metadata.session as
      Record<string, unknown> | undefined;
    if (
      command.sessionId !== record.sessionId ||
      command.hostRef !== record.id ||
      command.runnerId !== this.ledger.runnerId ||
      (storedSession &&
        ['projectId', 'actorId', 'instanceId', 'expectedRevision'].some(
          (key) => storedSession[key] !== command[key as keyof CodeCommitCommand],
        )) ||
      (['repositoryId', 'workspaceId', 'mode', 'branch', 'baseOid'] as const).some(
        (key) => command.workspace[key] !== attached[key],
      )
    )
      throw new WorkspaceError('workspace_command_mismatch');
    const encoded = JSON.stringify(command);
    let journal = this.commitRow(command.id);
    if (journal && (journal.launch_id !== record.id || journal.command_json !== encoded))
      throw new WorkspaceError('workspace_command_conflict');
    if (journal?.receipt_json) return JSON.parse(journal.receipt_json) as CodeCommitReceipt;
    if (journal?.error) throw new WorkspaceError(journal.error);
    if (!journal) {
      this.db
        .prepare('INSERT INTO runner_code_commits(command_id,launch_id,command_json) VALUES(?,?,?)')
        .run(command.id, record.id, encoded);
      journal = this.commitRow(command.id)!;
    }
    const repository = await this.repository();
    const receiptRef = `refs/merv/commands/${hash(command.id)}`;
    const recordedTarget = await this.optionalRef(repository.bare_path, receiptRef);
    if (recordedTarget) {
      if (!journal?.target_oid || recordedTarget !== journal.target_oid)
        throw new WorkspaceError('workspace_command_receipt_conflict');
      await this.syncCommitIndex(row, journal);
      return this.finishCommitReceipt(row, command, journal);
    }
    this.requireCommitLaunch(row);
    await this.validateCheckout(row);
    const fence = this.fence(row);
    if (
      fence?.status !== 'armed' ||
      (await this.optionalRef(repository.bare_path, this.ownerRef(row))) !== fence.owner_oid
    )
      throw new WorkspaceError('workspace_commit_fenced');
    if (
      oid(await this.checkoutGit(row, ['rev-parse', '--verify', 'HEAD^{commit}'])) !==
      command.expectedHead
    )
      throw new WorkspaceError('workspace_head_conflict');
    if (!journal.tree_oid) {
      // Each pre-freeze retry owns a fresh index. A crashed Git child can never mutate
      // the checkout index, a successor's index, or another attempt's frozen tree.
      const directory = join(this.root, 'operations', hash(record.id), hash(command.id));
      this.safeDirectory(directory);
      const index = join(directory, `index-${randomUUID()}`);
      const env = { GIT_INDEX_FILE: index };
      await this.checkoutGit(row, ['read-tree', command.expectedHead], env);
      await this.checkChangedFiles(row, env);
      await this.checkoutGit(row, ['add', '-A', '--', '.'], env);
      await this.checkChangedFiles(row, env);
      const tree = oid(await this.checkoutGit(row, ['write-tree'], env));
      await this.checkTreeFiles(row, command.expectedHead, tree);
      this.requireCommitLaunch(row);
      this.db
        .prepare(
          'UPDATE runner_code_commits SET tree_oid=?,index_path=? WHERE command_id=? AND tree_oid IS NULL',
        )
        .run(tree, index, command.id);
      journal = this.commitRow(command.id)!;
    }
    if (!journal.target_oid) {
      const parentTree = oid(
        await this.checkoutGit(row, ['rev-parse', `${command.expectedHead}^{tree}`]),
      );
      const timestamp = `${Math.floor(Date.parse(command.createdAt) / 1000)} +0000`;
      const target =
        parentTree === journal.tree_oid
          ? command.expectedHead
          : oid(
              await this.checkoutGit(
                row,
                ['commit-tree', journal.tree_oid!, '-p', command.expectedHead],
                {
                  GIT_AUTHOR_NAME: 'Merv Agent Runner',
                  GIT_AUTHOR_EMAIL: 'merv@localhost',
                  GIT_COMMITTER_NAME: 'Merv Agent Runner',
                  GIT_COMMITTER_EMAIL: 'merv@localhost',
                  GIT_AUTHOR_DATE: timestamp,
                  GIT_COMMITTER_DATE: timestamp,
                },
                command.message.endsWith('\n') ? command.message : `${command.message}\n`,
              ),
            );
      this.db
        .prepare(
          'UPDATE runner_code_commits SET target_oid=? WHERE command_id=? AND target_oid IS NULL',
        )
        .run(target, command.id);
      journal = this.commitRow(command.id)!;
    }
    this.requireCommitLaunch(row);
    if (this.fence(row)?.status !== 'armed') throw new WorkspaceError('workspace_commit_fenced');
    // HEAD and the receipt marker commit atomically; the ownership verify also fences
    // an orphan process whose controller died before the Git transaction completed.
    await this.checkoutGit(
      row,
      ['update-ref', '--stdin'],
      undefined,
      [
        'start',
        `verify ${this.ownerRef(row)} ${fence.owner_oid}`,
        `update HEAD ${journal.target_oid} ${command.expectedHead}`,
        `create ${receiptRef} ${journal.target_oid}`,
        'prepare',
        'commit',
        '',
      ].join('\n'),
    );
    await this.syncCommitIndex(row, journal);
    return this.finishCommitReceipt(row, command, journal);
  }

  capture(record: LaunchRecord): Promise<SessionWorkspace | undefined> {
    return this.run(record, async (record) => {
      this.requireLaunch(record);
      if (!terminalLaunch(this.ledger.get(record.id)!))
        throw new WorkspaceError('workspace_process_stop_unconfirmed');
      let row = this.row(record.id);
      if (!row) return undefined;
      if (row.result_json) return JSON.parse(row.result_json) as SessionWorkspace;
      if (row.canceled || row.status === 'captured' || row.status === 'closed') return undefined;
      this.requireOwnership(row);
      if (row.status === 'preparing') {
        // No command ran before successful preparation. Preserve every unverified path.
        try {
          await this.validateCheckout(row);
          const snapshot = await this.snapshot(row);
          this.db
            .prepare(
              "UPDATE runner_workspaces SET status='ready',attachment_json=? WHERE launch_id=?",
            )
            .run(snapshot ? JSON.stringify(snapshot) : null, record.id);
          row = this.row(record.id)!;
        } catch {
          this.db
            .prepare("UPDATE runner_workspaces SET status='captured',canceled=1 WHERE launch_id=?")
            .run(record.id);
          return undefined;
        }
      }
      this.db
        .prepare("UPDATE runner_workspaces SET status='capturing' WHERE launch_id=?")
        .run(record.id);
      await this.validateCheckout(row);
      const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
      if (policy.mode === 'none') {
        this.db
          .prepare("UPDATE runner_workspaces SET status='captured' WHERE launch_id=?")
          .run(record.id);
        return undefined;
      }
      // A delayed orphan update-ref must fail before final capture or successor reuse.
      await this.revokeFence(row);
      const attached = JSON.parse(row.attachment_json!) as SessionWorkspace;
      const before = await this.checkoutGit(row, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (row.read_only && oid(before) !== attached.headOid)
        throw new WorkspaceError('workspace_readonly_head_changed');
      const status = await this.checkoutGit(row, [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ]);
      // A reviewer may compute in a checkout that is about to be removed: its untracked
      // scratch goes with it, and nothing later reuses the path. What a read-only lease may
      // never do is change the thing it is judging, which the HEAD check and the tracked-file
      // lines below still refuse. A retained checkout keeps the strict rule, because the next
      // launch inherits whatever is left behind.
      if (row.read_only) {
        const dirty = policy.retain
          ? status.trim()
          : status
              .split('\n')
              .filter((line) => line.trim() && !line.startsWith('??'))
              .join('\n');
        if (dirty) throw new WorkspaceError('workspace_readonly_dirty');
      }
      if (!row.read_only) {
        if (status.trim()) {
          await this.checkChangedFiles(row);
          await this.checkoutGit(row, ['add', '-A', '--', '.']);
          const staged = await this.checkoutGit(row, [
            'diff',
            '--cached',
            '--no-ext-diff',
            '--no-textconv',
            '--name-only',
          ]);
          if (staged.trim())
            await this.checkoutGit(row, [
              '-c',
              'user.name=Merv Agent Runner',
              '-c',
              'user.email=merv@localhost',
              'commit',
              '--no-verify',
              '-m',
              `merv: capture ${record.sessionId}`,
            ]);
        }
      }
      const snapshot = (await this.snapshot(row))!;
      this.db
        .prepare("UPDATE runner_workspaces SET status='captured',result_json=? WHERE launch_id=?")
        .run(JSON.stringify(snapshot), record.id);
      return snapshot;
    });
  }
  close(record: LaunchRecord): Promise<void> {
    return this.run(record, async (record) => {
      this.requireLaunch(record);
      if (!terminalLaunch(this.ledger.get(record.id)!))
        throw new WorkspaceError('workspace_process_stop_unconfirmed');
      const row = this.row(record.id);
      if (!row || row.status === 'closed') return;
      this.requireOwnership(row);
      if (!['captured', 'closing'].includes(row.status))
        throw new WorkspaceError('workspace_capture_required');
      this.db
        .prepare("UPDATE runner_workspaces SET status='closing' WHERE launch_id=?")
        .run(record.id);
      const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
      if (!row.canceled && policy.mode !== 'none' && !policy.retain && existsSync(row.path)) {
        await this.validateCheckout(row);
        const repository = await this.repository();
        await this.git([
          '--git-dir',
          repository.bare_path,
          'worktree',
          'remove',
          '--force',
          '--',
          row.path,
        ]);
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.requireOwnership(row);
        this.db
          .prepare(
            'UPDATE runner_checkout_slots SET owner_launch_id=NULL WHERE slot_id=? AND owner_launch_id=? AND epoch=?',
          )
          .run(row.slot_id, record.id, row.epoch);
        this.db
          .prepare("UPDATE runner_workspaces SET status='closed' WHERE launch_id=?")
          .run(record.id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  dispose(): void {
    this.disposed = true;
    this.db.close();
  }

  private async run<Input, T>(input: Input, action: (input: Input) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(input);
    const operation = this.serial.then(() => {
      if (this.disposed) throw new WorkspaceError('workspace_manager_closed');
      return action(snapshot);
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  private row(id: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM runner_workspaces WHERE launch_id=?').get(id) as
      WorkspaceRow | undefined;
  }
  private requireLaunch(record: LaunchRecord): void {
    const actual = this.ledger.get(record.id);
    if (
      !actual ||
      actual.sessionId !== record.sessionId ||
      actual.runDirectory !== record.runDirectory
    )
      throw new WorkspaceError('workspace_unknown_launch');
  }
  private requireOwnership(row: WorkspaceRow): void {
    const slot = this.db
      .prepare('SELECT owner_launch_id,epoch FROM runner_checkout_slots WHERE slot_id=?')
      .get(row.slot_id);
    if (slot?.owner_launch_id !== row.launch_id || Number(slot.epoch) !== row.epoch)
      throw new WorkspaceError('workspace_ownership_changed');
  }
  private commitRow(id: string): CommitRow | undefined {
    return this.db.prepare('SELECT * FROM runner_code_commits WHERE command_id=?').get(id) as
      CommitRow | undefined;
  }
  private async recordCommitError(
    record: LaunchRecord,
    command: CodeCommitCommand,
    error: unknown,
  ): Promise<void> {
    const journal = this.commitRow(command.id);
    if (
      !journal ||
      journal.launch_id !== record.id ||
      journal.command_json !== JSON.stringify(command) ||
      journal.receipt_json ||
      journal.error
    )
      return;
    if (journal.target_oid) {
      // A failed/unknown update-ref can only become a terminal failure once capture
      // has fenced this launch and an atomic receipt is conclusively absent.
      const row = this.row(record.id)!;
      try {
        const repository = await this.repository();
        if (this.fence(row)?.status !== 'revoked') return;
        const owner = await this.optionalRef(repository.bare_path, this.ownerRef(row));
        if (owner === this.fence(row)!.owner_oid) return;
        if (await this.optionalRef(repository.bare_path, `refs/merv/commands/${hash(command.id)}`))
          return;
      } catch {
        return;
      }
    }
    const code = error instanceof WorkspaceError ? error.code : 'workspace_commit_failed';
    this.db
      .prepare(
        'UPDATE runner_code_commits SET error=? WHERE command_id=? AND receipt_json IS NULL AND error IS NULL',
      )
      .run(code, command.id);
  }
  private requireCommitLaunch(row: WorkspaceRow): void {
    const launch = this.ledger.get(row.launch_id);
    if (launch?.status !== 'running' || launch.deadline <= Date.now())
      throw new WorkspaceError('workspace_process_not_running');
    this.requireOwnership(row);
    if (this.row(row.launch_id)?.status !== 'ready')
      throw new WorkspaceError('workspace_not_ready');
    if (row.read_only) throw new WorkspaceError('workspace_readonly_commit');
  }
  private fence(row: WorkspaceRow): FenceRow | undefined {
    return this.db
      .prepare('SELECT owner_oid,status FROM runner_workspace_fences WHERE launch_id=?')
      .get(row.launch_id) as FenceRow | undefined;
  }
  private ownerRef(row: WorkspaceRow): string {
    return `refs/merv/owners/${hash(row.slot_id)}`;
  }
  private async closedOwner(repository: RepositoryRow): Promise<string> {
    return (this.closedOwnerOid ??= oid(
      await this.git(
        ['--git-dir', repository.bare_path, 'hash-object', '-w', '--stdin'],
        60000,
        false,
        undefined,
        '{"format":1,"workspaceOwner":"closed"}',
      ),
    ));
  }
  private async armFence(row: WorkspaceRow): Promise<void> {
    if (!row.repository_id) return;
    this.requireOwnership(row);
    const repository = await this.repository();
    let fence = this.fence(row);
    if (!fence) {
      const owner = oid(
        await this.git(
          ['--git-dir', repository.bare_path, 'hash-object', '-w', '--stdin'],
          60000,
          false,
          undefined,
          JSON.stringify({
            format: 1,
            launchId: row.launch_id,
            slotId: row.slot_id,
            epoch: row.epoch,
          }),
        ),
      );
      this.db
        .prepare("INSERT INTO runner_workspace_fences VALUES(?,?,'preparing')")
        .run(row.launch_id, owner);
      fence = this.fence(row)!;
    }
    if (fence.status === 'revoked') throw new WorkspaceError('workspace_commit_fenced');
    const current = await this.optionalRef(repository.bare_path, this.ownerRef(row));
    if (current !== fence.owner_oid) {
      if ((current && current !== (await this.closedOwner(repository))) || fence.status === 'armed')
        throw new WorkspaceError('workspace_commit_fenced');
      await this.git([
        '--git-dir',
        repository.bare_path,
        'update-ref',
        this.ownerRef(row),
        fence.owner_oid,
        current ?? '0'.repeat(fence.owner_oid.length),
      ]);
    }
    this.db
      .prepare(
        "UPDATE runner_workspace_fences SET status='armed' WHERE launch_id=? AND status='preparing'",
      )
      .run(row.launch_id);
  }
  private async revokeFence(row: WorkspaceRow): Promise<void> {
    const repository = await this.repository();
    // Older local ledgers may not have created an interactive-operation fence yet.
    if (!this.fence(row)) await this.armFence(row);
    const fence = this.fence(row)!;
    const closed = await this.closedOwner(repository);
    this.db
      .prepare("UPDATE runner_workspace_fences SET status='revoked' WHERE launch_id=?")
      .run(row.launch_id);
    const current = await this.optionalRef(repository.bare_path, this.ownerRef(row));
    if (current === closed) return;
    if (current && current !== fence.owner_oid)
      throw new WorkspaceError('workspace_ownership_changed');
    await this.git([
      '--git-dir',
      repository.bare_path,
      'update-ref',
      this.ownerRef(row),
      closed,
      current ?? '0'.repeat(closed.length),
    ]);
  }
  private async optionalRef(bare: string, ref: string): Promise<string | undefined> {
    const refs = await this.git([
      '--git-dir',
      bare,
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      ref,
    ]);
    const line = refs.split('\n').find((entry) => entry.startsWith(`${ref} `));
    return line ? oid(line.slice(ref.length + 1)) : undefined;
  }
  private async checkChangedFiles(row: WorkspaceRow, env?: Record<string, string>): Promise<void> {
    const changed = await this.checkoutGit(
      row,
      ['ls-files', '--modified', '--others', '--exclude-standard', '-z'],
      env,
    );
    const staged = await this.checkoutGit(
      row,
      ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z'],
      env,
    );
    for (const name of new Set((changed + staged).split('\0').filter(Boolean))) {
      const file = resolve(row.path, name);
      // A tracked final-component symlink is Git data. Never traverse a symlink parent.
      this.within(row.path, dirname(file));
      const stat = statIfPresent(file);
      if (stat?.isFile() && stat.size > MAX_FILE)
        throw new WorkspaceError('workspace_file_too_large');
    }
  }
  private async checkTreeFiles(row: WorkspaceRow, parent: string, tree: string): Promise<void> {
    const changed = new Set(
      (
        await this.checkoutGit(row, [
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-r',
          '-z',
          parent,
          tree,
        ])
      ).split('\0'),
    );
    const entries = await this.checkoutGit(row, ['ls-tree', '-r', '-l', '-z', tree]);
    for (const entry of entries.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (!changed.has(entry.slice(tab + 1))) continue;
      const size = entry.slice(0, tab).trim().split(/\s+/)[3];
      if (size !== '-' && Number(size) > MAX_FILE)
        throw new WorkspaceError('workspace_file_too_large');
    }
  }
  private async syncCommitIndex(row: WorkspaceRow, journal: CommitRow): Promise<void> {
    if (
      this.ledger.get(row.launch_id)?.status !== 'running' ||
      this.row(row.launch_id)?.status !== 'ready'
    )
      return;
    const repository = await this.repository();
    const admin = await this.adminDirectory(row, repository);
    if (oid(await this.checkoutGit(row, ['rev-parse', 'HEAD'])) !== journal.target_oid) return;
    this.requireCommitLaunch(row);
    if (this.fence(row)?.status !== 'armed') throw new WorkspaceError('workspace_commit_fenced');
    this.within(this.root, journal.index_path!);
    const index = join(admin, 'index');
    this.within(this.root, index);
    const temporary = join(admin, `merv-index-${randomUUID()}`);
    // Synchronous copy + rename leaves no orphan Git child able to modify the normal index.
    copyFileSync(journal.index_path!, temporary);
    syncPath(temporary);
    renameSync(temporary, index);
    syncPath(admin);
  }
  private async finishCommitReceipt(
    row: WorkspaceRow,
    command: CodeCommitCommand,
    journal: CommitRow,
  ): Promise<CodeCommitReceipt> {
    const receipt: CodeCommitReceipt = {
      commandId: command.id,
      repositoryId: row.repository_id!,
      workspaceId: `workspace_${hash(row.slot_id)}`,
      baseOid: row.base_oid,
      parentOid: command.expectedHead,
      headOid: journal.target_oid!,
      treeOid: journal.tree_oid!,
      stats: await this.stats(row, journal.target_oid!),
    };
    this.db
      .prepare(
        'UPDATE runner_code_commits SET receipt_json=? WHERE command_id=? AND receipt_json IS NULL',
      )
      .run(JSON.stringify(receipt), command.id);
    return receipt;
  }
  private within(root: string, path: string): void {
    const name = relative(root, path);
    if (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name))
      throw new WorkspaceError('workspace_path_escape');
    let current = root;
    if (statIfPresent(current)?.isSymbolicLink()) throw new WorkspaceError('workspace_symlink');
    for (const part of name.split(sep).filter(Boolean)) {
      current = join(current, part);
      if (statIfPresent(current)?.isSymbolicLink()) throw new WorkspaceError('workspace_symlink');
    }
  }
  private safeDirectory(path: string): void {
    this.within(this.root, path);
    privateDirectory(path);
  }
  private async repository(): Promise<RepositoryRow> {
    if (!this.config) throw new WorkspaceError('workspace_repository_required');
    if ('github' in this.config) {
      const row = this.repositoryRow();
      if (!row || row.status !== 'ready' || !row.repository_id.startsWith('github:'))
        throw new WorkspaceError('workspace_github_prepare_required');
      this.within(this.root, row.bare_path);
      marker(join(row.bare_path, 'merv-repository.json'), repositoryIdentity(row));
      await this.validateRepository(row.bare_path);
      return row;
    }
    if (
      !isAbsolute(this.config.repository) ||
      !this.config.baseRef ||
      /[\0\r\n]/.test(this.config.baseRef)
    )
      throw new WorkspaceError('workspace_invalid_repository_config');
    if (!existsSync(this.config.repository) || lstatSync(this.config.repository).isSymbolicLink())
      throw new WorkspaceError('workspace_repository_missing');
    const source = realpathSync(this.config.repository);
    let row = this.repositoryRow();
    if (row && (row.source_path !== source || row.base_ref !== this.config.baseRef))
      throw new WorkspaceError('workspace_repository_changed');
    if (!row) {
      const initial = oid(
        await this.git([
          '-C',
          source,
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${this.config.baseRef}^{commit}`,
        ]),
      );
      row = this.insertRepositoryRow(`repo_${randomUUID()}`, source, this.config.baseRef, initial);
    }
    const central = row.initial_oid;
    await this.materializeBare(row, `bootstrap-${row.repository_id}`, async (temporary) => {
      await this.git(
        [
          'clone',
          '--bare',
          '--no-local',
          '--no-hardlinks',
          `--template=${this.emptyTemplate}`,
          '--',
          source,
          temporary,
        ],
        240000,
      );
      await this.git(['--git-dir', temporary, 'remote', 'remove', 'origin']);
      await this.git(['--git-dir', temporary, 'update-ref', 'refs/merv/central', central]);
    });
    const identityFile = join(row.bare_path, 'merv-repository.json');
    if (
      !existsSync(identityFile) ||
      lstatSync(identityFile).isSymbolicLink() ||
      readFileSync(identityFile, 'utf8') !== JSON.stringify(repositoryIdentity(row))
    )
      throw new WorkspaceError('workspace_foreign_repository');
    await this.validateRepository(row.bare_path);
    if (row.status === 'preparing') {
      if ((await this.rev(row.bare_path, 'refs/merv/central')) !== row.initial_oid)
        throw new WorkspaceError('workspace_initial_base_changed');
      this.db.prepare("UPDATE runner_repository SET status='ready' WHERE singleton=1").run();
      row = { ...row, status: 'ready' };
    }
    return row;
  }
  private repositoryRow(): RepositoryRow | undefined {
    return this.db.prepare('SELECT * FROM runner_repository WHERE singleton=1').get() as
      RepositoryRow | undefined;
  }
  private insertRepositoryRow(
    repositoryId: string,
    sourcePath: string,
    baseRef: string,
    initialOid: string,
  ): RepositoryRow {
    this.db
      .prepare("INSERT INTO runner_repository VALUES(1,?,?,?,?,?,'preparing')")
      .run(repositoryId, sourcePath, baseRef, initialOid, join(this.root, 'repository.git'));
    return this.repositoryRow()!;
  }
  /**
   * Create a durable repository intent's bare copy once: populated inside a marked stage
   * directory, then renamed into place. A ready repository whose copy is missing was lost.
   */
  private async materializeBare(
    row: RepositoryRow,
    stageName: string,
    populate: (temporary: string) => Promise<void>,
  ): Promise<void> {
    this.within(this.root, row.bare_path);
    if (existsSync(row.bare_path)) return;
    if (row.status === 'ready') throw new WorkspaceError('workspace_repository_lost');
    const stage = join(this.root, stageName);
    this.safeDirectory(stage);
    marker(join(stage, 'owner.json'), repositoryIdentity(row));
    const temporary = join(stage, 'repository.git');
    this.within(stage, temporary);
    // Only the marked bootstrap directory belongs to this exact durable intent.
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    await populate(temporary);
    marker(join(temporary, 'merv-repository.json'), repositoryIdentity(row));
    renameSync(temporary, row.bare_path);
    syncPath(this.root);
  }
  /** Import pinned objects into this machine's private repository, without storing a remote or credential. */
  syncGitHub(value: CodeTransportGrant, references: string[] = []): Promise<void> {
    return this.run({ value, references }, async ({ value, references }) => {
      const grant = codeTransportGrantSchema.parse(value);
      if (!this.config || !('github' in this.config) || grant.target)
        throw new WorkspaceError('workspace_github_config_required');
      const url = this.githubUrl(grant);
      let row = this.repositoryRow();
      if (
        row &&
        (row.repository_id !== grant.repositoryId ||
          row.source_path !== url ||
          row.base_ref !== grant.baseBranch)
      )
        throw new WorkspaceError('workspace_repository_changed');
      if (!row)
        row = this.insertRepositoryRow(grant.repositoryId, url, grant.baseBranch, grant.baseOid);
      await this.materializeBare(row, 'github-bootstrap', async (temporary) => {
        await this.git(['init', '--bare', `--template=${this.emptyTemplate}`, temporary]);
      });
      marker(join(row.bare_path, 'merv-repository.json'), repositoryIdentity(row));
      await this.validateRepository(row.bare_path);
      const commits = [...new Set([row.initial_oid, grant.baseOid, ...references.map(oid)])];
      if (commits.length > 200) throw new WorkspaceError('workspace_reference_limit');
      for (const sha of commits) {
        if ((await this.optionalRef(row.bare_path, `refs/merv/imports/${sha}`)) === sha) continue;
        await this.remoteGit(grant, [
          '--git-dir',
          row.bare_path,
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--no-write-fetch-head',
          url,
          `${sha}:refs/merv/imports/${sha}`,
        ]);
        if ((await this.rev(row.bare_path, sha)) !== sha)
          throw new WorkspaceError('workspace_base_missing');
      }
      await this.git([
        '--git-dir',
        row.bare_path,
        'update-ref',
        'refs/merv/central',
        grant.baseOid,
      ]);
      this.db.prepare("UPDATE runner_repository SET status='ready' WHERE singleton=1").run();
    });
  }
  /** Create an immutable checkpoint ref. The absent-ref lease prevents even a concurrent fast-forward replacement. */
  pushGitHub(value: CodeTransportGrant): Promise<void> {
    return this.run(value, async (value) => {
      const grant = codeTransportGrantSchema.parse(value),
        target = grant.target;
      if (!target) throw new WorkspaceError('workspace_push_target_required');
      const row = await this.repository(),
        url = this.githubUrl(grant);
      if (
        row.repository_id !== grant.repositoryId ||
        row.source_path !== url ||
        row.base_ref !== grant.baseBranch
      )
        throw new WorkspaceError('workspace_repository_changed');
      if (
        (await this.rev(row.bare_path, target.headOid)) !== target.headOid ||
        oid(
          await this.git(['--git-dir', row.bare_path, 'rev-parse', `${target.headOid}^{tree}`]),
        ) !== target.treeOid
      )
        throw new WorkspaceError('workspace_push_object_mismatch');
      const ref = `refs/heads/${target.branch}`;
      const remote = async () => {
        const output = (
          await this.remoteGit(grant, ['--git-dir', row.bare_path, 'ls-remote', '--refs', url, ref])
        ).trim();
        if (!output) return null;
        const parts = output.split(/\s+/);
        if (parts.length !== 2 || parts[1] !== ref)
          throw new WorkspaceError('workspace_remote_ref_invalid');
        return oid(parts[0]);
      };
      const existing = await remote();
      if (existing === target.headOid) return;
      if (existing) throw new WorkspaceError('workspace_remote_ref_conflict');
      try {
        await this.remoteGit(grant, [
          '--git-dir',
          row.bare_path,
          'push',
          '--porcelain',
          `--force-with-lease=${ref}:`,
          url,
          `${target.headOid}:${ref}`,
        ]);
      } catch (error) {
        // A disconnected response may follow a successful push. Only the exact remote object proves success.
        if ((await remote()) !== target.headOid) throw error;
      }
      if ((await remote()) !== target.headOid)
        throw new WorkspaceError('workspace_remote_ref_conflict');
    });
  }
  private githubUrl(grant: CodeTransportGrant) {
    if (
      grant.repository.split('/').some((part) => part === '.' || part === '..') ||
      Date.parse(grant.expiresAt) <= Date.now()
    )
      throw new WorkspaceError('workspace_github_grant_invalid');
    return `https://github.com/${grant.repository}.git`;
  }
  private remoteGit(grant: CodeTransportGrant, args: string[]) {
    // Secret exists only in this trusted Git child's environment, never its argv, saved config,
    // runner journal or worker environment. Git diagnostics are always replaced with safe codes.
    return this.git(
      ['-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', ...args],
      240000,
      false,
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${grant.token}`).toString('base64')}`,
      },
    );
  }
  private async validateRepository(bare: string): Promise<void> {
    for (const component of ['config', 'objects', 'refs', 'worktrees'])
      this.within(this.root, join(bare, component));
    if (existsSync(join(bare, 'objects/info/alternates')))
      throw new WorkspaceError('workspace_object_alternates_refused');
    const config = await this.git([
      '--git-dir',
      bare,
      'config',
      '--local',
      '--no-includes',
      '--null',
      '--list',
    ]);
    for (const entry of config.split('\0').filter(Boolean)) {
      const key = entry.split('\n', 1)[0];
      if (
        !/^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|extensions\.objectformat|user\.(?:name|email))$/.test(
          key,
        )
      )
        throw new WorkspaceError('workspace_unsafe_git_config');
    }
    if (
      (await this.git(['--git-dir', bare, 'rev-parse', '--is-bare-repository'])).trim() !== 'true'
    )
      throw new WorkspaceError('workspace_not_bare');
  }
  private async prepareCheckout(row: WorkspaceRow): Promise<void> {
    this.requireOwnership(row);
    const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
    if (policy.mode === 'none') {
      const parent =
        this.assignmentWorkspaceDirectory ??
        realpathSync(this.ledger.get(row.launch_id)!.runDirectory);
      this.within(parent, row.path);
      privateDirectory(row.path);
      marker(join(row.path, '.merv-workspace-owner.json'), {
        launchId: row.launch_id,
        slotId: row.slot_id,
      });
    } else {
      const repository = await this.repository();
      this.within(this.root, row.path);
      // A persistent branch's lineage records its base once; a changed record is refused
      // before any checkout is added, including the recovery of an existing path.
      const baseRef = `refs/merv/bases/${hash(row.slot_id)}`;
      let recorded = row.branch ? await this.optionalRef(repository.bare_path, baseRef) : undefined;
      if (recorded && recorded !== row.base_oid)
        throw new WorkspaceError('workspace_recorded_base_changed');
      if (!existsSync(row.path)) {
        this.safeDirectory(dirname(row.path));
        const heads = (
          await this.git([
            '--git-dir',
            repository.bare_path,
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/',
          ])
        ).split('\n');
        if (row.branch && heads.includes(`refs/heads/${row.branch}`)) {
          if (!recorded) throw new WorkspaceError('workspace_recorded_base_changed');
          await this.git([
            '--git-dir',
            repository.bare_path,
            'worktree',
            'add',
            '--',
            row.path,
            row.branch,
          ]);
        } else {
          const args = row.branch ? ['-b', row.branch] : ['--detach'];
          await this.git([
            '--git-dir',
            repository.bare_path,
            'worktree',
            'add',
            ...args,
            '--',
            row.path,
            row.base_oid,
          ]);
          // A new branch records its base before validation, so a failed validation cannot
          // leave the lineage without one.
          if (row.branch) {
            await this.git([
              '--git-dir',
              repository.bare_path,
              'update-ref',
              baseRef,
              row.base_oid,
            ]);
            recorded = row.base_oid;
          }
        }
      }
      await this.validateCheckout(row);
      if (row.branch && !recorded)
        await this.git(['--git-dir', repository.bare_path, 'update-ref', baseRef, row.base_oid]);
    }
    const snapshot = await this.snapshot(row);
    await this.armFence(row);
    this.db
      .prepare("UPDATE runner_workspaces SET status='ready',attachment_json=? WHERE launch_id=?")
      .run(snapshot ? JSON.stringify(snapshot) : null, row.launch_id);
  }
  private async validateCheckout(row: WorkspaceRow): Promise<void> {
    const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
    if (policy.mode === 'none') {
      this.within(
        this.assignmentWorkspaceDirectory ??
          realpathSync(this.ledger.get(row.launch_id)!.runDirectory),
        row.path,
      );
      const file = join(row.path, '.merv-workspace-owner.json');
      if (
        !existsSync(file) ||
        lstatSync(file).isSymbolicLink() ||
        readFileSync(file, 'utf8') !==
          JSON.stringify({ launchId: row.launch_id, slotId: row.slot_id })
      )
        throw new WorkspaceError('workspace_foreign_checkout');
      return;
    }
    const repository = await this.repository();
    if (repository.repository_id !== row.repository_id)
      throw new WorkspaceError('workspace_repository_changed');
    this.within(this.root, row.path);
    const admin = await this.adminDirectory(row, repository);
    const branch = (
      await this.git(
        ['--git-dir', admin, '--work-tree', row.path, 'symbolic-ref', '-q', 'HEAD'],
        60000,
        true,
      )
    ).trim();
    if ((row.branch ? `refs/heads/${row.branch}` : '') !== branch)
      throw new WorkspaceError('workspace_branch_changed');
  }
  private async adminDirectory(row: WorkspaceRow, repository: RepositoryRow): Promise<string> {
    const dot = join(row.path, '.git');
    this.within(this.root, dot);
    if (!existsSync(dot) || !lstatSync(dot).isFile())
      throw new WorkspaceError('workspace_foreign_checkout');
    const match = /^gitdir: (.+)\n?$/.exec(readFileSync(dot, 'utf8'));
    if (!match) throw new WorkspaceError('workspace_foreign_checkout');
    const admin = resolve(row.path, match[1]);
    this.within(join(repository.bare_path, 'worktrees'), admin);
    const common = join(admin, 'commondir'),
      gitdir = join(admin, 'gitdir');
    this.within(this.root, common);
    this.within(this.root, gitdir);
    if (
      resolve(admin, readFileSync(common, 'utf8').trim()) !== repository.bare_path ||
      resolve(readFileSync(gitdir, 'utf8').trim()) !== dot
    )
      throw new WorkspaceError('workspace_foreign_checkout');
    return admin;
  }
  private async checkoutGit(
    row: WorkspaceRow,
    args: string[],
    env?: Record<string, string>,
    input?: string,
  ): Promise<string> {
    const repository = await this.repository();
    const admin = await this.adminDirectory(row, repository);
    return this.git(
      ['--git-dir', admin, '--work-tree', row.path, ...args],
      60000,
      false,
      env,
      input,
    );
  }
  private async snapshot(row: WorkspaceRow): Promise<SessionWorkspace | undefined> {
    const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
    if (policy.mode === 'none') return undefined;
    const head = oid(await this.checkoutGit(row, ['rev-parse', '--verify', 'HEAD^{commit}']));
    return {
      repositoryId: row.repository_id!,
      workspaceId: `workspace_${hash(row.slot_id)}`,
      mode: policy.mode,
      branch: row.branch,
      baseOid: row.base_oid,
      headOid: head,
      treeOid: oid(await this.checkoutGit(row, ['rev-parse', '--verify', `${head}^{tree}`])),
      stats: await this.stats(row, head),
    };
  }
  private async stats(row: WorkspaceRow, head: string): Promise<SessionWorkspace['stats']> {
    const repository = await this.repository();
    const git = (args: string[]) => this.git(['--git-dir', repository.bare_path, ...args]);
    const commits = Number((await git(['rev-list', '--count', `${row.base_oid}..${head}`])).trim());
    const changes = await git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-z',
      row.base_oid,
      head,
    ]);
    let files = 0,
      insertions = 0,
      deletions = 0;
    for (const entry of changes.split('\0').filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
      if (!match) continue;
      files++;
      insertions += match[1] === '-' ? 0 : Number(match[1]);
      deletions += match[2] === '-' ? 0 : Number(match[2]);
    }
    if ([commits, files, insertions, deletions].some((n) => !Number.isSafeInteger(n) || n < 0))
      throw new WorkspaceError('workspace_invalid_stats');
    return { commitCount: commits, filesChanged: files, insertions, deletions };
  }
  private async rev(bare: string, ref: string): Promise<string> {
    return oid(
      await this.git([
        '--git-dir',
        bare,
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${ref}^{commit}`,
      ]),
    );
  }
  private async git(
    args: string[],
    timeout = 60000,
    allowOne = false,
    env?: Record<string, string>,
    input?: string,
  ): Promise<string> {
    const options = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'credential.helper=',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.file.allow=always',
      '-c',
      'submodule.recurse=false',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
    ];
    try {
      const operation = execute('git', [...options, ...args], {
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: this.emptyTemplate,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_ATTR_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/usr/bin/false',
          GIT_SSH_COMMAND: '/usr/bin/false',
          LC_ALL: 'C',
          LANG: 'C',
          ...env,
        },
      });
      operation.child.stdin?.end(input);
      const result = await operation;
      return result.stdout;
    } catch (error) {
      if (allowOne && (error as { code?: number }).code === 1) return '';
      throw new WorkspaceError(
        (error as { killed?: boolean }).killed ? 'workspace_git_timeout' : 'workspace_git_failed',
      );
    }
  }
}
