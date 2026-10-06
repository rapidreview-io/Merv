import assert from 'node:assert/strict';
import test from 'node:test';
import type { PiCommand, PiEvent } from '../packages/pi/src/models.js';
import { click, jump, mount, requests, resize, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');

const { createElement, StrictMode } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter, useNavigate } = await import('react-router-dom');
const { PiView } = await import('../packages/ui/web/views/pi.js');
const { actOf, factsOf, labelOf, receiptOf } =
  await import('../packages/ui/web/views/pi-proposal.js');
const { App } = await import('../packages/ui/web/app.js');
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
  activeCommandId: string | null;
  checkpoint: null;
  previousCheckpoint: null;
  createdAt: string;
  updatedAt: string;
  model?: string;
}
const conversation = (id = 'conversation_1'): Conversation => ({
  id,
  projectId: 'p1',
  userId: 'user_1',
  title: 'New conversation',
  revision: 1,
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
const standard = {
  key: 'standard',
  label: 'Standard',
  vcpu: 0.5,
  memoryGiB: 4,
  diskGB: 8,
  maxHourlyUsd: 0.074,
};
const large = {
  key: 'large',
  label: 'Large',
  vcpu: 2,
  memoryGiB: 8,
  diskGB: 16,
  maxHourlyUsd: 0.22,
};
/** The person's machine here, as PiHostView reads it; `none` has no machine yet. */
const host = (state: 'none' | 'starting' | 'ready' = 'ready', extra: object = {}) => ({
  machine: state === 'none' ? null : standard,
  preferred: 'standard',
  catalog: [
    { ...standard, available: true },
    { ...large, available: true },
  ],
  state,
  idleEndsAt: null,
  idleSeconds: 600,
  moving: null,
  lastMove: null,
  ...extra,
});
const snapshot = (
  item: Conversation,
  commands: ReturnType<typeof command>[] = [],
  sequence = 0,
  tail: PiEvent[] = [],
  available = true,
  machine: ReturnType<typeof host> = host(),
) => ({
  available,
  conversation: item,
  commands,
  host: machine,
  models: [] as { id: string; label: string }[],
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
    state = staged(snapshot(conversation(), [], 0, [], true, host('starting')), 'machine');
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

test('a question typed right after New conversation is kept and sent into it', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(() => snapshot(conversation()));
  serve('/tools/pi.warm', { body: { result: snapshot(conversation()) } });
  const created: unknown[] = [];
  serve('/tools/pi.create', (_count, input) => {
    created.push(input.requestId);
    return { body: { result: conversation('conversation_2') } };
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'waiting') } };
  });
  let answer = () => {};
  const held = new Promise<void>((resolve) => (answer = resolve));
  const withStream = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/tools/pi.create')) await held;
    return withStream(input, init);
  }) as typeof fetch;
  await open();
  await settle(10);
  await write('First?');
  await click('Send');
  await settle(10);
  await act(async () => document.querySelector<HTMLButtonElement>('.pi-switch-button')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  // The box stays editable while the conversation is being made, and the question is not lost.
  assert.equal(document.querySelector<HTMLTextAreaElement>('#pi-draft')!.readOnly, false);
  await write('Asked at once?');
  await click('Send');
  answer();
  await settle(10);
  assert.equal(new Set(created).size, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].id, 'conversation_2');
  assert.equal(sent[1].text, 'Asked at once?');
});

test('Enter sends, and ⌘/Ctrl+Enter starts a new line where the cursor is', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(() => snapshot(conversation()));
  serve('/tools/pi.warm', { body: { result: snapshot(conversation()) } });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'waiting') } };
  });
  await open();
  await settle(10);
  const area = document.querySelector<HTMLTextAreaElement>('#pi-draft')!;
  // Whether the page kept the key from the browser; a key it lets through does its native thing.
  const press = async (init: KeyboardEventInit) => {
    let kept = false;
    await act(async () => {
      kept = !area.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
    await settle(10);
    return kept;
  };
  assert.equal(area.getAttribute('enterkeyhint'), 'send');
  // A new line the person deletes again is gone from what is sent.
  await write('ab');
  area.setSelectionRange(1, 1);
  assert.equal(await press({ metaKey: true }), true);
  assert.equal(area.value, 'a\nb');
  await write('ab');
  assert.equal(await press({}), true);
  assert.equal(sent.at(-1)?.text, 'ab');
  await write('ab');
  area.setSelectionRange(1, 1);
  for (const init of [{ metaKey: true }, { ctrlKey: true }]) assert.equal(await press(init), true);
  assert.equal(area.value, 'a\n\nb');
  assert.equal(area.selectionStart, 3);
  for (const init of [
    { shiftKey: true },
    { altKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ])
    assert.equal(await press(init), false);
  assert.equal(sent.length, 1);
  assert.equal(await press({}), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, 'a\n\nb');
});

test('a question sent while the first warm-up is under way goes to the conversation it opens', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(() => snapshot(conversation()));
  const warmed: unknown[] = [];
  serve('/tools/pi.warm', (_count, input) => {
    warmed.push(input.requestId);
    return { body: { result: snapshot(conversation()) } };
  });
  const created: unknown[] = [];
  serve('/tools/pi.create', (_count, input) => {
    created.push(input.requestId);
    return { body: { result: conversation() } };
  });
  serve('/tools/pi.send', { body: { result: command('command_1', 'waiting') } });
  let answer = () => {};
  const held = new Promise<void>((resolve) => (answer = resolve));
  const withStream = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/tools/pi.warm')) await held;
    return withStream(input, init);
  }) as typeof fetch;
  await open();
  await write('What is known?');
  await click('Send');
  answer();
  await settle(10);
  // The same request: pi.create answers the conversation that warm-up opens, not a second one.
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
      { ...conversation(), activeCommandId: input.commandId as string },
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
      conversation(),
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
  await click('Stop');
  assert.match(text(), /Stopped/);
  assert.equal(requests.filter((request) => request.includes('/tools/pi.stop')).length, 1);
});

test('a stopped answer keeps the words it had streamed, marked Stopped, and so does a reload', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const asked = { role: 'user', text: 'What is known?' };
  const words = 'Two findings so far';
  let state = snapshot(
    { ...conversation(), activeCommandId: 'command_1' },
    [command('command_1', 'working', [asked])],
    2,
    [{ sequence: 2, commandId: 'command_1', type: 'text', text: words }],
  );
  boot(
    () => state,
    () => [conversation()],
  );
  serve('/tools/pi.stop', () => {
    state = snapshot(
      conversation(),
      [
        {
          ...command('command_1', 'interrupted', [asked, { role: 'assistant', text: words }]),
          error: 'cancelled',
        },
      ],
      3,
    );
    return { body: { result: state } };
  });
  const answer = () =>
    [...document.querySelectorAll('.pi-messages > *')].slice(1).map((node) => node.textContent);
  await open();
  assert.deepEqual(answer(), [`Agent · live${words}`, 'Answering']);
  await click('Stop');
  assert.deepEqual(answer(), [`Agent${words}`, 'Stopped']);
  await unmount();
  boot(
    () => state,
    () => [conversation()],
  );
  await open();
  assert.deepEqual(answer(), [`Agent${words}`, 'Stopped']);
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

test('snapshot tail and live deltas share ordered transient output, however long', async (context) => {
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
  assert.equal(transientText(), `${'a'.repeat(17_000)}tail`);
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
  assert.equal(transientText(), `${'a'.repeat(17_000)}taillive`);
  assert.equal(transientProgress(), 'q'.repeat(300));
});

test('a streamed answer is drawn at the pace it arrives, never half a second behind, and whole once saved', async (t) => {
  t.after(cleanup);
  setProject('p1');
  // Motion allowed: by default this page asks for less, and every word shows at once.
  const media = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...media(query),
    matches: !query.includes('reduced-motion'),
  })) as typeof window.matchMedia;
  t.after(() => {
    window.matchMedia = media;
  });
  const active = { ...conversation(), activeCommandId: 'command_1' };
  let state = snapshot(active, [command('command_1', 'working', [{ role: 'user', text: 'Hi' }])]);
  const stream = boot(
    () => state,
    () => [active],
  );
  await open();
  const live = () =>
    document.querySelector<HTMLElement>('.pi-message--transient .md')?.textContent ?? '';
  const words = (from: number) =>
    Array.from({ length: 60 }, (_, index) => `word${from + index}`).join(' ');
  const say = (sequence: number, text: string) =>
    act(async () =>
      stream.push('delta', {
        streamId: 'stream_1',
        sequence,
        commandId: 'command_1',
        type: 'text',
        text,
      }),
    );
  await say(1, words(0));
  await settle(60);
  const early = live().length;
  assert.ok(early > 0 && early < words(0).length, `${early} of ${words(0).length} shown`);
  await settle(300);
  assert.equal(live(), words(0));
  // More words pick up where the last stopped, and catch up as soon.
  await say(2, ` ${words(60)}`);
  await settle(60);
  assert.ok(live().length > words(0).length && live().length < 2 * words(0).length);
  await settle(300);
  assert.equal(live(), `${words(0)} ${words(60)}`);
  // Saved mid-reveal: the whole answer shows at once.
  await say(3, ` ${words(120)}`);
  const answer = `${words(0)} ${words(60)} ${words(120)}`;
  state = snapshot(
    { ...conversation() },
    [
      command('command_1', 'completed', [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: answer },
      ]),
    ],
    4,
  );
  await act(async () =>
    stream.push('delta', {
      streamId: 'stream_1',
      sequence: 4,
      commandId: 'command_1',
      type: 'changed',
      text: '',
    }),
  );
  await settle(20);
  assert.ok(!document.querySelector('.pi-message--transient'));
  assert.equal(
    document.querySelector<HTMLElement>('.pi-message--assistant .md')?.textContent,
    answer,
  );
});

