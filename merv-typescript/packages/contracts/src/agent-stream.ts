/**
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

/** One session of a unit of work, as its panel lists them for the live view. */
export interface AgentStreamSession {
  sessionId: string;
  /** The responsibility it holds, in the workflow's own words: the state and the role. */
  state: string;
  role: string;
  live: boolean;
  startedAt: string;
  endedAt?: string;
  /** The session whose conversation this one continues, where it resumed one. */
  continues?: string;
  /** A same-origin path, read with GET (server-sent events: `snapshot`, then `events`); Sessions serves /sessions/:id/events. */
  events: string;
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

/** A Merv tool as its own name, another server's as `server.tool`, a built-in as itself. */
const claudeTool = (name: string) =>
  name.startsWith('mcp__merv__')
    ? name.slice('mcp__merv__'.length)
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
