import assert from 'node:assert/strict';
import test from 'node:test';
import type { PiEvent } from '../packages/ui/web/pi-stream.js';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');

const { createElement, StrictMode } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
const { PiView } = await import('../packages/ui/web/views/pi.js');
const { piFrameParser } = await import('../packages/ui/web/pi-stream.js');
const { setProject, setToken } = await import('../packages/ui/web/api.js');

const row = {
  id: 'pi',
  label: 'Agent',
  group: 'operations',
  order: 0,
  path: '/agent',
  view: { kind: 'pi' },
  status: {},
  readable: false,
};
interface Conversation {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  revision: number;
  epoch: number;
  runtimeId: string | null;
  activeCommandId: string | null;
  checkpoint: null;
  previousCheckpoint: null;
  createdAt: string;
  updatedAt: string;
}
const conversation = (id = 'conversation_1'): Conversation => ({
  id,
  projectId: 'p1',
  userId: 'user_1',
  title: 'New conversation',
  revision: 1,
  epoch: 0,
  runtimeId: null,
  activeCommandId: null,
  checkpoint: null,
  previousCheckpoint: null,
  createdAt: '2026-09-20T00:00:00Z',
  updatedAt: '2026-09-20T00:00:00Z',
});
const command = (id: string, status: string, messages: { role: string; text: string }[] = []) => ({
  id,
  conversationId: 'conversation_1',
  epoch: 0,
  runtimeId: 'runtime_1',
  status,
  messages,
  outcomes: [],
  error: null,
  createdAt: '2026-09-20T00:00:00Z',
  expiresAt: '2026-09-20T01:00:00Z',
  completedAt: null,
});
const snapshot = (
  item: Conversation,
  commands: ReturnType<typeof command>[] = [],
  sequence = 0,
  tail: PiEvent[] = [],
) => ({
  conversation: item,
  commands,
  streamId: 'stream_1',
  sequence,
  tail,
});
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const originalFetch = globalThis.fetch;

function streamFixture(current: () => ReturnType<typeof snapshot>) {
  let connection: ReadableStreamDefaultController<Uint8Array> | undefined;
  let aborted = 0;
  const headers: Headers[] = [];
  const encoder = new TextEncoder();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/events')) {
      requests.push(`GET ${String(input)}`);
      headers.push(new Headers(init?.headers));
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              connection = controller;
              controller.enqueue(encoder.encode(frame('snapshot', current())));
              init?.signal?.addEventListener(
                'abort',
                () => {
                  aborted++;
                  try {
                    controller.close();
                  } catch {}
                },
                { once: true },
              );
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return {
    push(event: string, data: unknown) {
      connection?.enqueue(encoder.encode(frame(event, data)));
    },
    drop() {
      connection?.close();
    },
    get aborted() {
      return aborted;
    },
    headers,
  };
}

function boot(current: () => ReturnType<typeof snapshot>, list: () => Conversation[] = () => []) {
  serve('/tools/pi.list', () => ({ body: { result: list() } }));
  serve('/tools/pi.create', { body: { result: conversation() } });
  serve('/tools/pi.snapshot', () => ({ body: { result: current() } }));
  return streamFixture(current);
}
const open = (status = row.status, strict = false) => {
  const page = createElement(
    MemoryRouter,
    { initialEntries: ['/agent'] },
    createElement(PiView, { row: { ...row, status }, shell: { rows: [], plugins: [] } }),
  );
  return mount(strict ? createElement(StrictMode, null, page) : page);
};
const write = async (value: string) => {
  const area = document.querySelector<HTMLTextAreaElement>('#pi-draft')!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(area, value);
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
const cleanup = async () => {
  await unmount();
  globalThis.fetch = originalFetch;
  setProject(null);
};

test('opening an empty Agent creates a conversation, never sends or creates a task', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const stream = boot(() => snapshot(conversation()));
  await open();
  await settle(10);
  assert.match(text(), /Read-only native-query pilot/);
  assert.match(text(), /Ready/);
  assert.equal(requests.filter((request) => request.includes('/tools/pi.create')).length, 1);
  assert.equal(
    requests.some((request) => /pi.send|task.create|fleet.request/.test(request)),
    false,
  );
  assert.equal(stream.headers[0].get('authorization'), 'Bearer fixture-token');
  assert.equal(stream.headers[0].get('x-merv-project-id'), 'p1');
});

