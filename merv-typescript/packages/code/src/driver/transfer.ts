import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { syncPath } from '@merv/contracts/private-directory';
import { WorkspaceDeferred, type CodeCommitCommand, type CodeCommitReceipt } from '@merv/contracts';
import type { CodeStoreOperation } from '../store/protocol.js';
import { hashFile } from '../files.js';
import { MERGE_SETTINGS } from '../merge-settings.js';
import {
  changedNames,
  commitInput,
  commitReceipt,
  hash,
  identity,
  MAX_FILE,
  oid,
  WorkspaceError,
} from './git.js';
import {
  type WorkspaceRow,
  type TransferRow,
  type TransportFailure,
  driverDirectory,
  UploadRefused,
  terminal,
  uncapturable,
  CAPTURE_FAILING_MS,
  CAPTURE_GAP_MS,
  lockFiles,
} from './core.js';
import { DriverCheckout } from './checkout.js';

/** What a launch sends back: merges, commits, uploads, the final capture and settling. */
export abstract class DriverTransfer extends DriverCheckout {
  /** Journal the merge tree before materialising it, so an interrupted start repeats exactly. */
  protected async startMerge(
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
          // Both parents are frozen by Code; connecting a remote may join separate roots.
          '--allow-unrelated-histories',
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
    const stats = (await this.snapshot(row, command.expectedHead)).stats;
    const receipt = commitReceipt(command, command.expectedHead, tree, stats);
    this.db
      .prepare('UPDATE code_v2_transfers SET receipt_json=? WHERE request_id=?')
      .run(JSON.stringify(receipt), command.id);
    return receipt;
  }

  protected pendingRef(requestId: string): string {
    return `refs/merv/pending/${hash(requestId)}`;
  }

  protected async dropPending(row: WorkspaceRow, requestId: string): Promise<void> {
    const cache = this.repository(row.project_ref)!;
    // A refused commit must not ride along in the next bundle, so nothing keeps it reachable.
    await this.git.run(['--git-dir', cache, 'update-ref', '-d', this.pendingRef(requestId)]);
  }

  /** Refuse a file no repository of Code's would keep, before Git spends time on it. */
  protected async checkFiles(row: WorkspaceRow, env?: Record<string, string>): Promise<void> {
    const root = realpathSync(row.path);
    for (const name of await changedNames((args) => this.git.ok(args, { cwd: row.path, env }))) {
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
      if (stat.isFile() && stat.size > MAX_FILE)
        throw new WorkspaceError('workspace_file_too_large');
    }
  }

