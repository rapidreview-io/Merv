import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lchownSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { NATIVE_CODE_DRIVER as CODE_DRIVER, type SessionWorkspace } from '@merv/contracts';
import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import type { CodeWorkspaceManifest } from '../store/protocol.js';
import { pathStat } from '@merv/contracts/private-directory';
import { diffStats, hash, oid, WorkspaceError } from './git.js';
import { type WorkspaceRow, driverDirectory, stageAssignmentBundle, DriverCore } from './core.js';

/** Where a launch's code comes from: the cache, its fetches and the checkouts. */
export abstract class DriverCheckout extends DriverCore {
  /** The project's cache repository: bare, without a remote, made from an empty template. */
  protected async cache(manifest: CodeWorkspaceManifest): Promise<string> {
    const known = this.db
      .prepare('SELECT * FROM code_v2_repositories WHERE project_ref=?')
      .get(manifest.projectRef) as
      { repository_id: string; object_format: string; path: string; status: string } | undefined;
    if (known) {
      // Objects made in another format cannot be reused, so that machine genuinely cannot
      // serve this project any more. A changed identity is a rebind, which moves no object:
      // the cache is re-keyed and rebuilt rather than bricking the machine for good. The
      // status goes first so a concurrent call cannot be handed the half-built path, and the
      // removal below is safe only because a rebind refuses while any session — read-only
      // included — holds a workspace on this project.
      if (known.object_format !== manifest.objectFormat)
        throw new WorkspaceError('workspace_repository_changed');
      if (known.repository_id !== manifest.repositoryId)
        this.db
          .prepare(
            "UPDATE code_v2_repositories SET repository_id=?,status='preparing' WHERE project_ref=?",
          )
          .run(manifest.repositoryId, manifest.projectRef);
      else if (known.status === 'ready') return known.path;
    }
    const directory = driverDirectory(join(this.root, hash(manifest.projectRef).slice(0, 32)));
    const path = join(directory, 'cache.git');
    if (!known)
      this.db
        .prepare(
          "INSERT INTO code_v2_repositories (project_ref,repository_id,object_format,path,status) VALUES (?,?,?,?,'preparing')",
        )
        .run(manifest.projectRef, manifest.repositoryId, manifest.objectFormat, path);
    rmSync(path, { recursive: true, force: true });
    // Checkouts kept here are worktrees of the repository just removed; Git cannot open them.
    rmSync(join(directory, 'checkouts'), { recursive: true, force: true });
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

  protected async has(cache: string, commit: string): Promise<boolean> {
    return (
      (await this.git.run(['--git-dir', cache, 'cat-file', '-e', `${commit}^{commit}`])).code === 0
    );
  }

  /** Native fetch negotiates history and retains the assignment's exact immutable objects. */
  protected async fetch(
    cache: string,
    manifest: CodeWorkspaceManifest,
    control: { sessionId: string; runnerId: string; hostRef: string },
  ): Promise<void> {
    const credentials = await this.credentials(control, manifest.remote);
    const env = this.gitEnvironment(credentials.url, credentials.token);
    await this.git.ok(
      [
        '--git-dir',
        cache,
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.http.allow=always',
        'fetch',
        '--no-tags',
        credentials.url,
        '+refs/heads/*:refs/remotes/merv/*',
        manifest.head,
        ...(manifest.pendingMerge ? [manifest.pendingMerge.secondParent] : []),
        ...(manifest.submission
          ? [`refs/merv/submissions/${manifest.submission.sessionId}/tree`]
          : []),
      ],
      { env },
    );
    if (!(await this.has(cache, manifest.head)))
      throw new WorkspaceError('workspace_download_failed');
    await this.know(cache, manifest.head);
    if (manifest.pendingMerge) await this.know(cache, manifest.pendingMerge.secondParent);
  }

  /** Keep an assigned commit reachable in the private cache. */
  protected async know(cache: string, commit: string): Promise<void> {
    await this.git.ok(['--git-dir', cache, 'update-ref', `refs/merv/known/${commit}`, commit]);
  }

  protected async checkout(
    cache: string,
    row: WorkspaceRow,
    retryPreparing = false,
  ): Promise<void> {
    if (this.assignmentRoot) return this.checkoutShared(cache, row, retryPreparing);
    driverDirectory(dirname(row.path));
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
    // A known writer keeps its files and index. Only an exact frozen-tree approval
    // may advance its baseline without a local agent commit.
    if (!row.branch) throw new WorkspaceError('workspace_foreign_checkout');
    const previous = this.prior(row, true);
    if (previous && !previous.read_only && !this.refusedFinal(previous)) {
      // Ordinary session ends leave both the working tree and index in place.
      // The server's head was advanced by the previous agent's own Git commits.
      const branch = (
        await this.git.ok(['symbolic-ref', '--short', 'HEAD'], { cwd: row.path })
      ).trim();
      const head = await this.resolve(row, 'HEAD^{commit}');
      if (branch === row.branch && head === row.head_oid) return;
      const submitted = this.submission(previous.launch_id);
      if (
        branch === row.branch &&
        previous.repository_id === row.repository_id &&
        submitted?.sessionId === previous.session_id &&
        submitted.parentOid === head
      ) {
        const lineage = (
          await this.git.ok(['rev-list', '--parents', '-n', '1', row.head_oid], {
            cwd: row.path,
          })
        )
          .trim()
          .split(/\s+/);
        const tree = await this.resolve(row, `${row.head_oid}^{tree}`);
        if (lineage.length === 2 && lineage[1] === head && tree === submitted.treeOid) {
          // Approval retained precisely the tree this runner froze. Adopt its baseline
          // without touching working files: later edits, deletions and untracked data stay.
          await this.git.ok(['reset', '--mixed', '--quiet', row.head_oid], { cwd: row.path });
          return;
        }
      }
      throw new WorkspaceError('workspace_continuity_conflict');
    }
    await this.git.ok(['checkout', '--quiet', '--force', '-B', row.branch, row.head_oid], {
      cwd: row.path,
    });
    await this.git.ok(['clean', '-fdq'], { cwd: row.path });
  }

  /** All hosted phases materialize Code's frozen head with independent Git metadata. */
  protected async checkoutAssignment(cache: string, row: WorkspaceRow): Promise<void> {
    this.assignmentPath(row.path);
    const dot = join(row.path, '.git');
    if (!existsSync(dot)) {
      if (existsSync(row.path)) throw new WorkspaceError('workspace_foreign_checkout');
      driverDirectory(row.path);
      const bundle = join(dirname(cache), `checkout-${hash(row.launch_id)}.bundle`);
      const pending = this.mergeMetadata(row);
      const refs = [row.head_oid, ...(pending ? [pending.secondParent] : [])].map(
        (commit) => `refs/merv/known/${commit}`,
      );
      try {
        const objectFormat = (
          await this.git.ok(['--git-dir', cache, 'rev-parse', '--show-object-format'])
        ).trim();
        await this.git.ok(['--git-dir', cache, 'bundle', 'create', bundle, ...refs]);
        await this.git.ok([
          'init',
          '--quiet',
          `--object-format=${objectFormat}`,
          `--template=${join(this.root, 'empty-template')}`,
          row.path,
        ]);
        await this.git.ok(['bundle', 'unbundle', bundle], { cwd: row.path });
      } finally {
        rmSync(bundle, { force: true });
      }
    } else if (!lstatSync(dot).isDirectory() || existsSync(join(dot, 'objects/info/alternates')))
      throw new WorkspaceError('workspace_foreign_checkout');
    await this.git.ok(
      row.branch
        ? ['checkout', '--quiet', '--force', '-B', row.branch, row.head_oid]
        : ['checkout', '--quiet', '--force', '--detach', row.head_oid],
      { cwd: row.path },
    );
    await this.git.ok(['clean', '-fdq'], { cwd: row.path });
  }

  /**
   * Within one work unit on one machine the next agent continues where the last one stopped:
   * its directory, data, environments and Git state stay as they are, nothing moved or rebuilt,
   * whenever the last agent left it at the head Code now names. A refused capture, a moved head
   * or a new machine is rebuilt from Code as before. A reviewer that
   * continues in place records the directory, so its close checks nothing replaced it.
   */
  protected async continuesInPlace(cache: string, row: WorkspaceRow): Promise<boolean> {
    const last = this.prior(row);
    if (!last || this.refusedFinal(last) || pathStat(this.preservedPath())) return false;
    const left = last.result_json
      ? (JSON.parse(last.result_json) as SessionWorkspace).headOid
      : last.head_oid;
    const visible = pathStat(row.path);
    if (left !== row.head_oid || !visible?.isDirectory() || !(await this.has(cache, row.head_oid)))
      return false;
    if (row.read_only)
      this.db
        .prepare(
          'INSERT OR IGNORE INTO code_v2_review_restores(launch_id,device,inode) VALUES(?,?,?)',
        )
        .run(row.launch_id, visible.dev, visible.ino);
    return true;
  }

  /**
   * One visible cwd per work unit. The previous writer checkout is an immutable source of
   * non-Code files while review gets a disposable copy at the same path. A preparing row is
   * the durable intent: after a crash the sidecar is authoritative and a partial visible
   * checkout is rebuilt. Git metadata always comes afresh from Code's private object cache.
   */
  protected async checkoutShared(
    cache: string,
    row: WorkspaceRow,
    retryPreparing: boolean,
  ): Promise<void> {
    this.assignmentPath(row.path);
    if (!row.read_only && (await this.continuesInPlace(cache, row))) return;
    const preserved = this.preservedPath();
    const previous = this.prior(row, true);
    const lastVisible = this.prior(row);
    // A Code phase can follow CPU-only scratch, including a new attempt after an
    // earlier Code writer. The runner vouches for the immediate closed predecessor;
    // a path found on disk alone is never enough to adopt as input.
    const preceding = this.host.previousWorkspace?.(row.launch_id);
    const scratch = preceding && !preceding.snapshot ? preceding : undefined;
    if (
      scratch &&
      (scratch.path !== row.path ||
        !['captured', 'closed'].includes(scratch.status) ||
        !scratch.retain)
    )
      throw new WorkspaceError('workspace_foreign_checkout');
    if (previous && this.refusedFinal(previous) && !row.read_only && scratch) {
      const rejected = this.rejectedPath(previous);
      const saved = pathStat(rejected);
      if (saved && !saved.isDirectory()) throw new WorkspaceError('workspace_foreign_checkout');
      const pending = pathStat(preserved);
      if (!saved && pending) {
        if (!pending.isDirectory()) throw new WorkspaceError('workspace_foreign_checkout');
        renameSync(preserved, rejected);
      }
    }
    const info = pathStat(preserved);
    if (info) {
      if ((!previous && !scratch) || !info.isDirectory())
        throw new WorkspaceError('workspace_foreign_checkout');
    } else if (existsSync(row.path)) {
      const restored = lastVisible && this.restoredReview(lastVisible, row.path);
      const preparing = retryPreparing && lstatSync(row.path).uid === process.getuid?.();
      if (!restored && !preparing) {
        // Accept only a known writer or settled scratch without foreign Git metadata.
        if (lastVisible?.read_only && !scratch)
          throw new WorkspaceError('workspace_foreign_checkout');
        if (!previous && (!scratch || pathStat(join(row.path, '.git'))))
          throw new WorkspaceError('workspace_foreign_checkout');
      }
      if (previous || scratch) {
        if (previous) {
          const dot = lstatSync(join(row.path, '.git'));
          if (!dot.isDirectory() || existsSync(join(row.path, '.git/objects/info/alternates')))
            throw new WorkspaceError('workspace_foreign_checkout');
        }
        renameSync(row.path, preserved);
      }
    }
    // Only a completed prior launch can have owned this path. A preparation interrupted
    // after the rename may have left a partial checkout; it has never run an agent.
    if (pathStat(row.path)) rmSync(row.path, { recursive: true, force: true });
    await this.checkoutAssignment(cache, row);
    if (!pathStat(preserved) || (row.read_only && previous && this.refusedFinal(previous))) return;
    const sourceHead = previous?.result_json
      ? (JSON.parse(previous!.result_json) as SessionWorkspace).headOid
      : previous?.head_oid;
    if (sourceHead && !(await this.has(cache, sourceHead)))
      throw new WorkspaceError('workspace_transfer_lost');
    // The checkout starts at Code's admitted head: whatever the last session left that Code did
    // not admit (its own commits and its edits, which its final capture carried) is not carried
    // over either. Only what Git ignores, the machine's data, is.
    const unadmitted = previous ? this.refusedFinal(previous) : null;
    const tracked = new Set<string>();
    for (const commit of [sourceHead, unadmitted])
      if (commit && (await this.has(cache, commit)))
        for (const name of (
          await this.git.ok(['--git-dir', cache, 'ls-tree', '-r', '-z', '--name-only', commit])
        )
          .split('\0')
          .filter(Boolean))
          tracked.add(name);
    const copied: string[] = [];
    cpSync(preserved, row.path, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: false,
      filter: (source, target) => {
        if (source === preserved) return true;
        const name = relative(preserved, source);
        if (name === '.git' || name.startsWith(`.git${sep}`) || tracked.has(name)) return false;
        // A hard-linked file (a uv or pip environment links its packages from a cache) or a
        // special node (a socket, a FIFO) is not carried over: it stays with the writer's
        // sidecar, and the review starts without it rather than failing on every machine retry.
        const entry = lstatSync(source);
        if (!(
          entry.isDirectory() ||
          entry.isSymbolicLink() ||
          (entry.isFile() && entry.nlink === 1)
        ))
          return false;
        const parent = realpathSync.native(dirname(target));
        if (parent !== row.path && !parent.startsWith(row.path + sep))
          throw new WorkspaceError('workspace_foreign_path');
        copied.push(target);
        return true;
      },
    });
    // The hosted launcher hands off only a checkout that is wholly the supervisor's, and refuses
    // the launch otherwise (exit 70). Node's copy keeps a file's owner, so a file the writer's
    // agent left untracked would stay the agent's: every copied node becomes the supervisor's.
    const uid = process.getuid?.(),
      gid = process.getgid?.();
    if (uid !== undefined && gid !== undefined)
      for (const target of copied) {
        const info = pathStat(target);
        if (info && info.uid !== uid) lchownSync(target, uid, gid);
      }
  }