test('a reader who asks for less motion gets each word as it arrives', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const active = { ...conversation(), activeCommandId: 'command_1' };
  const stream = boot(
    () => snapshot(active, [command('command_1', 'working', [{ role: 'user', text: 'Hi' }])]),
    () => [active],
  );
  await open();
  const text = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ');
  await act(async () =>
    stream.push('delta', {
      streamId: 'stream_1',
      sequence: 1,
      commandId: 'command_1',
      type: 'text',
      text,
    }),
  );
  await settle(0);
  assert.equal(
    document.querySelector<HTMLElement>('.pi-message--transient .md')?.textContent,
    text,
  );
});

test('the conversation menu names each item and holds still while an answer streams', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const active = {
    ...conversation(),
    title: 'Protein folding',
    activeCommandId: 'command_1',
    updatedAt: '2026-09-22T00:00:00Z',
  };
  const older = {
    ...conversation('conversation_2'),
    title: 'Earlier inquiry',
    updatedAt: '2026-09-21T00:00:00Z',
  };
  let current = active;
  const stream = boot(
    () =>
      current.id === older.id
        ? snapshot(older)
        : snapshot(current, [command('command_1', 'working', [{ role: 'user', text: 'Hi' }])]),
    () => [active, older],
  );
  await open();
  const bar = () => document.querySelector<HTMLButtonElement>('.pi-switch-button')!;
  const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  await act(async () => bar().click());
  const opened = items();
  // Named by label, or by their words where those are the whole name.
  const names = () => items().map((item) => item.getAttribute('aria-label') ?? item.textContent);
  assert.equal(names()[0], 'New conversation');
  assert.match(names()[1], /^Protein folding, \S/);
  assert.match(names()[2], /^Earlier inquiry, \S/);
  // Words stream and the conversation's own snapshot moves it below the other: the open menu
  // keeps every item where it was.
  current = { ...active, updatedAt: '2026-09-20T00:00:00Z' };
  for (let sequence = 1; sequence <= 3; sequence++)
    await act(async () =>
      stream.push('delta', {
        streamId: 'stream_1',
        sequence,
        commandId: 'command_1',
        type: sequence === 2 ? 'changed' : 'text',
        text: sequence === 2 ? '' : 'more ',
      }),
    );
  await settle(20);
  assert.equal(bar().getAttribute('aria-expanded'), 'true');
  assert.deepEqual(items(), opened);
  current = older;
  await act(async () => items()[2].click());
  await settle(10);
  assert.equal(bar().textContent, 'Earlier inquiry');
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

test('a turn that ended early says why under its question, quietly, however many turns follow', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const ended = (error: string) => ({
    ...command('command_1', 'interrupted', [{ role: 'user', text: 'Hello' }]),
    error,
  });
  const noted = () =>
    [...document.querySelectorAll('.pi-message--user + .pi-ended')].map((node) => node.textContent);
  let state = snapshot(conversation(), [
    ended('turn_expired'),
    command('command_2', 'completed', [
      { role: 'user', text: 'Again' },
      { role: 'assistant', text: 'Answer' },
    ]),
  ]);
  boot(
    () => state,
    () => [conversation()],
  );
  await open();
  assert.deepEqual(noted(), ['The answer took too long. Ask again.']);
  assert.doesNotMatch(text(), /turn_expired/);
  assert.equal(document.querySelector('[role="alert"]'), null);
  await unmount();
  // Stopping it yourself needs only the word.
  state = snapshot(conversation(), [ended('cancelled')]);
  boot(
    () => state,
    () => [conversation()],
  );
  await open();
  assert.deepEqual(noted(), ['Stopped']);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.doesNotMatch(text(), /cancelled/);
});

test('an agent that cannot start machines says so calmly and never reads Ready', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(
    () => snapshot(conversation(), [], 0, [], false, host('none')),
    () => [conversation()],
  );
  await open();
  assert.match(text(), /Agent isn’t available right now/);
  assert.doesNotMatch(text(), /Ready|Standard ·/);
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
  assert.match(text(), /Agent isn’t available right now/);
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

test('the machine warms where the page opens or a question begins with none, and only there', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let machine: 'none' | 'starting' = 'none';
  const first = conversation();
  const second = { ...conversation('conversation_2'), updatedAt: '2026-09-21T00:00:00Z' };
  let current = first;
  const stream = boot(
    () => snapshot(current, [], 0, [], true, host(machine)),
    () => [first, second],
  );
  const warmed: unknown[] = [];
  serve('/tools/pi.warm', (_count, input) => {
    warmed.push(input.conversationId);
    machine = 'starting';
    const id = input.conversationId as string;
    return { body: { result: snapshot(conversation(id), [], 0, [], true, host(machine)) } };
  });
  let started = 0;
  let answer = () => {};
  const held = new Promise<void>((resolve) => (answer = resolve));
  const withStream = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/tools/pi.warm')) {
      started++;
      await held;
    }
    return withStream(input, init);
  }) as typeof fetch;
  const area = () => document.querySelector<HTMLTextAreaElement>('#pi-draft')!;
  const focus = () =>
    act(async () => {
      area().blur();
      area().focus();
    });
  // Newest first, after New conversation.
  const go = async (item: Conversation) => {
    current = item;
    await act(async () => document.querySelector<HTMLButtonElement>('.pi-switch-button')!.click());
    await act(async () =>
      document
        .querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
        [item === second ? 1 : 2].click(),
    );
    await settle(10);
  };
  await open();
  await settle(10);
  // Opening the page starts the machine before anything is begun there.
  assert.equal(started, 1);
  // A question begun while it starts asks nothing more.
  await focus();
  assert.equal(area().readOnly, false);
  answer();
  await settle(10);
  assert.equal(started, 1);
  assert.deepEqual(warmed, ['conversation_1']);
  assert.equal(note().textContent, 'Standard · ½ vCPU · 4 GiB');
  // Every conversation here shares it: opening another, or asking there, starts nothing.
  await go(second);
  await focus();
  assert.deepEqual(warmed, ['conversation_1']);
  // A machine that stops while the page stands open stays stopped while the person only looks.
  machine = 'none';
  await act(async () => stream.push('snapshot', snapshot(second, [], 1, [], true, host('none'))));
  await settle(10);
  assert.equal(note().textContent, 'Standard · ½ vCPU · 4 GiB');
  await go(first);
  assert.equal(note().textContent, 'Standard · ½ vCPU · 4 GiB');
  assert.deepEqual(warmed, ['conversation_1']);
  // Beginning a question starts it again.
  await focus();
  await settle(10);
  assert.deepEqual(warmed, ['conversation_1', 'conversation_1']);
});

test('opening Agent goes to the newest conversation, and leaves a running machine alone', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const newest = { ...conversation('conversation_2'), updatedAt: '2026-09-21T00:00:00Z' };
  boot(
    () => snapshot(newest),
    () => [newest, conversation()],
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
  const active = { ...conversation(), activeCommandId: 'command_1' };
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
  assert.match(bar(), /^Reading a file$/);
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

test('a wait counts its seconds by the server’s clock, however far this one is off', async (t) => {
  t.after(cleanup);
  setProject('p1');
  // The server's clock runs a minute ahead; by it, the machine began starting six seconds ago.
  boot(
    () => ({
      ...staged(snapshot(conversation()), 'machine', 6000 - 60_000),
      now: new Date(Date.now() + 60_000).toISOString(),
    }),
    () => [conversation()],
  );
  await open();
  assert.match(
    document.querySelector('.pi-bar [role="status"]')?.textContent ?? '',
    /^Starting a machine · 6 s/,
  );
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

const note = () => document.querySelector<HTMLButtonElement>('.pi-machine-button')!;
const picker = () => [
  ...document.querySelectorAll<HTMLButtonElement>('.pi-machine [role^="menuitem"]'),
];
const press = (name: string) =>
  act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }));
  });

