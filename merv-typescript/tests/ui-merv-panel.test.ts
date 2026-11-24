/**
 * merv-desktop's chat panel and first-run card, as Merv draws them: a first visit is asked what
 * it wants to learn; the panel shows the project's agents, an agent's question answered with its
 * worded buttons (`session.ask_owner` options, sent to its thread as the answer), and work handed
 * from a board waits on its card for an explicit Approve, never sending itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { click, jump, mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
Object.assign(globalThis, {
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});
// The thread follows its end as a browser scrolls it; jsdom lays nothing out.
Element.prototype.scrollTo = function () {};
// The Agent's composer listens on the window by its bare name, as a browser page may.
Object.assign(globalThis, {
  addEventListener: window.addEventListener.bind(window),
  removeEventListener: window.removeEventListener.bind(window),
});

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { App } = await import('../packages/ui/web/app.js');
const { hold } = await import('../packages/ui/web/board-app/held.js');
const { setToken } = await import('../packages/ui/web/api.js');

const project = {
  id: 'project_1',
  name: 'Grokking replication',
  createdAt: '2026-09-01T00:00:00Z',
};
const actor = { id: 'actor_1', projectId: project.id, name: 'Ada', role: 'operator', active: true };
const rows = [
  {
    id: 'settings',
    label: 'Settings',
    group: 'settings',
    order: 100,
    path: '/settings',
    view: { kind: 'settings' },
    status: {},
    readable: false,
    rooms: true,
  },
];
const at = new Date(Date.now() - 60_000).toISOString();
const question = 'Which GPU should the sweep rent?';
const options = ['Rent one A100', 'Rent two L4s'];
const asking = {
  id: 'thr_1',
  instanceId: 'wf_1',
  state: 'running',
  role: 'worker',
  status: 'dormant',
  takesMessage: true,
  name: 'Learning-rate sweep',
  workflow: 'tasks',
  attention: true,
  visits: [
    {
      sessionId: 'ses_1',
      status: 'released',
      offeredAt: at,
      startedAt: at,
      endedAt: at,
      outcome: 'asked_owner',
      launched: true,
      resumed: false,
      harness: 'claude',
    },
  ],
  question: { id: 'q_1', question, options, askedAt: at },
};

function boot() {
  setToken('fixture-token');
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'actor', actor, projects: [project] } });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows, plugins: [] } } });
  serve('/sessions/threads', { body: { threads: [asking], next: null } });
}
const open = async () => {
  await mount(createElement(MemoryRouter, { initialEntries: ['/settings'] }, createElement(App)));
  await settle(20);
};

test('a first visit is asked what it wants to learn, with research asks to start from', async (t) => {
  t.after(unmount);
  localStorage.clear();
  boot();
  await open();
  assert.match(text(), /What do you want to learn\?/);
  assert.match(text(), /Reproduce the main result of the LoRA paper/);
  // The tour it replaces is gone: there are no steps to walk.
  assert.doesNotMatch(text(), /Project switcher|Replay this tour/);
  await click('Skip');
  assert.doesNotMatch(text(), /What do you want to learn\?/);
  // Seen once, it stays away on the next visit.
  await unmount();
  await open();
  assert.doesNotMatch(text(), /What do you want to learn\?/);
});

test("an agent's question is answered with its worded buttons, sent to its thread", async (t) => {
  t.after(unmount);
  localStorage.clear();
  localStorage.setItem('merv:welcome-seen:', 'seen');
  localStorage.setItem('merv:panel', 'open');
  boot();
  let answered: Record<string, unknown> | undefined;
  serve('/sessions/threads/thr_1/messages', (_call, sent) => {
    answered = sent;
    return { body: { message: { id: 'msg_1' } } };
  });
  await open();
  const panel = document.querySelector('#web-panel')!;
  assert.ok(panel, text().slice(0, 800));
  assert.match(panel.textContent!, /Learning-rate sweep/);
  assert.match(panel.textContent!, /needs you/);
  // The live card opens on what waits: the question, and one button per answer.
  const head = [...panel.querySelectorAll<HTMLButtonElement>('.agent-head')].find((one) =>
    one.textContent?.includes('Learning-rate sweep'),
  )!;
  if (head.getAttribute('aria-expanded') !== 'true') await act(async () => head.click());
  await settle(0);
  assert.match(panel.textContent!, new RegExp(question.replace('?', '\\?')));
  for (const option of options) assert.match(panel.textContent!, new RegExp(option));
  const choice = [...panel.querySelectorAll<HTMLButtonElement>('button.one-option')].find(
    (one) => one.textContent === 'Rent two L4s',
  );
  assert.ok(choice, panel.innerHTML.slice(0, 3000));
  await act(async () => choice.click());
  await settle(20);
  assert.ok(requests.includes('POST /sessions/threads/thr_1/messages'), requests.join('\n'));
  assert.equal(answered?.body, 'Rent two L4s');
  assert.equal(typeof answered?.requestId, 'string');
});

test('work handed from a board waits for Approve and never sends itself', async (t) => {
  t.after(unmount);
  localStorage.clear();
  localStorage.setItem('merv:welcome-seen:', 'seen');
  boot();
  serve('/sessions/threads', { body: { threads: [], next: null } });
  await open();
  await act(async () =>
    hold({ id: 'cmd_1', board: 'board_1', title: 'Ideas', words: 'Run this sweep', shapes: ['a'] }),
  );
  await settle(20);
  const panel = document.querySelector('#web-panel')!;
  // Holding work opens the panel on its card.
  assert.ok(panel.classList.contains('is-open'));
  assert.match(panel.textContent!, /Waiting for you/);
  const approve = [...panel.querySelectorAll('button')].find(
    (one) => one.textContent === 'Approve',
  );
  assert.ok(approve, panel.textContent!);
  assert.doesNotMatch(panel.textContent!, /starts in/);
  const before = requests.length;
  await jump(45_000);
  // Long past the 30 seconds a Mac would have counted down, it still waits, and nothing went.
  assert.match(panel.textContent!, /Waiting for you/);
  assert.equal(
    requests.slice(before).filter((one) => /pi\.send|pi\.prompt/.test(one)).length,
    0,
    requests.slice(before).join('\n'),
  );
});
