/**
 * A worker agent's live stream as the runner reads it: each harness's lines become AgentEvents,
 * pieces of one block become one, every text is blanked of credentials and cut, and a launch's
 * log is sent a batch at a time, whole lines only, a failed batch again as it was.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AGENT_EVENT_TEXT, type AgentEvent } from '@merv/contracts';
import type { SessionStreamBatch } from '@merv/sessions/types';
import { AgentStream, coalesce, Scrubber } from '../packages/runner/src/agent-stream.js';
import { harnesses } from '../packages/runner/src/harness/index.js';
import { RunnerControlError } from '../packages/runner/src/client.js';

const line = (value: unknown) => JSON.stringify(value);
const stream = (event: unknown) =>
  line({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null, uuid: 'u' });
/** Each line read as if it stood at its index in the log. */
const parse = (harness: 'claude' | 'codex', lines: string[]) => {
  const read = harnesses[harness].lines();
  return lines.flatMap((text, at) => read(text, at));
};

/** Claude Code's stream-json with --include-partial-messages, as recorded, trimmed. */
const claude = [
  line({ type: 'system', subtype: 'init', model: 'claude-opus-4-1', tools: ['Bash'] }),
  line({ type: 'system', subtype: 'status', status: 'requesting' }),
  stream({ type: 'message_start', message: { id: 'msg_1', content: [] } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'Look ' },
  }),
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'first.' },
  }),
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'x' },
  }),
  line({
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Look first.' }] },
  }),
  stream({ type: 'content_block_stop', index: 0 }),
  stream({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__merv__sandbox_run', input: {} },
  }),
  stream({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"a"' },
  }),
  line({
    type: 'assistant',
    message: {
      id: 'msg_1',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'mcp__merv__sandbox_run', input: { a: 1 } },
      ],
    },
  }),
  stream({ type: 'content_block_stop', index: 1 }),
  stream({ type: 'message_stop' }),
  'not json at all',
  '{"truncated": ',
  line({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'ran' }, { type: 'image' }],
          is_error: true,
        },
      ],
    },
  }),
  stream({ type: 'message_start', message: { id: 'msg_2', content: [] } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } }),
  stream({ type: 'content_block_stop', index: 0 }),
  line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Done' }] } }),
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, usage: {} }),
];