test('the bar names the machine every conversation here shares, and its picker says who may choose', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const shared = host('ready', {
    catalog: [
      { ...standard, available: true },
      { ...large, available: false, reason: 'needs write access in this project' },
    ],
  });
  boot(
    () => snapshot(conversation(), [], 0, [], true, shared),
    () => [conversation()],
  );
  await open();
  // The hardware alone, with no words around it.
  assert.equal(note().textContent, 'Standard · ½ vCPU · 4 GiB');
  assert.equal(note().getAttribute('aria-haspopup'), 'menu');
  await act(async () => note().click());
  // The picker is its machines alone: no note explains the machine.
  assert.equal(document.querySelector('.pi-machine .pi-menu-note'), null);
  assert.equal(
    document.querySelector('.pi-machine [role="menu"]')!.hasAttribute('aria-describedby'),
    false,
  );
  assert.deepEqual(
    picker().map((item) => [item.textContent, item.getAttribute('aria-checked')]),
    [
      ['Standard½ vCPU · 4 GiB · 8 GB', 'true'],
      ['Largeneeds write access in this project', 'false'],
      ['Release machine', null],
    ],
  );
  assert.equal(picker()[1].getAttribute('aria-disabled'), 'true');
  // Operated as the conversation menu is, and a machine the person may not choose does nothing.
  assert.equal(document.activeElement, picker()[0]);
  await press('ArrowDown');
  assert.equal(document.activeElement, picker()[1]);
  await act(async () => picker()[1].click());
  await press('Escape');
  assert.equal(picker().length, 0);
  assert.equal(document.activeElement, note());
  // Picking the machine it already runs on only shuts the menu.
  await act(async () => note().click());
  await act(async () => picker()[0].click());
  assert.equal(picker().length, 0);
  assert.ok(!requests.some((request) => request.includes('pi.machine')));
});

test('picking Large counts the move while the machine still serves, and a failure says where it stays', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const state = staged(snapshot(conversation()), 'ready');
  const stream = boot(
    () => state,
    () => [conversation()],
  );
  const picked: unknown[] = [];
  serve('/tools/pi.machine.set', (_count, input) => {
    picked.push(input);
    const since = new Date(Date.now() - 8000).toISOString();
    return { body: { result: host('ready', { moving: { to: 'large', by: 'person', since } }) } };
  });
  await open();
  await act(async () => note().click());
  await act(async () => picker()[1].click());
  assert.deepEqual(picked, [{ machine: 'large' }]);
  assert.equal(document.activeElement, note());
  assert.equal(note().textContent, 'Moving to a Large machine · 8 s');
  // The conversation is not waiting on the move: the machine it runs on still answers.
  const moving = host('ready', {
    moving: { to: 'large', by: 'person', since: new Date().toISOString() },
  });
  await act(async () =>
    stream.push('snapshot', staged(snapshot(conversation(), [], 1, [], true, moving), 'moving')),
  );
  assert.match(
    document.querySelector('.pi-bar [role="status"]')?.textContent ?? '',
    /^Agent ready$/,
  );
  assert.match(note().textContent!, /^Moving to a Large machine · \d+ s$/);
  // Picking the machine it runs on while the move is under way calls the move off.
  await act(async () => note().click());
  assert.equal(picker()[1].getAttribute('aria-checked'), 'true');
  await act(async () => picker()[0].click());
  assert.deepEqual(picked, [{ machine: 'large' }, { machine: 'standard' }]);
  let sequence = 2;
  const show = (view: ReturnType<typeof host>, stage?: string) => {
    const next = snapshot(conversation(), [], sequence++, [], true, view);
    return act(async () => stream.push('snapshot', stage ? staged(next, stage) : next));
  };
  const since = new Date().toISOString();
  // With the machine it ran on gone mid-move, the conversation waits on the one starting, and
  // the machine can still be stopped.
  await show(host('none', { moving: { to: 'large', by: 'person', since } }), 'moving');
  assert.match(
    document.querySelector('.pi-bar [role="status"]')?.textContent ?? '',
    /^Starting a machine · \d+ s$/,
  );
  await act(async () => note().click());
  assert.equal(picker().at(-1)?.textContent, 'Release machine');
  await press('Escape');
  const failure = (ago: number, extra: object = {}) => ({
    at: new Date(Date.now() - ago).toISOString(),
    by: 'agent',
    from: 'standard',
    to: 'large',
    outcome: 'failed',
    reason: 'no free machine',
    ...extra,
  });
  await show(host('ready', { lastMove: failure(60_000) }));
  assert.equal(note().textContent, 'Couldn’t start Large: no free machine. Still on Standard.');
  // With no machine left it is on nothing, and a deadline's rollover is no news.
  const runs = 'Standard · ½ vCPU · 4 GiB';
  await show(host('none', { lastMove: failure(60_000) }));
  assert.equal(note().textContent, runs);
  await show(host('ready', { lastMove: failure(60_000, { by: 'deadline', to: 'standard' }) }));
  assert.equal(note().textContent, runs);
  await show(host('ready', { moving: { to: 'standard', by: 'deadline', since } }));
  assert.equal(note().textContent, runs);
  // A failure is news for as long as a machine's idle wait, even on a page left alone.
  await show(host('ready', { lastMove: failure(600_000 - 400) }));
  assert.match(note().textContent!, /^Couldn’t start Large/);
  await settle(1200);
  assert.equal(note().textContent, runs);
});

test('releasing the machine asks first, then releases it for every conversation here', async (t) => {
  t.after(cleanup);
  setProject('p1');
  boot(
    () => snapshot(conversation()),
    () => [conversation()],
  );
  let stopped = 0;
  serve('/tools/pi.machine.stop', () =>
    ++stopped === 1
      ? { status: 409, body: { error: { code: 'pi_busy', message: 'A move is under way' } } }
      : { body: { result: host('none') } },
  );
  await open();
  await act(async () => note().click());
  await act(async () => picker()[2].click());
  assert.equal(stopped, 0);
  assert.match(text(), /Answers still running here stop too./);
  assert.deepEqual(
    picker().map((item) => item.textContent),
    ['Release machine', 'Cancel'],
  );
  assert.equal(document.activeElement, picker()[0]);
  await act(async () => picker()[1].click());
  assert.equal(picker().length, 3);
  const confirm = async () => {
    await act(async () => picker()[2].click());
    await act(async () => picker()[0].click());
    await settle(10);
  };
  // A refusal says why, and the machine stands as it was.
  await confirm();
  assert.equal(stopped, 1);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, 'A move is under way');
  assert.equal(note().textContent, 'Standard · ½ vCPU · 4 GiB');
  await act(async () => note().click());
  await confirm();
  assert.equal(stopped, 2);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(note().textContent, 'Standard · ½ vCPU · 4 GiB');
  // With no machine there is nothing to stop.
  await act(async () => note().click());
  assert.deepEqual(
    picker().map((item) => item.firstChild?.textContent),
    ['Standard', 'Large'],
  );
});

test('the transcript marks where the machine changed between two turns', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const turn = (id: string, machine?: string) => ({
    ...command(id, 'completed', [{ role: 'user', text: id }]),
    ...(machine ? { machine } : {}),
  });
  boot(
    () =>
      snapshot(conversation(), [
        turn('before'),
        turn('first', 'standard'),
        turn('second', 'standard'),
        turn('third', 'large'),
      ]),
    () => [conversation()],
  );
  await open();
  const dividers = [...document.querySelectorAll('.pi-divider')];
  assert.deepEqual(
    dividers.map((line) => line.textContent),
    ['Moved to Large'],
  );
  assert.equal(dividers[0].previousElementSibling?.textContent, 'Yousecond');
  assert.equal(dividers[0].nextElementSibling?.textContent, 'Youthird');
});

