#!/usr/bin/env node
/**
 * The board's connector: runs on your machine, dials out to the board server every 2 s, and runs
 * your own Claude Code and Codex over ACP (claude-agent-acp, codex-acp) in a git worktree of the
 * repo you hand each session to. Their own permission prompts stay on and come to the board.
 *
 *   node connect.mjs --server URL --project ID --key KEY --repo DIR [--repo DIR] [--name NAME]
 *                    [--claude-config DIR] [--claude-mode default] [--codex-mode workspace-write]
 *
 * Or MERV_URL, MERV_PROJECT, MERV_KEY and CLAUDE_CONFIG_DIR. Sent: repo folder names, which
 * harnesses answer `--version`, the agent's messages, one line per tool call, approval questions,
 * a diffstat and a branch name. Never sent: paths, file contents, diffs or any credential.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};
const args = (name) => argv.flatMap((one, at) => (one === `--${name}` ? [argv[at + 1]] : []));
const server = (arg('server', process.env.MERV_URL) ?? '').replace(/\/$/, '');
const project = arg('project', process.env.MERV_PROJECT);
const key = arg('key', process.env.MERV_KEY);
const name = arg('name', process.env.HOSTNAME?.split('.')[0] ?? 'My Mac');
const modes = { claude: arg('claude-mode', 'default'), codex: arg('codex-mode', 'workspace-write') };
const repos = new Map();
for (const dir of args('repo')) {
  const path = resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME ?? ''));
  if (!existsSync(join(path, '.git'))) {
    console.error(`Not a git repo: ${dir}`);
    process.exit(2);
  }
  let label = basename(path);
  for (let n = 2; repos.has(label); n++) label = `${basename(path)} ${n}`;
  repos.set(label, path);
}
if (!server || !project || !key || !repos.size) {
  console.error('Usage: connect.mjs --server URL --project ID --key KEY --repo DIR [--repo DIR]');
  process.exit(2);
}
const log = (...words) => console.log(new Date().toISOString().slice(11, 19), ...words);
const bin = (which) =>
  new URL(`node_modules/.bin/${which === 'claude' ? 'claude-agent-acp' : 'codex-acp'}`, import.meta.url)
    .pathname;

/** Claude's config folder: an option, the environment, or what the shell's `claude` alias sets. */
function claudeConfigDir() {
  const given = arg('claude-config', process.env.CLAUDE_CONFIG_DIR);
  if (given) return given.replace(/^~(?=$|\/)/, process.env.HOME ?? '');
  const said = spawnSync(process.env.SHELL ?? 'sh', ['-ic', 'alias claude'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).stdout;
  const found = /CLAUDE_CONFIG_DIR=(\S+)/.exec(said ?? '')?.[1]?.replace(/^['"]|['"]$/g, '');
  return found?.replace(/^~(?=$|\/)/, process.env.HOME ?? '');
}
const claudeDir = claudeConfigDir();
const envOf = (which) =>
  which === 'claude'
    ? { ...process.env, ...(claudeDir && { CLAUDE_CONFIG_DIR: claudeDir }) }
    : // Codex's JS "code mode" runs commands with no approval at all; the plain shell tool asks.
      { ...process.env, CODEX_CONFIG: JSON.stringify({ features: { code_mode_host: false } }) };
const answers = (which) =>
  spawnSync(which, ['--version'], { encoding: 'utf8', env: envOf(which), timeout: 15000 }).status === 0;
const have = { claude: answers('claude'), codex: answers('codex') };
log(`Claude Code ${have.claude ? 'on' : 'off'}${claudeDir ? ` (config ${claudeDir})` : ''}, Codex ${have.codex ? 'on' : 'off'}`);
log(`Folders: ${[...repos.keys()].join(', ')}`);

async function call(tool, input) {
  const response = await fetch(`${server}/tools/${tool}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'x-merv-project-id': project,
    },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${tool}: ${response.status} ${body.error?.message ?? ''}`);
  return body.result;
}
const git = (cwd, ...rest) => spawnSync('git', rest, { cwd, encoding: 'utf8' });
const short = (run) => run.id.slice(-8);

/** A worktree of its own per session, on its own branch, so your checkout is never edited. */
function worktree(run) {
  const repo = repos.get(run.repo);
  if (!repo) throw new Error(`Folder not offered: ${run.repo}`);
  const dir = join(repo, '.board-worktrees', short(run));
  if (!existsSync(dir)) {
    mkdirSync(join(repo, '.board-worktrees'), { recursive: true });
    // Kept out of the repo's own status, without touching a tracked file.
    const exclude = join(repo, '.git', 'info', 'exclude');
    if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').includes('.board-worktrees'))
      appendFileSync(exclude, '\n.board-worktrees/\n');
    const made = git(repo, 'worktree', 'add', '-q', '-B', `board/${short(run)}`, dir, 'HEAD');
    if (made.status !== 0) throw new Error(`worktree: ${made.stderr.trim()}`);
  }
  return dir;
}

const firstPrompt = (run) =>
  [
    `From a whiteboard: ${run.brief}`,
    run.words && `\nWhat the selected shapes say:\n${run.words}`,
    '\nYou are in a git worktree on a branch of your own; work here. Keep it small. When done, say in a few lines what you changed.',
  ]
    .filter(Boolean)
    .join('\n');

const live = new Map();

/** One session: its process, its ACP connection and what it is in the middle of. */
async function open(run) {
  const cwd = worktree(run);
  const child = spawn(bin(run.harness), [], { cwd, env: envOf(run.harness), stdio: ['pipe', 'pipe', 'ignore'] });
  const me = {
    run,
    child,
    cwd,
    agent: null,
    sessionId: run.session,
    turn: null,
    queue: [],
    asks: new Map(),
    pending: new Map(),
    tools: new Map(),
    message: null,
    count: 0,
    last: '',
    loading: false,
    flushing: null,
    sending: Promise.resolve(),
  };
  const report = (body) => call('handoff.report', { run: run.id, ...body }).catch((error) => log(error.message));
  const flush = () => {
    if (me.flushing) clearTimeout(me.flushing);
    me.flushing = null;
    if (!me.pending.size) return Promise.resolve();
    const events = [...me.pending.values()];
    me.pending.clear();
    // Reports go one after another: two in flight would race for the run's record.
    return (me.sending = me.sending.then(() => report({ events })));
  };
  me.flush = flush;
  const note = (event) => {
    me.pending.set(event.id, event);
    me.flushing ??= setTimeout(flush, 600);
  };
  const app = client({ name: 'merv-board' })
    .onNotification('session/update', ({ params }) => {
      if (me.loading) return;
      const u = params.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        // Unique across restarts of this process: an id names one row of the session's record.
        me.message ??= { id: `m${Date.now().toString(36)}${++me.count}`, kind: 'agent', text: '' };
        me.message.text = (me.message.text + u.content.text).slice(0, 20000);
        me.last = me.message.text;
        note(me.message);
      } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        if (u.sessionUpdate === 'tool_call') me.message = null;
        const held = me.tools.get(u.toolCallId) ?? { id: u.toolCallId, kind: 'tool', text: u.kind ?? 'tool' };
        if (u.title) held.text = u.title.slice(0, 200);
        if (u.status) held.status = u.status;
        me.tools.set(u.toolCallId, held);
        if (me.tools.size > 200) me.tools.delete(me.tools.keys().next().value);
        note({ ...held });
      }
    })
    .onRequest('session/request_permission', async ({ params, signal }) => {
      const tc = params.toolCall ?? {};
      const id = tc.toolCallId ?? `ask${Date.now()}`;
      const options = params.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind }));
      // The question in full: Codex says "Run command" and puts the command in the input.
      const raw = tc.rawInput ?? {};
      const detail = [raw.command, raw.url, ...(tc.content ?? []).map((c) => c.content?.text)]
        .flat()
        .filter((one) => typeof one === 'string' && one && one !== tc.title)
        .join(' · ');
      const title = `${tc.title ?? 'Allow this?'}${detail ? `: ${detail}` : ''}`.slice(0, 400);
      await flush();
      await report({ state: 'asking', ask: { id, title, options } });
      const chosen = await new Promise((resolve) => {
        me.asks.set(id, resolve);
        signal?.addEventListener('abort', () => resolve(null), { once: true });
      });
      me.asks.delete(id);
      return chosen
        ? { outcome: { outcome: 'selected', optionId: chosen } }
        : { outcome: { outcome: 'cancelled' } };
    })
    .onRequest('*', () => {
      throw new Error('unsupported');
    });
  const conn = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  me.agent = conn.agent;
  child.once('exit', (code) => {
    live.delete(run.id);
    if (me.turn) void report({ state: 'failed', error: `${run.harness} exited (${code})` });
  });
  await me.agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'merv-board', version: '0.1' },
  });
  let fresh = !me.sessionId;
  if (me.sessionId) {
    me.loading = true;
    try {
      await me.agent.request('session/load', { sessionId: me.sessionId, cwd, mcpServers: [] });
    } catch {
      fresh = true;
    }
    me.loading = false;
  }
  if (fresh) {
    const made = await me.agent.request('session/new', { cwd, mcpServers: [] });
    me.sessionId = made.sessionId;
    await me.agent.request('session/set_mode', { sessionId: me.sessionId, modeId: modes[run.harness] }).catch(() => {});
    await report({ session: me.sessionId });
    if (run.state === 'queued') {
      const blocks = [{ type: 'text', text: firstPrompt(run) }];
      if (run.picture) blocks.push({ type: 'image', data: run.picture.data, mimeType: run.picture.mimeType });
      prompt(me, blocks);
    }
  }
  return me;
}

