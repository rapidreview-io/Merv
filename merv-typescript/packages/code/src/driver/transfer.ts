import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { CodeStoreOperation } from '../store/protocol.js';
import { changedNames, hash, identity, MAX_FILE, oid, WorkspaceError } from './git.js';
import { type WorkspaceRow, type TransferRow, driverDirectory } from './core.js';
import { DriverCheckout } from './checkout.js';

/** Native Git transfer, immutable submission retention and planned shutdown capture. */
export abstract class DriverTransfer extends DriverCheckout {
  protected pendingRef(requestId: string): string {
    return `refs/merv/pending/${hash(requestId)}`;
  }

  /** Refuse a file no repository of Code's would keep, before Git spends time on it. */
  protected async checkFiles(row: WorkspaceRow, env?: Record<string, string>): Promise<void> {
    const root = realpathSync.native(row.path);
    for (const name of await changedNames((args) => this.git.ok(args, { cwd: row.path, env }))) {
      const file = resolve(root, name);
      // A tracked final-component symlink is Git data. Never traverse a symlink parent.
      const parent = existsSync(dirname(file)) ? realpathSync.native(dirname(file)) : dirname(file);
      if (parent !== root && !parent.startsWith(root + sep))
        throw new WorkspaceError('workspace_foreign_path');
      let stat;
      try {
        stat = lstatSync(file);
      } catch {
        continue;
      }
      if (stat.isFile() && stat.size > MAX_FILE)
        throw new WorkspaceError('workspace_file_too_large');
    }
  }

  /**
   * Fill a commit's fresh index with the checkout's own entries, which are only read, so that
   * what is staged is committed as `git commit` would: a path a merge start materialised, or
   * one the agent force-added, stays though .gitignore names it. `add -A` then adds the rest.
   * An index Git cannot read or copy starts from the expected head instead.
   */
  protected async seedIndex(
    row: WorkspaceRow,
    expectedHead: string,
    env: Record<string, string>,
  ): Promise<void> {
    const cwd = row.path;
    // The index is fresh, so the copy creates it; a copy that fails leaves none behind.
    const staged = await this.git.run(['ls-files', '--stage', '-z'], { cwd });
    const copy = ['update-index', '-z', '--index-info'];
    const copied =
      staged.code === 0 &&
      (!staged.stdout || (await this.git.run(copy, { cwd, env, stdin: staged.stdout })).code === 0);
    if (!copied) await this.git.ok(['read-tree', expectedHead], { cwd, env });
  }

  protected async upload(row: WorkspaceRow, journal: TransferRow): Promise<CodeStoreOperation> {
    const cache = this.repository(row.project_ref)!;
    const access = this.access(row.launch_id);
    if (!row.branch) throw new WorkspaceError('workspace_read_only');
    const archive = journal.command_json
      ? (JSON.parse(journal.command_json).archive as
          { ref: string; baseHead: string; generation: number } | undefined)
      : undefined;
    await this.git.ok(
      [
        '--git-dir',
        cache,
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.http.allow=always',
        'push',
        '--porcelain',
        access.url,
        `${journal.target_oid}:${archive?.ref ?? `refs/heads/${row.branch}`}`,
      ],
      { env: this.gitEnvironment(access.url, access.token) },
    );
    const result = (await this.ask(() =>
      this.transport.call('pushed', {
        sessionId: row.session_id,
        runnerId: row.runner_id,
        hostRef: row.launch_id,
        unitId: row.unit_id,
        generation: archive?.generation ?? row.generation,
        ...(archive ? { archiveRef: archive.ref } : {}),
        leaseId: row.session_id,
        expectedHead: archive?.baseHead ?? journal.expected_head,
        proposedHead: journal.target_oid,
        treeOid: journal.tree_oid,
        kind: 'final',
      }),
    )) as { operation: CodeStoreOperation };
    this.db
      .prepare('UPDATE code_v2_transfers SET operation_id=? WHERE request_id=?')
      .run(result.operation.id, journal.request_id);
    return result.operation;
  }