test('a proposed call reads as the act it performs and its facts, and Run as me runs it once as the person', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const proposals = [
    { id: 'pip_halt', name: 'fleet.halt', input: { id: 'flt_1' }, at: '2026-09-20T00:00:01Z' },
    {
      id: 'pip_download',
      name: 'artifact.read',
      input: { artifactId: 'art_1', mode: 'download' },
      act: { title: 'Download file', says: 'mode' },
      secret: true,
      at: '2026-09-20T00:00:02Z',
    },
  ];
  const asked = [{ role: 'user', text: 'Stop that machine' }];
  const turn = (status: string, ran: Record<string, object> = {}) => ({
    ...command('c1', status, asked),
    proposals: proposals.map((proposal) =>
      ran[proposal.id] ? { ...proposal, ran: ran[proposal.id] } : proposal,
    ),
  });
  let state = snapshot({ ...conversation(), activeCommandId: 'c1' }, [turn('working')]);
  const stream = boot(
    () => state,
    () => [conversation()],
  );
  const requested: Record<string, unknown>[] = [];
  serve('/tools/pi.run', (_count, input) => {
    requested.push(input);
    return input.proposalId === 'pip_halt'
      ? {
          body: {
            result: {
              result: null,
              told: 'fleet.halt was refused: Actor lacks admin permission',
              whole: true,
            },
          },
        }
      : {
          body: {
            result: {
              result: { url: 'https://files.example/art_1?sig=abc', expiresAt: 'soon' },
              told: 'Ran artifact.read; its result is shown only to me.',
              whole: false,
            },
          },
        };
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'waiting') } };
  });
  await open();
  await settle(10);
  const cards = () => [...document.querySelectorAll('.pi-proposal')];
  assert.equal(cards().length, 2);
  // The act, its input as facts, and the control: the tool's name is only the hover title, and
  // its JSON is not printed at all.
  assert.deepEqual(
    cards().map((card) => card.textContent),
    ['Halt machineMachineflt_1Run as me', 'Download fileFileart_1Run as me'],
  );
  assert.deepEqual(
    cards().map((card) => card.getAttribute('title')),
    ['fleet.halt', 'artifact.read'],
  );
  const runs = () => cards().map((card) => card.querySelector<HTMLButtonElement>('button.btn'));
  const ran = () => cards().map((card) => card.querySelector('.pi-receipt-word')?.textContent);
  // While the turn runs, nothing can be run.
  assert.ok(runs().every((button) => button!.disabled));
  state = snapshot(conversation(), [turn('completed')]);
  await act(async () => stream.push('snapshot', state));
  assert.ok(runs().every((button) => !button!.disabled));
  await act(async () => runs()[1]!.click());
  await settle(10);
  assert.deepEqual(requested[0], {
    id: 'conversation_1',
    commandId: 'c1',
    proposalId: 'pip_download',
  });
  // A secret result shows only in its card, standing open with its link live, and never reaches
  // the agent.
  const kept = cards()[1].querySelector('.pi-receipt')!;
  assert.equal(kept.querySelector('details')!.open, true);
  assert.equal(kept.querySelector('a')!.href, 'https://files.example/art_1?sig=abc');
  assert.deepEqual(
    sent.map(({ text }) => text),
    ['Ran artifact.read; its result is shown only to me.'],
  );
  assert.ok(!JSON.stringify(sent).includes('sig=abc'));
  // The turn that answered proposes nothing: the other call stays under its own turn, to run,
  // and the one that ran says so where its control stood, and nowhere else.
  const told = command('c2', 'completed', [
    { role: 'user', text: 'Ran artifact.read; its result is shown only to me.' },
    { role: 'assistant', text: 'Downloaded.' },
  ]);
  const secret = {
    at: 'now',
    ok: true,
    told: 'Ran artifact.read; its result is shown only to me.',
  };
  state = snapshot(conversation(), [turn('completed', { pip_download: secret }), told]);
  await act(async () => stream.push('snapshot', state));
  assert.equal(cards().length, 2);
  assert.deepEqual(ran(), [undefined, 'Ran']);
  assert.equal(document.querySelector('.pi-messages > .pi-receipt'), null);
  assert.equal(runs()[1], null);
  assert.equal(runs()[0]!.disabled, false);
  await act(async () => runs()[0]!.click());
  await settle(10);
  assert.equal(sent[1].text, 'fleet.halt was refused: Actor lacks admin permission');
  const refusal = {
    pip_download: secret,
    pip_halt: {
      at: 'now',
      ok: false,
      code: 'forbidden',
      told: 'fleet.halt was refused: Actor lacks admin permission',
      said: 'Actor lacks admin permission',
    },
  };
  state = snapshot(conversation(), [turn('completed', refusal), told]);
  await act(async () => stream.push('snapshot', state));
  assert.deepEqual(ran(), ['Refused', 'Ran']);
  assert.ok(cards()[0].querySelector('.pi-receipt-word.pi-refused'));
  // The card says why at once, and once the agent has been told it says so nowhere else.
  assert.equal(
    cards()[0].querySelector('.pi-receipt')!.textContent,
    'Refused·Actor lacks admin permission',
  );
  const refused = command('c2b', 'completed', [
    { role: 'user', text: 'fleet.halt was refused: Actor lacks admin permission' },
    { role: 'assistant', text: 'Ask an admin.' },
  ]);
  state = snapshot(conversation(), [turn('completed', refusal), told, refused]);
  await act(async () => stream.push('snapshot', state));
  assert.equal(
    cards()[0].querySelector('.pi-receipt')!.textContent,
    'Refused·Actor lacks admin permission',
  );
  assert.equal(document.querySelector('.pi-messages > .pi-receipt'), null);
  // A later turn proposes the next step: the secret stays in its card under its own turn, and
  // the calls it held that are not secret give way.
  const revoke = { id: 'pip_revoke', name: 'actor.revoke_token', input: {}, at: 'later' };
  state = snapshot(conversation(), [
    turn('completed', refusal),
    command('c2', 'completed', [{ role: 'assistant', text: 'Downloaded.' }]),
    {
      ...command('c3', 'completed', [{ role: 'assistant', text: 'Revoke the old one?' }]),
      proposals: [revoke],
    },
  ]);
  await act(async () => stream.push('snapshot', state));
  assert.deepEqual(
    cards().map((card) => card.querySelector('.pi-proposal-act')!.textContent),
    ['Download file', 'Revoke token'],
  );
  assert.equal(
    cards()[0].querySelector('.pi-receipt a')!.href,
    'https://files.example/art_1?sig=abc',
  );
  assert.deepEqual(ran(), ['Ran', undefined]);
});

test('Run tells Pi what the server wrote of a call and keeps the whole result for the person', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const proposal = {
    id: 'pip_advance',
    name: 'research.advance',
    input: { researchId: 'research_1', expectedRevision: 0, requestId: 'advance_1' },
    act: { title: 'Start next step' },
    at: '2026-09-20T00:00:01Z',
  };
  boot(
    () => snapshot(conversation(), [{ ...command('c1', 'completed'), proposals: [proposal] }]),
    () => [conversation()],
  );
  const result = {
    id: 'research_1',
    workflow: { state: 'researching', revision: 1 },
    reflectionId: 'reflection_very_long_identifier_that_must_not_be_clipped',
    integrations: ['task_first', 'task_second'],
    successorId: 'research_successor',
    problem: { text: 'Full Problem content '.repeat(300) },
  };
  const told =
    'Ran research.advance: {"id":"research_1","state":"researching","revision":1}. Re-read research.get and workflow.status_and_next for current details.';
  serve('/tools/pi.run', { body: { result: { result, told, whole: false } } });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'waiting') } };
  });
  await open();
  await act(async () => document.querySelector<HTMLButtonElement>('.pi-proposal button')!.click());
  await settle(10);
  assert.equal(sent.length, 1, 'running the proposal still starts one continuation turn');
  assert.equal(sent[0]!.text, told, 'the server writes what the agent is told');
  // The whole of it stays in the card, behind its fold, read as a tree, its long Problem one
  // press away.
  const full = document.querySelector('.pi-proposal .pi-receipt')!;
  await act(async () => full.querySelector('summary')!.click());
  await settle(10);
  const all = [...full.querySelectorAll('button')].find(
    (button) => button.textContent === 'Show all',
  );
  await act(async () => all!.click());
  assert.ok(full.textContent?.includes(result.problem.text));
});

const models = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
];
/** A snapshot of a conversation answering on `model`, with the catalog. */
const modelled = (
  model: string,
  item: Conversation = conversation(),
  commands: ReturnType<typeof command>[] = [],
  tail: PiEvent[] = [],
) => ({ ...snapshot({ ...item, model }, commands, 0, tail), models });
const model = () => document.querySelector<HTMLButtonElement>('.pi-model-button')!;
const choices = () => [
  ...document.querySelectorAll<HTMLButtonElement>('.pi-model [role="menuitemradio"]'),
];
/** Opens the model menu and picks the `index`th model. */
const pick = async (index: number) => {
  await act(async () => model().click());
  await act(async () => choices()[index].click());
};
/** Holds each pi.model.set until the returned function is called. */
function holdPicks() {
  let release = () => {};
  let held = new Promise<void>((resolve) => (release = resolve));
  const through = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/tools/pi.model.set')) await held;
    return through(input, init);
  }) as typeof fetch;
  return async () => {
    release();
    held = Promise.resolve();
    await settle(10);
  };
}

test('the bar names the conversation’s model, and its picker lists the models by name alone', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let state = modelled('gpt-6-luna');
  boot(
    () => state,
    () => [conversation()],
  );
  const picks: Record<string, unknown>[] = [];
  serve('/tools/pi.model.set', (_count, input) => {
    picks.push(input);
    state = modelled(input.model as string);
    return { body: { result: state } };
  });
  await open();
  assert.equal(model().textContent, 'Model: GPT-6 Luna');
  assert.equal(model().getAttribute('aria-haspopup'), 'menu');
  await act(async () => model().click());
  assert.deepEqual(
    choices().map((item) => [item.textContent, item.getAttribute('aria-checked')]),
    [
      ['GPT-6 Luna', 'true'],
      ['GPT-6 Sol', 'false'],
      ['GPT-6 Astra', 'false'],
    ],
  );
  assert.equal(document.activeElement, choices()[0]);
  await press('ArrowDown');
  assert.equal(document.activeElement, choices()[1]);
  await press('Escape');
  assert.equal(choices().length, 0);
  assert.equal(document.activeElement, model());
  // Picking the model it has only shuts the menu.
  await pick(0);
  assert.equal(choices().length, 0);
  assert.deepEqual(picks, []);
  // A pick asks the server, and the bar follows its answer.
  await pick(1);
  await settle(10);
  assert.deepEqual(picks, [{ id: 'conversation_1', model: 'gpt-6-sol' }]);
  assert.equal(model().textContent, 'Model: GPT-6 Sol');
  assert.equal(document.activeElement, model());
  // A refusal says so, and the bar stays where the server has it.
  serve('/tools/pi.model.set', {
    status: 403,
    body: { error: { code: 'pi_model_unavailable', message: 'That model is not offered' } },
  });
  await pick(2);
  await settle(10);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, 'That model is not offered');
  assert.equal(model().textContent, 'Model: GPT-6 Sol');
});

