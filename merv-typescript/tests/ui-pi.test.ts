import assert from 'node:assert/strict';
import test from 'node:test';
import type { PiEvent } from '../packages/ui/web/pi-stream.js';
import { click, jump, mount, requests, serve, settle, text, unmount } from './ui-render.js';

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
  available = true,
) => ({
  available,
  conversation: item,
  commands,
  streamId: 'stream_1',
  sequence,
  tail,
});
/** A snapshot standing at one stage, begun `ago` milliseconds before now. */
const staged = (value: ReturnType<typeof snapshot>, name: string, ago = 0, detail?: string) => ({
  ...value,
  stage: { name, since: new Date(Date.now() - ago).toISOString(), detail },
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

test('opening an empty Agent warms one conversation, and the first message goes to it', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let state = snapshot(conversation());
  const stream = boot(() => state);
  const warmed: Record<string, unknown>[] = [];
  serve('/tools/pi.warm', (_count, input) => {
    warmed.push(input);
    state = staged(snapshot({ ...conversation(), runtimeId: 'runtime_1' }), 'machine');
    return { body: { result: state } };
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    state = snapshot({ ...conversation(), activeCommandId: input.commandId as string }, [
      command(input.commandId as string, 'waiting', [{ role: 'user', text: input.text as string }]),
    ]);
    return { body: { result: state.commands[0] } };
  });
  await open();
  await settle(10);
  // The machine starts as the page opens, in the conversation warming found or made.
  assert.deepEqual(
    warmed.map((input) => Object.keys(input)),
    [['requestId']],
  );
  assert.equal(
    requests.some((request) => /pi.create|pi.send|task.create|fleet.request/.test(request)),
    false,
  );
  // One terse hint, and none of the copy that explained the system.
  assert.match(text(), /Ask a question to begin/);
  assert.match(text(), /Starting a machine · 0 s/);
  for (const gone of ['pilot', 'No task is created', 'Ctrl + Enter', 'Ready'])
    assert.ok(!text().includes(gone), `“${gone}” is on the page: ${text()}`);
  await write('What is known?');
  await click('Send');
  assert.equal(requests.filter((request) => request.includes('/tools/pi.create')).length, 0);
  assert.equal(sent[0].id, 'conversation_1');
  assert.match(text(), /Waiting for a free machine/);
  assert.equal(stream.headers[0].get('authorization'), 'Bearer fixture-token');
  assert.equal(stream.headers[0].get('x-merv-project-id'), 'p1');
  // New conversation asks under a request of its own, not the one warming opened this under.
  const created: unknown[] = [];
  serve('/tools/pi.create', (_count, input) => {
    created.push(input.requestId);
    return { body: { result: conversation('conversation_2') } };
  });
  await act(async () => document.querySelector<HTMLButtonElement>('.pi-switch-button')!.click());
  await click('New conversation');
  assert.equal(created.length, 1);
  assert.notEqual(created[0], warmed[0].requestId);
});

test('a question sent while the first warm-up waits out a release goes to the conversation it opened', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(() => snapshot(conversation()));
  const warmed: unknown[] = [];
  serve('/tools/pi.warm', (_count, input) => {
    warmed.push(input.requestId);
    return {
      status: 409,
      body: { error: { code: 'pi_runtime_releasing', message: 'pi_runtime_releasing' } },
    };
  });
  const created: unknown[] = [];
  serve('/tools/pi.create', (_count, input) => {
    created.push(input.requestId);
    return { body: { result: conversation() } };
  });
  serve('/tools/pi.send', { body: { result: command('command_1', 'waiting') } });
  await open();
  await settle(10);
  await write('What is known?');
  await click('Send');
  // The same request: pi.create answers the conversation that warm-up opened, not a second one.
  assert.deepEqual(created, [warmed[0]]);
});

