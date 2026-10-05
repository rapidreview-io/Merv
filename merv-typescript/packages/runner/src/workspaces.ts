import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  effectiveWorkspace,
  type CheckoutSlotClaim,
  type CheckoutSlotLedger,
  WorkspaceDeferred,
  type CodeCommitCommand,
  type CodeCommitReceipt,
  type SessionWorkspace,
  type WorkflowWorkspacePolicy,
  type WorkspaceDriver,
  type WorkspaceHandle,
  type WorkspaceLaunch,
} from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import {
  LocalLedger,
  privateDirectory,
  terminalLaunch,
  type LaunchMetadata,
  type LocalJson,
} from './ledger.js';

export type { WorkspaceHandle } from '@merv/contracts';
/** The hosted image's unprivileged assignment user, and the wrapper that runs Git as it. */
export const assignmentUser = {
  uid: 12001,
  gid: 12001,
  git: '/opt/merv/python/merv_sandboxes/runtimes/assignment.py',
};
/** The runner's own repository: a local source it never changes, and the ref work starts from. */
export type RunnerRepository = { repository: string; baseRef: string };
/** What the driver of the runner's own repository is lent: the ledger and its view of a launch. */
export interface RepositoryDriverHost {
  directory: string;
  path: string;
  runnerId: string;
  terminal(launchId: string): boolean;
  launch(launchId: string):
    | {
        sessionId: string;
        runDirectory: string;
        status: string;
        deadline: number;
        session?: Record<string, unknown>;
      }
    | undefined;
  note(launchId: string, code: string, detail: Record<string, unknown>): void;
  /** The runner's checkout-slot ledger, which the driver's checkouts are claimed in too. */
  slots: CheckoutSlots;
}
/**
 * Whatever makes checkouts of the runner's own repository for policies that name no driver.
 * Only a composition names it, as it does every other driver; the runner itself runs no Git.
 */
export interface RepositoryDriverFactory {
  create(host: RepositoryDriverHost, repository: RunnerRepository): Required<WorkspaceDriver>;
}
type WorkspaceRow = {
  launch_id: string;
  slot_id: string;
  epoch: number;
  path: string;
  policy_json: string;
  read_only: number;
  status: WorkspaceHandle['status'];
};
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
const scratch = (row: WorkspaceRow) =>
  (JSON.parse(row.policy_json) as WorkflowWorkspacePolicy).mode === 'none';

type SlotOwner = Pick<WorkspaceRow, 'launch_id' | 'slot_id' | 'epoch'>;
/**
 * The runner's checkout-slot ledger: which launch owns each checkout path, at which epoch, and
 * each launch's workspace row. Scratch directories and the repository driver's checkouts are
 * claimed and released here alike; the driver keeps only what it adds to a row.
 */
export class CheckoutSlots implements CheckoutSlotLedger {
  readonly db: DatabaseSync;
  constructor(private readonly ledger: LocalLedger) {
    this.db = new DatabaseSync(ledger.path);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;
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
    `);
  }
  /** The base a slot was first claimed at, if it was ever claimed. */
  base(slotId: string): string | undefined {
    const row = this.db
      .prepare('SELECT base_oid FROM runner_checkout_slots WHERE slot_id=?')
      .get(slotId);
    return row && String(row.base_oid);
  }
  /** `adoptable`: whether a directory at the path that no slot records may be taken over. */
  claim(claim: CheckoutSlotClaim, adoptable?: () => boolean): void {
    this.transaction(() => {
      const slot = this.db
        .prepare('SELECT * FROM runner_checkout_slots WHERE slot_id=?')
        .get(claim.slotId);
      // An owner that is running or settling frees the slot by itself, within the capture
      // bound; one whose process is uncertain needs an operator, so that refusal counts.
      if (slot?.owner_launch_id)
        throw this.ledger.get(String(slot.owner_launch_id))?.status === 'uncertain'
          ? new WorkspaceError('workspace_owned_by_another_launch')
          : new WorkspaceDeferred('checkout_busy', 'workspace_owned_by_another_launch');
      if (!slot && statIfPresent(claim.path) && !adoptable?.())
        throw new WorkspaceError('workspace_foreign_checkout');
      const epoch = Number(slot?.epoch ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO runner_checkout_slots VALUES(?,?,?,?,?,?)
          ON CONFLICT(slot_id) DO UPDATE SET owner_launch_id=excluded.owner_launch_id,epoch=excluded.epoch`,
        )
        .run(claim.slotId, claim.path, claim.branch, claim.base, claim.launchId, epoch);
      this.db
        .prepare(
          `INSERT INTO runner_workspaces(launch_id,slot_id,epoch,path,policy_json,read_only,base_oid,branch,repository_id,status)
          VALUES(?,?,?,?,?,?,?,?,?,'preparing')`,
        )
        .run(
          claim.launchId,
          claim.slotId,
          epoch,
          claim.path,
          JSON.stringify(claim.policy),
          Number(claim.readOnly),
          claim.base,
          claim.branch,
          claim.repositoryId,
        );
    });
  }
  requireOwnership(row: SlotOwner): void {
    const slot = this.db
      .prepare('SELECT owner_launch_id,epoch FROM runner_checkout_slots WHERE slot_id=?')
      .get(row.slot_id);
    if (slot?.owner_launch_id !== row.launch_id || Number(slot.epoch) !== row.epoch)
      throw new WorkspaceError('workspace_ownership_changed');
  }
  /** Frees the slot its owner still holds and closes the launch's workspace row. */
  release(row: SlotOwner): void {
    this.transaction(() => {
      this.requireOwnership(row);
      this.db
        .prepare(
          'UPDATE runner_checkout_slots SET owner_launch_id=NULL WHERE slot_id=? AND owner_launch_id=? AND epoch=?',
        )
        .run(row.slot_id, row.launch_id, row.epoch);
      this.db
        .prepare("UPDATE runner_workspaces SET status='closed' WHERE launch_id=?")
        .run(row.launch_id);
    });
  }
  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** What the repository driver is lent of a runner's ledger. */
