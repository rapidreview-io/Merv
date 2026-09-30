/** Test-only IPC barrier: pause after real work, then either continue or kill the child. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { deferred } from './deferred.js';

const timeoutMs = 10_000;

export async function deadline<T>(work: Promise<T>, label: string, ms = timeoutMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('Worker requires an IPC channel'));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

export async function processBarrier(evidence: object): Promise<void> {
  const release = deferred();
  const receive = (message: unknown) => {
    if ((message as { kind?: string })?.kind === 'continue') release.resolve();
  };
  process.on('message', receive);
  try {
    await send({ kind: 'barrier', evidence });
    await deadline(release.promise, 'parent must release or kill the paused worker');
  } finally {
    process.off('message', receive);
  }
}

export async function processResult(result: object): Promise<void> {
  await send({ kind: 'result', result });
  process.disconnect();
}

export function barrierWorker<Evidence, Result>(t: TestContext, script: URL, args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(script), ...args], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const reached = deferred<Evidence>();
  const closed = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  let output = '',
    error: Error | undefined,
    hasClosed = false,
    hasBarrier = false,
    hasResult = false,
    result: Result;
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-16_384);
  };
  child.stdout!.on('data', capture);
  child.stderr!.on('data', capture);
  child.on('error', (cause) => {
    error = cause;
  });
  child.on('message', (message: unknown) => {
    const data = message as { kind?: string; evidence: Evidence; result: Result };
    if (data?.kind === 'barrier') {
      hasBarrier = true;
      reached.resolve(data.evidence);
    } else if (data?.kind === 'result') {
      hasResult = true;
      result = data.result;
    }
  });
  child.once('close', (code, signal) => {
    hasClosed = true;
    closed.resolve({ code, signal });
  });
  const diagnostic = () => `worker ${child.pid}: ${error?.message ?? ''}\n${output}`;
  t.after(async () => {
    if (!hasClosed) child.kill('SIGKILL');
    await deadline(closed.promise, `child cleanup: ${diagnostic()}`, 5000);
  });
  async function completed(): Promise<Result> {
    const status = await deadline(closed.promise, `worker completion: ${diagnostic()}`);
    assert.deepEqual(status, { code: 0, signal: null }, diagnostic());
    assert.equal(hasResult, true, `worker exited without its operation reply: ${diagnostic()}`);
    return result;
  }
  return {
    pid: child.pid,
    async barrier(): Promise<Evidence> {
      return deadline(
        Promise.race([
          reached.promise,
          closed.promise.then((status) => {
            throw new Error(
              `Worker exited before barrier: ${JSON.stringify(status)} ${diagnostic()}`,
            );
          }),
        ]),
        `worker barrier: ${diagnostic()}`,
      );
    },
    completed,
    async resume(): Promise<Result> {
      assert.equal(hasBarrier, true, 'Wait for the actual barrier before continuing');
      await new Promise<void>((resolve, reject) => {
        child.send({ kind: 'continue' }, (cause) => (cause ? reject(cause) : resolve()));
      });
      return completed();
    },
    async kill(): Promise<void> {
      assert.equal(hasBarrier, true, 'Wait for the actual barrier before killing');
      assert.equal(hasClosed, false, diagnostic());
      assert.equal(hasResult, false, 'Operation must not have replied before the crash');
      assert.equal(child.kill('SIGKILL'), true, diagnostic());
      const status = await deadline(closed.promise, `SIGKILL: ${diagnostic()}`, 5000);
      assert.deepEqual(status, { code: null, signal: 'SIGKILL' }, diagnostic());
      assert.equal(hasResult, false, 'Killed worker must not report normal completion');
    },
  };
}