test('the StrictMode page still loads after effect replay', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(
    () => snapshot(conversation()),
    () => [conversation()],
  );
  await open(row.status, true);
  assert.match(text(), /Ready/);
  assert.equal(requests.filter((request) => request.includes('/tools/pi.create')).length, 0);
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
  assert.match(text(), /Answering/);
  assert.match(text(), /What is known\?/);
  // The cursor is back where the next question is written.
  assert.equal(document.activeElement?.id, 'pi-draft');
  assert.equal(
    document.querySelector<HTMLAnchorElement>('a[href="/fleet/runtime_1"]')?.textContent,
    'Fleet details',
  );
  await click('Stop');
  assert.match(text(), /Stopped/);
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
  assert.match(text(), /Merv didn’t answer. Try again./);
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
    document.querySelector<HTMLElement>('.pi-message--transient .md')?.textContent;
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
    requests.filter((request) => request.endsWith('/events')).at(-1),
    'GET /pi/conversation_2/events',
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
    () => staged(snapshot(conversation()), 'machine', 5000),
    () => [conversation()],
  );
  const withStream = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/events')
      ? Promise.resolve(new Response(null, { status: 404 }))
      : withStream(input, init)) as typeof fetch;
  await open();
  assert.match(text(), /Unavailable/);
  assert.doesNotMatch(text(), /404|·/);
  assert.ok(!document.querySelector('.pi-state-dot--active'));
  const sendButton = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send');
  assert.equal(sendButton?.disabled, true);
  const before = requests.length;
  await settle(2150);
  assert.equal(requests.length, before);
});

test('one bar names the conversation and switches between them, newest first, by keyboard or pointer', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let current = 'conversation_1';
  const asked = 'How do proteins fold into their native shapes so quickly?';
  const second = {
    ...conversation('conversation_2'),
    title: 'Earlier inquiry',
    updatedAt: '2026-09-21T00:00:00Z',
  };
  boot(
    () =>
      current === 'conversation_1'
        ? snapshot(conversation(), [
            command('command_1', 'completed', [{ role: 'user', text: asked }]),
          ])
        : snapshot(current === second.id ? second : conversation(current)),
    () => [conversation(), second],
  );
  let created: Record<string, unknown> = {};
  serve('/tools/pi.create', (_count, input) => {
    created = input;
    return { body: { result: conversation('conversation_3') } };
  });
  await open();
  const bar = () => document.querySelector<HTMLButtonElement>('.pi-switch-button')!;
  const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const key = (name: string) =>
    act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
  // Until Pi names it, a conversation is called by its first question.
  assert.equal(bar().textContent, `${asked.slice(0, 47)}…`);
  assert.equal(bar().getAttribute('aria-haspopup'), 'menu');
  for (const gone of ['Conversation', 'New conversation title'])
    assert.ok(!text().includes(gone), `“${gone}” is on the page`);
  assert.equal(document.querySelector('label[for="pi-draft"]')?.className, 'sr-only');
  await act(async () => bar().click());
  assert.equal(bar().getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    items().map((item) => item.firstChild?.textContent),
    ['New conversation', 'Earlier inquiry', bar().textContent],
  );
  assert.ok(items()[1].querySelector('time'));
  assert.equal(document.activeElement, items()[0]);
  await key('ArrowDown');
  assert.equal(document.activeElement, items()[1]);
  await key('Escape');
  assert.equal(items().length, 0);
  assert.equal(document.activeElement, bar());
  await act(async () => bar().click());
  await act(async () => {
    document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  });
  assert.equal(items().length, 0);
  current = second.id;
  await act(async () => bar().click());
  await act(async () => items()[1].click());
  await settle(10);
  assert.equal(bar().textContent, 'Earlier inquiry');
  assert.equal(document.activeElement, bar());
  current = 'conversation_3';
  await act(async () => bar().click());
  await act(async () => items()[0].click());
  await settle(10);
  // Pi names the conversation; nobody types a title.
  assert.deepEqual(Object.keys(created), ['requestId']);
  assert.equal(bar().textContent, 'New conversation');
  assert.equal(document.activeElement?.id, 'pi-draft');
  assert.equal(
    requests.some((request) => request.includes('/tools/pi.send')),
    false,
  );
});

test('a turn that ended early says why in a sentence, and stopping it yourself says nothing', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const ended = (error: string) => ({
    ...command('command_1', 'interrupted', [{ role: 'user', text: 'Hello' }]),
    error,
  });
  let state = snapshot(conversation(), [ended('turn_expired')]);
  boot(
    () => state,
    () => [conversation()],
  );
  await open();
  assert.match(text(), /The answer took too long. Ask again./);
  assert.doesNotMatch(text(), /turn_expired/);
  await unmount();
  state = snapshot(conversation(), [ended('cancelled')]);
  boot(
    () => state,
    () => [conversation()],
  );
  await open();
  assert.match(text(), /Stopped/);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.doesNotMatch(text(), /cancelled/);
});

