/**
 * Sessions' agent stream, as pure rules the runner runs too (`@merv/sessions/agent-stream`).
 *
 * What a worker agent is doing, as the runner reads it from the agent's own output and Sessions
 * keeps and relays it: its thinking, what it says, the tools it calls and what they answer. One
 * shape for every harness (Claude Code's stream-json, Codex's --json), so the page that draws it
 * never learns which agent wrote it.
 *
 * A block that is still being written arrives in pieces under one `id`: each piece's `delta` is
 * appended to the ones before it, and `done` closes the block. A block sent whole is one event with
 * `done`. Every text is scrubbed of credentials before it leaves the machine. Thinking and text
 * longer than AGENT_EVENT_TEXT characters are split into more pieces, nothing dropped; a tool's
 * input or output is cut to AGENT_EVENT_TEXT characters, and `cut` counts what was dropped.
 */
export const AGENT_EVENT_TEXT = 16_000;

export type AgentEvent =
  | { kind: 'thinking'; id: string; delta: string; done?: boolean; cut?: number }
  | { kind: 'text'; id: string; delta: string; done?: boolean; cut?: number }
  /** `input` is the call's arguments as JSON text. */
  | { kind: 'tool_call'; id: string; name: string; input: string; cut?: number }
  /** Answers the call with the same `id`. */
  | { kind: 'tool_result'; id: string; output: string; error?: boolean; cut?: number }
  /** The session's own milestones: started, resumed a conversation, finished, its usage. */
  | { kind: 'status'; id: string; text: string };

/** One event as Sessions keeps it: numbered from 1 within its session, in the order it arrived. */
export interface AgentStreamEvent {
  seq: number;
  at: string;
  event: AgentEvent;
}

// ─── Reading a harness's own output as AgentEvents ─────────────────────────────────────────
// The runner reads its agent's log with these as it streams; Sessions reads a stored transcript
// back with the same readers, so a visit whose stream was pruned reads as it streamed.

/** A harness's JSON line, read field by field. */
export type HarnessLine = Record<string, any>;
export const readLine = (line: string): HarnessLine | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as HarnessLine)
      : undefined;
  } catch {
    return undefined;
  }
};
const str = (value: unknown) => (typeof value === 'string' ? value : '');
/** What a tool answered: its text, with anything else named by its type. */
const answer = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part?.type === 'text' ? str(part.text) : `[${str(part?.type) || 'content'}]`,
          )
          .join('\n')
      : '';

