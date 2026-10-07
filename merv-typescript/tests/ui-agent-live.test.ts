/**
 * What a thread's agent said, in its dialog: the live visit's stream read from a fake
 * server-sent event body. Each test states one thing a person reading it relies on: what the
 * agent says is prose and every step it took one short line, the steps between two messages
 * one group whose errors stay in sight, an empty answer is not drawn, ids appear only in a
 * step opened to its raw call, a stream that has said nothing is Starting… and never Connecting…
 * for good, a dropped stream picks up where it left off without repeating itself, and a stream
 * nobody is looking at is closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aborted,
  click,
  eventStream,
  jump,
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
const { STALL_MS } = await import('../packages/ui/web/event-stream.js');

const at = new Date().toISOString();
/** A thread's one live visit, streamed from its session's route. */
const session = (id: string) => ({
  sessionId: id,
  at: new Date(0).toISOString(),
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

/** Opens a fold the page drew as a button: a step's line or a group's. */
const expand = async (line: Element) => {
  await act(async () => void (line as HTMLElement).click());
  await settle(10);
};
const lineOf = (label: string) =>
  [...document.querySelectorAll('.agent-step-line')].find(
    (line) => line.querySelector('.agent-step-label')!.textContent === label,
  )!;

test('what the agent says is prose; each step is one quiet line a press opens to its raw call', async (t) => {
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
  // Thinking is one step line, its first line only, its body not drawn until it is opened.
  const thought = lineOf('Thinking');
  assert.equal(thought.querySelector('.agent-step-summary')!.textContent, 'Plan the run');
  assert.equal(document.querySelector('.agent-step-thought'), null);
  // The call is in flight: its words, what it is about, a moving dot, and nothing raw.
  const call = lineOf('sandbox · run');
  assert.equal(call.querySelector('.agent-step-summary')!.textContent, 'ls -la');
  assert.ok(call.querySelector('.live-dot--moving'));
  assert.equal(document.querySelector('.json'), null, 'raw arguments wait for a press');

  // A batch may come as a bare list.
  first!.send('events', [
    event({ kind: 'text', id: 'tx1', delta: 'baseline **now**.', done: true }),
    event({ kind: 'tool_result', id: 'tc1', output: 'total 0\n\x1b[32mok\x1b[0m', error: false }),
    event({ kind: 'text', id: 'tx2', delta: 'x'.repeat(10), cut: 1234 }),
    event({ kind: 'status', id: 'st1', text: 'Finished · success · 4 turns' }),
  ]);
  await settle(10);
  const said = [...document.querySelectorAll('.agent-text')];
  assert.equal(said.length, 2, 'one block for the pieces of tx1, one for tx2');
  assert.equal(said[0]!.textContent, 'Running the baseline now.');
  assert.ok(said[0]!.querySelector('strong'), 'text is read as Markdown');
  assert.equal(said[1]!.querySelector('.agent-cut')!.textContent, '… 1,234 characters not shown');
  // Answered, the call is no longer moving; the session's own "Finished" is said by nothing.
  assert.equal(lineOf('sandbox · run').querySelector('.live-dot--moving'), null);
  assert.ok(!text().includes('Finished'));
  // Opened, the call shows its raw input and its answer, escapes read as colour.
  await expand(lineOf('sandbox · run'));
  const step = lineOf('sandbox · run').parentElement!;
  assert.ok(step.querySelector('.json'), 'JSON arguments are a tree');
  assert.ok(step.querySelector('.agent-output .code-body')!.textContent!.includes('ok'));
  assert.ok(!step.textContent!.includes('\x1b'));
  // Opened, thinking is read whole.
  await expand(lineOf('Thinking'));
  assert.ok(document.querySelector('.agent-step-thought')!.textContent!.includes('loss'));
});

test('the steps between two messages are one group; an error stays in sight, an empty answer is not drawn', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  seq = 0;
  const [stream] = streams('/sessions/ses_g/events', 1);
  await mount(createElement(Panel, { sessions: [session('ses_g')] }));
  stream!.send('snapshot', {
    events: [
      event({ kind: 'text', id: 'a', delta: 'Looking at the runs.', done: true }),
      event({
        kind: 'tool_call',
        id: 'c1',
        name: 'sandboxes.workflow_get',
        input: '{"workflow_id":"pipe_yvs82yw2idgtz0n2"}',
      }),
      event({ kind: 'tool_result', id: 'c1', output: '[]' }),
      event({
        kind: 'tool_call',
        id: 'c2',
        name: 'shell',
        input: `/usr/bin/bash -c "python3 - <<'PY'\nimport json\nprint(len(json.load(open('runs.json'))))\nPY"`,
      }),
      event({
        kind: 'tool_result',
        id: 'c2',
        output: "FileNotFoundError: no such file 'runs.json'\nTraceback …",
        error: true,
      }),
      event({ kind: 'status', id: 's1', text: 'Turn completed · 1200 tokens in · 40 out' }),
      event({
        kind: 'tool_call',
        id: 'c3',
        name: 'Read',
        input: '{"file_path":"/work/a/b/notes.md"}',
      }),
      event({ kind: 'tool_result', id: 'c3', output: '# Notes' }),
      event({ kind: 'text', id: 'b', delta: 'The runs file is missing.', done: true }),
    ],
  });
  await settle(10);
  const items = [...document.querySelectorAll('.agent-blocks > li')];
  assert.deepEqual(
    items.map((item) => item.firstElementChild!.className),
    ['agent-divider', 'agent-text', 'agent-steps', 'agent-text'],
  );
  // Shut, the group is one line, and the step that failed stands under it, red, in few words.
  const group = document.querySelector('.agent-steps')!;
  assert.equal(group.querySelector('.agent-steps-head')!.textContent, '3 steps· 1 failed');
  const errors = [...group.querySelectorAll('.agent-step--error')];
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0]!.textContent,
    "Ran shell failedFileNotFoundError: no such file 'runs.json'",
  );
  assert.ok(!text().includes('pipe_'), 'no id reaches the page while the steps are shut');
  // Opened, every step is its line, in order; no step names an id.
  await expand(group.querySelector('.agent-steps-head')!);
  assert.deepEqual(
    [...group.querySelectorAll('.agent-steps-list .agent-step-line')].map(
      (line) => line.textContent,
    ),
    [
      'sandboxes · workflow_get',
      "Ran shell failedFileNotFoundError: no such file 'runs.json'",
      'Read fileb/notes.md',
    ],
  );
  // The call whose answer is `[]` opens to its arguments alone: an empty answer is not drawn.
  await expand(lineOf('sandboxes · workflow_get'));
  const empty = lineOf('sandboxes · workflow_get').parentElement!;
  assert.ok(empty.querySelector('.json'));
  assert.equal(empty.querySelector('.agent-output'), null);
  // Only there, raw, may its id appear.
  assert.ok(empty.textContent!.includes('pipe_yvs82yw2idgtz0n2'));
});

