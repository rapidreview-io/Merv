/**
 * Who worked each stage, on the Work page's stage card: Sessions' threads, each on the stage
 * whose state it names, and the dialog one opens. Each test states one thing a person reading
 * it relies on: a thread stands on its own stage and nowhere else, a stage's threads in one role
 * are one chip whose failed launches are a count and not a crowd, the dialog opens and closes,
 * names no machine, and folds every visit of the role under Details; the timeline marks each
 * visit where it begins (a resumed one says so), what an agent said is an operator's alone, the
 * people's lines stand among it, and the box at its foot answers the thread's question.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, requests, serve, settle, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
await import('../packages/ui/web/components.js');
const { ThreadStages } = await import('../packages/ui/web/views/threads.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');
const { Reading } = await import('../packages/ui/web/views/running-phrase.js');
const { useTool } = await import('../packages/ui/web/api.js');

// jsdom has the element but not its modal methods: open sets the attribute, close clears it
// and says so, as a browser's does.
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

const at = (minute: number) => `2026-10-06T12:${String(minute).padStart(2, '0')}:00.000Z`;
const node = (state: string, marks: { terminal?: boolean; current?: boolean } = {}) => ({
  state,
  initial: state === 'planned',
  terminal: !!marks.terminal,
  current: !!marks.current,
  entries: 1,
  firstEnteredAt: at(0),
  blockers: [],
});
const graph = {
  instanceId: 'wf_1',
  workflow: 'experiment',
  version: 1,
  revision: 3,
  state: 'running',
  currentGate: 'running',
  terminal: false,
  dependencies: [],
  nodes: [
    node('planned'),
    node('design_review'),
    node('running', { current: true }),
    node('complete', { terminal: true }),
  ],
  edges: [
    { from: 'planned', to: 'design_review' },
    { from: 'design_review', to: 'running' },
    { from: 'running', to: 'complete' },
  ].map((edge) => ({ ...edge, action: 'act', traversals: [], status: null, tool: null })),
};
const visit = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  status: 'released',
  offeredAt: at(1),
  startedAt: at(1),
  endedAt: at(9),
  outcome: 'submitted',
  launched: true,
  resumed: false,
  harness: 'claude',
  runnerId: 'mac-studio',
  hasConversation: true,
  ...over,
});
const failedLaunch = (sessionId: string) =>
  visit(sessionId, {
    startedAt: undefined,
    outcome: 'launch_failed',
    why: 'local_process_exit_code_70',
    launched: false,
    harness: undefined,
  });
const threads = [
  {
    id: 'thr_plan',
    instanceId: 'wf_1',
    state: 'planned',
    role: 'producer',
    status: 'dormant',
    visits: [visit('ses_p1')],
  },
  {
    id: 'thr_rev',
    instanceId: 'wf_1',
    state: 'design_review',
    role: 'reviewer',
    status: 'live',
    visits: [
      visit('ses_v1', {
        status: 'active',
        endedAt: undefined,
        outcome: undefined,
        runnerId: 'lab-1',
        liveness: { verdict: 'active', tone: 'ok', rest: [{ since: at(30) }] },
      }),
    ],
  },
  {
    id: 'thr_done',
    instanceId: 'wf_1',
    state: 'complete',
    role: 'reviewer',
    status: 'retired',
    visits: [visit('ses_d1')],
  },
  {
    id: 'thr_old',
    instanceId: 'wf_1',
    state: 'running',
    role: 'producer',
    status: 'retired',
    visits: [visit('ses_o1')],
  },
  {
    id: 'thr_run',
    instanceId: 'wf_1',
    state: 'running',
    role: 'producer',
    status: 'dormant',
    takesMessage: true,
    visits: [
      visit('ses_r1'),
      failedLaunch('ses_r2'),
      failedLaunch('ses_r3'),
      visit('ses_r4', { resumed: true, startedAt: at(41), endedAt: at(50) }),
    ],
  },
];
const said = (id: string, text: string) => ({
  sessionId: id,
  from: 'transcript',
  events: [{ seq: 1, at: at(2), event: { kind: 'text', id: 'a', delta: text, done: true } }],
});

/** The sidebars the page was asked to open, by key. */
const opened: string[] = [];
/** The card as the Work page's sidebar draws it, for a reader of this role. */
async function open(role: string, list: unknown[] = threads) {
  opened.length = 0;
  const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
  const actor = { id: 'actor_me', projectId: project.id, name: 'Me', role };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  serve('/sessions/threads?instanceId=wf_1', { body: { threads: list } });
  // Sessions' ThreadConversation: each visit says where its events came from.
  serve('/sessions/threads/thr_run/conversation', {
    body: {
      threadId: 'thr_run',
      visits: [
        said('ses_r1', 'First pass.'),
        { sessionId: 'ses_r2', from: 'none', events: [] },
        { sessionId: 'ses_r3', from: 'none', events: [] },
        said('ses_r4', 'Picked it up again.'),
      ],
    },
  });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(
        Reading.Provider,
        {
          value: {
            now: { at: Date.now(), since: 0, stale: false },
            nameOf: () => undefined,
            open: (key: string) => void opened.push(key),
          },
        },
        createElement(
          SessionProvider,
          null,
          createElement(ThreadStages, { graph: graph as never, title: 'Grokking at scale' }),
          // Home, read beside the card, as the shell's Needs you reads it.
          createElement(() => (useTool('ui.home'), null)),
        ),
      ),
    ),
  );
  await settle(20);
}
const rowOf = (state: string) =>
  [...document.querySelectorAll('.stages > li')].find(
    (row) => row.querySelector('.stage-word')!.textContent === state.replaceAll('_', ' '),
  )!;