  /** Import only this checkout's immutable objects, never its mutable Git configuration. */
  protected async importAssignmentCommit(row: WorkspaceRow, commit: string): Promise<void> {
    if (!this.assignmentRoot) return;
    this.assignmentPath(row.path);
    const cache = this.repository(row.project_ref)!;
    if ((await this.git.run(['--git-dir', cache, 'cat-file', '-e', commit])).code === 0) return;
    const prefix = join(row.path, '.git', `merv-export-${randomUUID()}`);
    const staged = join(
      driverDirectory(join(dirname(cache), 'transfers')),
      `import-${randomUUID()}.pack`,
    );
    let pack: string | undefined;
    try {
      const hash = oid(
        await this.git.ok(['pack-objects', '--revs', prefix], {
          cwd: row.path,
          stdin: `${commit}\n`,
        }),
      );
      pack = `${prefix}-${hash}`;
      stageAssignmentBundle(`${pack}.pack`, staged, this.host.assignmentUser?.uid);
      await this.git.ok(['--git-dir', cache, 'index-pack', '--stdin', '--fix-thin'], {
        stdinFile: staged,
      });
      if ((await this.git.run(['--git-dir', cache, 'cat-file', '-e', commit])).code !== 0)
        throw new WorkspaceError('workspace_transfer_lost');
    } finally {
      if (pack)
        for (const extension of ['.pack', '.idx', '.rev'])
          rmSync(pack + extension, { force: true });
      rmSync(staged, { force: true });
    }
  }

