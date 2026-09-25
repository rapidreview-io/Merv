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
 * - Credentials are read only from the variables the flags name, must be one printable token,
 *   and go only to https or loopback http URLs. Nothing prints them: every line is redacted.
 * - Codex gets the lease's manifest plus the project reads every runner worker gets (the server
 *   admits those reads to any session). With --network, `sandbox_workspace_write.network_access=
 *   true` and a `sandboxes` MCP server whose tools are approved: in a running (or task
 *   in_progress) stage all of them, in any other stage only providers_list, sandbox_options and
 *   spend_status, so a planning worker can price a machine but not rent one.
 * - --network refuses to start while this account can read any `.merv` directory: the worker
 *   runs as this account with open egress, so it must be one that holds no Merv credentials
 *   (the harness VM, or a dedicated user with its own CODEX_HOME), with W and Z only in this
 *   process's environment (§5.4 precondition). Every launch logs `credentialPathMentions` when
 *   its Codex output names `.merv` or `.codex/auth` outside <out> (the J7 check).
 * - --offer-only activates the lease with one MCP handshake and holds it without Codex until the
 *   server says it closed (Halt lease in the UI: exit 0) or a signal stops it. An unanswered
 *   status read is not a close: it keeps holding and heartbeating.
 * - Heartbeats every 10 min. Every step is a JSON line on stdout, then in <out>/launcher.ndjson;
 *   each launch's Codex jsonl and stderr stream, redacted line by line, to
 *   <out>/<stamp>-<session>-<n>.* (a launch that dies at Codex's MCP handshake is retried once).
 * - Workspace `none` records only: a Git stage needs the runner's checkout (plan C5).
 * - Nothing is left dangling: once the offer is taken, any failure, SIGINT, SIGTERM, SIGHUP or
 *   SIGQUIT ends in finish(), which halts a lease still `offered` and releases one still
 *   `active` the way the runner releases its own.
 * - Exit codes: Codex's own when the lease closed by the worker's handoff; 0 for --offer-only
 *   when the lease was closed from outside; 4 when the launcher had to close the lease itself or
 *   could not learn its state (not handed off); 128 + n for signal n; 2 usage or refusal; 3 offer
 *   refused.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, appendFileSync, constants as files, mkdirSync, readdirSync } from 'node:fs';