  protected async commit(
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
      // Once the commit is journalled it is what Code is told; a head the agent moved since
      // is rescued when the branch advances, never a reason to stop. A merge start would
      // reset the checkout over what the agent did, so it always stops.
      if ((!journal.target_oid || command.merge === 'start') && head !== command.expectedHead)
        throw new WorkspaceError('workspace_head_conflict');
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
      const directory = this.assignmentRoot
        ? join(row.path, '.git')
        : driverDirectory(
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
                { cwd: row.path, ...commitInput(command) },
              ),
            );
      await this.importAssignmentCommit(row, target);
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
    const receipt = commitReceipt(command, journal.target_oid!, journal.tree_oid!, stats);
    this.db
      .prepare(
        'UPDATE code_v2_transfers SET receipt_json=? WHERE request_id=? AND receipt_json IS NULL',
      )
      .run(JSON.stringify(receipt), command.id);
    return receipt;
  }

  /** Code acknowledged the commit: only now does the local branch move to it. */
  protected async advance(row: WorkspaceRow, journal: TransferRow): Promise<void> {
    const cache = this.repository(row.project_ref)!;
    const target = journal.target_oid!;
    const head = oid(
      await this.git.ok(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: row.path }),
    );
    if (head !== target) {
      // The agent committed while Code admitted: Code's commit is the branch now. The agent's
      // stays reachable under a rescue ref, and its files stay in the checkout for the next capture.
      if (head !== journal.expected_head)
        await this.git.ok(['update-ref', `refs/merv/rescued/${hash(journal.request_id)}`, head], {
          cwd: row.path,
        });
      await this.git.ok(['update-ref', '--stdin'], {
        cwd: row.path,
        stdin: `start\nupdate HEAD ${target} ${head}\nprepare\ncommit\n`,
      });
      if (this.assignmentRoot) {
        await this.git.ok(['read-tree', target], { cwd: row.path });
      } else if (journal.index_path && existsSync(journal.index_path)) {
        // The frozen index is the tree that was committed; the checkout's index becomes it.
        const index = (
          await this.git.ok(['rev-parse', '--path-format=absolute', '--git-path', 'index'], {
            cwd: row.path,
          })
        ).trim();
        const temporary = `${index}.merv-${randomUUID()}`;
        copyFileSync(journal.index_path, temporary);
        syncPath(temporary);
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
  protected async upload(
    row: WorkspaceRow,
    journal: TransferRow,
    request: { kind: 'checkpoint'; commandId: string; requestId: string } | { kind: 'final' },
  ): Promise<CodeStoreOperation> {
    const cache = this.repository(row.project_ref)!;
    const target = journal.target_oid!;
    if (target !== journal.expected_head && !journal.bundle_hash) {
      const transfers = driverDirectory(join(dirname(cache), 'transfers'));
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
      this.db
        .prepare(
          'UPDATE code_v2_transfers SET bundle_path=?,bundle_hash=?,bundle_bytes=? WHERE request_id=? AND bundle_hash IS NULL',
        )
        .run(file, await hashFile(file), lstatSync(file).size, journal.request_id);
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
        // Each part is read where it lies in the file; a bundle is never held whole.
        const fd = openSync(journal.bundle_path!, 'r');
        try {
          for (let offset = operation.received; offset < journal.bundle_bytes!;) {
            const part = Buffer.alloc(
              Math.min(operation.partBytes, journal.bundle_bytes! - offset),
            );
            const read = readSync(fd, part, 0, part.length, offset);
            await this.ask(() =>
              this.transport.putPart(operation.id, offset, part.subarray(0, read)),
            );
            offset += operation.partBytes;
          }
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
        } finally {
          closeSync(fd);
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
  protected async finalize(row: WorkspaceRow): Promise<string> {
    const requestId = `final:${row.session_id}`;
    let journal = this.transfer(requestId);
    if (!journal) {
      await this.settle(row);
      row = this.row(row.launch_id)!;
      let target: string,
        tree: string,
        refused: string | null = null;
      const started = Date.now();
      try {
        // The session's processes are confirmed stopped: the locks their Git left are stale. A
        // hosted checkout's own .git is the assignment's, refs and all: never follow a link out
        // of it. Another checkout shares its refs, so only its own index, HEAD and branch, which
        // no other checkout writes, are cleared.
        const dot = join(row.path, '.git');
        const locks = this.assignmentRoot
          ? lstatSync(dot).isDirectory()
            ? ['index.lock', 'HEAD.lock', 'packed-refs.lock']
                .map((name) => join(dot, name))
                .concat(lockFiles(join(dot, 'refs')))
            : []
          : await Promise.all(
              [
                'index.lock',
                'HEAD.lock',
                ...(row.branch ? [`refs/heads/${row.branch}.lock`] : []),
              ].map(async (name) =>
                (
                  await this.git.ok(['rev-parse', '--path-format=absolute', '--git-path', name], {
                    cwd: row.path,
                  })
                ).trim(),
              ),
            );
        for (const lock of locks) rmSync(lock, { force: true });
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
        await this.importAssignmentCommit(row, target);
      } catch (error) {
        // Moving a built commit into this machine's cache fails under the same bound: a machine
        // that can never import hands over as surely as a checkout that can never be captured.
        const code = (error as { code?: unknown }).code;
        const lasting = typeof code === 'string' && uncapturable.includes(code);
        if (!lasting) {
          const at = Date.now();
          const { since } = this.db
            .prepare(
              'INSERT INTO code_v2_capture_attempts (launch_id,since,last) VALUES (?,?,?) ON CONFLICT(launch_id) DO UPDATE SET since=CASE WHEN ?-last>? THEN excluded.since ELSE since END,last=excluded.last RETURNING since',
            )
            .get(row.launch_id, at, at, started, CAPTURE_GAP_MS) as { since: number };
          if (at - since < CAPTURE_FAILING_MS) throw error;
        }
        // The checkout holds something no capture may carry, and no later attempt finds it
        // different, exactly as such a refusal ends a checkpoint command; so does a checkout
        // whose capture kept failing for CAPTURE_FAILING_MS. The generation is handed over at the
        // commit Code already has instead of being asked for a capture that can never be
        // built; what the session left stays in the checkout.
        refused = lasting ? code : 'workspace_capture_failed';
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
  protected async settle(row: WorkspaceRow): Promise<void> {
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
            const stats = (await this.snapshot(row, journal.target_oid)).stats;
            const receipt = commitReceipt(command, journal.target_oid, journal.tree_oid!, stats);
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
