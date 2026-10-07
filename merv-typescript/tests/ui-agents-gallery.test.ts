/**
 * The Agents page: one card a thread. Each test states one thing the owner relies on: the cards
 * waiting on them come first and are answered in place, through the thread; the cards at work
 * stream their agents' last lines, all of them over one connection, and only to an operator;
 * the rest wait folded under Recent; and any card opens its thread with the box that speaks to it.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eventStream, mount, requests, serve, settle, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
const { setToken } = await import('../packages/ui/web/api.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');
const { AgentsGallery } = await import('../packages/ui/web/views/agents-gallery.js');
const { applyFrame } = await import('../packages/ui/web/live-feed.js');
const { tailLines } = await import('../packages/ui/web/conversation.js');

// jsdom has the element but not its modal methods: open sets the attribute, close clears it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Dialog = (window as any).HTMLDialogElement.prototype;
Dialog.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
Dialog.close = function (this: HTMLDialogElement) {
  if (!this.hasAttribute('open')) return;
  this.removeAttribute('open');
  this.dispatchEvent(new window.Event('close'));
};

beforeEach(() => setToken('ui-agents-gallery-fixture'));

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const visit = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  status: 'released',
  offeredAt: ago(30),
  startedAt: ago(29),
  endedAt: ago(5),
  outcome: 'submitted',
  launched: true,
  resumed: false,
  runnerId: 'lab-01',
  hasConversation: true,
  ...over,
});
const working = (sessionId: string, verdict = 'active') =>
  visit(sessionId, {
    status: verdict === 'offered' ? 'offered' : 'active',
    endedAt: undefined,
    outcome: undefined,
    liveness: { verdict, tone: verdict === 'lapsed' ? 'bad' : 'ok', rest: [] },
  });
/** A thread of the project as Sessions lists it. */
const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  instanceId: `wf_${id}`,
  state: 'running',
  role: 'producer',
  status: 'dormant',
  takesMessage: true,
  name: `work-${id}`,
  workflow: 'experiment',
  visits: [visit(`ses_${id}`)],
  ...over,
});
const asking = thread('ask', {
  name: 'pocket-schema-control-evaluation',
  state: 'design_review',
  visits: [visit('ses_ask', { outcome: 'asked_owner' })],
  question: { id: 'q1', question: 'Which split should the control use?', askedAt: ago(4) },
});
const liveA = thread('a', { status: 'live', visits: [working('ses_a')] });
const liveB = thread('b', {
  status: 'live',
  state: 'design_review',
  role: 'reviewer',
  workflow: 'task',
  visits: [working('ses_b')],
});
const lapsedC = thread('c', { status: 'live', visits: [working('ses_c', 'lapsed')] });
const pending = thread('p', {
  attention: true,
  message: {
    id: 'm1',
    senderActorId: 'actor_me',
    body: 'Use the smaller model.',
    createdAt: ago(2),
    acknowledgedAt: null,
    reply: null,
  },
});
const retired = thread('old', { status: 'retired', takesMessage: false, seq: '7' });
const page = { threads: [pending, lapsedC, liveB, asking, liveA, retired], next: '7' };

/** The page as a reader of `role` opens it, the project's threads as Sessions sends them. */
async function open(role: string, threads: unknown = page, at = '/sessions') {
  const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
  const actor = { id: 'actor_me', projectId: project.id, name: 'Me', role };
  const rows = [
    {
      id: 'experiments',
      label: 'Experiments',
      group: 'research',
      order: 1,
      path: '/experiments',
      workflow: 'experiment',
      view: { kind: 'experiments' },
      status: {},
      readable: true,
    },
  ];
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows, plugins: [] } } });
  serve(
    '/sessions/threads',
    typeof threads === 'function' ? (threads as () => { body: unknown }) : { body: threads },
  );
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: [at] },
      createElement(SessionProvider, null, createElement(AgentsGallery)),
    ),
  );
  await settle(20);
}
const cards = () => [...document.querySelectorAll<HTMLElement>('.agent-card')];
const titleOf = (card: Element) => card.querySelector('.agent-card-word')!.textContent;
const cardOf = (title: string, sub: string) =>
  cards().find(
    (card) => titleOf(card) === title && card.querySelector('.agent-card-sub')!.textContent === sub,
  )!;
const press = async (element: Element) => {
  await act(async () => void (element as HTMLElement).click());
  await settle(10);
};
const type = async (area: HTMLTextAreaElement, value: string) =>
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!;
    set.set!.call(area, value);
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const line = (sessionId: string, threadId: string, events: unknown[], reset = false) => ({
  sessionId,
  threadId,
  ...(reset && { reset: true }),
  events,
});
const text = (seq: number, id: string, delta: string) => ({
  seq,
  at: ago(0),
  event: { kind: 'text', id, delta },
});
const tool = (seq: number, id: string, name: string, input: string) => ({
  seq,
  at: ago(0),
  event: { kind: 'tool_call', id, name, input },
});