test('a question sent right after a pick waits for it and goes on that model; after a failed pick, nothing is sent', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let state = modelled('gpt-6-luna');
  boot(
    () => state,
    () => [conversation()],
  );
  let refuse = false;
  serve('/tools/pi.model.set', (_count, input) => {
    if (refuse)
      return {
        status: 403,
        body: { error: { code: 'pi_model_unavailable', message: 'That model is not offered' } },
      };
    state = modelled(input.model as string);
    return { body: { result: state } };
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'starting') } };
  });
  await open();
  const release = holdPicks();
  // Two quick picks go in order; the question waits for both, and names the last.
  await pick(1);
  await pick(2);
  await write('Which model are you?');
  await click('Send');
  await settle(10);
  assert.deepEqual(sent, []);
  await release();
  const asked = requests.filter((request) => /pi\.(model\.set|send)$/.test(request));
  assert.deepEqual(asked, [
    'POST /tools/pi.model.set',
    'POST /tools/pi.model.set',
    'POST /tools/pi.send',
  ]);
  assert.equal(sent[0].model, 'gpt-6-astra');
  assert.equal(model().textContent, 'Model: GPT-6 Astra');
  // A pick that fails keeps the question here, unsent, and says why.
  refuse = true;
  state = modelled('gpt-6-astra');
  const again = holdPicks();
  await pick(0);
  await write('And now?');
  await click('Send');
  await again();
  assert.equal(sent.length, 1);
  assert.equal(document.querySelector<HTMLTextAreaElement>('#pi-draft')?.value, 'And now?');
  assert.equal(document.querySelector('[role="alert"]')?.textContent, 'That model is not offered');
  assert.equal(model().textContent, 'Model: GPT-6 Astra');
});

test('a question sent on a model another page changed keeps its words, and the bar catches up', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let state = modelled('gpt-6-luna');
  boot(
    () => state,
    () => [conversation()],
  );
  serve('/tools/pi.send', {
    status: 409,
    body: {
      error: {
        code: 'pi_model_changed',
        message: 'This conversation now answers on GPT-6 Astra. Send again to use it.',
      },
    },
  });
  await open();
  state = modelled('gpt-6-astra');
  await write('Hello');
  await click('Send');
  await settle(10);
  assert.equal(
    document.querySelector('[role="alert"]')?.textContent,
    'This conversation now answers on GPT-6 Astra. Send again to use it.',
  );
  assert.equal(document.querySelector<HTMLTextAreaElement>('#pi-draft')?.value, 'Hello');
  assert.equal(model().textContent, 'Model: GPT-6 Astra');
});

test('a pick while an answer streams leaves the answer on screen, finishing on its model', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const active = { ...conversation(), activeCommandId: 'command_1' };
  const turn = [command('command_1', 'working', [{ role: 'user', text: 'Explain' }])];
  const partial: PiEvent = { sequence: 1, commandId: 'command_1', type: 'text', text: 'Partial' };
  let state = modelled('gpt-6-luna', active, turn, [partial]);
  boot(
    () => state,
    () => [active],
  );
  serve('/tools/pi.model.set', (_count, input) => {
    state = modelled(input.model as string, active, turn, [partial]);
    return { body: { result: state } };
  });
  await open();
  assert.match(text(), /Partial/);
  assert.equal(model().disabled, false);
  await pick(1);
  await settle(10);
  assert.match(text(), /Partial/);
  assert.equal(model().textContent, 'Model: GPT-6 Sol');
});

test('with one model, or a server that offers none, there is no model picker', async (t) => {
  t.after(cleanup);
  setProject('p1');
  let state: ReturnType<typeof snapshot> & { models?: typeof models } = {
    ...modelled('gpt-6-luna'),
    models: models.slice(0, 1),
  };
  const stream = boot(
    () => state,
    () => [conversation()],
  );
  await open();
  assert.match(text(), /Agent ready|Ready/);
  assert.equal(document.querySelector('.pi-model'), null);
  state = snapshot(conversation(), [], 1);
  await act(async () => stream.push('snapshot', state));
  assert.equal(document.querySelector('.pi-model'), null);
});

test('the transcript marks a switch of model, with a move of machine, from the turns that recorded them', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const turn = (id: string, machine?: string, answered?: string) => ({
    ...command(id, answered ? 'completed' : 'interrupted', [{ role: 'user', text: id }]),
    ...(machine ? { machine } : {}),
    ...(answered ? { model: answered } : {}),
  });
  const halt = { id: 'pip_halt', name: 'fleet.halt', input: { id: 'flt_1' }, at: 'later' };
  boot(
    () =>
      modelled('gpt-6-luna', conversation(), [
        turn('before'),
        turn('first', 'standard', 'gpt-6-luna'),
        // Stopped before a worker claimed it: no model, and no mark.
        turn('unclaimed', 'standard'),
        turn('second', 'standard', 'gpt-6-sol'),
        turn('third', 'large', 'gpt-6-astra'),
        { ...turn('fourth', 'large', 'gpt-5-retired'), proposals: [halt] },
      ]),
    () => [conversation()],
  );
  await open();
  // The bar holds both pickers, and the proposed call sits under its turn, after the marks.
  assert.ok(model() && document.querySelector('.pi-machine-button'));
  assert.equal(
    document.querySelector('.pi-messages > :last-child .pi-proposal-act')?.textContent,
    'Halt machine',
  );
  const dividers = [...document.querySelectorAll('.pi-divider')];
  assert.deepEqual(
    dividers.map((line) => line.textContent),
    [
      'Switched to GPT-6 Sol',
      'Moved to Large · Switched to GPT-6 Astra',
      'Switched to gpt-5-retired',
    ],
  );
  assert.equal(dividers[0].nextElementSibling?.textContent, 'Yousecond');
});

test('unavailable Agent is inert, including SSE and list', async (t) => {
  t.after(cleanup);
  setProject('p1');
  await open({ state: 'unavailable', detail: 'Pilot disabled' });
  assert.match(text(), /Agent unavailable. Pilot disabled/);
  assert.equal(requests.length, 0);
});

/** What a screen reader calls an element: aria-labelledby, else aria-label, else its text. */
const accessible = (element: Element, attribute = 'aria-labelledby') =>
  element
    .getAttribute(attribute)
    ?.split(' ')
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ') ??
  element.getAttribute('aria-label') ??
  element.textContent;

test('each Run as me is named by the act it runs, and described by that act’s facts', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const proposals = [
    { id: 'pip_halt', name: 'fleet.halt', input: { id: 'flt_1' }, at: '2026-09-20T00:00:01Z' },
    { id: 'pip_task', name: 'task.create', input: { title: 'x' }, at: '2026-09-20T00:00:02Z' },
  ];
  boot(
    () => snapshot(conversation(), [{ ...command('c1', 'completed'), proposals }]),
    () => [conversation()],
  );
  await open();
  const buttons = [...document.querySelectorAll('.pi-proposal button')];
  assert.deepEqual(
    buttons.map((button) => accessible(button)),
    ['Run as me Halt machine', 'Run as me New task'],
  );
  assert.deepEqual(
    buttons.map((button) => accessible(button, 'aria-describedby')),
    ['Machineflt_1', 'Titlex'],
  );
  // Nothing visible was added to say it.
  assert.equal(
    document.querySelector('.pi-proposal')!.textContent,
    'Halt machineMachineflt_1Run as me',
  );
});

test('what Run as me tells the agent is kept in the composer when it cannot be sent, and sent again as it was', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const halt = { id: 'pip_halt', name: 'fleet.halt', input: { id: 'flt_1' }, at: 'later' };
  let state = modelled('gpt-6-luna', conversation(), [
    { ...command('c1', 'completed'), proposals: [halt] },
  ]);
  boot(
    () => state,
    () => [conversation()],
  );
  serve('/tools/pi.run', {
    body: {
      result: { result: { halted: true }, told: 'Ran fleet.halt: {"halted":true}', whole: true },
    },
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (count, input) => {
    sent.push(input);
    return count === 1
      ? {
          status: 409,
          body: {
            error: {
              code: 'pi_model_changed',
              message: 'This conversation now answers on GPT-6 Sol. Send again to use it.',
            },
          },
        }
      : { body: { result: command(input.commandId as string, 'waiting') } };
  });
  await open();
  const draft = () => document.querySelector<HTMLTextAreaElement>('#pi-draft')!.value;
  const told = 'Ran fleet.halt: {"halted":true}';
  await act(async () => document.querySelector<HTMLButtonElement>('.pi-proposal button')!.click());
  await settle(10);
  assert.equal(sent[0].text, told);
  assert.equal(
    document.querySelector('[role="alert"]')?.textContent,
    'This conversation now answers on GPT-6 Sol. Send again to use it.',
  );
  assert.equal(draft(), told);
  // The same words go again under the same command, so an answer that did arrive is not doubled.
  await click('Retry send');
  await settle(10);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(draft(), '');

  // A pick that fails first keeps the words too, ahead of anything typed meanwhile.
  serve('/tools/pi.model.set', {
    status: 403,
    body: { error: { code: 'pi_model_unavailable', message: 'That model is not offered' } },
  });
  const release = holdPicks();
  await pick(1);
  await write('And then?');
  await act(async () => document.querySelector<HTMLButtonElement>('.pi-proposal button')!.click());
  await release();
  assert.equal(sent.length, 2);
  assert.equal(draft(), `${told}\n\nAnd then?`);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, 'That model is not offered');
});

