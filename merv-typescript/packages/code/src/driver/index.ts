import { existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  codeCommitCommandSchema,
  effectiveWorkspace,
  CODE_DRIVER,
  type CodeCommitCommand,
  type CodeCommitReceipt,
  type SessionWorkspace,
  type WorkspaceDriver,
  type WorkspaceDriverFactory,
  type WorkspaceHandle,
  type WorkspaceLaunch,
  type WorkspaceSession,
} from '@merv/contracts';
import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import { codeWorkspaceManifestSchema } from '../store/protocol.js';
import { hash, oid, pathStat, WorkspaceError } from './git.js';
import { UploadRefused, terminal, deferral } from './core.js';
import { DriverTransfer } from './transfer.js';

export { WorkspaceError } from './git.js';
export type { CodeDriverOptions } from './core.js';

/**
 * The workspace driver for projects whose history lives in Code's repository on the server.
 * A machine keeps only a cache: before a session it downloads exactly the commit Code names,
 * every commit and the final capture are uploaded as bundles, and the local branch moves only
 * after Code has acknowledged the upload. Nothing here knows a remote, a central ref or a
 * GitHub credential, and the runner's own repository and ledger tables are never touched.
 */
export class CodeWorkspaceDriver extends DriverTransfer implements WorkspaceDriver {
  get(launchId: string): WorkspaceHandle | undefined {
    const row = this.row(launchId);
    if (!row) return undefined;
    const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
    const encoded = row.result_json ?? row.attachment_json;
    return {
      path: row.path,
      ...(encoded ? { snapshot: JSON.parse(encoded) as SessionWorkspace } : {}),
      retain: policy.mode === 'none' || policy.retain || !!this.workKey,
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
    return this.run(this.workKey ?? launch.id, async () => {
      if (launch.sessionId !== session.id) throw new WorkspaceError('workspace_session_mismatch');
      if (this.workKey && this.workKey !== session.instanceId)
        throw new WorkspaceError('workspace_session_mismatch');
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
      // A project's cache is made by one launch at a time.
      const cache = await this.run('', () => this.cache(manifest));
      await this.fetch(cache, manifest, control);
      const path = this.assignmentRoot
        ? join(this.assignmentRoot, hash(this.workKey!))
        : manifest.mode === 'write'
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
      await this.checkout(cache, row, !!existing);
      const snapshot = await this.snapshot(row, manifest.head);
      if (this.workKey && !row.read_only) {
        const preserved = this.preservedPath();
        const info = pathStat(preserved);
        if (info?.isSymbolicLink() || (info && !info.isDirectory()))
          throw new WorkspaceError('workspace_foreign_checkout');
        if (info) {
          const previous = this.priorWriter(row);
          if (previous && this.priorCaptureRefused(previous)) {
            const rejected = this.rejectedPath(previous);
            const saved = pathStat(rejected);
            if (saved && (!saved.isDirectory() || saved.isSymbolicLink()))
              throw new WorkspaceError('workspace_foreign_checkout');
            if (saved) rmSync(preserved, { recursive: true, force: true });
            else renameSync(preserved, rejected);
          } else rmSync(preserved, { recursive: true, force: true });
        }
      }
      this.db
        .prepare(
          "UPDATE code_v2_workspaces SET status='ready',attachment_json=? WHERE launch_id=? AND status='preparing'",
        )
        .run(JSON.stringify(snapshot), launch.id);
      return this.get(launch.id)!;
    });
  }

  /**
   * Commit the checkout deterministically, but keep the commit aside until Code has admitted
   * it: HEAD moves only on that acknowledgement, so the local branch never runs ahead of the
   * one everybody else resumes from.
   */
  checkpointCommit(launch: WorkspaceLaunch, input: CodeCommitCommand): Promise<CodeCommitReceipt> {
    const parsed = codeCommitCommandSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new WorkspaceError('workspace_invalid_command'));
    const command = parsed.data;
    return this.run(this.workKey ?? launch.id, async () => {
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
        // Before there is a commit, a failure is this checkout's and ends the command. Once
        // Code is involved only a refusal that time cannot change ends it; everything else is
        // tried again with the same journal.
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

  /**
   * The head a periodic checkpoint commits on: Code's head, while the live checkout holds changes
   * on it that Code has not admitted; else null (nothing changed, or the agent moved HEAD on its
   * own, which only its own code.commit may hand over). Read without taking Git's locks, so the
   * agent's own Git is never kept waiting.
   */
  checkpointHead(launchId: string): Promise<string | null> {
    return this.run(this.workKey ?? launchId, async () => {
      const row = this.row(launchId);
      if (!row || row.read_only || row.status !== 'ready' || !row.attachment_json) return null;
      const env = { GIT_OPTIONAL_LOCKS: '0' };
      const head = oid(
        await this.git.ok(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: row.path, env }),
      );
      if (head !== row.head_oid) return null;
      const changes = await this.git.ok(['status', '--porcelain', '--untracked-files=all'], {
        cwd: row.path,
        env,
      });
      return changes.toString().trim() ? head : null;
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
    return this.run(this.workKey ?? launch.id, async () => {
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
      // A reviewer's session is reported as it was attached, whatever it left in the checkout:
      // what was judged is what is inherited, and the next prepare restores the checkout.
      const head = row.read_only
        ? (JSON.parse(row.attachment_json!) as SessionWorkspace).headOid
        : await this.finalize(row);
      row = this.row(launch.id)!;
      const snapshot = await this.snapshot(row, head);
      this.db
        .prepare("UPDATE code_v2_workspaces SET status='captured',result_json=? WHERE launch_id=?")
        .run(JSON.stringify(snapshot), launch.id);
      return snapshot;
    });
  }

  close(launch: WorkspaceLaunch): Promise<void> {
    return this.run(this.workKey ?? launch.id, async () => {
      const row = this.row(launch.id);
      if (!row || row.status === 'closed') return;
      if (!['captured', 'closing'].includes(row.status))
        throw new WorkspaceError('workspace_capture_required');
      this.db
        .prepare("UPDATE code_v2_workspaces SET status='closing' WHERE launch_id=?")
        .run(launch.id);
      if (this.workKey && row.read_only) {
        this.assignmentPath(row.path);
        const preserved = this.preservedPath();
        const info = pathStat(preserved);
        const writer = this.priorWriter(row);
        if (writer && this.priorCaptureRefused(writer)) {
          // Keep the refused writer private. Replace the disposable review tree with
          // Code's frozen head so a later scratch phase cannot inherit review edits.
          if (!info || !info.isDirectory() || info.isSymbolicLink())
            throw new WorkspaceError('workspace_foreign_checkout');
          await this.checkoutShared(this.repository(row.project_ref)!, row, true);
        } else {
          const recorded = this.db
            .prepare('SELECT device,inode FROM code_v2_review_restores WHERE launch_id=?')
            .get(row.launch_id) as { device: number; inode: number } | undefined;
          if (info) {
            if (
              !info.isDirectory() ||
              info.isSymbolicLink() ||
              (recorded && (recorded.device !== info.dev || recorded.inode !== info.ino))
            )
              throw new WorkspaceError('workspace_foreign_checkout');
            if (!recorded)
              this.db
                .prepare(
                  'INSERT INTO code_v2_review_restores(launch_id,device,inode) VALUES(?,?,?)',
                )
                .run(row.launch_id, info.dev, info.ino);
            if (pathStat(row.path)) rmSync(row.path, { recursive: true, force: true });
            renameSync(preserved, row.path);
          } else if (recorded) {
            const visible = pathStat(row.path);
            if (
              !visible ||
              !visible.isDirectory() ||
              visible.isSymbolicLink() ||
              visible.dev !== recorded.device ||
              visible.ino !== recorded.inode
            )
              throw new WorkspaceError('workspace_foreign_checkout');
          } else if (writer) throw new WorkspaceError('workspace_foreign_checkout');
          else {
            // A replacement VM may start with a review. No writer sidecar exists;
            // discard that reviewer's files and rebuild from the frozen Code head.
            if (pathStat(row.path)) rmSync(row.path, { recursive: true, force: true });
            await this.checkoutShared(this.repository(row.project_ref)!, row, true);
            const clean = lstatSync(row.path);
            this.db
              .prepare('INSERT INTO code_v2_review_restores(launch_id,device,inode) VALUES(?,?,?)')
              .run(row.launch_id, clean.dev, clean.ino);
          }
        }
      }
      const policy = JSON.parse(row.policy_json) as WorkflowWorkspacePolicy;
      const cache = this.repository(row.project_ref);
      if (
        !row.canceled &&
        policy.mode !== 'none' &&
        !policy.retain &&
        !this.workKey &&
        existsSync(row.path)
      )
        await this.git.ok(['--git-dir', cache!, 'worktree', 'remove', '--force', row.path]);
      for (const transfer of this.db
        .prepare('SELECT bundle_path,index_path FROM code_v2_transfers WHERE launch_id=?')
        .all(launch.id) as { bundle_path: string | null; index_path: string | null }[])
        for (const file of [transfer.bundle_path, transfer.index_path])
          if (file) rmSync(file, { force: true });
      if (cache && !this.assignmentRoot)
        rmSync(join(dirname(cache), 'operations', hash(launch.id).slice(0, 32)), {
          recursive: true,
          force: true,
        });
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
}

/** What a composition hands the runner. Only Code knows that this driver needs Git at all. */
export const codeWorkspaceDriver: WorkspaceDriverFactory = {
  name: CODE_DRIVER,
  create(host, transport) {
    if (!existsSync('/usr/bin/git')) throw new WorkspaceError('workspace_git_missing');
    return new CodeWorkspaceDriver(host, transport);
  },
};
