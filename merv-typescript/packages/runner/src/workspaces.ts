import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  effectiveWorkspace,
  type SessionWorkspace,
  type WorkspaceDriver,
  type WorkspaceHandle,
  type WorkspaceLaunch,
} from '@merv/contracts';
import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { privateDirectory } from '@merv/contracts/private-directory';
import { LocalLedger, terminalLaunch } from './ledger.js';

export type { WorkspaceHandle } from '@merv/contracts';
/** The hosted image's unprivileged assignment user, and the wrapper that runs Git as it. */
export const assignmentUser = {
  uid: 12001,
  gid: 12001,
  git: '/opt/merv/python/merv_sandboxes/runtimes/assignment.py',
};
/** A hosted work host's scratch root, kept for exactly this one work item across its phases. */
export type RunnerAssignment = { directory: string; workInstanceId: string };
/** One launch's claim of a scratch directory, with the workspace row it opens. */
interface ScratchClaim {
  launchId: string;
  path: string;
  policy: WorkflowWorkspacePolicy;
  readOnly: boolean;
}
/** A launch's workspace row in the runner's ledger. */
interface WorkspaceRow {
  launch_id: string;
  path: string;
  policy_json: string;
  read_only: number;
  status: WorkspaceHandle['status'];
}
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

/**
 * Each launch's workspace row in the runner's ledger. A path is occupied while a row for it is
 * not closed. Earlier runners kept checkouts of their own repository and a slot table here too,
 * so the row keeps those columns (`slot_id`, `epoch`, `base_oid`, `branch`, `repository_id`)
 * and the slot table is dropped.
 */
class WorkspaceRows {
  private readonly db: DatabaseSync;
  constructor(ledger: LocalLedger) {
    this.db = new DatabaseSync(ledger.path);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;
      DROP TABLE IF EXISTS runner_checkout_slots;
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
  /**
   * Opens the launch's row. A path another launch has not closed is refused; `adoptable` says
   * whether an existing directory no row records may be taken over.
   */
  claim(claim: ScratchClaim, adoptable: () => boolean): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          "SELECT count(*) AS known, count(*) FILTER (WHERE status<>'closed') AS open FROM runner_workspaces WHERE path=?",
        )
        .get(claim.path) as { known: number; open: number };
      if (rows.open) throw new WorkspaceError('workspace_owned_by_another_launch');
      if (!rows.known && statIfPresent(claim.path) && !adoptable())
        throw new WorkspaceError('workspace_foreign_checkout');
      this.db
        .prepare(
          `INSERT INTO runner_workspaces(launch_id,slot_id,epoch,path,policy_json,read_only,base_oid,branch,repository_id,status)
          VALUES(?,'',0,?,?,?,'',NULL,NULL,'preparing')`,
        )
        .run(claim.launchId, claim.path, JSON.stringify(claim.policy), Number(claim.readOnly));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  workspace(launchId: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM runner_workspaces WHERE launch_id=?').get(launchId) as
      WorkspaceRow | undefined;
  }
  update(launchId: string, status: WorkspaceHandle['status']): void {
    this.db
      .prepare('UPDATE runner_workspaces SET status=? WHERE launch_id=?')
      .run(status, launchId);
  }
  close(): void {
    this.db.close();
  }
}

/**
 * The workspaces of work whose policy names no driver: a scratch directory of the launch's own,
 * or on a work host the one directory its work item keeps across phases. Git checkouts are
 * always a named driver's.
 */
export class RunnerWorkspaces implements WorkspaceDriver {
  private readonly rows: WorkspaceRows;
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly ledger: LocalLedger,
    private readonly assignment?: RunnerAssignment,
    private readonly previousWorkspace?: (launchId: string) => WorkspaceHandle | undefined,
  ) {
    if (assignment) {
      const assignmentWorkspaceDirectory = assignment.directory;
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
    this.rows = new WorkspaceRows(ledger);
  }
  get(launchId: string): WorkspaceHandle | undefined {
    const row = this.row(launchId);
    if (!row) return undefined;
    return { path: row.path, retain: true, readOnly: !!row.read_only, status: row.status };
  }
  prepare(record: WorkspaceLaunch, session: Session): Promise<WorkspaceHandle> {
    if (this.assignment && session.instanceId !== this.assignment.workInstanceId)
      return Promise.reject(new WorkspaceError('workspace_work_mismatch'));
    if (effectiveWorkspace(session.execution.policy).mode !== 'none')
      return Promise.reject(new WorkspaceError('workspace_repository_required'));
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
      const path = this.assignment
        ? join(this.assignment.directory, hash(this.assignment.workInstanceId))
        : join(realpathSync(record.runDirectory), 'workspace');
      this.rows.claim(
        {
          launchId: record.id,
          path,
          policy,
          readOnly: session.execution.policy.readOnly,
        },
        // A retained directory the preceding phase of the same work closed is this work's own.
        () => {
          const previous = this.assignment && this.previousWorkspace?.(record.id);
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
    return this.run(record, async (record) => {
      this.requireLaunch(record);
      if (!terminalLaunch(this.ledger.get(record.id)!))
        throw new WorkspaceError('workspace_process_stop_unconfirmed');
      const row = this.row(record.id);
      if (!row || row.status === 'captured' || row.status === 'closed') return undefined;
      this.rows.update(record.id, 'captured');
      return undefined;
    });
  }
  close(record: WorkspaceLaunch): Promise<void> {
    return this.run(record, async (record) => {
      this.requireLaunch(record);
      if (!terminalLaunch(this.ledger.get(record.id)!))
        throw new WorkspaceError('workspace_process_stop_unconfirmed');
      const row = this.row(record.id);
      if (!row || row.status === 'closed') return;
      if (!['captured', 'closing'].includes(row.status))
        throw new WorkspaceError('workspace_capture_required');
      this.rows.update(record.id, 'closed');
    });
  }
  dispose(): void {
    this.disposed = true;
    this.rows.close();
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
    return this.rows.workspace(id);
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
    return this.assignment?.directory ?? realpathSync(this.ledger.get(row.launch_id)!.runDirectory);
  }
  private prepareScratch(row: WorkspaceRow): void {
    this.within(this.parent(row), row.path);
    const info = statIfPresent(row.path);
    // On a retained hosted machine the preceding phase handed this same leaf to the
    // unprivileged assignment user. Its parent is still supervisor-owned and fenced.
    if (this.assignment && info && process.getuid?.() === 0 && info.uid === assignmentUser.uid) {
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.gid !== assignmentUser.gid ||
        (info.mode & 0o777) !== 0o700
      )
        throw new WorkspaceError('workspace_foreign_checkout');
    } else privateDirectory(row.path);
    this.rows.update(row.launch_id, 'ready');
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