export function ledgerHost(
  ledger: LocalLedger,
  slots = new CheckoutSlots(ledger),
): RepositoryDriverHost {
  return {
    slots,
    directory: ledger.directory,
    path: ledger.path,
    runnerId: ledger.runnerId,
    terminal: (id) => terminalLaunch(ledger.get(id)!),
    launch: (id) => {
      const record = ledger.get(id);
      return (
        record && {
          sessionId: record.sessionId,
          runDirectory: record.runDirectory,
          status: record.status,
          deadline: record.deadline,
          session: record.metadata.session as Record<string, unknown> | undefined,
        }
      );
    },
    // A launch's workspace diagnostic: in its ledger metadata, on stderr, and as lastError.
    note: (id, code, detail) => {
      const notes = ledger.get(id)?.metadata.workspaceNotes as LaunchMetadata;
      ledger.updateMetadata(id, {
        workspaceNotes: { ...notes, [code]: detail as Record<string, LocalJson> },
      });
      process.stderr.write(`merv-runner: launch ${id} ${code} ${JSON.stringify(detail)}\n`);
    },
  };
}

/**
 * The workspaces of work whose policy names no driver: a scratch directory of the launch's own,
 * or a checkout of the runner's own repository through the driver the composition supplied.
 * Both keep their rows in the same ledger tables, so a launch's row says which one it is.
 */