test('a project that cannot run the agent says so calmly and never reads Ready', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(
    () => snapshot(conversation(), [], 0, [], false),
    () => [conversation()],
  );
  await open();
  assert.match(text(), /Agent isn’t set up for this project yet/);
  assert.doesNotMatch(text(), /Ready/);
  assert.equal(document.querySelector<HTMLTextAreaElement>('#pi-draft')?.disabled, true);
  // Nothing is warmed where no machine can start.
  assert.equal(
    requests.some((request) => request.includes('/tools/pi.warm')),
    false,
  );
  await unmount();
  // A project with no conversation, whose warming failed, learns it from the first refusal.
  setProject('p1');
  boot(() => snapshot(conversation()));
  serve('/tools/pi.send', {
    status: 403,
    body: { error: { code: 'sandbox_not_connected', message: 'sandbox_not_connected' } },
  });
  await open();
  await write('Hello');
  await click('Send');
  assert.match(text(), /Agent isn’t set up for this project yet/);
  assert.doesNotMatch(text(), /sandbox_not_connected/);
  assert.equal(document.querySelector<HTMLTextAreaElement>('#pi-draft')?.disabled, true);
});

test('a rotated stream reconnects at once and silently; a busy one waits quietly', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const stream = boot(
    () => snapshot(conversation()),
    () => [conversation()],
  );
  await open();
  const opened = () => requests.filter((request) => request.endsWith('/events')).length;
  assert.equal(opened(), 1);
  // A stream that lived its while; one closed at once would wait like any other failure.
  await jump(6000, 0);
  stream.push('rotate', {});
  stream.drop();
  await settle(20);
  assert.equal(opened(), 2);
  assert.doesNotMatch(text(), /Reconnecting|disconnected/);
  await unmount();

  setProject('p1');
  boot(
    () => snapshot(conversation()),
    () => [conversation()],
  );
  const withStream = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/events')
      ? Promise.resolve(
          Response.json({ error: { code: 'pi_stream_busy', message: 'busy' } }, { status: 429 }),
        )
      : withStream(input, init)) as typeof fetch;
  await open();
  await settle(2100);
  assert.doesNotMatch(text(), /Reconnecting|unavailable|429/i);
  assert.match(text(), /Ready/);
});

test('a send refused while the previous agent finishes is asked again with the same command', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let state: ReturnType<typeof snapshot> = staged(
    snapshot({ ...conversation(), runtimeId: 'runtime_1' }),
    'agent',
  );
  boot(
    () => state,
    () => [conversation()],
  );
  const sent: string[] = [];
  serve('/tools/pi.send', (attempt, input) => {
    sent.push(input.commandId as string);
    if (attempt === 1)
      return {
        status: 409,
        body: { error: { code: 'pi_runtime_releasing', message: 'pi_runtime_releasing' } },
      };
    state = snapshot(
      { ...conversation(), activeCommandId: sent[0], runtimeId: 'runtime_2' },
      [command(sent[0], 'starting', [{ role: 'user', text: 'Again' }])],
      1,
    );
    return { body: { result: state.commands[0] } };
  });
  await open();
  await write('Again');
  await click('Send');
  assert.match(text(), /Finishing the previous agent…/);
  assert.doesNotMatch(text(), /pi_runtime_releasing|·/);
  assert.ok(document.querySelector('.pi-bar .pi-state-dot--active'));
  await settle(3100);
  assert.deepEqual(sent, [sent[0], sent[0]]);
  assert.match(text(), /Preparing a machine/);
});