/** One turn: a prompt, its stream, and at its end the branch's state. */
function prompt(me, blocks) {
  const { run } = me;
  const report = (body) => call('handoff.report', { run: run.id, ...body }).catch((error) => log(error.message));
  me.message = null;
  void report({ state: 'running' });
  me.turn = me.agent
    .request('session/prompt', { sessionId: me.sessionId, prompt: blocks })
    .then(
      ({ stopReason }) => stopReason,
      (error) => {
        log(`${short(run)}: ${error.message}`);
        return 'error';
      },
    )
    .then((stopReason) => {
      me.turn = null;
      me.message = null;
      return me.flush().then(() => stopReason);
    })
    .then((stopReason) => {
      const branch = `board/${short(run)}`;
      git(me.cwd, 'add', '-A');
      git(me.cwd, '-c', 'user.name=Board', '-c', 'user.email=board@merv', 'commit', '-qm', run.brief.slice(0, 72));
      const base = git(me.cwd, 'log', '-g', '--format=%H', `refs/heads/${branch}`).stdout.trim().split('\n').pop();
      const stat = base ? git(me.cwd, 'diff', '--stat', base, 'HEAD').stdout.trim().slice(0, 2000) : '';
      void report({
        state: stopReason === 'cancelled' ? 'stopped' : stopReason === 'error' ? 'failed' : 'done',
        ...(stopReason === 'error' && { error: 'The turn failed; say something to try again' }),
        result: { summary: me.last.slice(0, 4000), branch, dir: `${run.repo}/.board-worktrees/${short(run)}`, stat },
      });
      const next = me.queue.shift();
      if (next) prompt(me, [{ type: 'text', text: next }]);
    });
}