/** What stands under a stage: its chips, and the quiet way to the threads before them. */
const chips = (state: string) =>
  [...rowOf(state).querySelectorAll<HTMLButtonElement>('.stage-aside > button')].map(
    (chip) => chip.textContent,
  );
const chip = (state: string) => rowOf(state).querySelector('.agent-chip')!;
const press = async (element: Element) => {
  await act(async () => void (element as HTMLElement).click());
  await settle(10);
};
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === label || item.getAttribute('aria-label') === label,
  );
const dialogText = () => document.querySelector('dialog')!.textContent!;
/** Opens the dialog's Details: its visits' table and what its calls came to. */
const details = async () => {
  const fold = document.querySelector<HTMLDetailsElement>('dialog .thread-details')!;
  await act(async () => {
    fold.open = true;
    fold.dispatchEvent(new window.Event('toggle'));
  });
  await settle(10);
};
const dividers = () =>
  [...document.querySelectorAll('dialog .agent-divider')].map((item) => item.textContent);
/** The box at the foot of the reading, and the reading it stands in. */
const reading = () => document.querySelector('dialog .thread-reading')!;

test('each thread stands on the stage its state names, and failed launches are a count', async (t) => {
  t.after(unmount);
  await open('reader');
  // Each chip leads with its role's mark, P or R, as the unit's history marks its entries.
  assert.deepEqual(chips('planned'), ['PProducer']);
  assert.equal(chip('planned').querySelector('.role-mark')!.textContent, 'P');
  // The live visit's dot, and how it stands in the chip's tooltip, with no machine named.
  assert.deepEqual(chips('design_review'), ['RReviewer']);
  assert.ok(chip('design_review').querySelector('.live-dot--live'));
  assert.match(chip('design_review').getAttribute('title')!, /^active · \d+[smhd]$/);
  // Two launches failed: the chip counts them beside the visits that ran, the retired thread's
  // too. The producer the current one superseded is in the same chip, not a second one.
  assert.deepEqual(chips('running'), ['PProducer· 3 visits· 2 failed launches']);
  assert.ok(!chip('running').classList.contains('agent-chip--retired'));
  // A retired thread alone is a quieter chip.
  assert.deepEqual(chips('complete'), ['RReviewer']);
  assert.ok(chip('complete').classList.contains('agent-chip--retired'));
  assert.equal(document.querySelectorAll('.agent-chip').length, 4);

  // The chip opens the current thread; its Details list the earlier thread's visit too.
  await press(chip('running'));
  assert.equal(document.querySelector('dialog h2')!.textContent, 'Producer · Running · dormant');
  assert.equal(document.querySelectorAll('dialog .ruled-row').length, 0, 'Details start shut');
  await details();
  assert.equal(document.querySelectorAll('dialog .ruled-row').length, 5);
});

