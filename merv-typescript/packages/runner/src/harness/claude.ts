import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { check } from '@merv/contracts';
import { claudeEvents, claudeToolName, readLine } from '@merv/sessions/agent-stream';
import type { SessionUsageReport } from '@merv/sessions/types';
import type { RunnerProfile } from '../profiles.js';
import {
  counted,
  entries,
  firstId,
  type Harness,
  INTERNET_READS,
  type LaunchFacts,
  type Launcher,
  sessionTokenVariable,
} from './shared.js';

type Claude = Extract<RunnerProfile, { harness: 'claude' }>;

const cache = ['cache_creation_input_tokens', 'cache_read_input_tokens'];
/** A bounded line and bounded retained message ids; an incomplete sum is never reported. */
const usageLimit = 16 << 20;

/** What a log's lines spent: kept between reads of a growing log, which resume at `at`, where its
 *  first unfinished line begins. A line folded again changes nothing, so that one is on each read. */
export const claudeTally = () => ({
  at: 0,
  total: undefined as SessionUsageReport | undefined,
  incomplete: false,
  retained: 0,
  each: new Map<string, SessionUsageReport>(),
});
export type ClaudeTally = ReturnType<typeof claudeTally>;
function usage(lines: Iterable<string | undefined>, model?: string, t = claudeTally()) {
  for (const line of lines) {
    if (line === undefined) {
      t.incomplete = true;
      t.each.clear();
      t.total = undefined;
      continue;
    }
    if (!line.includes('"result"') && !line.includes('"assistant"')) continue;
    const event = readLine(line);
    if (event?.type === 'result') t.total = counted(event.usage, cache) ?? t.total;
    const item = event?.type === 'assistant' && counted(event.message?.usage, cache);
    const id = event?.message?.id;
    if (!t.incomplete && item && typeof id === 'string') {
      if (!t.each.has(id)) t.retained += id.length + 64;
      if (t.retained > usageLimit) {
        t.incomplete = true;
        t.each.clear();
      } else t.each.set(id, item);
    }
  }
  let total = t.total;
  if (!total && !t.incomplete && t.each.size) {
    total = { inputTokens: 0, outputTokens: 0 };
    for (const item of t.each.values()) {
      total.inputTokens += item.inputTokens;
      total.outputTokens += item.outputTokens;
    }
  }
  return total && { ...total, ...(model && { model }) };
}

/** Read the whole log, or on from `t`: assistant usage is per call, so a tail cannot give it. */
export function claudeLogUsage(path: string, model?: string, t = claudeTally()) {
  function* lines() {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return;
      const bytes = Buffer.alloc(64 << 10),
        decoder = new StringDecoder('utf8');
      let pending: string | undefined = '';
      const append = (text: string) => {
        if (pending !== undefined)
          pending = pending.length + text.length > usageLimit ? undefined : pending + text;
      };
      for (let at = t.at; at < stat.size;) {
        const got = readSync(fd, bytes, 0, Math.min(bytes.length, stat.size - at), at);
        if (!got) {
          yield undefined;
          return;
        }
        at += got;
        const text = decoder.write(bytes.subarray(0, got));
        let start = 0;
        for (let end; (end = text.indexOf('\n', start)) >= 0; start = end + 1) {
          append(text.slice(start, end));
          yield pending;
          pending = '';
        }
        append(text.slice(start));
        const last = bytes.lastIndexOf(0x0a, got - 1);
        if (last >= 0) t.at = at - got + last + 1;
      }
      append(decoder.end());
      if (pending !== '') yield pending;
    } finally {
      closeSync(fd);
    }
  }
  return usage(lines(), model, t);
}

/**
 * Claude Code. Its `stream-json` ends with one `result` event: its `input_tokens` excludes the
 * cache, so cache writes and reads are added. Its home is the machine's own, which holds its
 * login; a conversation is `projects/<cwd>/<id>.jsonl`, found in any project directory.
 */
/** The project directory Claude Code keeps a launch's conversations in: its cwd, spelled out. */
const project = (cwd: string) => realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-');
export const claude: Harness = {
  name: 'claude',
  lines: claudeEvents,
  // A run stopped before its `result` spent what each of its model calls printed.
  usage: (output, model) => usage(output.split('\n'), model),
  conversationId: (output) =>
    firstId(
      output,
      '"init"',
      (event) => event.type === 'system' && event.subtype === 'init' && event.session_id,
    ),
  resumeRefused: /no conversation found/i,
  line: (head) =>
    head.startsWith('{"type":"stream_event"')
      ? 'delta'
      : /^\{"type":"(?:assistant|result)"/.test(head)
        ? 'whole'
        : undefined,
  home: (_profile, _runDirectory, environment) =>
    environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), '.claude'),
  locate(root, id, cwd) {
    // The launch's own copy first: an inquiry visit elsewhere may hold the same conversation.
    const own = cwd && join(root, 'projects', project(cwd), `${id}.jsonl`);
    if (own && lstatSync(own, { throwIfNoEntry: false })?.isFile()) return own;
    for (const project of entries(join(root, 'projects'))) {
      const path = join(root, 'projects', project.name, `${id}.jsonl`);
      if (project.isDirectory() && lstatSync(path, { throwIfNoEntry: false })?.isFile())
        return path;
    }
    return undefined;
  },
  restorePath: (root, cwd, id) => [join(root, 'projects', project(cwd)), `${id}.jsonl`],
  forget(root, ids, cwd) {
    if (cwd) {
      for (const id of ids)
        for (const name of [`${id}.jsonl`, id])
          rmSync(join(root, 'projects', project(cwd), name), { recursive: true, force: true });
      return;
    }
    for (const id of ids)
      for (const path of [
        ...entries(join(root, 'projects')).flatMap((project) =>
          project.isDirectory()
            ? [`${id}.jsonl`, id].map((name) => join(root, 'projects', project.name, name))
            : [],
        ),
        join(root, 'file-history', id),
        join(root, 'session-env', id),
      ])
        rmSync(path, { recursive: true, force: true });
  },
};

