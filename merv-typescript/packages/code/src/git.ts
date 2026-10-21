import { MervError } from '@merv/contracts';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createGitOwner } from './git-owner.js';

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
  /** Streams stdout with backpressure; the caller retains ownership of ending the stream. */
  outputStream?: Writable;
  timeoutMs?: number;
  maxBuffer?: number;
  /** The one network protocol a child may use; every other is refused, as is every protocol without this. */
  protocol?: 'https' | 'file';
  /** Ends the child; the caller must reconcile any durable native outcome. */
  signal?: AbortSignal;
  /** Private FIFO path retained until native receive outcomes have been reconciled. */
  durableOwner?: string;
}

const MINIMUM = [2, 38] as const;
/** The refusal of Git work whose client was cancelled. */
export const stopped = () => new MervError('code_git_aborted', 'A Git operation was stopped', 503);

/** Each child leads its own process group, so cancellation also reaches its descendants. */
function terminate(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group may already have exited, or the platform may refuse group signals.
    }
  }
  child.kill('SIGKILL');
}

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
    return this.cancellation.run(signal, operation);
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
  async run(args: string[], options: GitOptions = {}): Promise<GitResult> {
    const signals = [this.signal, options.signal].filter(
      (signal): signal is AbortSignal => !!signal,
    );
    // On Node 22 a long-lived signal retains every signal composed from it: compose only two.
    const abortSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    if (abortSignal?.aborted) return Promise.reject(stopped());
    if (this.closed)
      return Promise.reject(new MervError('code_unavailable', 'Code is unavailable', 503));
    const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
    const owner = options.durableOwner ? await createGitOwner(options.durableOwner) : undefined;
    if (abortSignal?.aborted || this.closed) {
      owner?.close();
      throw this.closed ? new MervError('code_unavailable', 'Code is unavailable', 503) : stopped();
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
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
            stdio: owner ? ['pipe', 'pipe', 'pipe', owner.fd] : ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          },
        ) as ChildProcessWithoutNullStreams;
      } finally {
        // spawn has duplicated the descriptor into Git before it returns. Only the
        // actual receiver and its descendants now keep the durable lease alive.
        owner?.close();
      }
      this.children.add(child);
      const chunks: Buffer[] = [];
      let bytes = 0,
        stderr = '',
        failure: MervError | undefined;
      const stop = (error: MervError) => {
        failure ??= error;
        terminate(child);
      };
      const timer = setTimeout(
        () => stop(new MervError('code_git_timeout', 'A Git operation took too long', 503)),
        options.timeoutMs ?? 60_000,
      );
      const aborted = () => stop(stopped());
      if (abortSignal?.aborted) aborted();
      else abortSignal?.addEventListener('abort', aborted, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        if (options.outputStream) return;
        if (options.output) return options.output(chunk);
        bytes += chunk.length;
        if (bytes > maxBuffer)
          stop(new MervError('code_git_failed', 'A Git operation said more than it may', 500));
        else chunks.push(chunk);
      });
      const outputClosed = () => stop(stopped());
      if (options.outputStream) {
        options.outputStream.once('close', outputClosed);
        options.outputStream.once('error', outputClosed);
        child.stdout.pipe(options.outputStream, { end: false });
      }
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
      const finish = () => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', aborted);
        this.children.delete(child);
        if (options.outputStream) {
          child.stdout.unpipe(options.outputStream);
          options.outputStream.removeListener('close', outputClosed);
          options.outputStream.removeListener('error', outputClosed);
        }
        // A child that exits before reading all its input leaves the stream (and its file) open.
        if (typeof options.input === 'object' && !Buffer.isBuffer(options.input))
          options.input.destroy();
      };
      child.once('error', (error) => {
        finish();
        reject(
          failure ?? new MervError('code_git_failed', `Git could not run: ${error.message}`, 500),
        );
      });
      child.once('close', (code, signal) => {
        finish();
        if (failure) reject(failure);
        else if (this.closed) reject(new MervError('code_unavailable', 'Code is unavailable', 503));
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

  /** Refuse new children and end the running ones; callers reconcile durable outcomes. */
  close(): void {
    this.closed = true;
    for (const child of this.children) terminate(child);
  }
}