test('cards stand waiting on you first, then at work, then folded under Recent', async (t) => {
  t.after(unmount);
  serve('/sessions/live', () => ({ stream: eventStream().stream }));
  serve('/sessions/threads?before=7', {
    body: { threads: [thread('older', { seq: '6' })], next: null },
  });
  await open('operator');
  assert.equal(
    document.querySelector('.agents-count')!.textContent,
    '3 working · 1 waiting on an answer',
  );
  // Titled by the stage its work stands at, in its owner's word; under it, its kind and name.
  assert.deepEqual(
    cards().map((card) => [titleOf(card), card.querySelector('.agent-card-sub')!.textContent]),
    [
      ['Design review', 'Experiment · pocket-schema-control-evaluation'],
      ['Running', 'Experiment · work-c'],
      ['Design review', 'Task · work-b'],
      ['Running', 'Experiment · work-a'],
      ['Running', 'Experiment · work-p'],
    ],
  );
  // The waiting card is outlined and asks its question; the live ones wear a dot, green while
  // their lease holds and red once it lapsed.
  const [ask, lapsed, b, a, held] = cards();
  assert.ok(ask!.classList.contains('agent-card--waiting'));
  assert.match(ask!.textContent!, /Which split should the control use\?/);
  assert.equal(a!.querySelector('.live-dot')!.getAttribute('aria-label'), 'Live');
  assert.ok(b!.querySelector('.live-dot--live'));
  assert.equal(lapsed!.querySelector('.live-dot')!.getAttribute('aria-label'), 'Lapsed');
  assert.ok(lapsed!.classList.contains('agent-card--bad'));
  // A message its agent has not read yet keeps its card up, and says it was sent.
  assert.equal(held!.querySelector('.live-dot'), null);
  assert.match(
    held!.querySelector('.agent-card-said')!.textContent!,
    /^Sent Use the smaller model\./,
  );

  // Recent is folded: one press opens it, and older ones are a press further.
  const recent = [...document.querySelectorAll('button')].find((item) =>
    item.textContent!.startsWith('Recent'),
  )!;
  assert.equal(recent.getAttribute('aria-expanded'), 'false');
  assert.equal(cards().length, 5);
  await press(recent);
  assert.equal(cards().length, 6);
  assert.ok(cards()[5]!.classList.contains('agent-card--retired'));
  await press(
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Show older')!,
  );
  assert.equal(cards().length, 7);
});

test('a thread whose lease is offered and not yet taken up is at work: its dot, and the count', async (t) => {
  t.after(unmount);
  serve('/sessions/live', () => ({ stream: eventStream().stream }));
  const offered = thread('o', { status: 'live', visits: [working('ses_o', 'offered')] });
  await open('operator', { threads: [offered], next: null });
  assert.equal(
    document.querySelector('.agents-count')!.textContent,
    '1 working · 0 waiting on an answer',
  );
  assert.ok(
    cards()[0]!.querySelector('.live-dot--live'),
    'Sessions calls it live; so does the card',
  );
});

test('the waiting card answers its question through the thread, and its card says Sent', async (t) => {
  t.after(unmount);
  serve('/sessions/live', () => ({ stream: eventStream().stream }));
  const sent: Record<string, unknown>[] = [];
  serve('/sessions/threads/ask/messages', (_call, body) => {
    sent.push(body);
    return { body: { message: { id: 'm2', body: body.body } } };
  });
  let answered = false;
  const threads = () => ({
    body: answered
      ? {
          threads: [
            {
              ...asking,
              question: undefined,
              // Its unread answer still wants attention, as Sessions says.
              attention: true,
              message: {
                id: 'm2',
                senderActorId: 'actor_me',
                body: 'The held-out split.',
                createdAt: ago(0),
                acknowledgedAt: null,
                reply: null,
              },
            },
          ],
          next: null,
        }
      : { threads: [asking], next: null },
  });
  await open('operator', threads);
  const card = cards()[0]!;
  const area = card.querySelector('textarea')!;
  assert.equal(area.getAttribute('aria-label'), 'Answer');
  await type(area, 'The held-out split.');
  answered = true;
  await act(async () => void card.querySelector('form')!.requestSubmit());
  await settle(20);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body, 'The held-out split.');
  assert.equal(typeof sent[0]!.requestId, 'string');
  assert.equal(document.querySelector('dialog'), null, 'answering in place opens nothing');
  // The answer is read again at once: the card leaves Waiting and says its answer was sent.
  const after = cards()[0]!;
  assert.ok(!after.classList.contains('agent-card--waiting'));
  assert.match(after.querySelector('.agent-card-said')!.textContent!, /^Sent The held-out split\./);
  assert.equal(
    document.querySelector('.agents-count')!.textContent,
    '0 working · 0 waiting on an answer',
  );
});

