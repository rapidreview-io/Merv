import { MervError } from '@merv/contracts';
import { execFile } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * A private FIFO is an ownership record held by the kernel, not by a reusable PID.
 * Pass its writer as an extra Git descriptor; Git and its receiver descendants keep
 * it across exec. A restarted server observes EOF only after every writer has exited.
 * The path must remain present until that observation, including after server crashes.
 */
export async function createGitOwner(path: string): Promise<{ fd: number; close(): void }> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await execute('mkfifo', ['-m', '600', path], {
    env: { PATH: '/usr/bin:/bin' },
    timeout: 10_000,
  });
  const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let writer: number;
  try {
    // Opening the reader first lets this nonblocking writer open before Git exists.
    writer = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    closeSync(reader);
    throw error;
  }
  let closed = false;
  return {
    fd: writer,
    close() {
      if (closed) return;
      closed = true;
      closeSync(writer);
      closeSync(reader);
    },
  };
}

/**
 * Prove a previous native receive is quiescent before reading its final refs or
 * removing its lock files. No signal is sent to an unverified process identity.
 * A stuck receiver remains fenced and is retried on the next recovery attempt.
 * Call only under the repository writer lock, which prevents a new owner starting.
 */
export async function waitGitOwner(
  path: string,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // No receiver can start after its owning server lost the repository writer lock.
  // A completed receive may also have removed its private request directory already.
  if (!stat) return;
  if (!stat.isFIFO())
    throw new MervError('code_git_owner_invalid', 'Git receiver ownership is not a FIFO', 503);
  const reader = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const deadline = performance.now() + Math.max(0, timeoutMs);
  const byte = Buffer.alloc(1);
  try {
    for (;;) {
      try {
        const { bytesRead } = await reader.read(byte, 0, 1, null);
        if (bytesRead === 0) return;
        throw new MervError('code_git_owner_invalid', 'Git receiver ownership contains data', 503);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      }
      if (performance.now() >= deadline)
        throw new MervError(
          'code_git_receiver_active',
          'A previous Git receiver is still running; its writer remains fenced until it exits',
          503,
        );
      await setTimeout(Math.min(100, Math.max(1, deadline - performance.now())));
    }
  } finally {
    await reader.close();
  }
}
