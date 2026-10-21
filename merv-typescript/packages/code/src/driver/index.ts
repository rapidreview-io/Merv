import { existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  effectiveWorkspace,
  NATIVE_CODE_DRIVER as CODE_DRIVER,
  type SessionWorkspace,
  type WorkspaceDriver,
  type WorkspaceDriverFactory,
  type WorkspaceHandle,
  type WorkspaceLaunch,
  type WorkspaceSession,
} from '@merv/contracts';
import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import { codeWorkspaceManifestSchema } from '../store/protocol.js';
import { pathStat } from '@merv/contracts/private-directory';
import { hash, WorkspaceError } from './git.js';
import { deferral } from './core.js';
import { DriverTransfer } from './transfer.js';

export { WorkspaceError } from './git.js';

/**
 * The workspace driver for projects whose history lives in Code's repository on the server.
 * Native Git fetch/push carries objects; narrow authenticated controls freeze submissions
 * and acknowledge planned shutdown captures. Ordinary sessions retain local uncommitted work.
 */
export class CodeWorkspaceDriver extends DriverTransfer implements WorkspaceDriver {
  async shutdownCapture() {
    const rows = this.db
      .prepare(
        `SELECT w.* FROM code_v2_workspaces w WHERE read_only=0 AND attachment_json IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM code_v2_workspaces newer WHERE newer.project_ref=w.project_ref
      AND newer.unit_id=w.unit_id AND newer.read_only=0 AND newer.attachment_json IS NOT NULL AND newer.rowid>w.rowid)`,
      )
      .all() as unknown as import('./core.js').WorkspaceRow[];
    const receipts = [];
    for (const row of rows)
      receipts.push(await this.run(this.workKey ?? row.launch_id, () => this.captureShutdown(row)));
    return receipts;
  }
  agentGit(launchId: string) {
    const row = this.row(launchId);
    if (!row) throw new WorkspaceError('workspace_missing');
    const access = this.access(launchId);
    const attached = row.attachment_json
      ? (JSON.parse(row.attachment_json) as SessionWorkspace)
      : undefined;
    return {
      url: access.url,
      token: access.agentToken,
      branch: row.branch,
      startingCommit: attached?.headOid ?? row.head_oid,
    };
  }
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
      if (manifest.submission) {
        const submitted = manifest.submission;
        const saved = this.submission(row.launch_id);
        if (saved && JSON.stringify(saved) !== JSON.stringify(submitted))
          throw new WorkspaceError('workspace_submission_changed');
        this.db
          .prepare(
            'INSERT OR IGNORE INTO code_git_submissions(launch_id,session_id,parent_oid,tree_oid) VALUES(?,?,?,?)',
          )
          .run(row.launch_id, submitted.sessionId, submitted.parentOid, submitted.treeOid);
        if (this.assignmentRoot) {
          // Include the non-commit tree in the independent checkout using Git's local object transfer.
          await this.git.ok(
            ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache, submitted.treeOid],
            { cwd: row.path },
          );
        }
        await this.git.ok(['read-tree', '--reset', '-u', submitted.treeOid], { cwd: row.path });
      }
      const access = this.access(row.launch_id);
      await this.git.ok(['config', 'remote.merv.url', access.url], { cwd: row.path });
      await this.git.ok(['config', 'remote.merv.fetch', '+refs/heads/*:refs/remotes/merv/*'], {
        cwd: row.path,
      });
      await this.git.ok(['config', 'user.name', 'Merv Agent'], { cwd: row.path });
      await this.git.ok(['config', 'user.email', 'agent@merv.local'], { cwd: row.path });
      if (row.branch) {
        await this.git.ok(['config', `branch.${row.branch}.remote`, 'merv'], { cwd: row.path });
        await this.git.ok(['config', `branch.${row.branch}.merge`, `refs/heads/${row.branch}`], {
          cwd: row.path,
        });
      }
      const snapshot = await this.snapshot(row, manifest.head);
      if (this.workKey && !row.read_only) {
        const preserved = this.preservedPath();
        const info = pathStat(preserved);
        if (info && !info.isDirectory()) throw new WorkspaceError('workspace_foreign_checkout');
        if (info) {
          const previous = this.prior(row, true);
          if (previous && this.refusedFinal(previous)) {
            const rejected = this.rejectedPath(previous);
            const saved = pathStat(rejected);
            if (saved && !saved.isDirectory())
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

  /** Stop a session, retain its frozen submission if requested, and preserve local dirt. */
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
        : await this.finishSession(row);
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
        const writer = this.prior(row, true);
        if (writer && this.refusedFinal(writer)) {
          // Keep the refused writer private. Replace the disposable review tree with
          // Code's frozen head so a later scratch phase cannot inherit review edits.
          if (!info?.isDirectory()) throw new WorkspaceError('workspace_foreign_checkout');
          await this.checkoutShared(this.repository(row.project_ref)!, row, true);
        } else {
          const recorded = this.db
            .prepare('SELECT device,inode FROM code_v2_review_restores WHERE launch_id=?')
            .get(row.launch_id) as { device: number; inode: number } | undefined;
          if (info) {
            if (
              !info.isDirectory() ||
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
              !visible?.isDirectory() ||
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