test('a live stream that has said nothing yet is Starting…, never Connecting… for good', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  // A proxy that compresses the stream holds every frame until the server rotates it: the
  // connection opens and nothing arrives.
  const [held, again] = streams('/sessions/ses_slow/events', 2);
  await mount(createElement(Panel, { sessions: [session('ses_slow')] }));
  assert.equal(document.querySelector('.agent-live-state')!.textContent, 'Starting…');
  assert.ok(!text().includes('Connecting'));
  // Past the wait, the page says the live view is slow and offers to try again.
  await jump(STALL_MS);
  assert.equal(
    document.querySelector('.agent-live-state')!.textContent,
    'The live view is slow to connect.Retry',
  );
  await click('Retry');
  assert.deepEqual(aborted, ['/sessions/ses_slow/events']);
  assert.equal(requests.filter((r) => r === 'GET /sessions/ses_slow/events').length, 2);
  assert.equal(document.querySelector('.agent-live-state')!.textContent, 'Starting…');
  // A visit that has launched but said nothing is Starting… until its first line.
  again!.send('snapshot', { events: [] });
  await settle(10);
  assert.equal(document.querySelector('.agent-live-state')!.textContent, 'Starting…');
  again!.send('events', {
    events: [{ seq: 1, at, event: { kind: 'text', id: 'a', delta: 'Up.', done: true } }],
  });
  await settle(10);
  assert.equal(document.querySelector('.agent-live-state'), null);
  void held;
});

test('the people over a thread stand among what its agent said, where they said it', async (t) => {
  t.after(async () => await unmount());
  const early = '2026-10-06T12:00:00.000Z';
  const late = (minute: number) => `2026-10-06T12:${minute}:00.000Z`;
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(AgentConversation, {
        label: 'Producer',
        visits: [
          {
            sessionId: 'ses_p',
            at: early,
            divider: 'Visit 1 · 48m · submitted',
            events: [
              { seq: 1, at: late(10), event: { kind: 'text', id: 'a', delta: 'First.' } },
              { seq: 2, at: late(30), event: { kind: 'text', id: 'b', delta: 'Second.' } },
            ],
          },
        ],
        people: [
          { key: 'm1', at: late(20), who: 'You', body: 'Use the smaller model.', note: 'Read' },
          {
            key: 'q1',
            at: late(40),
            who: 'Agent asked',
            body: 'Which split?',
            asked: { open: true },
          },
        ],
      }),
    ),
  );
  assert.deepEqual(
    [...document.querySelectorAll('.agent-blocks > li')].map((item) => item.textContent),
    [
      'Visit 1 · 48m · submitted',
      'First.',
      'You · ReadUse the smaller model.',
      'Second.',
      'Agent askedWhich split?',
    ],
  );
  assert.ok(document.querySelector('.agent-person--asked'));
});

