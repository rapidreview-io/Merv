import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@merv/contracts';
import { answer, entries, firstId, type Harness, type Line, read, spent, str } from './shared.js';

/** A Merv tool as its own name, another server's as `server.tool`, a built-in as itself. */
const toolName = (name: string) =>
  name.startsWith('mcp__merv__')
    ? name.slice('mcp__merv__'.length)
    : name.replace(/^mcp__([^_]+(?:_[^_]+)*?)__/, '$1.');

/**
 * Reads Claude Code's stream-json, with --include-partial-messages. A block's pieces are taken
 * only after their message's start was read, so a reader that began mid-message adds nothing to
 * a block it never saw open.
 */
function lines() {
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
              name: toolName(str(item.name)),
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

/**
 * Claude Code. Its `stream-json` ends with one `result` event: its `input_tokens` excludes the
 * cache, so cache writes and reads are added. Its home is the machine's own, which holds its
 * login; a conversation is `projects/<cwd>/<id>.jsonl`, found in any project directory.
 */
export const claude: Harness = {
  lines,
  usage: (output, model) =>
    spent(output, 'result', model, ['cache_creation_input_tokens', 'cache_read_input_tokens']),
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
  locate(root, id) {
    for (const project of entries(join(root, 'projects'))) {
      const path = join(root, 'projects', project.name, `${id}.jsonl`);
      if (project.isDirectory() && lstatSync(path, { throwIfNoEntry: false })?.isFile())
        return path;
    }
    return undefined;
  },
  restorePath: (root, cwd, id) => [
    join(root, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-')),
    `${id}.jsonl`,
  ],
  forget(root, ids) {
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
