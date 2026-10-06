/**
 * What a thread's agent said, in its dialog: the live visit's stream read from a fake
 * server-sent event body. Each test states one thing a person reading it relies on: a
 * block written in pieces reads as one, a tool's answer stands under its call, thinking stays
 * folded until asked for, a dropped stream picks up where it left off without repeating
 * itself, and a stream nobody is looking at is closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aborted,
  click,
  eventStream,
  mount,
  requests,
  serve,
  settle,
  text,
  unmount,
} from './ui-render.js';

const { createElement, useState } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
await import('../packages/ui/web/components.js');
const { AgentConversation } = await import('../packages/ui/web/views/agent-live.js');
const { mergeEvents, NO_TIMELINE } = await import('../packages/ui/web/agent-stream.js');

const at = new Date().toISOString();
/** A thread's one live visit, streamed from its session's route. */
const session = (id: string) => ({
  sessionId: id,
  divider: 'Visit 1',
  stream: `/sessions/${id}/events`,
});
let seq = 0;
const event = (value: Record<string, unknown>) => ({ seq: ++seq, at, event: value });

/** The conversation, and a way to shut it as its dialog does. */
function Panel({ sessions }: { sessions: ReturnType<typeof session>[] }) {
  const [open, setOpen] = useState(true);
  return createElement(
    MemoryRouter,
    null,
    createElement('button', { onClick: () => setOpen(false) }, 'Close panel'),
    open && createElement(AgentConversation, { label: 'Producer', visits: sessions }),
  );
}
/** Serves each request of a path the next of these streams. */
const streams = (path: string, count: number) => {
  const made = Array.from({ length: count }, eventStream);
  serve(path, (call) => ({ stream: made[call - 1]!.stream }));
  return made;
};

test('pieces of one block read as one, and a tool’s answer stands under its call', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  seq = 0;
  const [first] = streams('/sessions/ses_1/events', 1);
  await mount(createElement(Panel, { sessions: [session('ses_1')] }));
  assert.ok(requests.includes('GET /sessions/ses_1/events'));
  first!.send('snapshot', {
    events: [
      event({ kind: 'thinking', id: 'th1', delta: 'Plan the run\nThen look at the loss.' }),
      event({ kind: 'text', id: 'tx1', delta: 'Running the ' }),
      event({ kind: 'tool_call', id: 'tc1', name: 'sandbox.run', input: '{"command":"ls -la"}' }),
    ],
  });
  await settle(10);
  // Thinking is folded to its first line, and its body is not drawn until it is opened.
  const thinking = document.querySelector<HTMLDetailsElement>('.agent-thinking')!;
  assert.equal(thinking.open, false);
  assert.equal(thinking.querySelector('.agent-thinking-line')!.textContent, 'Plan the run');
  assert.equal(thinking.querySelector('.agent-thinking-body'), null);
  // The call is in flight: its name, its arguments as a tree, and no answer yet.
  const tool = document.querySelector('.agent-tool')!;
  assert.equal(tool.querySelector('.agent-tool-name')!.textContent, 'sandbox.run');
  assert.equal(tool.querySelector('.agent-tool-state')!.textContent, 'running');
  assert.ok(tool.querySelector('.json'), 'JSON arguments are a tree');
  assert.ok(tool.textContent!.includes('ls -la'));

  // A batch may come as a bare list.
  first!.send('events', [
    event({ kind: 'text', id: 'tx1', delta: 'baseline **now**.', done: true }),
    event({ kind: 'tool_result', id: 'tc1', output: 'total 0\n\x1b[32mok\x1b[0m', error: false }),
    event({ kind: 'text', id: 'tx2', delta: 'x'.repeat(10), cut: 1234 }),
    event({ kind: 'status', id: 'st1', text: 'Finished · 1,204 tokens' }),
  ]);
  await settle(10);
  const said = [...document.querySelectorAll('.agent-text')];
  assert.equal(said.length, 2, 'one block for the pieces of tx1, one for tx2');
  assert.equal(said[0]!.textContent, 'Running the baseline now.');
  assert.ok(said[0]!.querySelector('strong'), 'text is read as Markdown');
  assert.equal(said[1]!.querySelector('.agent-cut')!.textContent, '… 1,234 characters not shown');
  // The answer stands under its call, in the one tool block, its escapes read as colour.
  assert.equal(document.querySelectorAll('.agent-tool').length, 1);
  assert.equal(tool.querySelector('.agent-tool-state'), null, 'answered, so no longer running');
  assert.ok(tool.querySelector('.agent-output .code-body')!.textContent!.includes('ok'));
  assert.ok(!tool.textContent!.includes('\x1b'));
  assert.equal(
    document.querySelector('.agent-status:not(.agent-visit)')!.textContent,
    'Finished · 1,204 tokens',
  );

  // Opened, thinking is read whole.
  await act(async () => {
    thinking.open = true;
    thinking.dispatchEvent(new window.Event('toggle'));
  });
  assert.ok(thinking.querySelector('.agent-thinking-body')!.textContent!.includes('loss'));
});