  /** Stop is already proven by the supervisor. Retain commits the agent made, and
   * freeze an uncommitted tree only when a submission was explicitly requested. */
  protected async finishSession(row: WorkspaceRow): Promise<string> {
    if (!this.host.terminal(row.launch_id))
      throw new WorkspaceError('workspace_process_stop_unconfirmed');
    const control = { sessionId: row.session_id, runnerId: row.runner_id, hostRef: row.launch_id };
    const status = (await this.ask(() => this.transport.call('submission-status', control))) as {
      requested: boolean;
      head: string;
      cleanup?: boolean;
      frozen?: boolean;
      writerClosed?: boolean;
    };
    let submissionOnly = false;
    if (!status.frozen && (!status.writerClosed || status.requested)) {
      const granted = (await this.ask(() =>
        this.transport.call('capture-credential', { ...control, stopped: true }),
      )) as { url: string; token: string; submissionOnly?: true };
      submissionOnly = granted.submissionOnly === true;
      const access = this.access(row.launch_id);
      if (
        this.transport.remoteUrl(granted.url) !== access.url ||
        !/^mg_[A-Za-z0-9_-]{43}$/.test(granted.token)
      )
        throw new WorkspaceError('workspace_invalid_git_access');
      this.db
        .prepare('UPDATE code_git_access SET token=? WHERE launch_id=?')
        .run(granted.token, row.launch_id);
    }
    const branch = (
      await this.git.ok(['symbolic-ref', '--short', 'HEAD'], { cwd: row.path })
    ).trim();
    if (branch !== row.branch) throw new WorkspaceError('workspace_branch_changed');
    const parent = await this.resolve(row, 'HEAD^{commit}');
    await this.importAssignmentCommit(row, parent);
    const access = this.access(row.launch_id);
    const cache = this.repository(row.project_ref)!;
    const push = async (refs: string[]) =>
      this.git.ok(
        [
          '--git-dir',
          cache,
          '-c',
          'protocol.https.allow=always',
          '-c',
          'protocol.http.allow=always',
          'push',
          '--atomic',
          '--porcelain',
          access.url,
          ...refs,
        ],
        { env: this.gitEnvironment(access.url, access.token) },
      );
    if (status.requested) {
      let submitted = this.submission(row.launch_id);
      if (status.frozen && !submitted) throw new WorkspaceError('workspace_submission_lost');
      if (!submitted) {
        const index = this.assignmentRoot
          ? join(row.path, '.git', `index-${randomUUID()}`)
          : join(driverDirectory(join(dirname(cache), 'indices')), `index-${randomUUID()}`);
        const env = { GIT_INDEX_FILE: index };
        try {
          await this.seedIndex(row, parent, env);
          await this.checkFiles(row, env);
          await this.git.ok(['add', '-A', '--', '.'], { cwd: row.path, env });
          const tree = oid(await this.git.ok(['write-tree'], { cwd: row.path, env }));
          await this.importAssignmentCommit(row, tree);
          this.db
            .prepare(
              'INSERT INTO code_git_submissions(launch_id,session_id,parent_oid,tree_oid) VALUES(?,?,?,?)',
            )
            .run(row.launch_id, row.session_id, parent, tree);
          submitted = this.submission(row.launch_id)!;
        } finally {
          rmSync(index, { force: true });
        }
      }
      if (submitted.parentOid !== parent) throw new WorkspaceError('workspace_submission_changed');
      if (!status.frozen)
        await push([
          ...(submissionOnly ? [] : [`${parent}:refs/heads/${row.branch}`]),
          `${parent}:refs/merv/submissions/${row.session_id}/parent`,
          `${submitted.treeOid}:refs/merv/submissions/${row.session_id}/tree`,
        ]);
      await this.ask(() =>
        this.transport.call('submissions', {
          ...control,
          generation: row.generation,
          leaseId: row.session_id,
          parentOid: parent,
          treeOid: submitted.treeOid,
          stopped: true,
        }),
      );
    } else {
      if (parent !== status.head) await push([`${parent}:refs/heads/${row.branch}`]);
      const ended = (await this.ask(() => this.transport.call('end', control))) as { head: string };
      if (ended.head !== parent) throw new WorkspaceError('workspace_head_conflict');
    }
    await this.know(cache, parent);
    this.db
      .prepare('UPDATE code_v2_workspaces SET head_oid=? WHERE launch_id=?')
      .run(parent, row.launch_id);
    return parent;
  }