test('a machine warms as the page opens and in a new conversation, but a switch waits for a question', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const second = { ...conversation('conversation_2'), updatedAt: '2026-09-21T00:00:00Z' };
  const known = (id: string) => (id === second.id ? second : conversation(id));
  let current = 'conversation_1';
  boot(
    () => snapshot(known(current)),
    () => [conversation(), second],
  );
  serve('/tools/pi.create', { body: { result: conversation('conversation_3') } });
  const warmed: Record<string, unknown>[] = [];
  serve('/tools/pi.warm', (attempt, input) => {
    warmed.push(input);
    if (attempt === 1 || attempt === 3)
      return {
        status: 409,
        body: { error: { code: 'pi_runtime_releasing', message: 'pi_runtime_releasing' } },
      };
    const item = { ...known(input.conversationId as string), runtimeId: 'runtime_1' };
    return { body: { result: staged(snapshot(item), 'machine') } };
  });
  const ids = () => warmed.map((input) => input.conversationId);
  const area = () => document.querySelector<HTMLTextAreaElement>('#pi-draft')!;
  const focus = () =>
    act(async () => {
      area().blur();
      area().focus();
    });
  const choose = async (index: number) => {
    await act(async () => document.querySelector<HTMLButtonElement>('.pi-switch-button')!.click());
    await act(async () =>
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index].click(),
    );
    await settle(10);
  };
  await open();
  await settle(10);
  // The agent released elsewhere is waited for without a word, and nothing is held up.
  assert.deepEqual(ids(), ['conversation_1']);
  assert.doesNotMatch(text(), /Finishing|still finishing|releasing/);
  assert.ok(!document.querySelector('[role="alert"]'));
  assert.equal(area().readOnly, false);
  await focus();
  assert.equal(warmed.length, 1);
  await settle(3100);
  assert.equal(warmed[1].requestId, warmed[0].requestId);
  assert.match(text(), /Starting a machine/);
  // Looking at another conversation and coming back leaves the warm machine where it is.
  current = 'conversation_2';
  await choose(1);
  current = 'conversation_1';
  await choose(2);
  assert.deepEqual(ids(), ['conversation_1', 'conversation_1']);
  // A question begun there warms it, and a conversation the person has left is not retried.
  current = 'conversation_2';
  await choose(1);
  await focus();
  current = 'conversation_1';
  await choose(2);
  await settle(3100);
  assert.deepEqual(ids(), ['conversation_1', 'conversation_1', 'conversation_2']);
  current = 'conversation_2';
  await choose(1);
  await focus();
  await focus();
  current = 'conversation_3';
  await choose(0);
  assert.deepEqual(ids(), [
    'conversation_1',
    'conversation_1',
    'conversation_2',
    'conversation_2',
    'conversation_3',
  ]);
  assert.deepEqual(
    requests
      .filter((request) => request.endsWith('/events'))
      .map((request) => request.slice(8, 22)),
    ['1', '2', '1', '2', '1', '2', '3'].map((n) => `conversation_${n}`),
  );
});

test('opening Agent goes to the conversation whose machine is warm, and warms nothing', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const warm = { ...conversation('conversation_2'), runtimeId: 'runtime_1' };
  boot(
    () => snapshot(warm),
    () => [conversation(), warm],
  );
  await open();
  assert.deepEqual(
    requests.filter((request) => /events|pi.warm/.test(request)),
    ['GET /pi/conversation_2/events'],
  );
});

test('a warm-up that answers late leaves the page where the person went', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(() => snapshot(conversation()));
  serve('/tools/pi.warm', { body: { result: snapshot(conversation('conversation_9')) } });
  let answer = () => {};
  const held = new Promise<void>((resolve) => (answer = resolve));
  const withStream = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/tools/pi.warm')) await held;
    return withStream(input, init);
  }) as typeof fetch;
  await open();
  await act(async () => document.querySelector<HTMLButtonElement>('.pi-switch-button')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  await settle(10);
  answer();
  await settle(10);
  assert.equal(
    requests.some((request) => request.includes('conversation_9')),
    false,
  );
  assert.equal(
    requests.filter((request) => request.endsWith('/events')).at(-1),
    'GET /pi/conversation_1/events',
  );
});