test('a Run whose answer is lost reads how the call came out, shows it, and tells the agent once', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const halt = { id: 'pip_halt', name: 'fleet.halt', input: { id: 'flt_1' }, at: 'later' };
  const told = 'Ran fleet.halt: {"halted":true}';
  let state = snapshot(conversation(), [{ ...command('c1', 'completed'), proposals: [halt] }]);
  boot(
    () => state,
    () => [conversation()],
  );
  // The call ran and Pi kept how it came out, but its answer never reached the page.
  serve('/tools/pi.run', () => {
    state = snapshot(conversation(), [
      {
        ...command('c1', 'completed'),
        proposals: [{ ...halt, ran: { at: 'now', ok: true, told, said: '{"halted":true}' } }],
      },
    ]);
    return { status: 502, body: { error: { code: 'bad_gateway', message: 'Bad gateway' } } };
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'waiting') } };
  });
  await open();
  await act(async () => document.querySelector<HTMLButtonElement>('.pi-proposal button')!.click());
  await settle(10);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(document.querySelector('.pi-proposal .pi-receipt-word')?.textContent, 'Ran');
  // The agent is told as if the answer had come, under a turn named for the call, so a page that
  // tells it again starts no second turn.
  assert.deepEqual(sent, [{ id: 'conversation_1', commandId: 'told_pip_halt', text: told }]);

  // A run Pi refused ran nothing: nothing is read again, and the agent is told nothing.
  await cleanup();
  setProject('p1');
  state = snapshot(conversation(), [{ ...command('c1', 'completed'), proposals: [halt] }]);
  boot(
    () => state,
    () => [conversation()],
  );
  serve('/tools/pi.run', {
    status: 409,
    body: {
      error: { code: 'pi_turn_busy', message: 'This conversation already has an active turn' },
    },
  });
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'waiting') } };
  });
  await open();
  await act(async () => document.querySelector<HTMLButtonElement>('.pi-proposal button')!.click());
  await settle(10);
  assert.equal(
    document.querySelector('[role="alert"]')?.textContent,
    'This conversation already has an active turn',
  );
  assert.equal(sent.length, 1);
});

test('a call is titled by the act its tool’s owner names, and otherwise by the tool’s own words', () => {
  // The owner's title, which Pi keeps on the proposal from the tool's registration.
  assert.equal(
    actOf({ name: 'session.dispatch', act: { title: 'Pause dispatch', says: 'enabled' } }),
    'Pause dispatch',
  );
  const titles: [string, string][] = [
    ['task.create', 'New task'],
    // Otherwise the tool's own words: an action with an underscore says itself, any other comes
    // before what it acts on, in the product's word for it.
    ['usage.set_budget', 'Set budget'],
    ['code.publication.merge', 'Merge publication'],
    ['research.create', 'New cycle'],
    ['research.end', 'End cycle'],
    ['artifact.read', 'Read file'],
    ['fleet.halt', 'Halt machine'],
  ];
  for (const [name, title] of titles) assert.equal(actOf({ name }), title, name);
});

test('a call’s input reads as facts: keys in words, flags as Yes and No, nested values folded, machinery left out', () => {
  assert.deepEqual(
    factsOf({
      name: 'session.dispatch',
      input: { enabled: false, ownMachines: true, requestId: 'request_1', expectedRevision: 3 },
      act: { title: 'Pause dispatch', says: 'enabled' },
    }),
    // What the act said (Pause dispatch) is not said again.
    [{ key: 'ownMachines', label: 'Own machines', text: 'Yes' }],
  );
  assert.deepEqual(
    factsOf({
      name: 'experiment.transition',
      input: { experimentId: 'exp_1', transition: 'abandon' },
      act: { title: 'Abandon experiment', says: 'transition' },
    }),
    [{ key: 'experimentId', label: 'Experiment', text: 'exp_1' }],
  );
  assert.deepEqual(
    factsOf({
      name: 'task.create',
      input: {
        title: 'Seed sweep',
        dependencies: ['wf_1', 'wf_2'],
        seconds: 600,
        deliverables: [{ title: 'Table' }],
        budget: { maxTokens: 10 },
        none: null,
        blank: '',
        nothing: [],
      },
    }),
    [
      { key: 'title', label: 'Title', text: 'Seed sweep' },
      { key: 'dependencies', label: 'Dependencies', list: ['wf_1', 'wf_2'] },
      { key: 'seconds', label: 'Seconds', text: '600' },
      { key: 'deliverables', label: 'Deliverables', tree: [{ title: 'Table' }] },
      { key: 'budget', label: 'Budget', tree: { maxTokens: 10 } },
    ],
  );
  // A field holding a record's id is named by the record, in the product's word for it, and a
  // bare id by the record acted on.
  assert.deepEqual(
    ['sessionId', 'artifactIds', 'researchId', 'instanceId', 'id', 'max_wall_minutes'].map((key) =>
      labelOf('sandbox.extend', key),
    ),
    ['Session', 'Files', 'Cycle', 'Unit', 'Sandbox', 'Max wall minutes'],
  );
  // An input with nothing left to say has no facts.
  assert.deepEqual(
    factsOf({ name: 'research.advance', input: { requestId: 'r', expectedRevision: 0 } }),
    [],
  );
});

test('what Run told the agent is a receipt only where it is exactly what Pi kept as told', () => {
  const ran = (told: string, ok = true) => ({ at: 'now', ok, told });
  const create = {
    id: 'pip_create',
    name: 'task.create',
    input: { title: 'x' },
    ran: ran('Ran task.create: {"id":"wf_1"}'),
  };
  const halt = {
    id: 'pip_halt',
    name: 'session.halt',
    input: {},
    ran: ran('session.halt was refused: Actor lacks admin permission', false),
  };
  const read = {
    id: 'pip_read',
    name: 'artifact.read',
    input: {},
    secret: true as const,
    ran: ran('Ran artifact.read; its result is shown only to me.'),
  };
  const end = { id: 'pip_end', name: 'research.end', input: {} };
  const proposed = {
    ...command('c1', 'completed', [{ role: 'user', text: 'Go' }]),
    proposals: [create, halt, read, end],
  } as unknown as PiCommand;
  const said = (text: string, role = 'user') =>
    command('c3', 'completed', [{ role, text }]) as unknown as PiCommand;
  const after = (text: string, role?: string) =>
    receiptOf([proposed, said('Thanks', 'assistant'), said(text, role)], 2);
  assert.equal(after('Ran task.create: {"id":"wf_1"}'), create);
  assert.equal(after('session.halt was refused: Actor lacks admin permission'), halt);
  assert.equal(after('Ran artifact.read; its result is shown only to me.'), read);
  // A result cut at a space keeps a trailing space in told; pi.send keeps the words trimmed.
  const cut = { ...create, id: 'pip_cut', ran: ran('Ran task.create: {"text":"x ') };
  const trimmed = { ...proposed, proposals: [cut] } as unknown as PiCommand;
  assert.equal(
    receiptOf([trimmed, said('Thanks', 'assistant'), said('Ran task.create: {"text":"x')], 2),
    cut,
  );
  for (const [text, role] of [
    // A message that merely begins alike.
    ['Ran the numbers again: anything new?'],
    // A receipt that waited in the composer and went with the person's own words.
    ['Ran task.create: {"id":"wf_1"}\n\nAnd then?'],
    // A call that never ran, and words that are not the person's.
    ['Ran research.end: {}'],
    ['Ran task.create: {"id":"wf_1"}', 'assistant'],
  ])
    assert.equal(after(text!, role), null, text);
  // Only the latest calls offer Run: once a later turn proposes, an earlier call is not answered.
  const later = { ...proposed, id: 'c2', proposals: [end] } as unknown as PiCommand;
  assert.equal(receiptOf([proposed, later, said('Ran task.create: {"id":"wf_1"}')], 2), null);
  // Two calls told alike are answered in the order they ran, whichever was proposed first.
  const dispatch = (id: string, at: string) => ({
    id,
    name: 'session.dispatch',
    input: { enabled: true },
    ran: { at, ok: true, told: 'Ran session.dispatch: {"enabled":true}' },
  });
  const [start, again] = [
    dispatch('pip_start', '2026-10-02T20:11:00Z'),
    dispatch('pip_again', '2026-10-02T20:10:25Z'),
  ];
  const twice = [
    { ...proposed, proposals: [start, again] } as unknown as PiCommand,
    said('Ran session.dispatch: {"enabled":true}'),
    said('Ran session.dispatch: {"enabled":true}'),
  ];
  assert.deepEqual(
    [1, 2].map((at) => receiptOf(twice, at)),
    [again, start],
  );
});

