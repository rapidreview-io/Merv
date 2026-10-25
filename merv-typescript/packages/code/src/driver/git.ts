import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { oidPattern, sha256Hex, type SessionWorkspace } from '@merv/contracts';

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
export const hash = sha256Hex;
export const oid = (value: string): string => {
  const result = value.trim();
  if (!oidPattern.test(result)) throw new WorkspaceError('workspace_invalid_oid');
  return result;
};
/** Changed files above this size are refused at capture and commit. */
export const MAX_FILE = 50 * 1024 * 1024;
export const identity = {
  GIT_AUTHOR_NAME: 'Merv Agent Runner',
  GIT_AUTHOR_EMAIL: 'merv@localhost',
  GIT_COMMITTER_NAME: 'Merv Agent Runner',
  GIT_COMMITTER_EMAIL: 'merv@localhost',
};
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
  tree = head,
): Promise<SessionWorkspace['stats']> => {
  const commitCount = Number((await git(['rev-list', '--count', `${base}..${head}`])).trim());
  const changes = await git([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--numstat',
    '-z',
    base,
    tree,
  ]);
  let filesChanged = 0,
    insertions = 0,
    deletions = 0;
  const entries = changes.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(entries[i]);
    if (!match) continue;
    // Renames have an empty name here, then separate old and new pathname fields.
    if (entries[i] === match[0]) i += 2;
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
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'credential.helper=',
  'protocol.allow=never',
  'submodule.recurse=false',
  'core.attributesFile=/dev/null',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'gc.auto=0',
].flatMap((setting) => ['-c', setting]);

/** Stop Git's transport and pack helpers as well as the direct child. */
function terminate(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group may already have exited, or group signals may be unavailable.
    }
  }
  child.kill('SIGKILL');
}

/** Report only the subcommand, never paths, remote URLs or configuration values. */
function commandName(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    if (
      ['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(argument)
    ) {
      i++;
      continue;
    }
    if (!argument.startsWith('-')) return /^[a-z][a-z-]*$/.test(argument) ? argument : 'command';
  }
  return 'command';
}

/**
 * Git as the driver runs it on a machine: nothing of the machine's or the user's
 * configuration reaches it. Native fetch and push explicitly enable their transport;
 * other calls cannot access remotes. Failures return their exit status and diagnostic text.
 */
export class DriverGit {
  constructor(
    private readonly home: string,
    /** The root of assignment-owned checkouts, whose Git runs as their user through `git`. */
    private readonly assignment?: { root: string; uid: number; gid: number; git: string },
  ) {}

  run(
    args: string[],
    input: {
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      stdinFile?: string;
      timeoutMs?: number;
    } = {},
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
      let timedOut = false;
      let failed = false;
      const child = spawn(
        assignmentOwned ? user!.git : 'git',
        [...(assignmentOwned ? ['--git'] : []), ...options, ...args],
        {
          cwd: input.cwd,
          detached: process.platform !== 'win32',
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
      );
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      const collect = (stream: NodeJS.ReadableStream, chunks: Buffer[]) => {
        let bytes = 0;
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) {
            failed = true;
            terminate(child);
          } else chunks.push(chunk);
        });
      };
      collect(child.stdout, stdout);
      collect(child.stderr, stderr);
      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, input.timeoutMs ?? 120_000);
      child.once('error', () => {
        failed = true;
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({
          code: failed || timedOut ? code || 1 : (code ?? 1),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
        });
      });
      child.stdin.on('error', () => {});
      if (input.stdinFile) {
        const stream = createReadStream(input.stdinFile);
        stream.on('error', () => {
          failed = true;
          terminate(child);
        });
        child.on('close', () => stream.destroy());
        child.stdin?.on('error', () => stream.destroy());
        stream.pipe(child.stdin!);
      } else child.stdin?.end(input.stdin);
    });
  }

  /** The output of a command that must succeed. */
  async ok(args: string[], input: Parameters<DriverGit['run']>[1] = {}): Promise<string> {
    const result = await this.run(args, input);
    if (result.code !== 0)
      throw new WorkspaceError(
        result.timedOut ? 'workspace_git_timeout' : 'workspace_git_failed',
        `git ${commandName(args)}: ${result.stderr.trim().slice(0, 400)}`,
      );
    return result.stdout;
  }
}