test('one feed connection streams every live card its agent’s last lines', async (t) => {
  t.after(unmount);
  const feed = eventStream();
  serve('/sessions/live', () => ({ stream: feed.stream }));
  await open('operator');
  feed.send('snapshot', {
    live: [
      { sessionId: 'ses_a', threadId: 'a' },
      { sessionId: 'ses_b', threadId: 'b' },
      { sessionId: 'ses_c', threadId: 'c' },
    ],
    visits: [
      line('ses_a', 'a', [text(1, 'm1.0', 'Reading the config.\nChecking the seeds.')], true),
      line('ses_b', 'b', [tool(4, 't1', 'shell', '{"command":"rg --files"}')], true),
      line('ses_c', 'c', [text(2, 'm2.0', 'Waiting on the GPU.')], true),
    ],
  });
  await settle(10);
  const tail = (id: string) =>
    [
      ...cardOf(
        id === 'b' ? 'Design review' : 'Running',
        `${id === 'b' ? 'Task' : 'Experiment'} · work-${id}`,
      ).querySelectorAll('.agent-tail li'),
    ].map((item) => item.textContent);
  // A message is its last line; a step is its words and what it was about, as the thread says.
  assert.deepEqual(tail('a'), ['Checking the seeds.']);
  assert.deepEqual(tail('b'), ['Ran shell · rg --files']);
  assert.deepEqual(tail('c'), ['Waiting on the GPU.']);
  // What follows reaches its own card, the block it continues joined.
  feed.send('tail', {
    live: [
      { sessionId: 'ses_a', threadId: 'a' },
      { sessionId: 'ses_b', threadId: 'b' },
      { sessionId: 'ses_c', threadId: 'c' },
    ],
    visits: [
      line('ses_a', 'a', [
        text(2, 'm1.0', ' All six.'),
        tool(3, 't9', 'Bash', '{"command":"pytest -q"}'),
      ]),
    ],
  });
  await settle(10);
  assert.deepEqual(tail('a'), ['Checking the seeds. All six.', 'Ran shell · pytest -q']);
  assert.deepEqual(tail('b'), ['Ran shell · rg --files']);
  // Three cards, one connection, and no card's own stream.
  assert.equal(requests.filter((request) => request === 'GET /sessions/live').length, 1);
  assert.ok(!requests.some((request) => /\/sessions\/ses_[a-z]+\/events/.test(request)));
  // The waiting card's agent is not live: it streams nothing.
  assert.equal(cards()[0]!.querySelector('.agent-tail'), null);
});

test('whoever may not read agents sees the cards, their stage and liveness, but no stream', async (t) => {
  t.after(unmount);
  serve('/sessions/live', () => ({ stream: eventStream().stream }));
  await open('reader');
  assert.equal(cards().length, 5);
  assert.equal(titleOf(cards()[3]!), 'Running');
  assert.ok(cards()[3]!.querySelector('.live-dot--live'));
  assert.equal(document.querySelector('.agent-tail'), null);
  assert.ok(!requests.includes('GET /sessions/live'), 'the feed is never asked for');
  // A reader writes nothing: the waiting card asks its question without a box.
  assert.equal(cards()[0]!.querySelector('textarea'), null);
});

test('a press on a card opens its thread: its conversation and the box that speaks to it', async (t) => {
  t.after(unmount);
  serve('/sessions/live', () => ({ stream: eventStream().stream }));
  serve('/sessions/threads/a/messages', { body: { threadId: 'a', messages: [], questions: [] } });
  serve('/sessions/threads/a/conversation', { body: { threadId: 'a', visits: [] } });
  serve('/sessions/ses_a/events', () => ({ stream: eventStream().stream }));
  await open('operator');
  // A live card whose agent has said nothing yet says it is starting.
  assert.equal(
    cardOf('Running', 'Experiment · work-a').querySelector('.agent-tail')!.textContent,
    'Starting…',
  );
  // Anywhere on the card: here its stream, which is no control.
  await press(cardOf('Running', 'Experiment · work-a').querySelector('.agent-tail')!);
  const dialog = document.querySelector('dialog')!;
  assert.ok(dialog.hasAttribute('open'));
  assert.match(dialog.querySelector('h2')!.textContent!, /^Producer · Running · \d+[smhd]$/);
  assert.equal(dialog.querySelector('.thread-head-unit')!.textContent, 'Experiment · work-a');
  // The conversation is the dialog's body, and the box that speaks to it is at its foot.
  assert.ok(dialog.querySelector('.agent-timeline'));
  assert.equal(dialog.querySelector('button[aria-pressed]'), null, 'no tabs');
  const box = dialog.querySelector('.thread-reading > form textarea')!;
  assert.equal(box.getAttribute('aria-label'), 'Message');
  assert.equal(dialog.querySelector('.thread-reading')!.lastElementChild!.tagName, 'FORM');
  await press(dialog.querySelector('button[aria-label="Close"]')!);
  assert.equal(document.querySelector('dialog'), null);
  // The title is a control too, and a card's answer box is not: typing in it opens nothing.
  await press(cards()[0]!.querySelector('textarea')!);
  assert.equal(document.querySelector('dialog'), null);
});