// ─── How Claude Code names a Merv tool, both ways ──────────────────────────────────────────
const MERV_PREFIX = 'mcp__merv__';
/** The name a runner allows a Merv tool under: MCP names keep only letters, digits, _ and -. */
export const claudeToolName = (name: string) =>
  `${MERV_PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
/** A Merv tool as its own name, another server's as `server.tool`, a built-in as itself. */
const claudeTool = (name: string) =>
  name.startsWith(MERV_PREFIX)
    ? name.slice(MERV_PREFIX.length)
    : name.replace(/^mcp__([^_]+(?:_[^_]+)*?)__/, '$1.');

/**
 * Reads Claude Code's stream-json, with --include-partial-messages. A block's pieces are taken
 * only after their message's start was read, so a reader that began mid-message adds nothing to
 * a block it never saw open.
 */
export function claudeEvents() {
  let message = '';
  /** Messages whose thinking and text arrived in pieces; their whole copies are skipped. */
  const streamed = new Set<string>();
  const blocks = new Map<number, { kind: 'thinking' | 'text'; id: string }>();
  return (text: string, at: number): AgentEvent[] => {
    const line = readLine(text);
    if (!line) return [];
    if (line.type === 'system')
      return line.subtype === 'init'
        ? [{ kind: 'status', id: `status-${at}`, text: `Started · ${str(line.model)}` }]
        : [];
    if (line.type === 'result')
      return [
        {
          kind: 'status',
          id: `status-${at}`,
          text: `${line.is_error ? 'Failed' : 'Finished'} · ${str(line.subtype)}${Number.isSafeInteger(line.num_turns) ? ` · ${line.num_turns} turns` : ''}`,
        },
      ];
    if (line.type === 'stream_event') {
      const event: HarnessLine = line.event ?? {};
      if (event.type === 'message_start') {
        message = str(event.message?.id);
        streamed.add(message);
        if (streamed.size > 64) streamed.delete(streamed.values().next().value!);
        blocks.clear();
        return [];
      }
      const block = blocks.get(event.index);
      if (event.type === 'content_block_start') {
        const kind = event.content_block?.type;
        if ((kind !== 'thinking' && kind !== 'text') || !message) return [];
        const id = `${message}.${event.index}`;
        blocks.set(event.index, { kind, id });
        return [{ kind, id, delta: '' }];
      }
      if (event.type === 'content_block_delta' && block) {
        const piece = block.kind === 'thinking' ? event.delta?.thinking : event.delta?.text;
        return typeof piece === 'string' && piece ? [{ ...block, delta: piece }] : [];
      }
      if (event.type === 'content_block_stop' && block) {
        blocks.delete(event.index);
        return [{ ...block, delta: '', done: true }];
      }
      return [];
    }
    if (line.type === 'assistant') {
      const id = str(line.message?.id);
      const content: HarnessLine[] = Array.isArray(line.message?.content)
        ? line.message.content
        : [];
      return content.flatMap((item, index): AgentEvent[] => {
        if (item?.type === 'tool_use')
          return [
            {
              kind: 'tool_call',
              id: str(item.id),
              name: claudeTool(str(item.name)),
              input: JSON.stringify(item.input ?? {}),
            },
          ];
        // Sent whole only where no piece of it was.
        const kind = item?.type;
        if ((kind !== 'thinking' && kind !== 'text') || streamed.has(id) || !str(item[kind]))
          return [];
        return [{ kind, id: `${id}.whole${at}-${index}`, delta: str(item[kind]), done: true }];
      });
    }
    if (line.type === 'user') {
      const content: HarnessLine[] = Array.isArray(line.message?.content)
        ? line.message.content
        : [];
      return content.flatMap((item): AgentEvent[] =>
        item?.type === 'tool_result'
          ? [
              {
                kind: 'tool_result',
                id: str(item.tool_use_id),
                output: answer(item.content),
                ...(item.is_error === true ? { error: true } : {}),
              },
            ]
          : [],
      );
    }
    return [];
  };
}

/** A Codex tool item: its call, and on completion its answer. */
function codexCall(item: HarnessLine) {
  const failed = item.status === 'failed';
  if (item.type === 'command_execution')
    return {
      name: 'shell',
      input: str(item.command),
      output: str(item.aggregated_output),
      error: failed || (typeof item.exit_code === 'number' && item.exit_code !== 0),
    };
  if (item.type === 'mcp_tool_call')
    return {
      name: item.server === 'merv' ? str(item.tool) : `${str(item.server)}.${str(item.tool)}`,
      input: JSON.stringify(item.arguments ?? {}),
      output: item.error ? str(item.error.message) : answer(item.result?.content),
      error: failed || !!item.error,
    };
  if (item.type === 'file_change')
    return {
      name: 'edit',
      input: (Array.isArray(item.changes) ? item.changes : [])
        .map((change: HarnessLine) => `${str(change?.kind)} ${str(change?.path)}`)
        .join('\n'),
      output: str(item.status),
      error: failed,
    };
  return { name: 'web_search', input: str(item.query), output: '', error: failed };
}
const CODEX_TOOLS = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search']);

/** Reads `codex exec --json`. */
export function codexEvents() {
  const started = new Set<string>();
  return (text: string, at: number): AgentEvent[] => {
    const status = (said: string): AgentEvent[] => [
      { kind: 'status', id: `status-${at}`, text: said },
    ];
    const line = readLine(text);
    if (!line) return [];
    if (line.type === 'thread.started') return status('Started');
    if (line.type === 'turn.completed') {
      const usage = line.usage ?? {};
      return status(
        `Turn completed · ${Number(usage.input_tokens) || 0} tokens in · ${Number(usage.output_tokens) || 0} out`,
      );
    }
    if (line.type === 'turn.failed') return status(`Turn failed · ${str(line.error?.message)}`);
    if (line.type === 'error') return status(`Error · ${str(line.message)}`);
    if (line.type !== 'item.started' && line.type !== 'item.completed') return [];
    const item: HarnessLine = line.item ?? {};
    const id = str(item.id),
      done = line.type === 'item.completed';
    if (item.type === 'reasoning' || item.type === 'agent_message')
      return done && str(item.text)
        ? [
            {
              kind: item.type === 'reasoning' ? 'thinking' : 'text',
              id,
              delta: str(item.text),
              done: true,
            },
          ]
        : [];
    // Codex reports its non-fatal warnings as error items; a fatal error is the top-level line.
    if (item.type === 'error') return done ? status(`Warning · ${str(item.message)}`) : [];
    if (!CODEX_TOOLS.has(item.type)) return [];
    const { name, input, output, error } = codexCall(item);
    const event: AgentEvent = { kind: 'tool_call', id, name, input };
    if (!done) {
      started.add(id);
      return [event];
    }
    return [
      ...(started.delete(id) ? [] : [event]),
      { kind: 'tool_result', id, output, ...(error ? { error: true } : {}) },
    ];
  };
}

// ─── What each event is to a person reading it ─────────────────────────────────────────────
// Sessions says what an event is; a page only draws it. A conversation reads as what the agent
// said (`message`), the steps it took on the way (`thinking`, `tool`), the ones that went wrong
// (`error`), the people over it (`person`: a message, a question or an answer, which Sessions
// keeps beside the stream) and the session's own milestones (`system`). A milestone a person
// has no use for (a turn's token count, the model it started on) is `quiet` and not drawn.

export type LineKind = 'message' | 'thinking' | 'tool' | 'error' | 'person' | 'system' | 'quiet';

/** The longest summary a step's line carries. */
export const SUMMARY_CHARS = 80;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A prefixed record id: `pipe_yvs82yw2idgtz0n2`, `session_a82de33c…`, `wf_000…1`. */
const PREFIXED = /\b[a-z][a-z0-9]*_(?=[a-z0-9]*\d)[a-z0-9]{10,}\b/gi;
/** A hash or a short commit: hex with a digit and a letter in it, seven characters or more. */
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi;

/**
 * Text as one short line a person reads: ids, hashes and UUIDs taken out with what only
 * framed them (empty quotes, a doubled slash), white space run together, and cut to `max`.
 */
export function plainLine(text: string, max = SUMMARY_CHARS): string {
  const line = text
    .replace(UUID, '')
    .replace(PREFIXED, '')
    .replace(HASH, '')
    .replace(/(["'`])\1/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,:;)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/(?:[\s,:;=/#-]|\(\)|\[\]|\{\})+$/, '')
    .replace(/^[\s,:;=/#-]+/, '')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The fields whose value says what a call is about, most telling first. */
const TELLING = ['description', 'command', 'cmd', 'query', 'pattern', 'file_path', 'path', 'url'];

/** A tool's arguments as an object, or the text itself where they are not JSON. */
function fieldsOf(input: string): Record<string, unknown> | string {
  try {
    const value: unknown = JSON.parse(input);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
    return typeof value === 'string' ? value : input;
  } catch {
    // Arguments a feed cut short are no longer JSON: the telling field is read from its start.
    const named = new RegExp(`"(${TELLING.join('|')})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(input);
    return named ? { [named[1]!]: JSON.parse(`"${named[2]!.replace(/\\$/, '')}"`) } : input;
  }
}

/** A shell's script without the `bash -lc '…'` it was wrapped in. */
function unwrapShell(command: string): string {
  const wrapped = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(command);
  if (!wrapped) return command;
  return wrapped[1] === '"' ? wrapped[2]!.replace(/\\(["\\$`])/g, '$1') : wrapped[2]!;
}
/** Lines a script starts with that say nothing about what it does. */
const SETUP = /^(?:#|set\s+-|import\s|from\s+\S+\s+import\s|export\s+\w+=|source\s|\.\s)/;

/**
 * The first line of a shell command that says what it does: past its wrapper, its setup and a
 * leading `cd … &&`; a script fed through a heredoc is its interpreter and the script's first
 * line that does something.
 */
export function shellLine(command: string): string {
  const lines = unwrapShell(command)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !SETUP.test(line));
  const first = lines[0] ?? '';
  const heredoc = /^(.*?)<<-?\s*(['"]?)(\w+)\2(.*)$/.exec(first);
  const head = (heredoc ? heredoc[1]! : first).replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim();
  if (!heredoc) return head;
  const body = lines.slice(1).find((line) => line !== heredoc[3]);
  return [head, body].filter(Boolean).join(' · ');
}

/** The words for the tools every harness has, by their lower-cased name. */
const VERBS: Record<string, string> = {
  shell: 'Ran shell',
  bash: 'Ran shell',
  exec_command: 'Ran shell',
  local_shell: 'Ran shell',
  read: 'Read file',
  write: 'Wrote file',
  edit: 'Edited file',
  multiedit: 'Edited file',
  notebookedit: 'Edited notebook',
  apply_patch: 'Edited files',
  grep: 'Searched code',
  glob: 'Found files',
  ls: 'Listed files',
  webfetch: 'Fetched page',
  web_search: 'Searched web',
  websearch: 'Searched web',
  todowrite: 'Updated plan',
  update_plan: 'Updated plan',
  task: 'Ran subagent',
  agent: 'Ran subagent',
};
const SHELLS = new Set(['shell', 'bash', 'exec_command', 'local_shell']);

/** A path as its last two parts, which is what a person knows it by. */
const shortPath = (value: string) =>
  /^(?:\/|~\/|\.\/)/.test(value) && !/\s/.test(value)
    ? value.split('/').filter(Boolean).slice(-2).join('/')
    : value;

/**
 * One tool call as a person reads it: a verb and the tool (`Ran shell`, `Read file`, or a Merv
 * tool as `sandboxes · workflow_get`) and what it was about, at most SUMMARY_CHARS and without
 * ids. A shell is its command's first line that does something, unless its harness described it.
 */
export function toolLine(
  name: string | undefined,
  input: string | undefined,
): { label: string; summary: string } {
  const key = (name ?? '').toLowerCase();
  const label = VERBS[key] ?? (name ? name.replace(/\./g, ' · ') : 'Tool');
  const fields = fieldsOf(input ?? '');
  let said = '';
  if (typeof fields === 'string') said = SHELLS.has(key) ? shellLine(fields) : fields;
  else {
    const command = fields.command ?? fields.cmd;
    const script = Array.isArray(command)
      ? command.length === 3 && /sh$/.test(String(command[0])) && /^-l?c$/.test(String(command[1]))
        ? String(command[2])
        : command.join(' ')
      : typeof command === 'string'
        ? command
        : '';
    const telling = TELLING.map((field) => fields[field]).filter(
      (value): value is string => typeof value === 'string' && !!plainLine(value),
    );
    said =
      typeof fields.description === 'string' && plainLine(fields.description)
        ? fields.description
        : script
          ? shellLine(script)
          : (telling[0] ??
            Object.values(fields).find(
              (value): value is string => typeof value === 'string' && !!plainLine(value),
            ) ??
            '');
  }
  return { label, summary: plainLine(shortPath(said.split('\n')[0] ?? '')) };
}

/** An answer with nothing in it: blank, `[]`, `{}`, `null` or `""`. Such an answer is not drawn. */
export const emptyOutput = (output: string | undefined): boolean =>
  !output || /^\s*(?:\[\s*\]|\{\s*\}|null|""|'')?\s*$/.test(output);

/**
 * Why a call failed, in a few words, or undefined where it did not: its harness marked it an
 * error (a refusal, a non-zero exit), or its answer is a JSON refusal (`{"error": …}`, `{"ok":
 * false, …}`). The words are the refusal's message, else the answer's first line, without ids.
 */
export function toolFailure(result: { output: string; error?: boolean }): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(result.output);
  } catch {}
  const object = value && typeof value === 'object' ? (value as Record<string, any>) : undefined;
  const refused = !!object && (object.error !== undefined || object.ok === false);
  if (!result.error && !refused) return undefined;
  const error = object?.error;
  const message =
    typeof error === 'string'
      ? error
      : typeof error?.message === 'string'
        ? error.message
        : typeof object?.message === 'string'
          ? object.message
          : (result.output
              .split('\n')
              .map((line) => line.trim())
              .find(Boolean) ?? '');
  return plainLine(message) || 'failed';
}

/**
 * A session milestone as a person reads it: a failure is an `error`; a stream that skipped
 * output or a conversation compacted is a `system` divider; the rest (started, a turn's tokens,
 * finished) is `quiet`, said already by the visit's own divider.
 */
export function statusLine(text: string): { kind: 'quiet' | 'system' | 'error'; text: string } {
  const [head = '', ...rest] = text.split(' · ');
  const tail = plainLine(rest.join(' · '));
  if (/^(?:Turn failed|Failed|Error)$/.test(head))
    return { kind: 'error', text: tail ? `${head} · ${tail}` : head };
  if (/compact/i.test(text)) return { kind: 'system', text: 'Context compacted' };
  if (/^Stream skipped/.test(head)) return { kind: 'system', text: 'Some output was skipped' };
  return { kind: 'quiet', text: plainLine(text) };
}

/** What one event is to a reader; a tool call is an `error` once its answer says it failed. */
export function lineKind(
  event:
    | { kind: 'thinking' }
    | { kind: 'text' }
    | { kind: 'status'; text: string }
    | { kind: 'tool'; result?: { output: string; error?: boolean } },
): LineKind {
  if (event.kind === 'text') return 'message';
  if (event.kind === 'thinking') return 'thinking';
  if (event.kind === 'status') return statusLine(event.text).kind;
  return event.result && toolFailure(event.result) !== undefined ? 'error' : 'tool';
}
