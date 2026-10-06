import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_EVENT_TEXT, type AgentEvent } from '@merv/contracts';
import type { SessionStreamBatch } from '@merv/sessions/types';
import { RunnerControlError } from './client.js';
import { blankPattern } from './transcript.js';

/**
 * A worker agent's output as it prints it, read back from its run directory's stdout.log (which
 * the guardian has already blanked of exact secrets) and sent to Sessions as AgentEvents. One
 * POST at a time per launch, off the controller's tick: the agent never waits for it.
 */

/** The most of the log one batch reads; its events stay well under a megabyte. */
const CHUNK = 768 << 10;
/** A stream further behind than this jumps to the end of the log and says what it skipped. */
const BEHIND = 4 << 20;
/** What an unfinished block holds back, so a credential split between pieces is blanked whole. */
const CARRY = 4096;
/** Tries after the process ended; the final transcript upload still keeps everything. */
const ENDED_TRIES = 5;

type Harness = 'claude' | 'codex';
// Lines are the harness's own JSON, read field by field.
type Line = Record<string, any>;

const read = (line: string): Line | undefined => {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
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
 * Reads Claude Code's stream-json, with --include-partial-messages, a line at a time; `at` is
 * the line's place in the log, which names what has no id of its own. A block's pieces are taken
 * only after their message's start was read, so a reader that began mid-message adds nothing to
 * a block it never saw open.
 */
function claudeLines() {
  let message = '';
  /** Messages whose thinking and text arrived in pieces; their whole copies are skipped. */
  const streamed = new Set<string>();
  const blocks = new Map<number, { kind: 'thinking' | 'text'; id: string }>();
  return (text: string, at: number): AgentEvent[] => {
    const line = read(text);
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
      const event: Line = line.event ?? {};
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
      const content: Line[] = Array.isArray(line.message?.content) ? line.message.content : [];
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
      const content: Line[] = Array.isArray(line.message?.content) ? line.message.content : [];
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
function codexCall(item: Line): { name: string; input: string; output: string; error: boolean } {
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
        .map((change: Line) => `${str(change?.kind)} ${str(change?.path)}`)
        .join('\n'),
      output: str(item.status),
      error: failed,
    };
  return { name: 'web_search', input: str(item.query), output: '', error: failed };
}
const CODEX_TOOLS = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search']);

/** Reads `codex exec --json` a line at a time; `at` is the line's place in the log. */
function codexLines() {
  const started = new Set<string>();
  return (text: string, at: number): AgentEvent[] => {
    const status = (said: string): AgentEvent[] => [
      { kind: 'status', id: `status-${at}`, text: said },
    ];
    const line = read(text);
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
    const item: Line = line.item ?? {};
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
    if (item.type === 'error') return done ? status(`Error · ${str(item.message)}`) : [];
    if (!CODEX_TOOLS.has(item.type)) return [];
    const { name, input, output, error } = codexCall(item);
    const call: AgentEvent = { kind: 'tool_call', id, name, input };
    if (!done) {
      started.add(id);
      return [call];
    }
    return [
      ...(started.delete(id) ? [] : [call]),
      { kind: 'tool_result', id, output, ...(error ? { error: true } : {}) },
    ];
  };
}

/** One harness's output lines as AgentEvents; it keeps what a block spread over lines needs. */
export const agentLines = (harness: Harness) =>
  harness === 'claude' ? claudeLines() : codexLines();

/** Pieces of one block within a batch become one piece, where its first piece stood; the
 *  scrubber parts it again where it is longer than an event holds. */
export function coalesce(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  const open = new Map<string, Extract<AgentEvent, { kind: 'thinking' | 'text' }>>();
  for (const event of events) {
    if (event.kind !== 'thinking' && event.kind !== 'text') {
      out.push(event);
      continue;
    }
    const key = `${event.kind}:${event.id}`,
      piece = open.get(key);
    if (piece) {
      piece.delta += event.delta;
      if (event.done) piece.done = true;
    } else {
      const copy = { ...event };
      open.set(key, copy);
      out.push(copy);
    }
    if (event.done) open.delete(key);
  }
  return out;
}

/** One block's text as pieces an event holds, never parting a surrogate pair. */
function pieces(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; ;) {
    let end = Math.min(text.length, at + AGENT_EVENT_TEXT);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    out.push(text.slice(at, end));
    if ((at = end) >= text.length) return out;
  }
}
/** Cuts one text to AGENT_EVENT_TEXT characters, saying how many it dropped. */
const cut = (text: string): [string, { cut?: number }] =>
  text.length > AGENT_EVENT_TEXT
    ? [text.slice(0, AGENT_EVENT_TEXT), { cut: text.length - AGENT_EVENT_TEXT }]
    : [text, {}];

/**
 * Every text blanked of bearers and exact secrets, then cut, or a block's parted into pieces.
 * An unfinished block's trailing run of non-space characters waits for its next piece, so a
 * credential is never sent in two halves.
 */
export class Scrubber {
  private readonly carry = new Map<string, string>();
  private readonly opened = new Set<string>();
  private readonly blank: RegExp;
  constructor(secrets: string[]) {
    this.blank = blankPattern(secrets);
  }
  private redact(text: string) {
    return text.replace(this.blank, '[REDACTED]');
  }
  scrub(events: AgentEvent[]): AgentEvent[] {
    return events.flatMap((event): AgentEvent[] => {
      if (event.kind === 'thinking' || event.kind === 'text') {
        const key = `${event.kind}:${event.id}`;
        let text = (this.carry.get(key) ?? '') + event.delta;
        this.carry.delete(key);
        if (!event.done) {
          const tail = /\S+$/.exec(text)?.[0] ?? '';
          const held = tail.slice(Math.max(0, tail.length - CARRY));
          if (held) this.carry.set(key, held);
          text = text.slice(0, text.length - held.length);
        }
        const first = !this.opened.has(key);
        if (event.done) this.opened.delete(key);
        else this.opened.add(key);
        if (!text && !event.done && !first) return [];
        const parts = pieces(this.redact(text));
        return parts.map((delta, index) => ({
          kind: event.kind,
          id: event.id,
          delta,
          ...(event.done && index === parts.length - 1 ? { done: true } : {}),
        }));
      }
      if (event.kind === 'tool_call') {
        const [input, dropped] = cut(this.redact(event.input));
        return [{ ...event, name: this.redact(event.name).slice(0, 200), input, ...dropped }];
      }
      if (event.kind === 'tool_result') {
        const [output, dropped] = cut(this.redact(event.output));
        return [{ ...event, output, ...dropped }];
      }
      return [{ ...event, text: cut(this.redact(event.text))[0] }];
    });
  }
}

/**
 * One launch's stream: the log's bytes from `offset`, read at whole lines, parsed, scrubbed and
 * sent. A batch not yet acknowledged is sent again as it was, so Sessions can tell a retry by its
 * `from`; Sessions answers how far it holds, and a stream that ends elsewhere (a restarted runner
 * reading from the start) carries on from there. Each jump starts its reading afresh.
 */
export class AgentStream {
  private offset = 0;
  /** The bytes at `offset` continue a line that was skipped: up to its end they are dropped. */
  private midLine = false;
  private pending?: SessionStreamBatch;
  private lines!: (line: string, at: number) => AgentEvent[];
  private scrubber!: Scrubber;
  private failures = 0;
  private retryAt = 0;
  private busy = false;
  private ended = false;
  /** Nothing more will be sent: the log is read to its end after the process ended, or refused. */
  finished = false;
  constructor(
    private readonly directory: string,
    private readonly harness: Harness,
    private readonly secrets: string[],
    private readonly post: (batch: SessionStreamBatch) => Promise<{ until: number }>,
    private readonly clock: () => number,
  ) {
    this.jump(0, false);
  }
  /** Reads on from `offset`, past the rest of a line there when `midLine`, nothing carried. */
  private jump(offset: number, midLine = true) {
    this.offset = offset;
    this.midLine = midLine;
    this.lines = agentLines(this.harness);
    this.scrubber = new Scrubber(this.secrets);
  }
  /** The process has ended: what the log holds now is all it will. */
  end() {
    this.ended = true;
  }
  /** Starts one flush unless one is in flight or waiting out a failure. */
  tick(): void {
    if (this.busy || this.finished || this.clock() < this.retryAt) return;
    this.busy = true;
    void this.flush().finally(() => (this.busy = false));
  }
  /** One batch: read, parse and send; a failure waits 1, 2, 4… up to 30 seconds. */
  async flush(): Promise<void> {
    try {
      this.pending ??= this.next();
      if (!this.pending) return;
      if (this.pending.events.length) {
        const { until } = await this.post(this.pending);
        // Sessions holds up to elsewhere in this batch or past it, as after a restart: carry on
        // from the line it reached (the byte before it is that line's end).
        if (until > this.pending.from && until !== this.pending.to) this.jump(until - 1);
      }
      this.pending = undefined;
      this.failures = 0;
    } catch (error) {
      if (error instanceof RunnerControlError && error.final) this.finished = true;
      else {
        this.failures++;
        if (this.ended && this.failures >= ENDED_TRIES) this.finished = true;
        this.retryAt = this.clock() + Math.min(30_000, 1000 * 2 ** (this.failures - 1));
      }
    }
  }
  /** The next batch from the log, or undefined when nothing new has been printed. */
  private next(): SessionStreamBatch | undefined {
    const ended = this.ended;
    let fd: number;
    try {
      fd = openSync(
        join(this.directory, 'stdout.log'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      // Not yet written, or never: a launch that failed before its process printed anything.
      if (ended) this.finished = true;
      return undefined;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        this.finished = true;
        return undefined;
      }
      let from = this.offset;
      const events: AgentEvent[] = [];
      if (stat.size - from > BEHIND) {
        events.push({
          kind: 'status',
          id: `skip-${stat.size}`,
          text: `Stream skipped ${stat.size - 1 - from} bytes`,
        });
        // The batch starts where it jumps to, past what Sessions holds, so it is taken.
        this.jump((from = stat.size - 1));
      }
      const length = Math.min(stat.size - this.offset, CHUNK);
      if (length <= 0) {
        if (ended) this.finished = true;
        return events.length ? { from, to: this.offset, events } : undefined;
      }
      const bytes = Buffer.allocUnsafe(length);
      let got = 0;
      for (let n = 1; n > 0 && got < length; got += n)
        n = readSync(fd, bytes, got, length - got, this.offset + got);
      // Whole lines only, unless the process has ended and this is the last of its output.
      const last = bytes.lastIndexOf(0x0a, got - 1);
      const whole = ended && this.offset + got === stat.size ? got : last + 1;
      let start = 0;
      if (whole === 0) {
        if (got < CHUNK) return events.length ? { from, to: this.offset, events } : undefined;
        // One line longer than a batch: it is skipped, and said to be once.
        if (!this.midLine)
          events.push({
            kind: 'status',
            id: `skip-${this.offset}`,
            text: `Stream skipped a line over ${CHUNK} bytes`,
          });
        this.offset += got;
        this.midLine = true;
        return { from, to: this.offset, events: this.scrubber.scrub(events) };
      }
      if (this.midLine) {
        start = bytes.indexOf(0x0a) + 1;
        if (start === 0 || start > whole) start = whole;
        this.midLine = start === whole && bytes[whole - 1] !== 0x0a;
      }
      // A batch begins at its first byte read, so one from a jump to Sessions' `until` is new.
      if (!events.length) from = this.offset + start;
      for (let at = start; at < whole;) {
        let end = bytes.indexOf(0x0a, at) + 1;
        if (!end || end > whole) end = whole;
        const line = bytes.toString('utf8', at, end);
        if (line.trim()) events.push(...this.lines(line, this.offset + at));
        at = end;
      }
      this.offset += whole;
      return { from, to: this.offset, events: this.scrubber.scrub(coalesce(events)) };
    } finally {
      closeSync(fd);
    }
  }
}