test('the bar and the transcript say what the turn waits on, counting the seconds of each wait', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const active = { ...conversation(), activeCommandId: 'command_1', runtimeId: 'runtime_1' };
  const asked = [{ role: 'user', text: 'Hello' }];
  let sequence = 0;
  const stream = boot(
    () => staged(snapshot(active, [command('command_1', 'starting', asked)]), 'machine', 6000),
    () => [active],
  );
  const bar = () => document.querySelector('.pi-bar [role="status"]')?.textContent ?? '';
  const row = () => document.querySelector('.pi-messages .pi-state');
  const push = (name: string, status = 'working', detail?: string, tail: PiEvent[] = []) =>
    act(async () =>
      stream.push(
        'snapshot',
        staged(
          snapshot(active, [command('command_1', status, asked)], ++sequence, tail),
          name,
          0,
          detail,
        ),
      ),
    );
  await open();
  assert.match(bar(), /^Starting a machine · 6 s/);
  // The same words under the question, for the eye alone: the bar already says them aloud.
  assert.match(row()?.textContent ?? '', /^Starting a machine · 6 s$/);
  assert.equal(row()?.getAttribute('aria-hidden'), 'true');
  assert.equal(
    document.querySelector('[role="status"] [aria-hidden="true"]')?.textContent,
    ' · 6 s',
  );
  assert.ok(document.querySelector('.pi-bar .pi-state-dot--active'));
  await jump(60_000);
  assert.match(bar(), /^Starting a machine · 6\d s/);
  // Nothing is counted while the stream that would end the wait is away.
  stream.drop();
  await settle(10);
  assert.match(text(), /Reconnecting…/);
  assert.doesNotMatch(bar(), /·/);
  await settle(2100);
  assert.match(bar(), /^Starting a machine · 6 s/);
  await push('agent', 'starting');
  assert.match(bar(), /^Loading the agent · 0 s/);
  await push('tool', 'working', 'Reading a file');
  assert.match(bar(), /^Reading a file(Fleet details)?$/);
  await push('thinking');
  assert.match(bar(), /^Thinking · 0 s/);
  const partial: PiEvent = {
    sequence: ++sequence,
    commandId: 'command_1',
    type: 'text',
    text: 'Partial',
  };
  await act(async () => stream.push('delta', { streamId: 'stream_1', ...partial }));
  await settle(10);
  assert.match(bar(), /^Writing…/);
  // Words the stage already counted are no news: after a tool the model thinks again.
  await push('thinking', 'working', undefined, [partial]);
  assert.match(bar(), /^Thinking · 0 s/);
  assert.match(text(), /Partial/);
  await push('saving', 'saving');
  assert.match(row()?.textContent ?? '', /^Saving…$/);
  await act(async () =>
    stream.push(
      'snapshot',
      staged(
        snapshot(
          { ...active, activeCommandId: null },
          [command('command_1', 'completed')],
          ++sequence,
        ),
        'ready',
      ),
    ),
  );
  assert.match(bar(), /^Agent ready/);
  assert.doesNotMatch(bar(), /·/);
  assert.ok(!row());
  assert.ok(document.querySelector('.pi-state-dot--ready'));
  assert.ok(!document.querySelector('.pi-state-dot--active'));
});

test('the transcript follows new text until the reader scrolls up, and reads answers as Markdown', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const active = { ...conversation(), activeCommandId: 'command_1' };
  const stream = boot(
    () =>
      snapshot(active, [
        command('command_1', 'working', [{ role: 'user', text: 'Hello' }]),
        command('command_0', 'completed', [{ role: 'assistant', text: 'A **bold** answer' }]),
      ]),
    () => [active],
  );
  await open();
  assert.equal(document.querySelector('.pi-message--assistant strong')?.textContent, 'bold');
  const list = document.querySelector<HTMLElement>('.pi-messages')!;
  let height = 900;
  Object.defineProperty(list, 'scrollHeight', { get: () => height });
  Object.defineProperty(list, 'clientHeight', { get: () => 300 });
  const delta = (sequence: number) =>
    act(async () =>
      stream.push('delta', {
        streamId: 'stream_1',
        sequence,
        commandId: 'command_1',
        type: 'text',
        text: 'more ',
      }),
    );
  await delta(1);
  await settle(10);
  assert.equal(list.scrollTop, 900);
  await act(async () => {
    list.scrollTop = 100;
    list.dispatchEvent(new window.Event('scroll'));
  });
  height = 1200;
  await delta(2);
  await settle(10);
  assert.equal(list.scrollTop, 100);
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
