import { MervError } from '@merv/contracts';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}
export interface GitOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the child and closed; a stream is piped as it arrives. */
  input?: Buffer | string | Readable;
  /** Receives stdout as it arrives instead of it being collected. */
  output?: (chunk: Buffer) => void;
  timeoutMs?: number;
  maxBuffer?: number;
  /** The one network protocol a child may use; every other is refused, as is every protocol without this. */
  protocol?: 'https' | 'file';
  /** Ends the child; the operation that started it is journalled and can be replayed. */
  signal?: AbortSignal;
}

const MINIMUM = [2, 38] as const;

/**
 * The only place the server starts Git. Every child sees a fixed PATH, an empty home, no
 * system or user configuration, no prompt and no transport unless the caller names one, so
 * what a child does depends on its arguments and the repository Code itself configured.
 */
export class ServerGit {
  private readonly cancellation = new AsyncLocalStorage<AbortSignal>();
  private readonly children = new Set<ChildProcess>();
  private closed = false;
  constructor(
    /** An empty directory Code owns; it is the home and the temporary directory of every child. */
    private readonly home: string,
    private readonly command = 'git',
  ) {}

  /** One client's operations inherit its cancellation without affecting other clients. */
  scoped<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const parent = this.signal;
    return this.cancellation.run(
      parent && parent !== signal ? AbortSignal.any([parent, signal]) : signal,
      operation,
    );
  }
  get signal(): AbortSignal | undefined {
    return this.cancellation.getStore();
  }

  /** The installed version, refused when it predates what admission relies on. */
  async assertGit(): Promise<string> {
    let result: GitResult;
    try {
      result = await this.run(['--version'], { timeoutMs: 10_000 });
    } catch (error) {
      throw new MervError(
        'code_git_unsupported',
        `Code keeps repositories and needs Git ${MINIMUM.join('.')} or newer on the server, and could not run it: ${error instanceof Error ? error.message : 'unknown error'}`,
        503,
      );
    }
    const version = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout.toString('utf8'));
    const supported =
      result.code === 0 &&
      version &&
      (Number(version[1]) > MINIMUM[0] ||
        (Number(version[1]) === MINIMUM[0] && Number(version[2]) >= MINIMUM[1]));
    if (!supported)
      throw new MervError(
        'code_git_unsupported',
        `Code keeps repositories and needs Git ${MINIMUM.join('.')} or newer on the server; found ${version ? version[0] : 'no usable Git'}`,
        503,
      );
    return `${version[1]}.${version[2]}.${version[3] ?? '0'}`;
  }

  /** The child's exit code and output. Only a child that could not run or finish in time throws. */
  run(args: string[], options: GitOptions = {}): Promise<GitResult> {
    const signals = [this.signal, options.signal].filter(
      (signal): signal is AbortSignal => !!signal,
    );
    const abortSignal = signals.length ? AbortSignal.any(signals) : undefined;
    if (abortSignal?.aborted)
      return Promise.reject(new MervError('code_git_aborted', 'A Git operation was stopped', 503));
    if (this.closed)
      return Promise.reject(new MervError('code_unavailable', 'Code is unavailable', 503));
    const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.command,
        [
          '-c',
          'protocol.allow=never',
          // No repository Code keeps has hooks, and none it is pointed at may run one.
          '-c',
          'core.hooksPath=/dev/null',
          ...(options.protocol ? ['-c', `protocol.${options.protocol}.allow=always`] : []),
          ...args,
        ],
        {
          cwd: options.cwd ?? this.home,
          env: {
            ...options.env,
            PATH: '/usr/bin:/bin',
            HOME: this.home,
            TMPDIR: this.home,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_ATTR_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '/bin/false',
            LC_ALL: 'C',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      this.children.add(child);
      const chunks: Buffer[] = [];
      let bytes = 0,
        stderr = '',
        failure: MervError | undefined;
      const stop = (error: MervError) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () => stop(new MervError('code_git_timeout', 'A Git operation took too long', 503)),
        options.timeoutMs ?? 60_000,
      );
      const aborted = () =>
        stop(new MervError('code_git_aborted', 'A Git operation was stopped', 503));
      if (abortSignal?.aborted) aborted();
      else abortSignal?.addEventListener('abort', aborted, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        if (options.output) return options.output(chunk);
        bytes += chunk.length;
        if (bytes > maxBuffer)
          stop(new MervError('code_git_failed', 'A Git operation said more than it may', 500));
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });
      // A child that exits before reading its input is reported by its exit code.
      child.stdin.on('error', () => {});
      if (options.input === undefined) child.stdin.end();
      else if (typeof options.input === 'string' || Buffer.isBuffer(options.input))
        child.stdin.end(options.input);
      else {
        options.input.on('error', () =>
          stop(new MervError('code_git_failed', 'The input of a Git operation failed', 500)),
        );
        options.input.pipe(child.stdin);
      }
      child.once('error', (error) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', aborted);
        this.children.delete(child);
        reject(
          failure ?? new MervError('code_git_failed', `Git could not run: ${error.message}`, 500),
        );
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', aborted);
        this.children.delete(child);
        if (failure) reject(failure);
        else if (this.closed && signal)
          reject(new MervError('code_unavailable', 'Code is unavailable', 503));
        // A child ended by a signal never reached an exit of its own. Callers read the exit
        // code as Git's answer, so inventing one would pass a kill off as something Git said.
        else if (code === null)
          reject(
            new MervError(
              'code_git_failed',
              `A Git operation was ended by ${signal ?? 'a signal'}`,
              503,
            ),
          );
        else resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim() });
      });
    });
  }

  /** `run`, for a command whose failure means Code cannot go on. */
  async ok(args: string[], options: GitOptions = {}): Promise<Buffer> {
    const result = await this.run(args, options);
    if (result.code !== 0)
      throw new MervError(
        'code_git_failed',
        `git ${args[0]} failed: ${result.stderr.split('\n')[0] ?? ''}`.trim(),
        500,
      );
    return result.stdout;
  }

  /** Refuse new children and end the running ones; every journalled operation can be replayed. */
  close(): void {
    this.closed = true;
    for (const child of this.children) child.kill('SIGKILL');
  }
}