test('Claude stream-json: pieces of thinking and text, whole tool calls and results, milestones; garbage is skipped', () => {
  assert.deepEqual(parse('claude', claude), [
    { kind: 'status', id: 'status-0', text: 'Started · claude-opus-4-1' },
    { kind: 'thinking', id: 'msg_1.0', delta: '' },
    { kind: 'thinking', id: 'msg_1.0', delta: 'Look ' },
    { kind: 'thinking', id: 'msg_1.0', delta: 'first.' },
    { kind: 'thinking', id: 'msg_1.0', delta: '', done: true },
    { kind: 'tool_call', id: 'toolu_1', name: 'sandbox_run', input: '{"a":1}' },
    { kind: 'tool_result', id: 'toolu_1', output: 'ran\n[image]', error: true },
    { kind: 'text', id: 'msg_2.0', delta: '' },
    { kind: 'text', id: 'msg_2.0', delta: 'Done' },
    { kind: 'text', id: 'msg_2.0', delta: '', done: true },
    { kind: 'status', id: 'status-22', text: 'Finished · success · 2 turns' },
  ]);
  // Without partial messages, a block arrives whole; another server's tool keeps its name.
  assert.deepEqual(
    parse('claude', [
      line({
        type: 'assistant',
        message: {
          id: 'msg_9',
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'tool_use', id: 't', name: 'mcp__nisa__papers_search', input: {} },
            { type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ]),
    [
      { kind: 'text', id: 'msg_9.whole0-0', delta: 'Hi', done: true },
      { kind: 'tool_call', id: 't', name: 'nisa.papers_search', input: '{}' },
      { kind: 'tool_call', id: 'u', name: 'Bash', input: '{"command":"ls"}' },
    ],
  );
});

test('Codex --json: reasoning, messages, commands, MCP calls and file changes with their completions', () => {
  const codex = [
    line({ type: 'thread.started', thread_id: 't' }),
    line({ type: 'turn.started' }),
    line({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Plan it.' } }),
    line({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: '',
        status: 'in_progress',
      },
    }),
    line({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: 'a\n',
        exit_code: 2,
        status: 'failed',
      },
    }),
    line({
      type: 'item.started',
      item: {
        id: 'item_2',
        type: 'mcp_tool_call',
        server: 'merv',
        tool: 'sandbox.run',
        arguments: { x: 1 },
        status: 'in_progress',
      },
    }),
    line({
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'mcp_tool_call',
        server: 'merv',
        tool: 'sandbox.run',
        arguments: { x: 1 },
        result: { content: [{ type: 'text', text: 'ok' }] },
        status: 'completed',
      },
    }),
    line({
      type: 'item.completed',
      item: {
        id: 'item_3',
        type: 'file_change',
        changes: [{ path: 'a.ts', kind: 'update' }],
        status: 'completed',
      },
    }),
    line({ type: 'item.updated', item: { id: 'item_4', type: 'todo_list', items: [] } }),
    '{oops',
    line({
      type: 'item.completed',
      item: { id: 'item_5', type: 'agent_message', text: 'Handed off.' },
    }),
    line({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 },
    }),
    line({ type: 'turn.failed', error: { message: 'boom' } }),
    // Codex reports non-fatal warnings as error items; only the top-level error line is fatal.
    line({ type: 'item.started', item: { id: 'item_6', type: 'error', message: 'early' } }),
    line({
      type: 'item.completed',
      item: { id: 'item_6', type: 'error', message: 'unknown model' },
    }),
    line({ type: 'error', message: 'stream lost' }),
  ];
  assert.deepEqual(parse('codex', codex), [
    { kind: 'status', id: 'status-0', text: 'Started' },
    { kind: 'thinking', id: 'item_0', delta: 'Plan it.', done: true },
    { kind: 'tool_call', id: 'item_1', name: 'shell', input: 'ls' },
    { kind: 'tool_result', id: 'item_1', output: 'a\n', error: true },
    { kind: 'tool_call', id: 'item_2', name: 'sandbox.run', input: '{"x":1}' },
    { kind: 'tool_result', id: 'item_2', output: 'ok' },
    { kind: 'tool_call', id: 'item_3', name: 'edit', input: 'update a.ts' },
    { kind: 'tool_result', id: 'item_3', output: 'completed' },
    { kind: 'text', id: 'item_5', delta: 'Handed off.', done: true },
    { kind: 'status', id: 'status-11', text: 'Turn completed · 10 tokens in · 3 out' },
    { kind: 'status', id: 'status-12', text: 'Turn failed · boom' },
    { kind: 'status', id: 'status-14', text: 'Warning · unknown model' },
    { kind: 'status', id: 'status-15', text: 'Error · stream lost' },
  ]);
});

test('pieces of one block in a batch become one, where its first piece stood', () => {
  const events: AgentEvent[] = [
    { kind: 'thinking', id: 'a', delta: '' },
    { kind: 'thinking', id: 'a', delta: 'x' },
    { kind: 'tool_call', id: 't', name: 'n', input: '{}' },
    { kind: 'thinking', id: 'a', delta: 'y', done: true },
    { kind: 'thinking', id: 'a', delta: 'z' },
  ];
  assert.deepEqual(coalesce(events), [
    { kind: 'thinking', id: 'a', delta: 'xy', done: true },
    { kind: 'tool_call', id: 't', name: 'n', input: '{}' },
    { kind: 'thinking', id: 'a', delta: 'z' },
  ]);
});

test('every text is blanked of bearers and exact secrets, even split between pieces, then cut', () => {
  const bearer = `ms_${'A'.repeat(43)}`;
  const secret = 'exact-secret-value-1234';
  const scrubber = new Scrubber([secret]);
  // The bearer's first half ends a piece: it waits for the rest before anything is blanked.
  assert.deepEqual(
    scrubber.scrub([{ kind: 'text', id: 'm', delta: `token is ${bearer.slice(0, 20)}` }]),
    [{ kind: 'text', id: 'm', delta: 'token is ' }],
  );
  assert.deepEqual(
    scrubber.scrub([
      { kind: 'text', id: 'm', delta: `${bearer.slice(20)} and ${secret}`, done: true },
    ]),
    [{ kind: 'text', id: 'm', delta: '[REDACTED] and [REDACTED]', done: true }],
  );
  const long = 'y'.repeat(AGENT_EVENT_TEXT + 5);
  assert.deepEqual(
    scrubber.scrub([
      { kind: 'tool_call', id: 't', name: 'shell', input: `echo ${bearer}` },
      { kind: 'tool_result', id: 't', output: long },
      { kind: 'status', id: 's', text: `key ${secret}` },
    ]),
    [
      { kind: 'tool_call', id: 't', name: 'shell', input: 'echo [REDACTED]' },
      { kind: 'tool_result', id: 't', output: long.slice(0, AGENT_EVENT_TEXT), cut: 5 },
      { kind: 'status', id: 's', text: 'key [REDACTED]' },
    ],
  );
  // A block's first piece is sent even empty, so a page can say it started.
  assert.deepEqual(scrubber.scrub([{ kind: 'thinking', id: 'n', delta: '' }]), [
    { kind: 'thinking', id: 'n', delta: '' },
  ]);
  assert.deepEqual(scrubber.scrub([{ kind: 'thinking', id: 'n', delta: '' }]), []);
});

test('a launch log is sent whole lines at a time; a failed batch is sent again as it was', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-agent-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'stdout.log');
  let now = 0;
  const sent: SessionStreamBatch[] = [];
  let answer: (batch: SessionStreamBatch) => Promise<{ until: number }> = async (batch) => ({
    until: batch.to,
  });
  const agent = new AgentStream(
    directory,
    'codex',
    [],
    async (batch) => {
      sent.push(structuredClone(batch));
      return await answer(batch);
    },
    () => now,
  );
  // Nothing printed yet: nothing sent.
  await agent.flush();
  assert.equal(sent.length, 0);

  const started = `${line({ type: 'thread.started' })}\n`;
  const message = line({
    type: 'item.completed',
    item: { id: 'i', type: 'agent_message', text: 'Hi' },
  });
  writeFileSync(log, `${started}${message.slice(0, 10)}`);
  await agent.flush();
  assert.deepEqual(sent, [
    { from: 0, to: started.length, events: [{ kind: 'status', id: 'status-0', text: 'Started' }] },
  ]);

  // A failure keeps the batch and waits; the retry sends it unchanged.
  appendFileSync(log, `${message.slice(10)}\n`);
  answer = async () => {
    throw new RunnerControlError('control_unavailable', 0);
  };
  await agent.flush();
  agent.tick(); // within its backoff: nothing is sent
  answer = async (batch) => ({ until: batch.to });
  now += 1000;
  await agent.flush();
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[1], sent[2]);
  assert.deepEqual(sent[2], {
    from: started.length,
    to: started.length + message.length + 1,
    events: [{ kind: 'text', id: 'i', delta: 'Hi', done: true }],
  });

  // Once the process ended, an unterminated last line is read too, and then the stream is done.
  appendFileSync(log, line({ type: 'error', message: 'last' }));
  agent.end();
  await agent.flush();
  assert.deepEqual(sent.at(-1)!.events, [
    { kind: 'status', id: `status-${sent[2]!.to}`, text: 'Error · last' },
  ]);
  await agent.flush();
  assert.equal(agent.finished, true);
});

