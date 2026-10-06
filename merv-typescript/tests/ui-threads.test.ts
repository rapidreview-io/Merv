/**
 * Who worked each stage, on the Work page's stage card: Sessions' threads, each on the stage
 * whose state it names, and the dialog one opens. Each test states one thing a person reading
 * it relies on: a thread stands on its own stage and nowhere else, failed launches are a count
 * and not a crowd of chips, the dialog opens and closes, what an agent said is an operator's
 * alone, and a resumed visit says so where it begins.
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

test('each thread stands on the stage its state names, and failed launches are a count', async (t) => {
  t.after(unmount);
  await open('reader');
  assert.deepEqual(chips('planned'), ['Producer']);
  // The live visit's dot, and how it stands in the chip's tooltip.
  assert.deepEqual(chips('design_review'), ['Reviewer']);
  assert.ok(chip('design_review').querySelector('.live-dot--live'));
  assert.match(chip('design_review').getAttribute('title')!, /^active · .* · lab-1$/);
  // Two launches failed: the chip counts them beside the two visits that ran. The retired
  // thread beside it is a quiet way back, not a second chip.
  assert.deepEqual(chips('running'), ['Producer· 2 visits· 2 failed launches', '+1 earlier']);
  assert.ok(!chip('running').classList.contains('agent-chip--retired'));
  // A retired thread alone is a quieter chip.
  assert.deepEqual(chips('complete'), ['Reviewer']);
  assert.ok(chip('complete').classList.contains('agent-chip--retired'));
  assert.equal(document.querySelectorAll('.agent-chip').length, 4);

  await press(button('+1 earlier')!);
  assert.equal(document.querySelector('dialog h2')!.textContent, 'Producer · running · retired');
});

test('a chip opens the thread’s dialog, which its close control and its backdrop close', async (t) => {
  t.after(unmount);
  await open('operator');
  await press(chip('running'));
  const dialog = document.querySelector('dialog')!;
  assert.ok(dialog.hasAttribute('open'));
  assert.equal(dialog.querySelector('h2')!.textContent, 'Producer · running · dormant');
  assert.ok(dialog.textContent!.includes('Grokking at scale'));
  await press(button('Close')!);
  assert.equal(document.querySelector('dialog'), null);

  await press(chip('running'));
  await press(document.querySelector('dialog')!);
  assert.equal(document.querySelector('dialog'), null, 'a press on the backdrop closes it');
});

test('a live thread’s dialog says how its lease stands and is the way to it', async (t) => {
  t.after(unmount);
  await open('reader');
  await press(chip('design_review'));
  assert.match(dialogText(), /active/);
  await press(button('Lease on lab-1')!);
  assert.deepEqual(opened, ['session:ses_v1']);
});

test('an operator reads the conversation, each visit marked where it began', async (t) => {
  t.after(unmount);
  await open('operator');
  await press(chip('running'));
  assert.ok(button('Conversation')?.getAttribute('aria-pressed') === 'true');
  assert.ok(requests.includes('GET /sessions/threads/thr_run/conversation'));
  const dividers = [...document.querySelectorAll('.agent-visit')].map((item) => item.textContent);
  assert.equal(dividers.length, 2, 'the failed launches said nothing and have no divider');
  assert.match(dividers[0]!, /^Visit 1 · /);
  assert.match(dividers[1]!, /^Visit 2 · resumed · /);
  assert.deepEqual(
    [...document.querySelectorAll('.agent-text')].map((item) => item.textContent),
    ['First pass.', 'Picked it up again.'],
  );

  // The table numbers the visits that ran as the chip counts them; a failed launch has none.
  await press(button('Visits')!);
  const rows = [...document.querySelectorAll('.ruled-row')].map((row) => row.textContent!);
  assert.equal(rows.length, 4);
  assert.match(rows[0]!, /^Visit 1/);
  assert.match(rows[1]!, /^Launch failed.*exit 70/);
  assert.match(rows[2]!, /^Launch failed/);
  assert.match(rows[3]!, /^Visit 2 · resumed.*submitted.*claude · mac-studio/);
});

test('anyone else reads the visits alone, and never asks for the conversation', async (t) => {
  t.after(unmount);
  await open('reviewer');
  await press(chip('running'));
  assert.equal(button('Conversation'), undefined);
  assert.equal(document.querySelector('.agent-timeline'), null);
  assert.equal(document.querySelectorAll('.ruled-row').length, 4);
  assert.ok(!requests.some((request) => request.includes('/conversation')));
  assert.ok(dialogText().includes('Launch failed'));
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
  unmount();

  // An active lease, and a thread with no live visit, are never red.
  await open('reader');
  assert.equal(document.querySelectorAll('.agent-chip--bad').length, 0);
});