test('the StrictMode page still loads after effect replay', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(() => snapshot(conversation()));
  await open(row.status, true);
  assert.match(text(), /Ready/);
  assert.equal(requests.filter((request) => request.includes('/tools/pi.create')).length, 1);
  assert.equal(
    requests.some((request) => request.includes('/tools/pi.send')),
    false,
  );
});

test('sending explicitly uses one command ID, stopping replaces canonical status', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let state = snapshot(conversation());
  boot(() => state);
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    state = snapshot(
      { ...conversation(), activeCommandId: input.commandId as string, runtimeId: 'runtime_1' },
      [
        command(input.commandId as string, 'working', [
          { role: 'user', text: input.text as string },
        ]),
      ],
      1,
    );
    return { body: { result: state.commands[0] } };
  });
  serve('/tools/pi.stop', () => {
    state = snapshot(
      { ...conversation(), runtimeId: 'runtime_1' },
      [
        command(sent[0].commandId as string, 'interrupted', [
          { role: 'user', text: 'What is known?' },
        ]),
      ],
      2,
    );
    return { body: { result: state } };
  });
  await open();
  await write('What is known?');
  await click('Send');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'What is known?');
  assert.ok(typeof sent[0].commandId === 'string');
  assert.match(text(), /Working/);
  assert.match(text(), /What is known\?/);
  assert.equal(
    document.querySelector<HTMLAnchorElement>('a[href="/fleet/runtime_1"]')?.textContent,
    'Fleet details',
  );
  await click('Stop');
  assert.match(text(), /Interrupted/);
  assert.equal(requests.filter((request) => request.includes('/tools/pi.stop')).length, 1);
});

test('an ambiguous send retry retains its command ID', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(() => snapshot(conversation()));
  const sent: string[] = [];
  serve('/tools/pi.send', (attempt, input) => {
    sent.push(input.commandId as string);
    return attempt === 1 ? { network: true } : { body: { result: command(sent[0], 'waiting') } };
  });
  await open();
  await write('Look up evidence');
  await click('Send');
  assert.match(text(), /server did not answer/);
  await click('Retry send');
  assert.deepEqual(sent, [sent[0], sent[0]]);
});

test('snapshot tail and live deltas share ordered, bounded transient output', async (context) => {
  context.after(cleanup);
  setProject('p1');
  const active = { ...conversation(), activeCommandId: 'command_1' };
  const entry = (
    sequence: number,
    type: PiEvent['type'],
    value: string,
    commandId = 'command_1',
  ): PiEvent => ({ sequence, type, text: value, commandId });
  const state = snapshot(active, [command('command_1', 'working')], 8, [
    entry(7, 'progress', 'p'.repeat(310)),
    entry(3, 'text', 'tail'),
    entry(2, 'text', 'a'.repeat(17_000)),
    entry(4, 'progress', 'earlier'),
    entry(5, 'text', 'wrong command', 'command_2'),
    entry(6, 'changed', 'ignored'),
  ]);
  const stream = boot(
    () => state,
    () => [active],
  );
  const transientText = () =>
    document.querySelector<HTMLElement>('.pi-message--transient .pi-message-text')?.textContent;
  const transientProgress = () =>
    document.querySelector<HTMLElement>('.pi-message--transient .muted')?.textContent;
  await open();
  assert.equal(transientText(), `${'a'.repeat(16_380)}tail`);
  assert.equal(transientProgress(), 'p'.repeat(300));

  await act(async () => {
    stream.push('delta', {
      streamId: 'stream_1',
      ...entry(9, 'text', 'live'),
    });
    stream.push('delta', {
      streamId: 'stream_1',
      ...entry(10, 'progress', 'q'.repeat(320)),
    });
  });
  await settle(10);
  assert.equal(transientText(), `${'a'.repeat(16_376)}taillive`);
  assert.equal(transientProgress(), 'q'.repeat(300));
});