/**
 * Claude Code headless. The same shape as the Codex launch: the Merv server alone, its
 * bearer read from the process environment and never from an argument, no user or
 * project settings, hooks, plugins or skills, and no permission prompts because there
 * is nobody to answer them. A read-only lease keeps only the read tools; the server
 * enforces the fixed manifest and argument bindings on every call either way.
 */
function claudeArgs(
  profile: Claude,
  { request, url, sealed: offline, inquiry, servers: native }: LaunchFacts,
): string[] {
  const readOnly = request.session.execution.policy.readOnly;
  const builtIn = offline
    ? ['Read', 'Glob', 'Grep']
    : ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'];
  const servers = [...(readOnly ? [] : (profile.servers ?? [])), ...native];
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    // Thinking and text arrive while they are written, for the live view.
    '--include-partial-messages',
    ...(request.resume ? ['--resume', request.resume] : []),
    // An inquiry visit forks the conversation it resumes: a work visit of its thread may be
    // running the same one in this home meanwhile, and the fork leaves that one alone.
    ...(request.resume && inquiry ? ['--fork-session'] : []),
    ...(request.session.continuity ? [] : ['--no-session-persistence']),
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        merv: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer \${${sessionTokenVariable}}` },
        },
        ...Object.fromEntries(
          servers.map((server) => [
            server.name,
            {
              type: 'http',
              url: server.url,
              headers: { Authorization: `Bearer \${${server.bearerEnv}}` },
            },
          ]),
        ),
      },
    }),
    '--tools',
    builtIn.join(','),
    '--allowedTools',
    [...builtIn, 'mcp__merv', ...servers.map((server) => `mcp__${server.name}`)].join(','),
    // A sealed review has no shell, so nothing else of it reaches the network.
    ...(offline ? ['--disallowedTools', INTERNET_READS.map(claudeToolName).join(',')] : []),
    '--dangerously-skip-permissions',
    '--model',
    profile.model ?? 'opus',
    ...(profile.effort !== undefined ? ['--effort', profile.effort] : []),
  ];
}

export const claudeLauncher: Launcher<Claude> = {
  agent: claude,
  tuned: true,
  skills: false,
  // Stopped at once: its per-call usage accounts for a run ending before its `result` event.
  handoffGraceMs: 0,
  valid: () => true,
  isolated: () => false,
  networked: () => true,
  huggingface: () => false,
  prepare: () => undefined,
  launch(profile, facts) {
    const { request, environment, servers: native } = facts;
    const readOnly = request.session.execution.policy.readOnly;
    if (!readOnly)
      check(
        !(profile.servers ?? []).some((server) =>
          native.some(
            (connection) =>
              server.name === connection.name || server.bearerEnv === connection.bearerEnv,
          ),
        ),
        'invalid_runner_launch',
        'Private MCP connection conflicts with configured server',
      );
    const args = claudeArgs(profile, facts);
    // A further server's bearer travels the same way as Merv's: by name, from the
    // runner's own environment, never as an argument.
    const bearers: Record<string, string> = {};
    if (!readOnly)
      for (const server of profile.servers ?? []) {
        const value = environment[server.bearerEnv];
        check(
          !!value,
          'invalid_runner_launch',
          `No bearer in ${server.bearerEnv} for ${server.name}`,
        );
        bearers[server.bearerEnv] = value;
      }
    // Claude's Bash inherits its environment, and its shell has the network: the MCP client
    // reads the bearers there, and the script Claude Code sources before every Bash command
    // unsets them, as Codex's shell_environment_policy keeps them from its shell.
    const { shellEnvFile } = request;
    check(
      !!shellEnvFile && isAbsolute(shellEnvFile),
      'invalid_runner_launch',
      'A Claude launch requires a private shell environment file',
    );
    return {
      executable: profile.executable,
      args,
      bearers,
      shellEnvFile,
      // The handshake waits behind the server's writer queue under load, as it did for
      // Codex; a server that lists no tools in time looks connected and useless.
      env: {
        ...facts.runtime,
        MCP_TIMEOUT: '120000',
        MCP_TOOL_TIMEOUT: '600000',
        CLAUDE_ENV_FILE: shellEnvFile!,
      },
      note: 'This session ends the moment you give a final reply, and nothing wakes it later: there is no timer, no callback and no next turn. To wait for remote work, wait inside this session (a shell sleep loop that checks again), then finish the handoff before you reply.',
    };
  },
};