test('a card says how its call came out from what Pi kept, and a run Pi itself refuses tells the agent nothing', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const proposals = [
    {
      id: 'pip_task',
      name: 'task.create',
      input: { title: 'Seed sweep' },
      at: 'now',
      // Kept before the agent was told: the card reads the outcome, not the sentence.
      ran: { at: 'now', ok: true, told: 'Ran task.create: {"id":"wf_1"}', said: '{"id":"wf_1"}' },
    },
    {
      id: 'pip_halt',
      name: 'session.halt',
      input: {},
      act: { title: 'Halt lease' },
      at: 'now',
      ran: {
        at: 'now',
        ok: false,
        code: 'forbidden',
        told: 'session.halt was refused: Ask an operator',
        said: 'Ask an operator',
      },
    },
    { id: 'pip_end', name: 'research.end', input: {}, act: { title: 'End research' }, at: 'now' },
  ];
  const state = snapshot(conversation(), [
    { ...command('c1', 'completed', [{ role: 'user', text: 'Go' }]), proposals },
  ]);
  boot(
    () => state,
    () => [conversation()],
  );
  serve('/tools/pi.run', {
    status: 409,
    body: {
      error: { code: 'pi_turn_busy', message: 'This conversation already has an active turn' },
    },
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'waiting') } };
  });
  await open();
  await settle(10);
  const cards = () => [...document.querySelectorAll('.pi-proposal')];
  assert.deepEqual(
    cards().map((card) => card.querySelector('.pi-receipt-line')?.textContent),
    ['RanResult', 'Refused·Ask an operator', undefined],
  );
  await act(async () => cards()[2].querySelector<HTMLButtonElement>('button.btn')!.click());
  await settle(10);
  // Nothing ran, so the agent is told nothing; the person reads why.
  assert.deepEqual(sent, []);
  assert.equal(
    document.querySelector('.pi-error')?.textContent,
    'This conversation already has an active turn',
  );
});

test('a card names the records its input points at, folds what is long or nested, and prints no machinery', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const task = `wf_${'a'.repeat(32)}`;
  const goal = 'Rerun every setting with three seeds. '.repeat(6);
  const create = {
    id: 'pip_task',
    name: 'task.create',
    at: 'now',
    input: {
      title: 'Seed sweep',
      goal,
      dependencies: [task],
      automatic: false,
      deliverables: [{ title: 'Seed table' }],
      requestId: 'request_1',
      expectedRevision: 2,
    },
  };
  const advance = {
    id: 'pip_advance',
    name: 'research.advance',
    at: 'now',
    input: { requestId: 'request_2', expectedRevision: 0 },
    act: { title: 'Start next step' },
  };
  serve('/tools/ui.home', { body: { result: { tasks: [{ id: task, title: 'Weight decay' }] } } });
  serve('/tools/ui.shell', { body: { result: { rows: [{ id: 'tasks', path: '/tasks' }] } } });
  boot(
    () =>
      snapshot(conversation(), [{ ...command('c1', 'completed'), proposals: [create, advance] }]),
    () => [conversation()],
  );
  await open();
  await settle(20);
  const [card, bare] = [...document.querySelectorAll('.pi-proposal')];
  assert.deepEqual(
    [...card.querySelectorAll('.kv-row')].map((row) => [
      row.querySelector('dt')!.textContent,
      row.querySelector('dd')!.textContent,
    ]),
    [
      ['Title', 'Seed sweep'],
      ['Goal', goal],
      ['Dependencies', 'Weight decay'],
      ['Automatic', 'No'],
    ],
  );
  // An id reads as its record's name, and is the way to it.
  assert.equal(card.querySelector('dd a')?.getAttribute('href'), `/tasks/${task}`);
  // What is long is folded to its first lines, what is nested to its key, read as a tree once open.
  assert.equal(card.querySelector<HTMLDetailsElement>('.pi-fact-long')?.open, false);
  const nested = card.querySelector<HTMLDetailsElement>('.pi-fact-tree')!;
  assert.equal(nested.querySelector('summary')!.textContent, 'Deliverables');
  assert.ok(!nested.querySelector('.json'));
  await act(async () => nested.querySelector('summary')!.click());
  await settle(10);
  assert.match(nested.querySelector('.json')!.textContent!, /Seed table/);
  // No tool name, no JSON and no machinery are printed.
  assert.doesNotMatch(card.textContent!, /task\.create|request|revision|[{}"]/i);
  // A call with nothing left to say is its act alone, and its control describes nothing.
  assert.equal(bare.textContent, 'Start next stepRun as me');
  assert.equal(bare.querySelector('button')!.hasAttribute('aria-describedby'), false);
});

test('how a run came out is said once, in its card or on a quiet line, never as a message of the person’s', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const created = JSON.stringify({ id: 'task_1', title: 'Seed sweep', state: 'planned' });
  const told = {
    task: `Ran task.create: ${created}`,
    halt: 'session.halt was refused: Actor lacks admin permission',
    read: 'Ran artifact.read; its result is shown only to me.',
  };
  const proposals = [
    {
      id: 'pip_task',
      name: 'task.create',
      input: { title: 'Seed sweep' },
      at: 'now',
      ran: { at: 'now', ok: true, told: told.task, said: created },
    },
    {
      id: 'pip_halt',
      name: 'session.halt',
      input: { sessionId: 'session_1' },
      act: { title: 'Halt lease' },
      at: 'now',
      ran: {
        at: 'now',
        ok: false,
        code: 'forbidden',
        told: told.halt,
        said: 'Actor lacks admin permission',
      },
    },
    {
      id: 'pip_read',
      name: 'artifact.read',
      input: {},
      secret: true,
      at: 'now',
      ran: { at: 'now', ok: true, told: told.read },
    },
  ];
  const turn = (id: string, asked: string, answer: string) =>
    command(id, 'completed', [
      { role: 'user', text: asked },
      { role: 'assistant', text: answer },
    ]);
  const turns = [
    { ...command('c1', 'completed', [{ role: 'user', text: 'Make the task' }]), proposals },
    turn('c2', told.task, 'Created.'),
    turn('c3', told.halt, 'Ask an admin.'),
    turn('c4', told.read, 'Downloaded.'),
    turn('c5', 'Ran the numbers again: anything new?', 'Nothing yet.'),
  ];
  let state = snapshot(conversation(), turns);
  const stream = boot(
    () => state,
    () => [conversation()],
  );
  await open();
  const lines = () => [...document.querySelectorAll('.pi-receipt')];
  const said = () => lines().map((line) => line.querySelector('.pi-receipt-line')!.textContent);
  // While its card is drawn, each outcome stands in the card, where Run stood, and nowhere else.
  assert.deepEqual(said(), ['RanResult', 'Refused·Actor lacks admin permission', 'Ran']);
  assert.ok(lines().every((line) => line.parentElement!.classList.contains('pi-proposal')));
  // Only what the person typed is theirs.
  const typed = () =>
    [...document.querySelectorAll('.pi-message--user')].map((message) => message.textContent);
  assert.deepEqual(typed(), ['YouMake the task', 'YouRan the numbers again: anything new?']);
  // Once the agent proposes again the cards give way, and each outcome is a quiet line where the
  // agent was told, named by the act.
  const next = { id: 'pip_next', name: 'research.advance', input: {}, at: 'later' };
  state = snapshot(conversation(), [
    ...turns,
    { ...command('c6', 'completed', [{ role: 'assistant', text: 'Next?' }]), proposals: [next] },
  ]);
  await act(async () => stream.push('snapshot', state));
  assert.deepEqual(said(), [
    'RanNew taskResult',
    'RefusedHalt lease·Actor lacks admin permission',
    'RanRead file',
  ]);
  assert.deepEqual(typed(), ['YouMake the task', 'YouRan the numbers again: anything new?']);
  // Each stands where its turn's words did, before the agent's answer, and keeps the tool's
  // name for the pointer alone.
  assert.equal(lines()[0].nextElementSibling?.textContent, 'AgentCreated.');
  assert.equal(lines()[0].getAttribute('title'), 'task.create');
  // A refusal wears the refusal's colour; the sentence that stands for a secret opens nothing.
  assert.ok(lines()[1].querySelector('.pi-receipt-word.pi-refused'));
  assert.ok(!lines()[2].querySelector('details'));
  // The result opens under its line, read as the tree it is.
  assert.ok(!lines()[0].querySelector('.json'));
  await act(async () => lines()[0].querySelector('summary')!.click());
  await settle(10);
  assert.match(lines()[0].querySelector('.json')!.textContent!, /Seed sweep.*planned/);
});

