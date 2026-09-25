import { cause, mark, runPiWorker } from './worker.js';
import type { PiBootstrapV1 } from './types.js';
import { pathToFileURL } from 'node:url';

export async function readBootstrap(
  input: AsyncIterable<Uint8Array | string> = process.stdin,
): Promise<PiBootstrapV1> {
  let content = '';
  for await (const chunk of input) {
    content += chunk.toString();
    if (Buffer.byteLength(content) > 4096) throw new Error('Invalid Pi bootstrap');
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('Invalid Pi bootstrap');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Pi bootstrap');
  const bootstrap = value as Record<string, unknown>;
  if (
    Object.keys(bootstrap).sort().join(',') !==
      'baseUrl,conversationId,epoch,expiresAt,kind,projectId,runtimeId,workerToken' ||
    bootstrap.kind !== 'pi' ||
    !Number.isSafeInteger(bootstrap.epoch) ||
    (bootstrap.epoch as number) < 0 ||
    !['projectId', 'conversationId', 'runtimeId'].every(
      (key) =>
        typeof bootstrap[key] === 'string' &&
        /^[A-Za-z0-9_-]{1,200}$/.test(bootstrap[key] as string),
    ) ||
    typeof bootstrap.workerToken !== 'string' ||
    !/^piw_flt_[A-Za-z0-9]+\.[A-Za-z0-9_-]{43}$/.test(bootstrap.workerToken) ||
    typeof bootstrap.baseUrl !== 'string' ||
    typeof bootstrap.expiresAt !== 'string'
  )
    throw new Error('Invalid Pi bootstrap');
  // runPiWorker checks the origin, lifetime and credential before any request.
  return bootstrap as unknown as PiBootstrapV1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Pi is loaded before the bootstrap is read, so a worker started early waits here ready to enroll.
  mark('ready');
  readBootstrap()
    .then((bootstrap) => {
      mark('bootstrap');
      return runPiWorker(bootstrap);
    })
    .catch((error: unknown) => {
      process.stderr.write(`Pi worker unavailable: ${cause(error)}\n`);
      process.exitCode = 1;
    });
}