test('reconnect fetches canonical messages and removes stale transient response', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const active = { ...conversation(), activeCommandId: 'command_1' };
  let state = snapshot(active, [
    command('command_1', 'working', [{ role: 'user', text: 'Hello' }]),
  ]);
  const stream = boot(
    () => state,
    () => [active],
  );
  await open();
  await act(async () =>
    stream.push('delta', {
      streamId: 'stream_1',
      sequence: 1,
      commandId: 'command_1',
      type: 'text',
      text: 'partial answer',
    }),
  );
  await settle(10);
  assert.match(text(), /partial answer/);
  state = snapshot(
    { ...conversation() },
    [
      command('command_1', 'completed', [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Complete answer' },
      ]),
    ],
    2,
  );
  stream.drop();
  await settle(2200);
  assert.match(text(), /Complete answer/);
  assert.doesNotMatch(text(), /partial answer/);
  assert.ok(requests.filter((request) => request.includes('/tools/pi.snapshot')).length >= 2);
});

test('project change aborts old stream and opens a clean project conversation', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let id = 'conversation_1';
  const stream = boot(
    () => snapshot(conversation(id)),
    () => [conversation(id)],
  );
  await open();
  id = 'conversation_2';
  await act(async () => setProject('p2'));
  await settle(20);
  assert.ok(stream.aborted >= 1);
  assert.equal(
    document.querySelector<HTMLSelectElement>('#pi-conversation')?.value,
    'conversation_2',
  );
  assert.equal(stream.headers.at(-1)?.get('x-merv-project-id'), 'p2');
});

test('account change aborts SSE and makes the view inert without a project', async (t) => {
  t.after(async () => {
    await cleanup();
    setToken('fixture-token');
  });
  setProject('p1');
  const stream = boot(
    () => snapshot(conversation()),
    () => [conversation()],
  );
  await open();
  await act(async () => setToken(null));
  assert.ok(stream.aborted >= 1);
  assert.match(text(), /Agent unavailable. Select a project/);
  const before = requests.length;
  await settle(20);
  assert.equal(requests.length, before);
});

test('terminal SSE errors disable commands without reconnecting in the background', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(
    () => snapshot(conversation()),
    () => [conversation()],
  );
  const withStream = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/events')
      ? Promise.resolve(new Response(null, { status: 404 }))
      : withStream(input, init)) as typeof fetch;
  await open();
  assert.match(text(), /Unavailable/);
  assert.equal(document.querySelector<HTMLTextAreaElement>('#pi-draft')?.disabled, true);
  const before = requests.length;
  await settle(2150);
  assert.equal(requests.length, before);
});

test('selecting and creating conversations resets the transcript without sending', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let current = 'conversation_1';
  const first = conversation('conversation_1');
  const second = { ...conversation('conversation_2'), title: 'Earlier inquiry' };
  boot(
    () => snapshot(conversation(current)),
    () => [first, second],
  );
  let title = '';
  serve('/tools/pi.create', (_count, input) => {
    title = input.title as string;
    return { body: { result: { ...conversation('conversation_3'), title } } };
  });
  await open();
  const select = document.querySelector<HTMLSelectElement>('#pi-conversation')!;
  current = second.id;
  await act(async () => {
    select.value = current;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await settle(10);
  assert.equal(select.value, second.id);
  current = 'conversation_3';
  const input = document.querySelector<HTMLInputElement>('.pi-title')!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, 'Second inquiry');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await click('New conversation');
  assert.equal(title, 'Second inquiry');
  assert.equal(document.querySelector<HTMLSelectElement>('#pi-conversation')?.value, current);
  assert.equal(
    requests.some((request) => request.includes('/tools/pi.send')),
    false,
  );
});

test('unavailable Agent is inert, including SSE and list', async (t) => {
  t.after(cleanup);
  setProject('p1');
  await open({ state: 'unavailable', detail: 'Pilot disabled' });
  assert.match(text(), /Agent unavailable. Pilot disabled/);
  assert.equal(requests.length, 0);
});

test('incremental SSE parser handles split frames and rejects oversized events', () => {
  const frames: { event: string; data: string }[] = [];
  const parse = piFrameParser((value) => frames.push(value));
  parse(': heartbeat\r\nevent: del');
  parse('ta\r\ndata: {"text":"ok"}\r');
  parse('\n\r\n');
  parse(`data: ${'x'.repeat(70_000)}\n\n`);
  assert.deepEqual(frames, [{ event: 'delta', data: '{"text":"ok"}' }]);
});
