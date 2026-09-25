/**
 * Targeted launcher for the QA plan (§5.4 item 6): one lease on exactly the named workflow
 * instance and revision, worked by one Codex launch built the way the runner builds its own
 * (`buildLaunch` in packages/runner/src/profiles.ts), with the network and the Sandboxes MCP
 * added when asked.
 *
 *   node --import tsx dev_docs/qa/launch.ts --base-url <url> --project <id> --token-env <ENV> \
 *     --instance <workflow instance id> --revision <n> --out <dir> \
 *     [--network [--sandboxes-url <mcp url> --sandboxes-token-env <ENV>]] [--offer-only] \
 *     [--model gpt-6-sol] [--effort <effort>]
 *
 * - Refuses to run while GET /sessions/status shows dispatch on for the project.
 * - POST /sessions/offer as runner `qa-launcher` with a fresh secret and request id and no
 *   agentId, so every lease gets a fresh agent actor. A refusal prints its code and exits 3.
 * - Codex gets the lease's manifest plus the project reads every runner worker gets; with
 *   --network, `sandbox_workspace_write.network_access=true` and a `sandboxes` MCP server whose
 *   tools are approved (the namespace's spend cap is the guard). Bearers travel only as
 *   environment variables named by the flags, never as arguments or in the output.
 * - --offer-only activates the lease with one MCP handshake and holds it without Codex until the
 *   lease closes (Halt lease in the UI, exit 0) or the launcher is interrupted (exit 130).
 * - Heartbeats every 10 min. Every step is a JSON line on stdout and in <out>/launcher.ndjson;
 *   each launch's Codex jsonl and stderr are kept, redacted, as <out>/<stamp>-<session>-<n>.*
 *   (a launch that dies at Codex's MCP handshake is retried once, as live-scenario.ts does).
 * - Workspace `none` records only: a Git stage needs the runner's checkout (plan C5).
 * - Exits with Codex's exit code. Nothing is left dangling: a lease still `offered` when Codex
 *   has gone (it never connected) is halted, and one still `active` (no handoff, or an
 *   interrupted launcher) is released as the runner releases its own (see finish()).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { buildLaunch, collectRepositorySkillPaths } from '@merv/runner/profiles';

const RUNNER = 'qa-launcher';
const { values: o } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    project: { type: 'string' },
    'token-env': { type: 'string' },
    instance: { type: 'string' },
    revision: { type: 'string' },
    out: { type: 'string' },
    network: { type: 'boolean', default: false },
    'sandboxes-url': { type: 'string' },
    'sandboxes-token-env': { type: 'string' },
    'offer-only': { type: 'boolean', default: false },
    model: { type: 'string', default: 'gpt-6-sol' },
    effort: { type: 'string' },
  },
});
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const baseUrl = o['base-url']?.replace(/\/+$/, '');
const revision = Number(o.revision);
if (
  !baseUrl ||
  !o.project ||
  !o['token-env'] ||
  !o.instance ||
  !o.out ||
  !Number.isSafeInteger(revision)
)
  fail(
    'Usage: launch.ts --base-url <url> --project <id> --token-env <ENV> --instance <id> --revision <n> --out <dir> [--network [--sandboxes-url <url> --sandboxes-token-env <ENV>]] [--offer-only] [--model <m>] [--effort <e>]',
  );
if (!!o['sandboxes-url'] !== !!o['sandboxes-token-env'] || (o['sandboxes-url'] && !o.network))
  fail('--sandboxes-url and --sandboxes-token-env go together, and only with --network');
const token = process.env[o['token-env']!] ?? fail(`No credential in ${o['token-env']}`);
const sandboxesToken = o['sandboxes-token-env']
  ? (process.env[o['sandboxes-token-env']] ?? fail(`No grant in ${o['sandboxes-token-env']}`))
  : undefined;
const secret = `ms_${randomBytes(32).toString('base64url')}`;
const secrets = [token, secret, ...(sandboxesToken ? [sandboxesToken] : [])];
const redact = (text: string) =>
  secrets
    .reduce((value, known) => value.split(known).join('[redacted]'), text)
    .replace(/\bm[sk]_[A-Za-z0-9_-]{32,}|\bsbxt_[A-Za-z0-9_-]{16,}/g, '[redacted]');
const out = resolve(o.out!);
mkdirSync(out, { recursive: true, mode: 0o700 });
const log = (entry: Record<string, unknown>) => {
  const line = redact(
    JSON.stringify({ at: new Date().toISOString(), instanceId: o.instance, revision, ...entry }),
  );
  appendFileSync(join(out, 'launcher.ndjson'), line + '\n', { mode: 0o600 });
  console.log(line);
};
const control = async (path: string, body?: unknown): Promise<any> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-merv-project-id': o.project!,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${value.error?.code}: ${value.error?.message}`);
  return value;
};

const status = await control('/sessions/status');
if (status.dispatch?.enabled) {
  log({ refused: 'dispatch_enabled', detail: 'Pause dispatch on the Sessions page first' });
  process.exit(2);
}
const requestId = `${RUNNER}:${o.instance}:${revision}:${randomBytes(6).toString('hex')}`;
let session: any;
try {
  ({ session } = await control('/sessions/offer', {
    instanceId: o.instance,
    expectedRevision: revision,
    runnerId: RUNNER,
    requestId,
    secret,
  }));
} catch (error) {
  log({ refused: 'offer', detail: (error as Error).message });
  process.exit(3);
}
const sessionPath = `/sessions/${encodeURIComponent(session.id)}`;
log({ sessionId: session.id, offered: session.role, agentActorId: session.actorId, requestId });

const current = async (): Promise<string> =>
  (await control(sessionPath).catch(() => ({ session: { status: 'unknown' } }))).session.status;
/**
 * Close what is still open once the worker is gone. A lease never activated is halted (a key
 * without admin releases it as `launch_failed`); an activated one is released the way the runner
 * releases its own after its process ends. A lease the worker handed off is already closed.
 */
