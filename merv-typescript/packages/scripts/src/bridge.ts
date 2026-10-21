import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MervError } from '@merv/contracts';

/** Sizes are UTF-8 bytes of serialized JSON. */
export const LIMITS = {
  calls: 50,
  inFlight: 4,
  scripts: 4,
  /** Host calls in flight across every script, finished ones' included. */
  hostCalls: 8,
  memory: 32 << 20,
  stack: 512 << 10,
  input: 64 << 10,
  callResult: 1 << 20,
  returned: 32 << 10,
  logLine: 2048,
  logLines: 200,
  /** Deeper JSON would overflow the stack of whatever serializes the answer next. */
  depth: 64,
  frame: 1 << 20,
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
export type ScriptHost = (name: string, input: Record<string, unknown>) => Promise<unknown>;

export const SANDBOX = fileURLToPath(new URL('./sandbox.mjs', import.meta.url));
// Real paths: the permission model compares them, and a temporary directory may be a symlink.
const real = (url: string) => realpathSync(fileURLToPath(url));
const core = real(import.meta.resolve('quickjs-emscripten-core'));
const variant = real(import.meta.resolve('@jitl/quickjs-wasmfile-release-sync'));
/** Only these real module directories and the sandbox file are readable by the child. */
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
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export function depth(text: string): number {
  let [level, most, quoted] = [0, 0, false];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') most = Math.max(most, ++level);
    else if (c === ']' || c === '}') level--;
  }
  return most;
}
/** Scripts holding a slot: running, or with host calls still out. */
let running = 0;
let hosting = 0;
const waiting: { owner: object; go: (run: boolean) => void }[] = [];
/** FIFO global host slots; dropQueued cancels waiting calls without occupying slots. */
async function hostSlot(owner: object, fn: () => Promise<void>) {
  if (hosting < LIMITS.hostCalls) hosting++;
  else if (!(await new Promise<boolean>((go) => waiting.push({ owner, go })))) return;
  try {
    await fn();
  } finally {
    const next = waiting.shift();
    if (next) next.go(true);
    else hosting--;
  }
}
function dropQueued(owner: object) {
  for (let i = waiting.length - 1; i >= 0; i--)
    if (waiting[i]!.owner === owner) waiting.splice(i, 1)[0]!.go(false);
}

export function parseCall(
  message: unknown,
  seen: Set<number>,
): { id: number; name: string; input: Record<string, unknown> } | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const { id, name, input } = message as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || seen.has(id)) return;
  if (typeof name !== 'string' || name.length > 128) return;
  if (typeof input !== 'string' || Buffer.byteLength(input) > LIMITS.input) return;
  if (depth(input) > LIMITS.depth) return;
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

/** Search whole code points: an escaped half-surrogate costs more than its complete pair. */
export function cut(text: string, room: number): string {
  if (bytes(text) <= room) return text;
  const points = Array.from(text);
  let [low, high] = [0, points.length];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(points.slice(0, mid).join('')) <= room) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join('');
}

/** Bound the entire answer; oversized or already truncated results return a JSON-text prefix. */
export function shape(
  head: Omit<ScriptResult, 'logs' | 'result' | 'truncated'>,
  logs: string[],
  text?: string,
  whole = true,
): ScriptResult {
  // The calls list is bounded like the rest: names cut, then the newest dropped to fit half.
  let calls = head.calls.map((call) => ({ ...call, name: cut(call.name, 128) }));
  let dropped = calls.some(({ name }, i) => name !== head.calls[i]!.name);
  while (calls.length && bytes(calls) > LIMITS.returned / 2) {
    calls = calls.slice(0, calls.length >> 1);
    dropped = true;
  }
  head = { ...head, calls };
  if (text !== undefined && whole && depth(text) > LIMITS.depth)
    return {
      ...head,
      ok: false,
      error: {
        code: 'script_result_too_deep',
        message: `The script's result nests deeper than ${LIMITS.depth} levels; flatten it.`,
      },
      logs: [],
      truncated: true,
    };
  let room = LIMITS.returned - bytes({ ...head, result: '', logs: [], truncated: true });
  const value = text !== undefined && whole ? (JSON.parse(text) as unknown) : undefined;
  // Measured as it will be sent, not as the script wrote it (the depth check makes this safe).
  if (value !== undefined) text = JSON.stringify(value);
  if (text !== undefined && (!whole || Buffer.byteLength(text) > room))
    return { ...head, result: cut(text, room), logs: [], truncated: true };
  room -= text === undefined ? 0 : Buffer.byteLength(text);
  const kept = logs.filter((line) => (room -= bytes(line) + 1) >= 0);
  return {
    ...head,
    ...(value !== undefined && { result: value }),
    logs: kept,
    ...((dropped || kept.length < logs.length) && { truncated: true as const }),
  };
}

const frame = (message: unknown) => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