async function command(me, cmd) {
  const { agent, sessionId } = me;
  switch (cmd.kind) {
    case 'stop':
      if (me.turn) await agent.notify('session/cancel', { sessionId });
      return;
    case 'answer':
      me.asks.get(cmd.ask)?.(cmd.option);
      return;
    case 'steer':
      if (!me.turn) return prompt(me, [{ type: 'text', text: cmd.text }]);
      try {
        await agent.request('_session/steering', { sessionId, prompt: [{ type: 'text', text: cmd.text }] });
      } catch {
        me.queue.push(cmd.text);
      }
      return;
    case 'say':
      if (me.turn) me.queue.push(cmd.text);
      else prompt(me, [{ type: 'text', text: cmd.text }]);
  }
}

const started = new Date().toISOString();
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const { runs } = await call('handoff.poll', { name, repos: [...repos.keys()], ...have, started });
    for (const run of runs) {
      let me = live.get(run.id);
      if (!me) {
        me = open(run).catch((error) => {
          live.delete(run.id);
          log(`${short(run)}: ${error.message}`);
          void call('handoff.report', { run: run.id, state: 'failed', error: error.message.slice(0, 400) }).catch(() => {});
        });
        live.set(run.id, me);
        log(`${short(run)}: ${run.harness} in ${run.repo}: ${run.brief}`);
      }
      const session = await me;
      if (session) for (const cmd of run.commands ?? []) await command(session, cmd);
    }
  } catch (error) {
    log(error.message);
  }
  polling = false;
}
setInterval(poll, 2000);
void poll();
log(`Connected to ${server} as ${name}`);
const bye = () => {
  for (const me of live.values()) void Promise.resolve(me).then((s) => s?.child.kill());
  process.exit(0);
};
process.once('SIGINT', bye);
process.once('SIGTERM', bye);
