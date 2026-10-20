import { fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MervError } from '@merv/contracts';

export const LIMITS = {
  calls: 50,
  inFlight: 4,
  scripts: 4,
  memory: 32 << 20,
  stack: 512 << 10,
  input: 64 << 10,
  callResult: 1 << 20,
  returned: 32 << 10,
  logLine: 2048,
  logLines: 200,
};

export interface ScriptCall {
  name: string;
  ms: number;
  ok: boolean;
  error?: string;
}
export interface ScriptError {
  code: string;
  message: string;
}
export interface ScriptResult {
  ok: boolean;
  result?: unknown;
  error?: ScriptError;
  logs: string[];
  calls: ScriptCall[];
  truncated?: true;
}
/** Runs one tool call for the script; throws to refuse or fail it. */
export type ScriptHost = (name: string, input: Record<string, unknown>) => Promise<unknown>;

export const SANDBOX = fileURLToPath(new URL('./sandbox.mjs', import.meta.url));
// Real paths: the permission model compares them, and a temporary directory may be a symlink.
const real = (url: string) => realpathSync(fileURLToPath(url));
const core = real(import.meta.resolve('quickjs-emscripten-core'));
const variant = real(import.meta.resolve('@jitl/quickjs-wasmfile-release-sync'));
/** The package directories of QuickJS's modules (a directory grants all below it): with the
 *  sandbox's own file, all the child may read. */
const readable = [
  core,
  variant,
  realpathSync(createRequire(core).resolve('@jitl/quickjs-ffi-types')),
].map((file) => /^.*\/node_modules\/(?:@[^/]+\/)?[^/]+/.exec(file)![0]);
const ENDS = new Set([
  'script_syntax',
  'script_error',
  'script_timeout',
  'script_memory',
  'script_call_limit',
]);
const unavailable = () => new MervError('script_unavailable', 'Scripts are unavailable here', 503);
/** Scripts running in this process. */
let running = 0;

/** One call message from the child, or undefined for anything a sandbox would not send. */
export function parseCall(
  message: unknown,
  seen: Set<number>,
): { id: number; name: string; input: Record<string, unknown> } | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const { id, name, input } = message as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || seen.has(id)) return;
  if (typeof name !== 'string' || name.length > 128) return;
  if (typeof input !== 'string' || Buffer.byteLength(input) > LIMITS.input) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  seen.add(id);
  return { id, name, input: parsed as Record<string, unknown> };
}

const failure = (error: unknown): ScriptError =>
  error instanceof MervError
    ? { code: error.code, message: error.message }
    : { code: 'internal_error', message: 'Internal server error' };

/** The result and as many logs as fit in LIMITS.returned; a result too large for it alone comes
 *  back as the start of its JSON text. */
function returned(result: string | undefined, logs: string[]) {
  const text = result ?? '';
  if (text.length > LIMITS.returned)
    return { result: text.slice(0, LIMITS.returned), logs: [], truncated: true as const };
  let room = LIMITS.returned - text.length;
  const kept = logs.filter((line) => (room -= line.length + 3) >= 0);
  return {
    ...(result === undefined ? {} : { result: JSON.parse(result) as unknown }),
    logs: kept,
    ...(kept.length < logs.length && { truncated: true as const }),
  };
}

/**
 * Runs `code` in a fresh child (QuickJS in WebAssembly, no environment, no file reads but its
 * own modules) whose only request is a tool call, each decided by `host`. The child is always
 * killed, at the latest its timeout and 1.5 s after it was started.
 */