test('an address naming a thread, as a question’s card on the Work map does, opens that thread', async (t) => {
  t.after(unmount);
  serve('/sessions/live', () => ({ stream: eventStream().stream }));
  serve('/sessions/threads/a/messages', { body: { threadId: 'a', messages: [], questions: [] } });
  serve('/sessions/threads/a/conversation', { body: { threadId: 'a', visits: [] } });
  serve('/sessions/ses_a/events', () => ({ stream: eventStream().stream }));
  await open('operator', page, '/sessions?thread=a');
  const dialog = document.querySelector('dialog')!;
  assert.ok(dialog.hasAttribute('open'));
  assert.match(dialog.textContent!, /Experiment · work-a/);
});

test('the feed keeps each visit to its newest blocks, starts a visit over on reset, and lets one go', () => {
  const frame = (visits: unknown[], live = ['ses_a', 'ses_b']) => ({
    live: live.map((sessionId) => ({ sessionId, threadId: sessionId.slice(4) })),
    visits,
  });
  let held = applyFrame(
    new Map(),
    frame([line('ses_a', 'a', [text(1, 'x', 'One')], true)]) as never,
    true,
  );
  held = applyFrame(
    held,
    frame([
      line(
        'ses_a',
        'a',
        Array.from({ length: 30 }, (_, at) => tool(at + 2, `t${at}`, 'shell', 'ls')),
      ),
    ]) as never,
    false,
  );
  assert.equal(held.get('ses_a')!.timeline.blocks.length, 16);
  held = applyFrame(
    held,
    frame([line('ses_a', 'a', [text(90, 'y', 'Fresh')], true)]) as never,
    false,
  );
  assert.deepEqual(
    tailLines(held.get('ses_a')!.timeline.blocks).map((item) => item.text),
    ['Fresh'],
  );
  held = applyFrame(held, frame([], ['ses_b']) as never, false);
  assert.equal(held.has('ses_a'), false);
});

test('a card holding a question that ended says how, not Sent, and folds under Recent', async (t) => {
  t.after(unmount);
  const asked = (id: string, status: string, seq: string) =>
    thread(id, {
      seq,
      message: {
        id: `m_${id}`,
        senderActorId: 'actor_me',
        body: `Why ${id}?`,
        createdAt: ago(60),
        acknowledgedAt: null,
        reply: null,
        inquiry: {
          id: `inquiry_${id}`,
          status,
          open: false,
          label: status === 'expired' ? 'expired' : 'no answer',
        },
      },
    });
  await open('operator', {
    threads: [asked('x', 'expired', '5'), asked('n', 'unanswered', '4')],
    next: null,
  });
  assert.equal(cards().length, 0, 'no question that ended wants attention');
  const recent = [...document.querySelectorAll('button')].find((item) =>
    item.textContent!.startsWith('Recent'),
  )!;
  await press(recent);
  const said = cards().map((card) => card.querySelector('.agent-said-state')!);
  assert.deepEqual(
    said.map((state) => [state.textContent, state.classList.contains('agent-said--sent')]),
    [
      ['Expired', false],
      ['No answer', false],
    ],
  );
});

test('the page polls quickly only while an agent works, and slowly while only questions wait', async (t) => {
  t.after(unmount);
  serve('/sessions/live', () => ({ stream: eventStream().stream }));
  // The delays the page's reads wait between polls.
  const delays: number[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
    if ((ms ?? 0) >= 1000) delays.push(ms!);
    return real(handler, ms, ...rest);
  }) as typeof setTimeout;
  t.after(() => void (globalThis.setTimeout = real));
  const polls = () => delays.filter((ms) => ms > 2_000 && ms <= 30_000);
  await open('operator', { threads: [asking], next: null });
  assert.ok(polls().length > 0);
  assert.ok(
    polls().every((ms) => ms > 20_000),
    `a question alone polls slowly: ${polls()}`,
  );
  await unmount();
  delays.length = 0;
  await open('operator', { threads: [asking, liveA], next: null });
  assert.ok(
    polls().some((ms) => ms <= 4_000),
    `an agent at work polls quickly: ${polls()}`,
  );
});