const finish = async (): Promise<string> => {
  let state = await current();
  // A server that is restarting answers again within a couple of minutes.
  for (let wait = 0; state === 'unknown' && wait < 8; wait++) {
    await delay(15_000);
    state = await current();
  }
  if (state === 'unknown') log({ sessionId: session.id, unreachable: 'halt it from Sessions' });
  if (state !== 'offered' && state !== 'active') return state;
  const reason =
    state === 'offered'
      ? 'qa-launcher: failed before activation'
      : stopped
        ? 'qa-launcher interrupted'
        : 'local_process_finished';
  const release = (outcome: string) =>
    control(`${sessionPath}/release`, { runnerId: RUNNER, reason, outcome });
  const result = await (
    state === 'offered'
      ? control(`${sessionPath}/halt`, { reason }).catch(() => release('launch_failed'))
      : release('host_failed')
  ).then(
    (value) => value.session?.status ?? value,
    (error: Error) => ({ error: error.message }),
  );
  log({ sessionId: session.id, [state === 'offered' ? 'halted' : 'released']: result, reason });
  return await current();
};
const beat = setInterval(() => {
  control(`${sessionPath}/heartbeat`, { runnerId: RUNNER }).then(
    () => log({ sessionId: session.id, heartbeat: 'ok' }),
    (error: Error) => log({ sessionId: session.id, heartbeat: error.message }),
  );
}, 600_000);
let interrupted: (() => void) | undefined;
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopped = true;
    interrupted?.();
  });

if (o['offer-only']) {
  // A session activates on its first authenticated MCP request; only an active one heartbeats.
  const handshake = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: RUNNER, version: '1' },
      },
    }),
  });
  let state = await current();
  log({ sessionId: session.id, activation: handshake.status, status: state });
  while (!stopped && ['offered', 'active'].includes(state)) {
    await Promise.race([delay(30_000), new Promise<void>((done) => (interrupted = done))]);
    state = await current();
  }
  clearInterval(beat);
  log({ sessionId: session.id, closed: await finish() });
  process.exit(stopped ? 130 : 0);
}

const workspace = join(out, 'workspaces', session.id);
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const launch = async (attempt: number): Promise<number> => {
  const spec = buildLaunch(
    {
      name: RUNNER,
      harness: 'codex',
      executable: process.env.MERV_CODEX_BIN ?? 'codex',
      enabled: true,
      parallelism: 1,
      model: o.model,
      ...(o.effort ? { effort: o.effort } : {}),
    },
    {
      session,
      secret,
      mcpUrl: `${baseUrl}/mcp`,
      cwd: workspace,
      disabledSkillPaths: collectRepositorySkillPaths(workspace),
    },
  );
  let { args, stdin } = spec;
  const env = { ...spec.env };
  if (o.network) {
    args = args.map((arg) =>
      arg === 'sandbox_workspace_write.network_access=false'
        ? 'sandbox_workspace_write.network_access=true'
        : arg,
    );
    stdin = stdin.replace(
      'Frozen assignment:',
      'This stage has network access: acquire the data and compute the assignment names, outside Merv, and bring the evidence back as artifacts.\nFrozen assignment:',
    );
    if (o['sandboxes-url']) {
      env[o['sandboxes-token-env']!] = sandboxesToken!;
      args.splice(
        args.length - 1,
        0,
        '-c',
        `mcp_servers.sandboxes={url=${JSON.stringify(o['sandboxes-url'])},bearer_token_env_var=${JSON.stringify(o['sandboxes-token-env'])},required=true,startup_timeout_sec=120,default_tools_approval_mode="approve"}`,
      );
    }
  }
  const stem = join(
    out,
    `${new Date().toISOString().replace(/[:.]/g, '')}-${session.id}-${attempt}`,
  );
  log({ sessionId: session.id, launch: attempt, model: o.model, network: o.network, files: stem });
  const child = spawn(spec.executable, args, { cwd: workspace, env, stdio: 'pipe' });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdin.on('error', (error) => stderr.push(`stdin: ${error.message}\n`));
  child.stdin.end(stdin);
  interrupted = () => child.kill('SIGTERM');
  const code = await new Promise<number>((done) => {
    child.once('error', (error) => {
      stderr.push(`spawn: ${error.message}\n`);
      done(127);
    });
    child.once('close', (exit, signal) => done(exit ?? (signal ? 128 : 1)));
  });
  writeFileSync(`${stem}.jsonl`, redact(stdout.join('')), { mode: 0o600 });
  writeFileSync(`${stem}.stderr.log`, redact(stderr.join('')), { mode: 0o600 });
  log({ sessionId: session.id, launch: attempt, exitCode: code });
  // A transient server error at Codex's MCP handshake leaves the lease usable: launch it once more.
  if (
    code !== 0 &&
    attempt === 1 &&
    !stopped &&
    /MCP servers failed to initialize/.test(stderr.join('')) &&
    ['offered', 'active'].includes(await current())
  ) {
    await delay(45_000);
    if (!stopped) return await launch(2);
  }
  return code;
};

let exitCode = 1;
try {
  exitCode = await launch(1);
} catch (error) {
  log({ sessionId: session.id, failed: (error as Error).message });
} finally {
  clearInterval(beat);
  log({ sessionId: session.id, exitCode, status: await finish() });
}
process.exit(exitCode);