/** QuickJS child: empty environment, narrow read grants, separate process group, framed stdio.
 * Kill by timeout + 1.5 s; hold its slot until started host calls settle. */
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
  const child = spawn(
    process.execPath,
    [
      // Explicit flags avoid inheriting parent imports. Stack allows QuickJS’s 512 KiB frames.
      // Node permissions contain files/processes/workers, not network/signals; see README.
      '--permission',
      ...[...readable, entry].map((path) => `--allow-fs-read=${path}`),
      '--stack-size=2000',
      '--max-old-space-size=64',
      entry,
      pathToFileURL(core).href,
      pathToFileURL(variant).href,
      `${LIMITS.memory}`,
    ],
    // No IPC channel: Node's own parser would read the child's messages before any check here.
    { env: {}, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  );
  const kill = () => {
    // Its whole group, while the child is there to lead it (a reaped id could be reused).
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  };
  // Ignore EPIPE after child exit.
  child.stdin!.on('error', () => {});
  // Kept for the server's log when the child dies before it is ready; never the caller's.
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    if (stderr.length < 2048) stderr = (stderr + chunk.toString()).slice(0, 2048);
  });
  const logs: string[] = [];
  const calls: ScriptCall[] = [];
  const seen = new Set<number>();
  const queue: (() => Promise<void>)[] = [];
  const out = new Set<Promise<void>>();
  let settle!: (result: ScriptResult | MervError) => void;
  const ended = new Promise<ScriptResult | MervError>((resolve) => (settle = resolve));
  let done = false;
  let started = false;
  const end = (outcome: MervError | ScriptError | { result?: string; whole: boolean }) => {
    if (done) return;
    done = true;
    kill();
    if (outcome instanceof MervError) return settle(outcome);
    settle(
      'code' in outcome
        ? shape({ ok: false, error: outcome, calls: [...calls] }, logs)
        : shape({ ok: true, calls: [...calls] }, logs, outcome.result, outcome.whole),
    );
  };
  const forged = () =>
    end(
      started
        ? { code: 'script_error', message: 'The script made a call the sandbox cannot send' }
        : unavailable(),
    );
  const pump = () => {
    while (!done && out.size < LIMITS.inFlight && queue.length) {
      const settled = hostSlot(queue, queue.shift()!).finally(() => {
        out.delete(settled);
        pump();
      });
      out.add(settled);
    }
  };
  const call = async (id: number, name: string, input: Record<string, unknown>) => {
    if (done) return;
    const begun = Date.now();
    let answer: Record<string, unknown>;
    try {
      const value = JSON.stringify((await host(name, input)) ?? null);
      if (Buffer.byteLength(value) > LIMITS.callResult)
        throw new MervError('script_result_too_large', `${name} returned more than 1 MiB`, 413);
      answer = { id, ok: true, value };
      calls.push({ name, ms: Date.now() - begun, ok: true });
    } catch (error) {
      const { code, message } = failure(error);
      answer = { id, ok: false, code, error: `${code}: ${message}` };
      calls.push({ name, ms: Date.now() - begun, ok: false, error: code });
    }
    if (!done) child.stdin!.write(frame(answer));
  };
  const receive = (message: Record<string, unknown> | null) => {
    if (!started) {
      // The second wall: never run a script outside Node's permission model.
      if (message?.type !== 'ready' || message.permission !== true) return forged();
      started = true;
      child.stdin!.write(
        frame({
          code,
          names,
          timeoutMs,
          stack: LIMITS.stack,
          calls: LIMITS.calls,
          logLines: LIMITS.logLines,
          input: LIMITS.input,
          returned: LIMITS.returned,
        }),
      );
      return;
    }
    switch (message?.type) {
      case 'log':
        if (typeof message.line !== 'string' || logs.length >= LIMITS.logLines) return forged();
        logs.push(cut(message.line, LIMITS.logLine));
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
        const { ok, result, error, truncated } = message as Record<string, any>;
        if (ok === true && (result === undefined || typeof result === 'string')) {
          const whole = truncated !== true;
          try {
            if (whole && result !== undefined) JSON.parse(result);
          } catch {
            return forged();
          }
          return end({ result, whole });
        }
        if (ok === false && ENDS.has(error?.code) && typeof error.message === 'string')
          return end({ code: error.code, message: cut(error.message, LIMITS.logLine) });
        return forged();
      }
      default:
        return forged();
    }
  };
  // Length-prefixed frames, each refused past LIMITS.frame before it is buffered.
  let buffer = Buffer.alloc(0);
  child.stdout!.on('data', (chunk: Buffer) => {
    if (done) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (!done && buffer.length >= 4) {
      const size = buffer.readUInt32BE(0);
      if (size > LIMITS.frame) return forged();
      if (buffer.length < 4 + size) return;
      const body = buffer.subarray(4, 4 + size).toString();
      buffer = buffer.subarray(4 + size);
      let message;
      try {
        message = JSON.parse(body) as unknown;
      } catch {
        return forged();
      }
      receive(message && typeof message === 'object' ? (message as Record<string, unknown>) : null);
    }
  });
  const dead = () => {
    if (done) return;
    process.stderr.write(`${JSON.stringify({ event: 'script_sandbox_failed', stderr })}\n`);
    end(unavailable());
  };
  child.on('error', dead);
  child.on('close', () =>
    started ? end({ code: 'script_error', message: 'The script stopped' }) : dead(),
  );
  const timer = setTimeout(
    () => end({ code: 'script_timeout', message: 'The script ran out of time' }),
    timeoutMs + 1500,
  );
  running++;
  try {
    const outcome = await ended;
    if (outcome instanceof MervError) throw outcome;
    return outcome;
  } finally {
    clearTimeout(timer);
    kill();
    // Calls already started keep the slot until they settle; queued ones never start.
    dropQueued(queue);
    void Promise.allSettled(out).then(() => running--);
  }
}