test('a restarted stream jumps to what Sessions holds; one far behind skips ahead and says so', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-agent-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'stdout.log');
  const one = (n: number) =>
    `${line({ type: 'item.completed', item: { id: `i${n}`, type: 'agent_message', text: `m${n}` } })}\n`;
  writeFileSync(log, one(1));
  const sent: SessionStreamBatch[] = [];
  // Sessions holds a line more than this runner remembers sending, as after a restart.
  let held = one(1).length + one(2).length;
  const agent = new AgentStream(
    directory,
    'codex',
    [],
    async (batch) => {
      sent.push(batch);
      return { until: Math.max(held, batch.to) };
    },
    () => 0,
  );
  await agent.flush();
  appendFileSync(log, one(2) + one(3));
  held = 0;
  await agent.flush();
  assert.deepEqual(
    sent.map((batch) => batch.events.map((event) => (event as { delta: string }).delta)),
    [['m1'], ['m3']],
  );
  // Over 4 MiB behind: the stream says how much it skipped and reads on from the log's end.
  appendFileSync(log, `${'x'.repeat(5 << 20)}\n`);
  await agent.flush();
  appendFileSync(log, one(4));
  await agent.flush();
  const skipped = sent.slice(2).flatMap((batch) => batch.events);
  assert.equal(skipped[0]!.kind, 'status');
  assert.match((skipped[0] as { text: string }).text, /^Stream skipped \d+ bytes$/);
  assert.deepEqual(skipped.slice(1), [{ kind: 'text', id: 'i4', delta: 'm4', done: true }]);
});

