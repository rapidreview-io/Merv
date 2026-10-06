import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  oidPattern,
  type CodeCommitCommand,
  type CodeCommitReceipt,
  type SessionWorkspace,
} from '@merv/contracts';

export interface DriverGitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
/** A local Git failure, named the way the runner's workspace errors are. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'WorkspaceError';
  }
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const oid = (value: string): string => {
  const result = value.trim();
  if (!oidPattern.test(result)) throw new WorkspaceError('workspace_invalid_oid');
  return result;
};
export const pathStat = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};
export const syncPath = (path: string): void => {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
/** Changed files above this size are refused at capture and commit. */
export const MAX_FILE = 50 * 1024 * 1024;
export const identity = {
  GIT_AUTHOR_NAME: 'Merv Agent Runner',
  GIT_AUTHOR_EMAIL: 'merv@localhost',
  GIT_COMMITTER_NAME: 'Merv Agent Runner',
  GIT_COMMITTER_EMAIL: 'merv@localhost',
};
/** What `commit-tree` is given for a command, so that a replay makes exactly the same commit. */
export const commitInput = (command: CodeCommitCommand) => {
  const timestamp = `${Math.floor(Date.parse(command.createdAt) / 1000)} +0000`;
  return {
    env: { ...identity, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp },
    stdin: command.message.endsWith('\n') ? command.message : `${command.message}\n`,
  };
};
/** The receipt of a command whose commit Code or the runner's repository holds. */
export const commitReceipt = (
  command: CodeCommitCommand,
  headOid: string,
  treeOid: string,
  stats: SessionWorkspace['stats'],
): CodeCommitReceipt => ({
  commandId: command.id,
  repositoryId: command.workspace.repositoryId,
  workspaceId: command.workspace.workspaceId,
  baseOid: command.workspace.baseOid,
  parentOid: command.expectedHead,
  headOid,
  treeOid,
  stats,
});
/** What a checkout changed or staged against its index, by name. */
export const changedNames = async (git: (args: string[]) => Promise<string>) =>
  new Set(
    (
      (await git(['ls-files', '--modified', '--others', '--exclude-standard', '-z'])) +
      (await git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z']))
    )
      .split('\0')
      .filter(Boolean),
  );
/** How far `head` is from `base`, read from the repository `git` runs in. */
export const diffStats = async (
  git: (args: string[]) => Promise<string>,
  base: string,
  head: string,
): Promise<SessionWorkspace['stats']> => {
  const commitCount = Number((await git(['rev-list', '--count', `${base}..${head}`])).trim());
  const changes = await git([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--numstat',
    '-z',
    base,
    head,
  ]);
  let filesChanged = 0,
    insertions = 0,
    deletions = 0;
  for (const entry of changes.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
    if (!match) continue;
    filesChanged++;
    insertions += match[1] === '-' ? 0 : Number(match[1]);
    deletions += match[2] === '-' ? 0 : Number(match[2]);
  }
  const stats = { commitCount, filesChanged, insertions, deletions };
  if (Object.values(stats).some((n) => !Number.isSafeInteger(n) || n < 0))
    throw new WorkspaceError('workspace_invalid_stats');
  return stats;
};
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
  'submodule.recurse=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'gc.auto=0',
];

/**
 * Git as the driver runs it on a machine: nothing of the machine's or the user's
 * configuration reaches it, no transport is allowed at all — history arrives and leaves as
 * bundle files — and a failure comes back as a result instead of one collapsed error.
 */
export class DriverGit {
  constructor(
    private readonly home: string,
    /** The root of assignment-owned checkouts, whose Git runs as their user through `git`. */
    private readonly assignment?: { root: string; uid: number; gid: number; git: string },
  ) {}

  run(
    args: string[],
    input: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
  ): Promise<DriverGitResult> {
    return new Promise((resolve) => {
      // Hosted checkouts become assignment-owned before the worker runs. Never run Git
      // against their mutable config, objects or hooks with the supervisor's identity.
      const user = this.assignment;
      const inAssignment =
        input.cwd &&
        user &&
        relative(user.root, input.cwd) !== '..' &&
        !relative(user.root, input.cwd).startsWith('../');
      const checkout = inAssignment ? lstatSync(input.cwd!) : undefined;
      const dot = checkout ? lstatSync(join(input.cwd!, '.git')) : undefined;
      const assignmentOwned = checkout && process.getuid?.() === 0 && checkout.uid === user!.uid;
      if (
        assignmentOwned &&
        (checkout.gid !== user!.gid || dot?.uid !== user!.uid || dot.gid !== user!.gid)
      )
        throw new WorkspaceError('workspace_foreign_checkout');
      const child = execFile(
        assignmentOwned ? user!.git : 'git',
        [...(assignmentOwned ? ['--git'] : []), ...options, ...args],
        {
          cwd: input.cwd,
          timeout: input.timeoutMs ?? 120_000,
          maxBuffer: 32 * 1024 * 1024,
          encoding: 'utf8',
          env: {
            PATH: '/usr/bin:/bin',
            HOME: this.home,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_ATTR_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '/usr/bin/false',
            GIT_SSH_COMMAND: '/usr/bin/false',
            LC_ALL: 'C',
            LANG: 'C',
            ...input.env,
          },
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout,
            stderr,
            timedOut: !!error?.killed,
          }),
      );
      child.stdin?.end(input.stdin);
    });
  }

  /** The output of a command that must succeed. */
  async ok(args: string[], input: Parameters<DriverGit['run']>[1] = {}): Promise<string> {
    const result = await this.run(args, input);
    if (result.code !== 0)
      throw new WorkspaceError(
        result.timedOut ? 'workspace_git_timeout' : 'workspace_git_failed',
        `git ${args[0]}: ${result.stderr.trim().slice(0, 400)}`,
      );
    return result.stdout;
  }
}