export async function runScript(
  code: string,
  timeoutMs: number,
  names: string[],
  host: ScriptHost,
  entry = SANDBOX,
): Promise<ScriptResult> {
  if (running >= LIMITS.scripts)
    throw new MervError('script_busy', 'Too many scripts are running; retry shortly', 429);
  entry = realpathSync(entry);
  const child = fork(
    entry,
    [pathToFileURL(core).href, pathToFileURL(variant).href, `${LIMITS.memory}`],
    {
      env: {},
      // Explicit, so the parent's own flags (tsx's --import in tests) are not inherited. Node's
      // stack holds QuickJS's 512 KiB of WebAssembly frames with room to spare. The permission
      // model of Node 22 walls off files, child processes and workers, not the network: the
      // child holds no credential to use it with.
      execArgv: [
        '--permission',
        ...[...readable, entry].map((path) => `--allow-fs-read=${path}`),
        '--stack-size=2000',
        '--max-old-space-size=64',
      ],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  // Kept for the server's log when the child dies before it is ready; never the caller's.
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    if (stderr.length < 2048) stderr = (stderr + chunk.toString()).slice(0, 2048);
  });
  const logs: string[] = [];
  const calls: ScriptCall[] = [];
  const seen = new Set<number>();
  const queue: (() => Promise<void>)[] = [];
  let active = 0;
  let settle!: (result: ScriptResult | MervError) => void;
  const ended = new Promise<ScriptResult | MervError>((resolve) => (settle = resolve));
  let done = false;
  let started = false;
  const end = (outcome: ScriptResult | MervError | ScriptError) => {
    if (done) return;
    done = true;
    child.kill('SIGKILL');
    settle(
      'code' in outcome && !(outcome instanceof MervError)
        ? { ok: false, error: outcome, logs: [...logs], calls: [...calls] }
        : outcome,
    );
  };
  const forged = () =>
    end({ code: 'script_error', message: 'The script made a call the sandbox cannot send' });
  const pump = () => {
    while (!done && active < LIMITS.inFlight && queue.length) {
      active++;
      void queue.shift()!().finally(() => {
        active--;
        pump();
      });
    }
  };
  const call = async (id: number, name: string, input: Record<string, unknown>) => {
    const begun = Date.now();
    let answer: Record<string, unknown>;
    try {
      const value = JSON.stringify((await host(name, input)) ?? null);
      if (value.length > LIMITS.callResult)
        throw new MervError('script_result_too_large', `${name} returned more than 1 MiB`, 413);
      answer = { id, ok: true, value };
      calls.push({ name, ms: Date.now() - begun, ok: true });
    } catch (error) {
      const { code, message } = failure(error);
      answer = { id, ok: false, code, error: `${code}: ${message}` };
      calls.push({ name, ms: Date.now() - begun, ok: false, error: code });
    }
    if (!done && child.connected) child.send(answer);
  };
  child.on('message', (message: Record<string, unknown>) => {
    if (done) return;
    switch (message?.type) {
      case 'ready':
        // The second wall: never run a script outside Node's permission model.
        if (started) return forged();
        if (message.permission !== true) return end(unavailable());
        started = true;
        child.send({
          code,
          names,
          timeoutMs,
          stack: LIMITS.stack,
          calls: LIMITS.calls,
          logLines: LIMITS.logLines,
        });
        return;
      case 'log':
        // The sandbox sends no line past the limit.
        if (typeof message.line !== 'string' || logs.length >= LIMITS.logLines) return forged();
        logs.push(message.line.slice(0, LIMITS.logLine));
        return;
      case 'call': {
        const parsed = parseCall(message, seen);
        if (!parsed) return forged();
        if (seen.size > LIMITS.calls)
          return end({
            code: 'script_call_limit',
            message: `A script makes at most ${LIMITS.calls} calls`,
          });
        queue.push(() => call(parsed.id, parsed.name, parsed.input));
        return pump();
      }
      case 'done': {
        const { ok, result, error } = message as Record<string, any>;
        if (ok === true && (result === undefined || typeof result === 'string')) {
          let shaped;
          try {
            shaped = returned(result, logs);
          } catch {
            return forged();
          }
          return end({ ok: true, ...shaped, calls: [...calls] });
        }
        if (ok === false && ENDS.has(error?.code) && typeof error.message === 'string')
          return end({ code: error.code, message: error.message.slice(0, LIMITS.logLine) });
        return forged();
      }
      default:
        return forged();
    }
  });
  const dead = () => {
    if (done) return;
    process.stderr.write(`${JSON.stringify({ event: 'script_sandbox_failed', stderr })}\n`);
    end(unavailable());
  };
  child.on('error', dead);
  // A child that stops before it is ready never ran the script.
  child.on('close', () =>
    started ? end({ code: 'script_error', message: 'The script stopped' }) : dead(),
  );
  const timer = setTimeout(
    () => end({ code: 'script_timeout', message: 'The script ran out of time' }),
    timeoutMs + 1500,
  );
  // Counted from here, where nothing before has awaited.
  running++;
  try {
    const outcome = await ended;
    if (outcome instanceof MervError) throw outcome;
    return outcome;
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    running--;
  }
}