/** Sessions as it takes batches: a batch from before what it holds is answered, not added. */
const sessions = () => {
  let until = 0;
  const held: AgentEvent[] = [];
  return {
    held,
    post: async (batch: SessionStreamBatch) => {
      if (batch.from < until || !batch.events.length) return { until };
      held.push(...batch.events);
      until = batch.to;
      return { until };
    },
  };
};

test('a restarted runner sends what Sessions does not hold yet, from the line it reached', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-agent-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'stdout.log');
  // The first two lines are more than one batch reads.
  const one = (n: number) =>
    `${line({ type: 'item.completed', item: { id: `i${n}`, type: 'agent_message', text: `m${n}${n < 3 ? ' '.repeat(400_000) : ''}` } })}\n`;
  const server = sessions();
  writeFileSync(log, one(1) + one(2));
  const first = new AgentStream(directory, 'codex', [], server.post, () => 0);
  await first.flush();
  await first.flush();
  // The runner restarts while its agent prints on: the new stream reads the log from the start,
  // a batch short of what Sessions holds.
  appendFileSync(log, one(3) + one(4));
  const restarted = new AgentStream(directory, 'codex', [], server.post, () => 0);
  await restarted.flush();
  await restarted.flush();
  appendFileSync(log, one(5));
  await restarted.flush();
  assert.deepEqual(
    [...new Set(server.held.map((event) => event.id))],
    ['i1', 'i2', 'i3', 'i4', 'i5'],
  );
});

test('after a restart or a skip, a block is never continued from what was not read, and no id repeats', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-agent-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'stdout.log');
  const text = (index: number, piece: string) =>
    stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
  const message = (id: string, ...pieces: string[]) => [
    stream({ type: 'message_start', message: { id, content: [] } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...pieces.map((piece) => text(0, piece)),
    stream({ type: 'content_block_stop', index: 0 }),
  ];
  const lines = (...items: string[]) => items.map((item) => `${item}\n`).join('');
  const result = line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 });
  const server = sessions();
  // Sessions holds msg_1 up to its first piece when the runner restarts.
  const [start, open, first, ...rest] = message('msg_1', 'Hello ', 'world');
  writeFileSync(log, lines(claude[0]!, start!, open!, first!));
  await new AgentStream(directory, 'claude', [], server.post, () => 0).flush();
  appendFileSync(log, lines(...rest, result, ...message('msg_2', 'Next'), result));
  const restarted = new AgentStream(directory, 'claude', [], server.post, () => 0);
  await restarted.flush();
  await restarted.flush();
  // Then, inside msg_3, it falls far behind: what follows the skip belongs to no block it saw open.
  appendFileSync(log, lines(...message('msg_3', 'Old ').slice(0, 3)));
  await restarted.flush();
  appendFileSync(log, lines('x'.repeat(5 << 20)));
  await restarted.flush();
  appendFileSync(log, lines(text(0, 'lost'), ...message('msg_4', 'New')));
  await restarted.flush();
  const said = server.held.map((event) =>
    event.kind === 'status'
      ? event.text.replace(/\d+ bytes/, 'N bytes')
      : `${event.id} ${event.kind === 'text' ? event.delta : ''}`,
  );
  assert.deepEqual(said, [
    'Started · claude-opus-4-1',
    'msg_1.0 Hello ',
    'Finished · success · 1 turns',
    'msg_2.0 Next',
    'Finished · success · 1 turns',
    'msg_3.0 Old ',
    'Stream skipped N bytes',
    'msg_4.0 New',
  ]);
  const ids = server.held.map((event) => `${event.kind}:${event.id}`);
  assert.equal(new Set(ids).size, ids.length);
});

test('a block longer than an event holds is parted into pieces, never cut', () => {
  const long = `${'a'.repeat(AGENT_EVENT_TEXT - 1)}😀${'b'.repeat(AGENT_EVENT_TEXT)}`;
  const parts = new Scrubber([]).scrub([{ kind: 'text', id: 'm', delta: long, done: true }]);
  assert.deepEqual(
    parts.map((part) => [(part as { delta: string }).delta.length, 'done' in part, 'cut' in part]),
    [
      [AGENT_EVENT_TEXT - 1, false, false],
      [AGENT_EVENT_TEXT, false, false],
      [2, true, false],
    ],
  );
  assert.equal(parts.map((part) => (part as { delta: string }).delta).join(''), long);
});