test('a review stage’s reviewers are one chip, and its dialog reaches the visit that ran', async (t) => {
  t.after(unmount);
  // A reviewer keeps no conversation, so each visit, each failed launch too, is its own thread.
  const reviewer = (id: string, visits: unknown[]) => ({
    id,
    instanceId: 'wf_1',
    state: 'design_review',
    role: 'reviewer',
    status: 'retired',
    visits,
  });
  await open('operator', [
    reviewer('thr_a', [failedLaunch('ses_a')]),
    reviewer('thr_b', [visit('ses_b', { offeredAt: at(2) })]),
    reviewer(
      'thr_c',
      [failedLaunch('ses_c')].map((item) => ({ ...item, offeredAt: at(3) })),
    ),
    reviewer(
      'thr_d',
      [failedLaunch('ses_d')].map((item) => ({ ...item, offeredAt: at(4) })),
    ),
  ]);
  assert.deepEqual(chips('design_review'), ['RReviewer· 3 failed launches']);
  await press(chip('design_review'));
  assert.ok(requests.includes('GET /sessions/threads/thr_b/conversation'));
  await details();
  const rows = [...document.querySelectorAll('dialog .ruled-row')].map((row) => row.textContent!);
  assert.equal(rows.length, 4);
  assert.match(rows[0]!, /^Launch failed/);
  assert.match(rows[1]!, /^Visit 1.*submitted/);
  assert.match(rows[2]!, /^Launch failed/);
});

test('a chip opens the thread’s dialog, which its close control and its backdrop close', async (t) => {
  t.after(unmount);
  await open('operator');
  await press(chip('running'));
  const dialog = document.querySelector('dialog')!;
  assert.ok(dialog.hasAttribute('open'));
  assert.equal(dialog.querySelector('h2')!.textContent, 'Producer · Running · dormant');
  assert.ok(dialog.textContent!.includes('Grokking at scale'));
  await press(button('Close')!);
  assert.equal(document.querySelector('dialog'), null);

  await press(chip('running'));
  await press(document.querySelector('dialog')!);
  assert.equal(document.querySelector('dialog'), null, 'a press on the backdrop closes it');
});

test('a live thread’s head is who and what, its dot and how long it has run, and no machine', async (t) => {
  t.after(unmount);
  await open('reader');
  await press(chip('design_review'));
  const head = document.querySelector('dialog h2')!;
  assert.ok(head.querySelector('.live-dot--live'));
  assert.match(head.textContent!, /^Reviewer · Design review · \d+[smhd]$/);
  assert.equal(
    document.querySelector('dialog .thread-head-unit')!.textContent,
    'Grokking at scale',
  );
  // No machine, no lease link, no status said twice.
  assert.ok(!dialogText().includes('lab-1'));
  assert.equal(button('Lease on lab-1'), undefined);
  assert.ok(!/live/i.test(head.textContent!));
});