test('Sessions says what each event is: a message, a step, an error, a milestone or nothing', async () => {
  const { emptyOutput, lineKind, plainLine, statusLine, toolFailure, toolLine } =
    await import('@merv/sessions/agent-stream');
  // A step is a verb and the tool, and what it was about in at most 80 characters, no ids.
  assert.deepEqual(
    toolLine(
      'shell',
      `/usr/bin/bash -c "python3 - <<'PY'\nimport json\ndata = json.load(open('r.json'))\nPY"`,
    ),
    { label: 'Ran shell', summary: "python3 - · data = json.load(open('r.json'))" },
  );
  assert.deepEqual(toolLine('shell', `bash -lc 'cd /work/repo && npm test'`), {
    label: 'Ran shell',
    summary: 'npm test',
  });
  assert.deepEqual(toolLine('Bash', '{"command":"ls -la","description":"List the runs"}'), {
    label: 'Ran shell',
    summary: 'List the runs',
  });
  assert.deepEqual(toolLine('Read', '{"file_path":"/home/agent/work/src/index.ts"}'), {
    label: 'Read file',
    summary: 'src/index.ts',
  });
  assert.deepEqual(toolLine('sandboxes.workflow_get', '{"workflow_id":"pipe_yvs82yw2idgtz0n2"}'), {
    label: 'sandboxes · workflow_get',
    summary: '',
  });
  // Arguments a feed cut short still say their command.
  assert.equal(
    toolLine('Grep', '{"pattern":"useEventStream","path":"/wo').summary,
    'useEventStream',
  );
  assert.equal(toolLine('shell', 'x'.repeat(200)).summary.length, 80);
  assert.equal(
    plainLine(
      'lease d426cc5f-9fd6-4d52-a112-f05653affb77 on workflow_id "pipe_yvs82yw2idgtz0n2" at aa81e34ad',
    ),
    'lease on workflow_id at',
  );
  // An answer with nothing in it is not drawn.
  for (const empty of ['', ' ', '[]', '{}', 'null', '""', '\n[ ]\n'])
    assert.ok(emptyOutput(empty), JSON.stringify(empty));
  for (const said of ['0', 'false', '[1]', 'ok']) assert.ok(!emptyOutput(said), said);
  // A failure is the harness's error, or a JSON refusal, in few words.
  assert.equal(
    toolFailure({ output: 'bash: x: not found\nmore', error: true }),
    'bash: x: not found',
  );
  assert.equal(
    toolFailure({
      output: '{"error":{"code":"not_found","message":"Run run_8f3a9c2e1d0b not found"}}',
    }),
    'Run not found',
  );
  assert.equal(toolFailure({ output: '{"ok":true}' }), undefined);
  assert.equal(toolFailure({ output: '' }), undefined);
  // A milestone is a divider, an error, or nothing a person reads.
  assert.deepEqual(statusLine('Turn failed · stream disconnected'), {
    kind: 'error',
    text: 'Turn failed · stream disconnected',
  });
  assert.equal(statusLine('Turn completed · 12 tokens in · 3 out').kind, 'quiet');
  assert.equal(statusLine('Started · gpt-6.1-sol').kind, 'quiet');
  assert.deepEqual(statusLine('Stream skipped 4096 bytes'), {
    kind: 'system',
    text: 'Some output was skipped',
  });
  assert.deepEqual(
    [
      lineKind({ kind: 'text' }),
      lineKind({ kind: 'thinking' }),
      lineKind({ kind: 'tool' }),
      lineKind({ kind: 'tool', result: { output: '[]' } }),
      lineKind({ kind: 'tool', result: { output: 'exit 1', error: true } }),
      lineKind({ kind: 'status', text: 'Finished · success' }),
    ],
    ['message', 'thinking', 'tool', 'tool', 'error', 'quiet'],
  );
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
      { seq: 601, at, event: { kind: 'status', id: 's', text: 'Context compacted' } },
      { seq: 602, at, event: { kind: 'text', id: 'a', delta: ' END', done: true } },
    ],
  });
  await settle(10);
  assert.deepEqual(
    [...document.querySelectorAll('.agent-blocks > li')].map((node) => node.textContent),
    ['Visit 1', 'Context compacted', 'END'],
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

test('a transcript of many tool calls asks nothing of the records it names until a step is opened', async (t) => {
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
  const asked = () => requests.filter((r) => r === 'POST /tools/project.references').length;
  // Forty calls are one group line; shut or open, no step's line names its record.
  const head = document.querySelector('.agent-steps-head')!;
  assert.equal(head.querySelector('.agent-step-label')!.textContent, '40 steps');
  // While the visit is live, the group says what its newest step is doing.
  assert.equal(
    head.querySelector('.agent-step-summary')!.textContent,
    'workflow · status_and_next',
  );
  assert.ok(head.querySelector('.live-dot--moving'));
  await expand(document.querySelector('.agent-steps-head')!);
  assert.equal(document.querySelectorAll('.agent-steps-list .agent-step').length, 40);
  assert.ok(!text().includes('wf_0'));
  assert.equal(asked(), 0);
  // Opened to its raw arguments, a step names its record, and asks after it.
  await expand(document.querySelector('.agent-steps-list .agent-step-line')!);
  await settle(50);
  assert.equal(asked(), 1);
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
  await expand(document.querySelector('.agent-steps-head')!);
  await expand(lineOf('task · status'));
  await expand(lineOf('task · get'));
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
  assert.equal(document.querySelectorAll('.agent-step').length, 2);
});