test('events pair by id in the order of their numbers, and an event already taken is taken once', () => {
  const timeline = mergeEvents(NO_TIMELINE, [
    { seq: 2, at, event: { kind: 'tool_result', id: 'a', output: 'boom', error: true } },
    { seq: 1, at, event: { kind: 'tool_call', id: 'a', name: 'shell', input: 'not json' } },
    { seq: 3, at, event: { kind: 'tool_call', id: 'b', name: 'shell', input: '{}' } },
  ]);
  assert.equal(timeline.last, 3);
  assert.deepEqual(
    timeline.blocks.map((block) => block.kind === 'tool' && [block.name, block.result?.error]),
    [
      ['shell', true],
      ['shell', undefined],
    ],
  );
  // What was already taken is taken once: the same timeline comes back.
  assert.equal(
    mergeEvents(timeline, [{ seq: 3, at, event: { kind: 'status', id: 's', text: 'x' } }]),
    timeline,
  );
});

test('a dropped stream reopens from the last event it holds, and nothing is drawn twice', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  seq = 0;
  const [first] = streams('/sessions/ses_2/events', 1);
  const [second] = streams('/sessions/ses_2/events?after=2', 1);
  await mount(createElement(Panel, { sessions: [session('ses_2')] }));
  first!.send('snapshot', {
    events: [
      event({ kind: 'text', id: 'a', delta: 'One.', done: true }),
      event({ kind: 'text', id: 'b', delta: 'Two.', done: true }),
    ],
  });
  await settle(10);
  first!.close();
  await settle(10);
  assert.ok(text().includes('Reconnecting…'));
  // The first wait is a second.
  await settle(1100);
  assert.ok(requests.includes('GET /sessions/ses_2/events?after=2'));
  second!.send('snapshot', {
    events: [
      { seq: 2, at, event: { kind: 'text', id: 'b', delta: 'Two.', done: true } },
      { seq: 3, at, event: { kind: 'text', id: 'c', delta: 'Three.', done: true } },
    ],
  });
  await settle(10);
  assert.deepEqual(
    [...document.querySelectorAll('.agent-text')].map((node) => node.textContent),
    ['One.', 'Two.', 'Three.'],
  );
  assert.ok(!text().includes('Reconnecting…'));

  // Shutting the panel closes its stream.
  await click('Close panel');
  assert.deepEqual(aborted, ['/sessions/ses_2/events?after=2']);
});

test('a hidden tab closes the stream, and showing it again reopens it from the last event', async (t) => {
  t.after(async () => await unmount());
  t.after(() => void delete (document as { visibilityState?: string }).visibilityState);
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  const [first] = streams('/sessions/ses_3/events', 1);
  streams('/sessions/ses_3/events?after=1', 1);
  await mount(createElement(Panel, { sessions: [session('ses_3')] }));
  first!.send('snapshot', {
    events: [{ seq: 1, at, event: { kind: 'text', id: 'a', delta: 'Hi' } }],
  });
  await settle(10);
  const turn = async (state: string) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    await act(async () => void document.dispatchEvent(new window.Event('visibilitychange')));
    await settle(10);
  };
  await turn('hidden');
  assert.deepEqual(aborted, ['/sessions/ses_3/events']);
  await turn('visible');
  assert.ok(requests.includes('GET /sessions/ses_3/events?after=1'));
});

test('a snapshot after a gap starts the timeline over, and nothing is joined across the gap', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  const [first] = streams('/sessions/ses_4/events', 1);
  const [second] = streams('/sessions/ses_4/events?after=1', 1);
  await mount(createElement(Panel, { sessions: [session('ses_4')] }));
  first!.send('snapshot', {
    events: [{ seq: 1, at, event: { kind: 'text', id: 'a', delta: 'Hello wor' } }],
  });
  await settle(10);
  first!.close();
  await settle(1100);
  // The page fell over 500 events behind: the server sends its newest instead.
  second!.send('snapshot', {
    events: [
      { seq: 601, at, event: { kind: 'status', id: 's', text: 'Turn completed' } },
      { seq: 602, at, event: { kind: 'text', id: 'a', delta: ' END', done: true } },
    ],
  });
  await settle(10);
  assert.deepEqual(
    [...document.querySelectorAll('.agent-blocks > li')].map((node) => node.textContent),
    ['Visit 1', 'Turn completed', 'END'],
  );
});

test('a stream reads on through rotations until the server says it ended', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  // A session that ends still takes its agent's last words for a while: it rotates, not ends.
  const [first] = streams('/sessions/ses_5/events', 1);
  const [second] = streams('/sessions/ses_5/events?after=1', 2);
  await mount(createElement(Panel, { sessions: [session('ses_5')] }));
  first!.send('snapshot', {
    events: [{ seq: 1, at, event: { kind: 'text', id: 'a', delta: 'One.', done: true } }],
  });
  first!.send('rotate', {});
  first!.close();
  await settle(1100);
  assert.ok(requests.includes('GET /sessions/ses_5/events?after=1'));
  second!.send('events', {
    events: [{ seq: 2, at, event: { kind: 'text', id: 'b', delta: 'Two.', done: true } }],
  });
  second!.send('end', {});
  second!.close();
  await settle(1100);
  assert.deepEqual(
    [...document.querySelectorAll('.agent-text')].map((node) => node.textContent),
    ['One.', 'Two.'],
  );
  assert.equal(requests.filter((request) => request.startsWith('GET /sessions/ses_5/')).length, 2);
  assert.ok(!text().includes('Reconnecting…'));
});