import { constants as system, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { buildLaunch, collectRepositorySkillPaths } from '@merv/runner/profiles';

const RUNNER = 'qa-launcher';
/** The child's name for the Sandboxes grant: nothing buildLaunch sets, whatever the flag names. */
const GRANT = 'QA_SANDBOXES_GRANT';
const PLANNING_TOOLS = ['providers_list', 'sandbox_options', 'spend_status'];
const COMPUTE_STATES = ['running', 'in_progress'];
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
const revision = Number(o.revision);
if (
  !o['base-url'] ||
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
/** The runner's rule for where a bearer may go: https, or http on this machine; nothing else in the URL. */
const endpoint = (flag: string, value: string) => {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (
    !url ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail(`${flag} must be https, or http on loopback, without credentials, query or fragment`);
  return url!.href.replace(/\/+$/, '');
};
const baseUrl = endpoint('--base-url', o['base-url']!);
const sandboxesUrl = o['sandboxes-url'] && endpoint('--sandboxes-url', o['sandboxes-url']);
const credential = (name: string) => {
  const value = process.env[name] ?? '';
  return /^[\x21-\x7e]+$/.test(value)
    ? value
    : fail(`${name} must hold one credential: printable, no whitespace`);
};
const token = credential(o['token-env']!);
const sandboxesToken = o['sandboxes-token-env'] && credential(o['sandboxes-token-env']);
if (sandboxesToken === token)
  fail('--sandboxes-token-env must name the Sandboxes grant, not the Merv key');
const secret = `ms_${randomBytes(32).toString('base64url')}`;
const secrets = [token, secret, ...(sandboxesToken ? [sandboxesToken] : [])];
const redact = (text: string) =>
  secrets
    .reduce((value, known) => value.split(known).join('[redacted]'), text)
    .replace(/\bm[sk]_[A-Za-z0-9_-]{32,}|\bsbxt_[A-Za-z0-9_-]{16,}/g, '[redacted]');
process.on('uncaughtException', (error) => {
  console.error(redact(String(error?.stack ?? error)));
  process.exit(1);
});
// A closed terminal or pipe must not turn the next log line into a crash that skips finish().
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

if (o.network && !o['offer-only']) {
  const homes = dirname(userInfo().homedir);
  const readable = readdirSync(homes)
    .map((name) => join(homes, name, '.merv'))
    .filter((path) => {
      try {
        accessSync(path, files.R_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (readable.length)
    fail(
      `--network gives the worker open egress as this account, which can read ${readable.join(', ')}. Run it as an account that holds no Merv credentials (the harness VM, or a dedicated user with its own CODEX_HOME), with W and Z only in this process's environment and --out outside .merv.`,
    );
}
const out = resolve(o.out!);
const ledger = join(out, 'launcher.ndjson');
mkdirSync(out, { recursive: true, mode: 0o700 });
appendFileSync(ledger, '', { mode: 0o600 }); // fails here, before any lease exists
let unwritable = false;
const append = (file: string, text: string) => {
  try {
    appendFileSync(file, text, { mode: 0o600 });
  } catch (error) {
    if (!unwritable) console.error(redact(`Cannot write ${file}: ${(error as Error).message}`));
    unwritable = true;
  }
};
const log = (entry: Record<string, unknown>) => {
  const line = redact(
    JSON.stringify({ at: new Date().toISOString(), instanceId: o.instance, revision, ...entry }),
  );
  console.log(line);
  append(ledger, line + '\n');
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

const signalCode = (signal: NodeJS.Signals) => 128 + system.signals[signal];
let stopped: NodeJS.Signals | undefined;
let offering = false;
let interrupted: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const)
  process.on(signal, () => {
    stopped ??= signal;
    if (!offering) process.exit(signalCode(signal)); // no lease requested yet
    interrupted?.();
  });
const pause = (ms: number) =>
  Promise.race([delay(ms), new Promise<void>((done) => (interrupted = done))]);

const status = await control('/sessions/status');
if (status.dispatch?.enabled) {
  log({ refused: 'dispatch_enabled', detail: 'Pause dispatch on the Sessions page first' });
  process.exit(2);
}
const requestId = `${RUNNER}:${o.instance}:${revision}:${randomBytes(6).toString('hex')}`;
let session: any;
offering = true; // from here a signal waits for the offer's answer, then closes what it took
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
  process.exit(stopped ? signalCode(stopped) : 3);
}
const sessionPath = `/sessions/${encodeURIComponent(session.id)}`;
log({ sessionId: session.id, offered: session.role, agentActorId: session.actorId, requestId });

type State = { status: string; outcome?: string | null; closeReason?: string | null };
/** The lease as the server has it; undefined when the read got no answer. */
const read = async (): Promise<State | undefined> =>
  (await control(sessionPath).catch(() => undefined))?.session;
const open = (state: State | undefined) => ['offered', 'active'].includes(state?.status ?? '');
let closedHere = false;
/**
 * Close what is still open once the worker is gone. A lease never activated is halted (a key
 * without admin releases it as `launch_failed`); an activated one is released the way the runner
 * releases its own after its process ends. A lease the worker handed off is already closed.
 */
const finish = async (): Promise<State | undefined> => {
  let state = await read();
  // A server that is restarting answers again within a couple of minutes.
  for (let wait = 0; !state && wait < 8; wait++) {
    await delay(15_000);
    state = await read();
  }
  if (!state) log({ sessionId: session.id, unreachable: 'halt it from Sessions' });
  if (!open(state)) return state;
  closedHere = true;
  const offered = state!.status === 'offered';
  const reason = offered
    ? 'qa-launcher: failed before activation'
    : stopped
      ? 'qa-launcher interrupted'
      : 'local_process_finished';
  const release = (outcome: string) =>
    control(`${sessionPath}/release`, { runnerId: RUNNER, reason, outcome });
  const result = await (
    offered
      ? control(`${sessionPath}/halt`, { reason }).catch(() => release('launch_failed'))
      : release('host_failed')
  ).then(
    (value) => value.session?.status ?? value,
    (error: Error) => ({ error: error.message }),
  );
  log({ sessionId: session.id, [offered ? 'halted' : 'released']: result, reason });
  return await read();
};
const beat = setInterval(() => {
  control(`${sessionPath}/heartbeat`, { runnerId: RUNNER }).then(
    () => log({ sessionId: session.id, heartbeat: 'ok' }),
    (error: Error) => log({ sessionId: session.id, heartbeat: error.message }),
  );
}, 600_000);

const hold = async () => {
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
  let state = await read();
  log({ sessionId: session.id, activation: handshake.status, status: state?.status ?? 'unknown' });
  if (!handshake.ok) throw new Error(`activation answered ${handshake.status}`);
  while (!stopped && (!state || open(state))) {
    await pause(30_000);
    state = await read();
    if (!state) log({ sessionId: session.id, status: 'unknown', holding: true });
  }
};

/** Line-buffered, so a credential split across two chunks is whole when it is redacted. */
const sink = (file: string, check: (line: string) => void) => {
  let rest = '';
  append(file, '');
  return {
    push(chunk: string) {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop()!;
      if (!lines.length) return;
      lines.forEach(check);
      append(file, redact(lines.join('\n') + '\n'));
    },
    end() {
      if (!rest) return;
      check(rest);
      append(file, redact(rest));
    },
  };
};
const launch = async (attempt: number): Promise<number> => {
  const workspace = join(out, 'workspaces', session.id);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
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
    const computes = COMPUTE_STATES.includes(session.execution.state);
    args = args.map((arg) =>
      arg === 'sandbox_workspace_write.network_access=false'
        ? 'sandbox_workspace_write.network_access=true'
        : arg,
    );
    stdin = stdin.replace(
      'Frozen assignment:',
      `${
        computes
          ? 'This stage has network access: acquire the data and compute the assignment names, outside Merv, and bring the evidence back as artifacts.'
          : `This stage has network access and read-only Sandboxes tools (${PLANNING_TOOLS.join(', ')}): price and size the machine the plan needs, and rent none; the running stage does the compute.`
      }\nFrozen assignment:`,
    );
    if (sandboxesUrl) {
      env[GRANT] = sandboxesToken!;
      const tools = computes ? '' : `,enabled_tools=${JSON.stringify(PLANNING_TOOLS)}`;
      args.splice(
        args.length - 1,
        0,
        '-c',
        `mcp_servers.sandboxes={url=${JSON.stringify(sandboxesUrl)},bearer_token_env_var="${GRANT}",required=true,startup_timeout_sec=120,default_tools_approval_mode="approve"${tools}}`,
      );
    }
  }
  const stem = join(
    out,
    `${new Date().toISOString().replace(/[:.]/g, '')}-${session.id}-${attempt}`,
  );
  log({ sessionId: session.id, launch: attempt, model: o.model, network: o.network, files: stem });
  let mentions = 0;
  let handshakeFailed = false;
  const jsonl = sink(`${stem}.jsonl`, (line) => {
    if (/\.merv\b|\.codex\/auth/.test(line.split(out).join('<out>'))) mentions++;
  });
  const stderr = sink(`${stem}.stderr.log`, (line) => {
    handshakeFailed ||= line.includes('MCP servers failed to initialize');
  });
  const child = spawn(spec.executable, args, { cwd: workspace, env, stdio: 'pipe' });
  child.stdout.setEncoding('utf8').on('data', jsonl.push);
  child.stderr.setEncoding('utf8').on('data', stderr.push);
  child.stdin.on('error', (error) => stderr.push(`stdin: ${error.message}\n`));
  child.stdin.end(stdin);
  interrupted = () => child.kill('SIGTERM');
  const code = await new Promise<number>((done) => {
    child.once('error', (error) => {
      stderr.push(`spawn: ${error.message}\n`);
      done(127);
    });
    child.once('close', (exit, signal) => done(exit ?? (signal ? signalCode(signal) : 1)));
  });
  jsonl.end();
  stderr.end();
  log({ sessionId: session.id, launch: attempt, exitCode: code });
  if (mentions) log({ sessionId: session.id, launch: attempt, credentialPathMentions: mentions });
  // A transient server error at Codex's MCP handshake leaves the lease usable: launch it once more.
  if (code !== 0 && attempt === 1 && !stopped && handshakeFailed && open(await read())) {
    await pause(45_000);
    if (!stopped) return await launch(2);
  }
  return code;
};

let codexCode: number | undefined;
let end: State | undefined;
try {
  if (stopped) log({ sessionId: session.id, interrupted: stopped });
  else if (o['offer-only']) await hold();
  else codexCode = await launch(1);
} catch (error) {
  log({ sessionId: session.id, failed: (error as Error).message });
} finally {
  clearInterval(beat);
  end = await finish();
}
const exitCode = stopped
  ? signalCode(stopped)
  : closedHere || !end
    ? 4
    : o['offer-only']
      ? 0
      : end.outcome === 'completed'
        ? (codexCode ?? 4)
        : 4;
log({
  sessionId: session.id,
  codexExitCode: codexCode,
  status: end?.status,
  outcome: end?.outcome,
  exitCode,
});
process.exit(exitCode);