export class RunnerWorkspaces implements Required<WorkspaceDriver> {
  private readonly db: DatabaseSync;
  private readonly slots: CheckoutSlots;
  private readonly assignmentWorkspaceDirectory?: string;
  private readonly repository?: Required<WorkspaceDriver>;
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly ledger: LocalLedger,
    repository?: { driver: RepositoryDriverFactory; config: RunnerRepository },
    assignmentWorkspaceDirectory?: string,
    private readonly workInstanceId?: string,
    private readonly previousWorkspace?: (launchId: string) => WorkspaceHandle | undefined,
  ) {
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
    this.slots = new CheckoutSlots(ledger);
    this.db = this.slots.db;
    try {
      this.repository = repository?.driver.create(
        ledgerHost(ledger, this.slots),
        repository.config,
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  /** The repository driver when this launch's row is one of its checkouts. */
  private checkout(launchId: string): Required<WorkspaceDriver> | undefined {
    if (this.disposed) throw new WorkspaceError('workspace_manager_closed');
    const row = this.row(launchId);
    return row && !scratch(row) ? this.repository : undefined;
  }
  get(launchId: string): WorkspaceHandle | undefined {
    const row = this.row(launchId);
    if (!row) return undefined;
    if (!scratch(row)) return this.repository?.get(launchId);
    return { path: row.path, retain: true, readOnly: !!row.read_only, status: row.status };
  }
  prepare(record: WorkspaceLaunch, session: Session): Promise<WorkspaceHandle> {
    if (this.workInstanceId && session.instanceId !== this.workInstanceId)
      return Promise.reject(new WorkspaceError('workspace_work_mismatch'));
    if (effectiveWorkspace(session.execution.policy).mode !== 'none')
      return this.repository
        ? this.repository.prepare(record, session)
        : Promise.reject(new WorkspaceError('workspace_repository_required'));
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
          if (existing.status === 'ready') this.validate(existing);
          return this.get(record.id)!;
        }
        this.prepareScratch(existing);
        return this.get(record.id)!;
      }
      if (terminalLaunch(this.ledger.get(record.id)!))
        throw new WorkspaceError('workspace_launch_closed');
      const path = this.assignmentWorkspaceDirectory
        ? join(this.assignmentWorkspaceDirectory, hash(this.workInstanceId ?? record.id))
        : join(realpathSync(record.runDirectory), 'workspace');
      this.slots.claim(
        {
          launchId: record.id,
          slotId: `scratch:${this.workInstanceId ?? record.id}`,
          path,
          branch: null,
          base: '',
          policy,
          readOnly: session.execution.policy.readOnly,
          repositoryId: null,
        },
        // A retained directory the preceding phase of the same work closed is this work's own.
        () => {
          const previous = this.workInstanceId && this.previousWorkspace?.(record.id);
          return (
            !!previous && previous.path === path && previous.status === 'closed' && previous.retain
          );
        },
      );
      this.prepareScratch(this.row(record.id)!);
      return this.get(record.id)!;
    });
  }
  /** A scratch directory is the launch's own: nothing in it is captured or checked. */
  capture(record: WorkspaceLaunch): Promise<SessionWorkspace | undefined> {
    const checkout = this.checkout(record.id);
    if (checkout) return checkout.capture(record);
    return this.run(record, async (record) => {
      this.requireLaunch(record);
      if (!terminalLaunch(this.ledger.get(record.id)!))
        throw new WorkspaceError('workspace_process_stop_unconfirmed');
      const row = this.row(record.id);
      if (!row || row.status === 'captured' || row.status === 'closed') return undefined;
      this.slots.requireOwnership(row);
      this.db
        .prepare("UPDATE runner_workspaces SET status='captured' WHERE launch_id=?")
        .run(record.id);
      return undefined;
    });
  }
  close(record: WorkspaceLaunch): Promise<void> {
    const checkout = this.checkout(record.id);
    if (checkout) return checkout.close(record);
    return this.run(record, async (record) => {
      this.requireLaunch(record);
      if (!terminalLaunch(this.ledger.get(record.id)!))
        throw new WorkspaceError('workspace_process_stop_unconfirmed');
      const row = this.row(record.id);
      if (!row || row.status === 'closed') return;
      this.slots.requireOwnership(row);
      if (!['captured', 'closing'].includes(row.status))
        throw new WorkspaceError('workspace_capture_required');
      this.slots.release(row);
    });
  }
  checkpointCommit(
    record: WorkspaceLaunch,
    command: CodeCommitCommand,
  ): Promise<CodeCommitReceipt> {
    return this.repository
      ? this.repository.checkpointCommit(record, command)
      : Promise.reject(new WorkspaceError('workspace_git_attachment_required'));
  }
  pendingCommits(launchId: string): CodeCommitCommand[] {
    return this.repository?.pendingCommits(launchId) ?? [];
  }
  commitOutcome(commandId: string): { receipt: CodeCommitReceipt } | { error: string } | null {
    return this.repository?.commitOutcome(commandId) ?? null;
  }
  acknowledgeCommit(commandId: string): void {
    if (!this.repository) throw new WorkspaceError('workspace_commit_outcome_required');
    this.repository.acknowledgeCommit(commandId);
  }
  dispose(): void {
    this.disposed = true;
    this.db.close();
    this.repository?.dispose();
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
  private requireLaunch(record: WorkspaceLaunch): void {
    const actual = this.ledger.get(record.id);
    if (
      !actual ||
      actual.sessionId !== record.sessionId ||
      actual.runDirectory !== record.runDirectory
    )
      throw new WorkspaceError('workspace_unknown_launch');
  }
  private parent(row: WorkspaceRow): string {
    return (
      this.assignmentWorkspaceDirectory ??
      realpathSync(this.ledger.get(row.launch_id)!.runDirectory)
    );
  }
  private prepareScratch(row: WorkspaceRow): void {
    this.slots.requireOwnership(row);
    this.within(this.parent(row), row.path);
    const info = statIfPresent(row.path);
    // On a retained hosted machine the preceding phase handed this same leaf to the
    // unprivileged assignment user. Its parent is still supervisor-owned and fenced.
    if (
      this.workInstanceId &&
      info &&
      process.getuid?.() === 0 &&
      info.uid === assignmentUser.uid
    ) {
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.gid !== assignmentUser.gid ||
        (info.mode & 0o777) !== 0o700
      )
        throw new WorkspaceError('workspace_foreign_checkout');
    } else privateDirectory(row.path);
    this.db
      .prepare("UPDATE runner_workspaces SET status='ready' WHERE launch_id=?")
      .run(row.launch_id);
  }
  private validate(row: WorkspaceRow): void {
    this.within(this.parent(row), row.path);
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
}