  /** Build the same validated tree for first capture and late-change detection. */
  private async shutdownTree(row: WorkspaceRow, localHead: string): Promise<string> {
    const cache = this.repository(row.project_ref)!;
    const index = this.assignmentRoot
      ? join(row.path, '.git', `index-${randomUUID()}`)
      : join(driverDirectory(join(dirname(cache), 'indices')), `index-${randomUUID()}`);
    let tree: string;
    try {
      await this.seedIndex(row, localHead, { GIT_INDEX_FILE: index });
      await this.checkFiles(row, { GIT_INDEX_FILE: index });
      await this.git.ok(['add', '-A', '--', '.'], {
        cwd: row.path,
        env: { GIT_INDEX_FILE: index },
      });
      tree = oid(
        await this.git.ok(['write-tree'], { cwd: row.path, env: { GIT_INDEX_FILE: index } }),
      );
      await this.importAssignmentCommit(row, tree);
    } finally {
      rmSync(index, { force: true });
    }
    return tree;
  }

  /** A planned VM release is the only runner-initiated automatic progress commit. */
  protected async captureShutdown(row: WorkspaceRow) {
    if (!this.host.terminal(row.launch_id) || row.status !== 'closed')
      throw new WorkspaceError('workspace_process_stop_unconfirmed');
    let requestId = `shutdown_${hash(row.launch_id).slice(0, 48)}`;
    const archivedRequest = `archive_${hash(row.launch_id).slice(0, 48)}`;
    if (this.transfer(archivedRequest)) requestId = archivedRequest;
    let journal = this.transfer(requestId);
    const cachedReceipt = journal?.receipt_json
      ? (JSON.parse(journal.receipt_json) as {
          sessionId: string;
          unitId: string;
          headOid: string;
          treeOid: string;
          operationId: string;
        })
      : undefined;
    if (cachedReceipt && JSON.parse(journal!.command_json ?? '{}').archive) return cachedReceipt;
    const control = { sessionId: row.session_id, runnerId: row.runner_id, hostRef: row.launch_id };
    let granted: {
      url: string;
      token: string;
      archive?: { ref: string; baseHead: string; generation: number };
    };
    try {
      granted = (await this.ask(() =>
        this.transport.call('shutdown-credential', { ...control, archive: true }),
      )) as typeof granted;
    } catch (error) {
      // Allocation acknowledgment revokes cleanup authority. Its existing normal receipt
      // can still be submitted to the idempotent endpoint; that endpoint alone authorizes
      // release, and rejects it if historical archival is now required.
      if (cachedReceipt) return cachedReceipt;
      throw error;
    }
    if (cachedReceipt && !granted.archive) return cachedReceipt;
    const access = this.access(row.launch_id);
    if (
      granted.archive &&
      (!/^refs\/merv\/shutdown\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(granted.archive.ref) ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(granted.archive.baseHead) ||
        !Number.isSafeInteger(granted.archive.generation))
    )
      throw new WorkspaceError('workspace_shutdown_archive_unsupported');
    if (
      this.transport.remoteUrl(granted.url) !== access.url ||
      !/^mg_[A-Za-z0-9_-]{43}$/.test(granted.token)
    )
      throw new WorkspaceError('workspace_invalid_git_access');
    this.db
      .prepare('UPDATE code_git_access SET token=? WHERE launch_id=?')
      .run(granted.token, row.launch_id);
    const cache = this.repository(row.project_ref)!;
    const env = this.gitEnvironment(access.url, granted.token);
    const network = [
      '--git-dir',
      cache,
      '-c',
      'protocol.https.allow=always',
      '-c',
      'protocol.http.allow=always',
    ];
    if (granted.archive) {
      // This recovery path cannot classify arbitrary ignored research files as disposable.
      // Normal shutdown remains compatible; archive recovery retains its host pending
      // evidence-aware export instead of uploading ignored files (which may be secrets).
      const ignored = await this.git.ok(
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        { cwd: row.path },
      );
      if (ignored) throw new WorkspaceError('workspace_shutdown_ignored_files_pending');
      if (journal?.tree_oid) {
        const currentTree = await this.shutdownTree(row, await this.resolve(row, 'HEAD^{commit}'));
        if (currentTree !== journal.tree_oid)
          throw new WorkspaceError('workspace_shutdown_tree_changed');
      }
      if (journal && !JSON.parse(journal.command_json ?? '{}').archive) {
        // A prior normal transfer may already have built its target. Retain that exact
        // tree/commit and change only the destination; never replay its working-ref push.
        const previous = journal;
        requestId = `archive_${hash(row.launch_id).slice(0, 48)}`;
        journal = this.transfer(requestId);
        if (!journal) {
          const command = {
            ...JSON.parse(previous.command_json ?? '{}'),
            archive: granted.archive,
            migratedFrom: previous.request_id,
          };
          this.db
            .prepare(
              "INSERT INTO code_v2_transfers(request_id,launch_id,kind,command_json,expected_head,tree_oid,target_oid) VALUES(?,?,'final',?,?,?,?)",
            )
            .run(
              requestId,
              row.launch_id,
              JSON.stringify(command),
              previous.expected_head,
              previous.tree_oid,
              previous.target_oid,
            );
          journal = this.transfer(requestId)!;
        }
      }
    }
    if (!journal) {
      await this.git.ok(
        [
          ...network,
          'fetch',
          '--no-tags',
          access.url,
          granted.archive?.baseHead ?? `refs/heads/${row.branch}`,
        ],
        { env },
      );
      const remoteHead = oid(await this.git.ok(['--git-dir', cache, 'rev-parse', 'FETCH_HEAD']));
      const localHead = await this.resolve(row, 'HEAD^{commit}');
      await this.importAssignmentCommit(row, localHead);
      if (
        !granted.archive &&
        localHead !== remoteHead &&
        (
          await this.git.run([
            '--git-dir',
            cache,
            'merge-base',
            '--is-ancestor',
            localHead,
            remoteHead,
          ])
        ).code !== 0
      )
        throw new WorkspaceError('workspace_shutdown_head_conflict');
      const tree = await this.shutdownTree(row, localHead);
      const remoteTree = oid(
        await this.git.ok(['--git-dir', cache, 'rev-parse', `${remoteHead}^{tree}`]),
      );
      if (!granted.archive && localHead !== remoteHead && tree !== remoteTree)
        throw new WorkspaceError('workspace_shutdown_head_conflict');
      const stamp = `${Math.floor(Date.now() / 1000)} +0000`;
      this.db
        .prepare(
          "INSERT INTO code_v2_transfers(request_id,launch_id,kind,command_json,expected_head,tree_oid) VALUES(?,?,'final',?,?,?)",
        )
        .run(
          requestId,
          row.launch_id,
          JSON.stringify({
            stamp,
            ...(granted.archive ? { archive: granted.archive } : {}),
          }),
          granted.archive ? localHead : remoteHead,
          tree,
        );
      journal = this.transfer(requestId)!;
    }
    if (!journal.target_oid) {
      const parentTree = oid(
        await this.git.ok(['--git-dir', cache, 'rev-parse', `${journal.expected_head}^{tree}`]),
      );
      const stamp = (JSON.parse(journal.command_json!) as { stamp: string }).stamp;
      const head =
        parentTree === journal.tree_oid
          ? journal.expected_head
          : oid(
              await this.git.ok(
                ['--git-dir', cache, 'commit-tree', journal.tree_oid!, '-p', journal.expected_head],
                {
                  env: { ...identity, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
                  stdin: `Merv: planned VM shutdown capture for ${row.unit_id} (${row.session_id})\n`,
                },
              ),
            );
      await this.git.ok(['--git-dir', cache, 'update-ref', this.pendingRef(requestId), head]);
      this.db
        .prepare('UPDATE code_v2_transfers SET target_oid=? WHERE request_id=?')
        .run(head, requestId);
      journal = this.transfer(requestId)!;
    }
    const operation = await this.upload(row, journal);
    if (operation.status !== 'completed' || operation.head !== journal.target_oid)
      throw new WorkspaceError('workspace_shutdown_not_durable');
    const receipt = {
      sessionId: row.session_id,
      unitId: row.unit_id,
      headOid: journal.target_oid!,
      treeOid: journal.tree_oid!,
      operationId: operation.id,
    };
    this.db
      .prepare('UPDATE code_v2_transfers SET receipt_json=?,acknowledged=1 WHERE request_id=?')
      .run(JSON.stringify(receipt), requestId);
    return receipt;
  }
}