test('an operator reads one timeline, each visit a divider where it began', async (t) => {
  t.after(unmount);
  await open('operator');
  await press(chip('running'));
  // No tabs: the conversation is the dialog's body.
  for (const tab of ['Conversation', 'Visits', 'Calls']) assert.equal(button(tab), undefined);
  assert.ok(requests.includes('GET /sessions/threads/thr_run/conversation'));
  // Numbered as the role's visits are: the superseded producer's visit was the first. Each says
  // how long it ran and how it ended; a launch that failed says why, in red.
  assert.deepEqual(dividers(), [
    'Visit 2 · 8m · submitted',
    'Launch failed · exit 70',
    'Launch failed · exit 70',
    'Visit 3 · resumed · 9m · submitted',
  ]);
  assert.equal(document.querySelectorAll('dialog .agent-divider--error').length, 2);
  assert.deepEqual(
    [...document.querySelectorAll('.agent-text')].map((item) => item.textContent),
    ['First pass.', 'Picked it up again.'],
  );

  // Details number the visits that ran as the chip counts them, and name no machine.
  await details();
  const rows = [...document.querySelectorAll('.ruled-row')].map((row) => row.textContent!);
  assert.equal(rows.length, 5);
  assert.match(rows[0]!, /^Visit 1/);
  assert.match(rows[1]!, /^Visit 2/);
  assert.match(rows[2]!, /^Launch failed.*exit 70/);
  assert.match(rows[3]!, /^Launch failed/);
  assert.match(rows[4]!, /^Visit 3 · resumed.*submitted/);
  assert.ok(!dialogText().includes('mac-studio'));
});

test('anyone else reads the visits’ dividers alone, and never asks for the conversation', async (t) => {
  t.after(unmount);
  await open('reviewer');
  await press(chip('running'));
  assert.equal(button('Conversation'), undefined);
  assert.equal(dividers().length, 4);
  assert.equal(document.querySelector('.agent-text'), null);
  assert.ok(!requests.some((request) => request.includes('/conversation')));
  assert.ok(dialogText().includes('Launch failed'));
  await details();
  assert.equal(document.querySelectorAll('.ruled-row').length, 5);
});

test('a stage’s chip turns red while its live visit’s lease has lapsed, and only then', async (t) => {
  t.after(unmount);
  const live = threads[1]!;
  const lapsed = {
    ...live,
    visits: [
      {
        ...live.visits[0]!,
        liveness: { verdict: 'lapsed', tone: 'bad', rest: ['lease ran out · ', { since: at(31) }] },
      },
    ],
  };
  await open('reader', [threads[0], lapsed]);
  assert.ok(chip('design_review').classList.contains('agent-chip--bad'));
  assert.match(chip('design_review').getAttribute('title')!, /^lapsed · lease ran out/i);
  assert.ok(!chip('planned').classList.contains('agent-chip--bad'));
  await unmount();

  // An active lease, and a thread with no live visit, are never red.
  await open('reader');
  assert.equal(document.querySelectorAll('.agent-chip--bad').length, 0);
});

test('what the thread’s calls came to is one line under Details, for anyone who reads it', async (t) => {
  t.after(unmount);
  serve('/sessions/threads/thr_run/calls', {
    body: {
      threadId: 'thr_run',
      calls: [
        {
          id: 'c1',
          sessionId: 'ses_r4',
          tool: 'artifact.create',
          status: 'succeeded',
          startedAt: at(42),
          finishedAt: at(42),
          durationMs: 1500,
          inputTokens: 120,
          outputTokens: 40,
        },
      ],
      totals: { calls: 1, completed: 1, inputTokens: 120, outputTokens: 40 },
    },
  });
  await open('reader');
  await press(chip('running'));
  assert.ok(!requests.includes('GET /sessions/threads/thr_run/calls'), 'read once Details open');
  await details();
  assert.match(dialogText(), /1 Merv call · ≈ 120 in · ≈ 40 out/);
});

/** The thread's messages as Sessions sends them: a question its agent asked, open or not, and
 *  whether it still stands (unanswered on work that has not ended). */