test('a stream path that resolves to another host is never asked, so the credential stays home', async (t) => {
  t.after(async () => await unmount());
  const { setToken } = await import('../packages/ui/web/api.js');
  const { StreamError, readEventStream } = await import('../packages/ui/web/event-stream.js');
  setToken('fixture-token');
  t.after(() => setToken(null));
  for (const path of [
    '/\t/evil.example/x',
    '/\n/evil.example/x',
    '/\r//evil.example/x',
    '//evil.example/x',
    '/\\evil.example/x',
    'https://evil.example/x',
  ]) {
    await assert.rejects(
      readEventStream(path, new AbortController().signal, () => {}),
      (error) => error instanceof StreamError,
      JSON.stringify(path),
    );
  }
  assert.deepEqual(requests, [], 'nothing was sent anywhere');
});

test('incremental SSE parser handles split frames and rejects oversized events', async () => {
  const { frameParser } = await import('../packages/ui/web/event-stream.js');
  const frames: { event: string; data: string }[] = [];
  const parse = frameParser((value) => frames.push(value));
  parse(': heartbeat\r\nevent: del');
  parse('ta\r\ndata: {"text":"ok"}\r');
  parse('\n\r\n');
  parse(`data: ${'x'.repeat(70_000)}\n\n`);
  assert.deepEqual(frames, [{ event: 'delta', data: '{"text":"ok"}' }]);
});

test('a transcript of many tool calls names their records in one request', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  serve('/tools/ui.home', { body: { result: {} } });
  serve('/tools/project.references', (_, sent) => ({
    body: {
      result: (sent.refs as string[]).map((id) => ({ ref: id, id, status: 'missing', kind: null })),
    },
  }));
  const stream = eventStream();
  serve('/sessions/ses_names/events', () => ({ stream: stream.stream }));
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(AgentConversation, { label: 'Producer', visits: [session('ses_names')] }),
    ),
  );
  stream.send('snapshot', {
    events: Array.from({ length: 40 }, (_, at) =>
      event({
        kind: 'tool_call',
        id: `call_${at}`,
        name: 'workflow.status_and_next',
        input: JSON.stringify({ instanceId: `wf_${String(at + 1).padStart(32, '0')}` }),
      }),
    ),
  });
  await settle(50);
  assert.equal(requests.filter((r) => r === 'POST /tools/project.references').length, 1);
});

test('a tool’s JSON answer is laid out two spaces deep, folded once it is long, and keeps its controls', async (t) => {
  t.after(async () => await unmount());
  // jsdom has no clipboard, and the copy control is drawn only where there is one.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async () => undefined },
    configurable: true,
  });
  t.after(() => void delete (navigator as { clipboard?: unknown }).clipboard);
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  seq = 0;
  const [stream] = streams('/sessions/ses_json/events', 1);
  await mount(createElement(Panel, { sessions: [session('ses_json')] }));
  const task = Object.fromEntries(Array.from({ length: 20 }, (_, at) => [`field_${at}`, at]));
  stream!.send('snapshot', {
    events: [
      event({ kind: 'tool_call', id: 'short', name: 'task.status', input: '{}' }),
      event({ kind: 'tool_result', id: 'short', output: '{"state":"done","ok":true}' }),
      event({ kind: 'tool_call', id: 'long', name: 'task.get', input: '{}' }),
      event({ kind: 'tool_result', id: 'long', output: JSON.stringify(task) }),
    ],
  });
  await settle(10);
  const [short, long] = [...document.querySelectorAll('.agent-output')];
  // Short: open, one key a line, with the code block's wrap and copy controls.
  assert.equal(short!.tagName, 'DIV');
  assert.equal(
    short!.querySelector('.code-body')!.textContent,
    '{\n  "state": "done",\n  "ok": true\n}',
  );
  assert.ok(short!.querySelector('[aria-label="Wrap long lines"]'));
  assert.ok(short!.querySelector('[aria-label="Copy"]'));
  // Long: folded to its line count until it is opened, then laid out the same way.
  const fold = long as HTMLDetailsElement;
  assert.equal(fold.tagName, 'DETAILS');
  assert.equal(fold.querySelector('summary')!.textContent, 'Output · 22 lines');
  await act(async () => {
    fold.open = true;
    fold.dispatchEvent(new window.Event('toggle'));
  });
  assert.ok(fold.querySelector('.code-body')!.textContent!.includes('\n  "field_19": 19\n}'));
  // What is not JSON stays the terminal's text it was.
  assert.equal(document.querySelectorAll('.agent-tool').length, 2);
});
