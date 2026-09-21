import { execFile } from 'node:child_process';

export interface DriverGitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
/** A local Git failure, named the way the runner's own workspace errors are. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'WorkspaceError';
  }
}
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
  constructor(private readonly home: string) {}

  run(
    args: string[],
    input: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
  ): Promise<DriverGitResult> {
    return new Promise((resolve) => {
      const child = execFile(
        'git',
        [...options, ...args],
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