const messages = (answered: boolean, stands = !answered) => ({
  threadId: 'thr_run',
  messages: [
    {
      id: 'm1',
      threadId: 'thr_run',
      instanceId: 'wf_1',
      senderActorId: 'actor_me',
      body: 'Use the smaller model.',
      createdAt: at(20),
      acknowledgedAt: at(21),
      reply: 'Switching to it.',
    },
  ],
  questions: [
    {
      id: 'q1',
      threadId: 'thr_run',
      sessionId: 'ses_r4',
      instanceId: 'wf_1',
      revision: 3,
      question: 'Which dataset split?',
      askedAt: at(50),
      answeredAt: answered ? at(51) : null,
      answerMessageId: null,
      open: stands,
    },
  ],
});

test('a writer answers the thread’s open question from the box under it', async (t) => {
  t.after(unmount);
  serve('/sessions/threads/thr_run/messages', (_call, sent) =>
    sent.body
      ? { body: { message: { ...messages(false).messages[0], id: 'm2', body: sent.body } } }
      : { body: messages(false) },
  );
  await open('producer');
  await press(chip('running'));
  const box = reading();
  // What passed before stands in the timeline where it was said: the message, that it was
  // read, and the agent's reply, on a person's accent bar.
  const [said, asked] = [...box.querySelectorAll('.agent-person')];
  assert.equal(said!.textContent, 'You · ReadUse the smaller model.↳ Switching to it.');
  // The question that stands is the timeline's last line, and the box at the foot answers it.
  assert.ok(asked!.classList.contains('agent-person--asked'));
  assert.equal(asked!.textContent, 'Agent asked · waiting on an answerWhich dataset split?');
  assert.equal(box.querySelector('.agent-blocks > li:last-child .agent-person'), asked);
  const area = box.querySelector('textarea')!;
  assert.ok(
    area.closest('form')!.compareDocumentPosition(asked!) & Node.DOCUMENT_POSITION_PRECEDING,
  );
  assert.equal(area.getAttribute('aria-label'), 'Answer');
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!;
    set.set!.call(area, 'The test split.');
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => void box.querySelector('form')!.requestSubmit());
  await settle(10);
  assert.ok(requests.includes('POST /sessions/threads/thr_run/messages'));
  assert.equal(area.value, '');
});

test('a question that no longer stands is not offered an answer: the box only says it was asked', async (t) => {
  t.after(unmount);
  serve('/sessions/threads/thr_run/messages', { body: messages(false, false) });
  await open('producer');
  await press(chip('running'));
  const box = reading();
  assert.equal(
    box.querySelector('.agent-person--asked')!.textContent,
    'Agent askedWhich dataset split?',
  );
  assert.notEqual(box.querySelector('textarea')!.getAttribute('aria-label'), 'Answer');
});

test('an agent that takes no message but kept its conversation is asked: the question goes to an inquiry, its answer under it', async (t) => {
  t.after(unmount);
  serve('/sessions/threads/thr_run/messages', {
    body: {
      threadId: 'thr_run',
      messages: [
        {
          id: 'm3',
          sessionId: null,
          threadId: 'thr_run',
          instanceId: 'wf_1',
          expectedRevision: null,
          senderActorId: 'actor_me',
          body: 'What did you conclude?',
          createdAt: at(60),
          acknowledgedAt: at(61),
          reply: 'The smaller model.',
          inquiry: { id: 'inquiry_1', status: 'answered', open: false, label: 'answered' },
        },
      ],
      questions: [],
    },
  });
  serve('/sessions/threads/thr_run/ask', { body: { inquiry: { id: 'inquiry_2' } } });
  await open(
    'producer',
    threads.map((item) =>
      item.id === 'thr_run' ? { ...item, takesMessage: false, asks: true } : item,
    ),
  );
  await press(chip('running'));
  const box = reading();
  assert.equal(
    box.querySelector('.agent-person')!.textContent,
    'You · answeredWhat did you conclude?↳ The smaller model.',
  );
  const area = box.querySelector('textarea')!;
  assert.equal(area.getAttribute('aria-label'), 'Ask');
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!;
    set.set!.call(area, 'And the seed?');
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => void box.querySelector('form')!.requestSubmit());
  await settle(10);
  assert.ok(requests.includes('POST /sessions/threads/thr_run/ask'));
  assert.ok(!requests.includes('POST /sessions/threads/thr_run/messages'));
  assert.equal(area.value, '');
});