test('a call run before Pi kept what Run told is still a receipt, read from the sentence Run wrote then', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const created = JSON.stringify({ id: 'task_1', title: 'Seed sweep', state: 'planned' });
  // Pi kept only when each ran and whether it was refused: no `told`, no `said`.
  const proposals = [
    { id: 'pip_task', name: 'task.create', input: {}, act: { title: 'New task' }, at: 'then' },
    { id: 'pip_halt', name: 'session.halt', input: {}, act: { title: 'Halt lease' }, at: 'then' },
    { id: 'pip_read', name: 'artifact.read', input: {}, act: { title: 'Read file' }, at: 'then' },
    { id: 'pip_list', name: 'task.list', input: {}, act: { title: 'List tasks' }, at: 'then' },
  ].map((call, index) => ({
    ...call,
    ran: { at: `then${index}`, ok: call.name !== 'session.halt' },
  }));
  const turn = (id: string, asked: string, answer: string) =>
    command(id, 'completed', [
      { role: 'user', text: asked },
      { role: 'assistant', text: answer },
    ]);
  const next = { id: 'pip_next', name: 'research.advance', input: {}, at: 'later' };
  const state = snapshot(conversation(), [
    { ...command('c1', 'completed', [{ role: 'user', text: 'Make the task' }]), proposals },
    turn('c2', `Ran task.create: ${created}`, 'Created.'),
    turn('c3', 'session.halt was refused: Actor lacks admin permission', 'Ask an admin.'),
    turn('c4', 'Ran artifact.read; its result is shown only to me.', 'Downloaded.'),
    turn('c5', 'Ran task.list: {"count":2}. Re-read task.list for current details.', 'Two.'),
    turn('c6', 'Ran the numbers again: anything new?', 'Nothing yet.'),
    { ...command('c7', 'completed', [{ role: 'assistant', text: 'Next?' }]), proposals: [next] },
  ]);
  boot(
    () => state,
    () => [conversation()],
  );
  await open();
  const lines = () => [...document.querySelectorAll('.pi-receipt')];
  assert.deepEqual(
    lines().map((line) => line.querySelector('.pi-receipt-line')!.textContent),
    [
      'RanNew taskResult',
      'RefusedHalt lease·Actor lacks admin permission',
      'RanRead file',
      'RanList tasksResult',
    ],
  );
  assert.deepEqual(
    [...document.querySelectorAll('.pi-message--user')].map((message) => message.textContent),
    ['YouMake the task', 'YouRan the numbers again: anything new?'],
  );
  // The result is what the sentence said, without the receipt's pointer to read on.
  await act(async () => lines()[0].querySelector('summary')!.click());
  await act(async () => lines()[3].querySelector('summary')!.click());
  await settle(10);
  assert.match(lines()[0].querySelector('.json')!.textContent!, /Seed sweep.*planned/);
  assert.doesNotMatch(lines()[3].textContent!, /Re-read/);
  assert.match(lines()[3].querySelector('.json')!.textContent!, /count.*2/);
});

let go = (_path: string) => {};
/** Hands the test the router's own way to go elsewhere, as a link in the page would. */
function Navigator() {
  const navigate = useNavigate();
  go = (path) => navigate(path);
  return null;
}
const operator = {
  id: 'actor_1',
  projectId: 'p1',
  name: 'Operator',
  role: 'operator',
  active: true,
};
const grokking = { id: 'p1', name: 'Grokking replication', createdAt: '2026-09-01T00:00:00Z' };
/** The whole app, signed in to p1 with the Agent's row, opened at `path`. */
const openApp = async (path: string) => {
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'actor', actor: operator, projects: [grokking] } });
  serve('/tools/ui.shell', {
    body: { result: { actor: operator, project: grokking, rows: [row], plugins: [] } },
  });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(App),
      createElement(Navigator),
    ),
  );
  await settle(20);
};
const visit = async (path: string) => {
  await act(async () => go(path));
  await settle(20);
};
const dock = () => document.querySelector<HTMLElement>('.pi-dock');
const asked = (count = 1) =>
  requests.filter((request) => request.includes(`/tools/pi.list`)).length === count;
const answered = [
  command('c1', 'completed', [
    { role: 'user', text: 'What is known?' },
    { role: 'assistant', text: 'Two findings so far' },
  ]),
];

test('the conversation stands beside other pages once its page was opened, and is the same one there', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const stream = boot(
    () => snapshot(conversation(), answered),
    () => [conversation()],
  );
  const sent: Record<string, unknown>[] = [];
  serve('/tools/pi.send', (_count, input) => {
    sent.push(input);
    return { body: { result: command(input.commandId as string, 'waiting') } };
  });
  await openApp('/elsewhere');
  // Before the Agent page opens nothing is read, warmed or streamed, and nothing floats.
  assert.ok(!dock());
  assert.ok(!requests.some((request) => /pi\.|\/events/.test(request)));
  await visit('/agent');
  assert.match(text(), /Two findings so far/);
  assert.ok(!dock());
  await visit('/elsewhere');
  const floating = dock()!;
  assert.equal(floating.getAttribute('role'), 'complementary');
  assert.equal(floating.getAttribute('aria-label'), 'Agent');
  assert.match(floating.querySelector('.pi-messages')!.textContent!, /Two findings so far/);
  // Its head: the conversation's name, how its turn stands, Expand and Close; none of the page's
  // pickers and no Context.
  assert.equal(floating.querySelector('.pi-dock-title')!.textContent, 'What is known?');
  assert.equal(floating.querySelector('.pi-dock-head [role="status"]')!.textContent, 'Ready');
  for (const control of ['Expand', 'Close']) {
    const button = floating.querySelector(`button[aria-label="${control}"]`)!;
    assert.equal(button.getAttribute('title'), control);
    assert.ok(button.querySelector('svg'));
  }
  assert.ok(!floating.querySelector('.pi-switch, .pi-model, .pi-machine, .pi-context-button'));
  // The stream went along with the person: no second list, no second stream.
  assert.ok(asked(1));
  assert.equal(requests.filter((request) => request.endsWith('/events')).length, 1);
  assert.equal(stream.aborted, 0);
  // The same composer: Enter sends into the same conversation.
  await write('And the third?');
  const area = floating.querySelector<HTMLTextAreaElement>('textarea')!;
  assert.equal(area.rows, 2);
  await act(async () => {
    area.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  await settle(10);
  assert.deepEqual(
    sent.map(({ id, text }) => [id, text]),
    [['conversation_1', 'And the third?']],
  );
  // Expand goes back to the Agent page, where the window is never drawn, and starts nothing anew.
  await act(async () =>
    floating.querySelector<HTMLButtonElement>('[aria-label="Expand"]')!.click(),
  );
  await settle(20);
  assert.ok(!dock());
  assert.ok(document.querySelector('.pi-page .pi-bar'));
  assert.ok(asked(1));
});

test('closed by hand the window stays shut until the Agent page opens again, and a phone never draws it', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const stream = boot(
    () => snapshot(conversation(), answered),
    () => [conversation()],
  );
  await openApp('/agent');
  await visit('/elsewhere');
  await act(async () => dock()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  assert.ok(!dock());
  await visit('/elsewhere/further');
  assert.ok(!dock());
  // Closing it puts it away; the conversation is still connected.
  assert.equal(stream.aborted, 0);
  await visit('/agent');
  await visit('/elsewhere');
  assert.ok(dock());
  assert.ok(asked(1));
  await resize(false);
  assert.ok(!dock());
  await resize(true);
  assert.ok(dock());
});

test('the window closes itself when the machine is released for inactivity, and the conversation with it', async (t) => {
  t.after(cleanup);
  setProject('p1');
  const idle = (ms: number) =>
    host('ready', { idleEndsAt: new Date(Date.now() + ms).toISOString() });
  let state = snapshot(conversation(), answered, 0, [], true, idle(1500));
  const stream = boot(
    () => state,
    () => [conversation()],
  );
  await openApp('/agent');
  // On its own page the conversation stays as it is, whatever the machine does.
  await settle(1600);
  await visit('/elsewhere');
  assert.ok(!dock());
  assert.ok(stream.aborted >= 1);
  // Opening the page again starts everything again.
  state = snapshot(conversation(), answered, 1, [], true, idle(1500));
  await visit('/agent');
  assert.ok(asked(2));
  await visit('/elsewhere');
  assert.ok(dock());
  await settle(1600);
  assert.ok(!dock());
  // A turn in flight keeps it open with the machine gone; once the turn ends, it closes.
  state = snapshot(
    { ...conversation(), activeCommandId: 'c2' },
    [...answered, command('c2', 'starting', [{ role: 'user', text: 'Again?' }])],
    2,
    [],
    true,
    host('none'),
  );
  await visit('/agent');
  await visit('/elsewhere');
  await settle(20);
  assert.ok(dock());
  await act(async () =>
    stream.push('snapshot', snapshot(conversation(), answered, 3, [], true, host('none'))),
  );
  await settle(20);
  assert.ok(!dock());
});
