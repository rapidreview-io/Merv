/**
 * The Board plugin's one program, for Claude Code on a person's machine: its hooks, its MCP server
 * and its pairing. No dependencies but Node. Bundled into clients/board/board.mjs by
 * scripts/build-client-bundle.mjs. Unattached sessions touch no network, and a hook never fails,
 * so it can never slow or break anyone's Claude by more than its time limit.
 */
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { redact } from './transcript.js';

/** How long a hook waits for the board, and how long it then leaves the board alone. */
const [HOOK_MS, QUIET_MS] = [600, 30_000];
/** The most characters of any one thing that leave the machine. */
const SENT = 200;
/** All of a tool's input that is ever sent. */
const FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'query'];
const HOSTED = 'https://experiments.rapidreview.io';

interface Attached {
  url: string;
  token: string;
  board: string;
}
const fileOf = (data: string, session: string) =>
  join(data, 'attached', `${session.replace(/[^\w-]/g, '')}.json`);
const attachedTo = (data = '', session = ''): Attached | undefined => {
  try {
    return JSON.parse(readFileSync(fileOf(data, session), 'utf8')) as Attached;
  } catch {
    return undefined;
  }
};
const short = (text: unknown) => redact(String(text ?? '')).slice(0, SENT);
const post = async ({ url, token }: Attached, path: string, body: unknown, ms?: number) => {
  const answer = await fetch(`${url}/board-attach${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    ...(ms && { signal: AbortSignal.timeout(ms) }),
  });
  if (!answer.ok) throw new Error((await answer.text()).slice(0, 300));
  return (await answer.json()) as Record<string, any>;
};

/** What a person's hand did, as Claude reads it: the meaning goes with it, so compaction loses none. */
const noted = (board: string, hand: string[]) =>
  `[board ${board}: the person watching this board just did this by hand, to steer you without typing: ${hand.join('; ')}. A stroke across a step of your work means they dropped it: carry on without it. A circle means focus there. The question mark only means software read a stroke, so ask only if acting on it could not easily be undone. Say in one line what you changed.]`;

/** A Claude Code hook's input as the one thing the board is told. */
function stepOf(input: Record<string, any>) {
  const event = input.hook_event_name as string;
  const lane = input.agent_type ? { lane: String(input.agent_type) } : {};
  if (event === 'UserPromptSubmit') return { kind: 'person', text: short(input.prompt), ask: true };
  if (event === 'Stop') return { kind: 'say', text: short(input.last_assistant_message) };
  if (event === 'SessionEnd') return { kind: 'say', text: '', ended: true };
  const tool = input.tool_input ?? {};
  const field = FIELDS.find((name) => tool[name] !== undefined);
  const done = event !== 'PreToolUse';
  return {
    kind: 'call',
    key: input.tool_use_id,
    tool: input.tool_name,
    text: field ? short(tool[field]) : '',
    ...lane,
    ...(done && { done: true, ask: true }),
    ...(event === 'PostToolUseFailure' && { failed: true }),
  };
}

async function hook() {
  let raw = '';
  for await (const part of process.stdin) raw += part;
  const input = JSON.parse(raw) as Record<string, any>;
  const data = process.env.CLAUDE_PLUGIN_DATA;
  const attached = attachedTo(data, input.session_id);
  if (!attached) return;
  const file = fileOf(data!, input.session_id);
  const ended = input.hook_event_name === 'SessionEnd';
  if (ended) rmSync(file, { force: true });
  // Its time is when the board last failed: the file's own, set in the future, so nothing else moves.
  if ((statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) > Date.now()) return;
  try {
    const { board, hand } = await post(attached, '/event', stepOf(input), HOOK_MS);
    if (hand?.length)
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: input.hook_event_name,
            additionalContext: noted(board, hand),
          },
        }),
      );
  } catch {
    const until = new Date(Date.now() + QUIET_MS);
    if (!ended) utimesSync(file, until, until);
  }
}

async function pair([code = '', session = '', data = '']: string[]) {
  const url = (process.env.BOARD_URL ?? HOSTED).replace(/\/$/, '');
  const name = `Claude ${basename(process.cwd())}`.replace(/[^\w .-]/g, '').slice(0, 40);
  const answer = await fetch(`${url}/board-attach/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!answer.ok) return console.log(`Not attached: ${(await answer.text()).slice(0, 200)}`);
  const { token, board, title } = (await answer.json()) as Record<string, string>;
  mkdirSync(join(data, 'attached'), { recursive: true, mode: 0o700 });
  const file = fileOf(data, session);
  writeFileSync(file, JSON.stringify({ url, token, board }), { mode: 0o600 });
  console.log(
    `Attached to board "${title}" (${board}) as ${name}; board_read and board_write always act on it. Sent while attached: prompts and Claude's closing words (first ${SENT} characters), tool names with their command, path, pattern or URL (first ${SENT} characters, and a command can hold text), and what is drawn. Never tool output.`,
  );
}

/** The MCP server: the board's tools by way of this session's own attachment, read per call. */
function mcp() {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const data = process.env.CLAUDE_PLUGIN_DATA;
  const url = (process.env.BOARD_URL ?? HOSTED).replace(/\/$/, '');
  const say = (id: unknown, result: unknown) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  const text = (words: string) => ({ isError: true, content: [{ type: 'text', text: words }] });
  const notify = (method: string) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  let listed: { instructions: string; tools: any[] } = { instructions: '', tools: [] };
  /** The board's tools; if it is down now, they appear when it comes back, and nothing waits. */
  const discover = async (): Promise<void> => {
    try {
      const answer = await fetch(`${url}/board-attach/tools`, {
        signal: AbortSignal.timeout(5_000),
      });
      listed = (await answer.json()) as typeof listed;
      if (started) notify('notifications/tools/list_changed');
    } catch {
      setTimeout(() => void discover(), QUIET_MS).unref();
    }
  };
  let started = false;
  const first = discover().finally(() => (started = true));
  createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params } = JSON.parse(line) as Record<string, any>;
    void (async () => {
      if (method === 'initialize') {
        await first;
        const { instructions } = listed;
        say(id, {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'board', version: '0.1.0' },
          instructions,
        });
      } else if (method === 'tools/list') {
        say(id, {
          tools: listed.tools.map((tool) => ({ ...tool, name: tool.name.replace('.', '_') })),
        });
      } else if (method === 'tools/call') {
        const attached = attachedTo(data, session);
        if (!attached)
          return say(id, text('Not attached: get a code from the board and run /board:pair CODE'));
        const name = String(params.name).replace('_', '.');
        say(
          id,
          await post(attached, '/call', { name, input: params.arguments ?? {} }).catch(
            (error: Error) => text(error.message),
          ),
        );
      } else if (id !== undefined) say(id, {});
    })();
  });
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'mcp') mcp();
else (mode === 'pair' ? pair(rest) : hook()).catch(() => undefined);