test('a reader sees what passed but no box, and an answered question is history', async (t) => {
  t.after(unmount);
  serve('/sessions/threads/thr_run/messages', { body: messages(true) });
  await open('reader');
  await press(chip('running'));
  const box = reading();
  assert.equal(box.querySelector('textarea'), null);
  assert.match(box.textContent!, /Agent askedWhich dataset split\?/);
});

test('a thread that takes no message is asked instead, where Sessions says it may be', async (t) => {
  t.after(unmount);
  serve('/sessions/threads/thr_run/messages', { body: messages(true) });
  // One Sessions says may not be asked (it kept no conversation, say): the box stands, disabled.
  const unaskable = threads.map((item) =>
    item.id === 'thr_run' ? { ...item, takesMessage: false } : item,
  );
  await open('producer', unaskable);
  await press(chip('running'));
  let box = reading();
  assert.match(box.textContent!, /Use the smaller model\./);
  const area = box.querySelector('textarea')!;
  assert.equal(area.disabled, true);
  assert.equal(area.getAttribute('placeholder'), 'Ask');
  assert.equal(box.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled, true);
  await unmount();

  // One that may be (`asks`) is asked through its thread's ask route, as a message is sent.
  const asked: Record<string, unknown>[] = [];
  serve('/sessions/threads/thr_run/ask', (_call, sent) => {
    asked.push(sent);
    return { body: { inquiry: { id: 'inquiry_3' } } };
  });
  const finished = threads.map((item) =>
    item.id === 'thr_run' ? { ...item, takesMessage: false, asks: true } : item,
  );
  await open('producer', finished);
  await press(chip('running'));
  box = reading();
  const ask = box.querySelector('textarea')!;
  assert.equal(ask.disabled, false);
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!;
    set.set!.call(ask, 'Why did the run stop?');
    ask.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => void box.querySelector('form')!.requestSubmit());
  await settle(10);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.body, 'Why did the run stop?');
  assert.equal(typeof asked[0]!.requestId, 'string');
  assert.ok(!requests.includes('POST /sessions/threads/thr_run/messages'));
  assert.equal(ask.value, '');
  // Whether it may be asked is Sessions' to say: the page reads no tool catalog for it.
  assert.ok(!requests.some((request) => request === 'GET /tools'));
  await unmount();

  // The same thread on open work is sent a message.
  serve('/sessions/threads/thr_run/messages', { body: messages(true) });
  await open('producer');
  await press(chip('running'));
  const message = reading().querySelector('textarea')!;
  assert.equal(message.getAttribute('aria-label'), 'Message');
});

test('an answer sent refreshes Home, and a send whose result is unknown keeps its words locked', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  let fails = false;
  serve('/sessions/threads/thr_run/messages', (_call, sent) =>
    !sent.body
      ? { body: messages(false) }
      : fails
        ? { status: 503, body: { error: { code: 'state_unavailable', message: 'Busy.' } } }
        : { body: { message: { ...messages(false).messages[0], id: 'm2', body: sent.body } } },
  );
  await open('producer');
  await press(chip('running'));
  const homes = () => requests.filter((request) => request === 'POST /tools/ui.home').length;
  const before = homes();
  const box = reading();
  const area = box.querySelector('textarea')!;
  const type = async (value: string) =>
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!;
      set.set!.call(area, value);
      area.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await type('The test split.');
  await act(async () => void box.querySelector('form')!.requestSubmit());
  await settle(10);
  // The question it answered leaves Needs you at once.
  assert.equal(homes(), before + 1);
  fails = true;
  await type('And the seed.');
  await act(async () => void box.querySelector('form')!.requestSubmit());
  await settle(10);
  // Its result unknown, the same words are sent again: they cannot be changed meanwhile.
  assert.equal(area.readOnly, true);
});