  protected async snapshot(row: WorkspaceRow, head: string): Promise<SessionWorkspace> {
    const policy = JSON.parse(row.policy_json) as Exclude<
      WorkflowWorkspacePolicy,
      { mode: 'none' }
    >;
    const cache = this.repository(row.project_ref)!;
    const git = (args: string[]) => this.git.ok(['--git-dir', cache, ...args]);
    const pending = this.mergeMetadata(row);
    const submission = this.submission(row.launch_id);
    return {
      repositoryId: row.repository_id,
      workspaceId: `workspace_${hash(`${CODE_DRIVER}:${row.project_ref}:${row.unit_id}:${row.read_only ? row.launch_id : 'work'}`)}`,
      mode: policy.mode,
      branch: row.branch,
      baseOid: row.base_oid,
      headOid: head,
      treeOid: submission?.treeOid ?? oid(await git(['rev-parse', '--verify', `${head}^{tree}`])),
      ...(submission ? { submission } : {}),
      ...(pending ? { pendingMerge: { ...pending, checkpoint: head } } : {}),
      stats: await diffStats(git, row.base_oid, head, submission?.treeOid),
    };
  }

  protected mergeMetadata(row: WorkspaceRow): SessionWorkspace['pendingMerge'] {
    return row.pending_merge ? JSON.parse(row.pending_merge) : undefined;
  }
}
