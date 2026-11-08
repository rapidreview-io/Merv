import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { RunningBoard, RunningNode } from '@merv/contracts/running';
import type { ShellData } from '../packages/ui/web/shell-types.js';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
const { SessionContext } = await import('../packages/ui/web/session.js');
const { WorkView } = await import('../packages/ui/web/views/work.js');
const { refreshTools, setProject } = await import('../packages/ui/web/api.js');

const actor = { id: 'actor_mine', name: 'Ada', role: 'operator', projectId: 'project_work' };
const other = { ...actor, id: 'actor_other', name: 'Grace' };
const project = { id: 'project_work', name: 'Transfer research' };
const shell: ShellData = {
  plugins: [],
  rows: ['tasks', 'experiments', 'research', 'reflections', 'reviews', 'sessions', 'paper'].map(
    (kind, order) => ({
      id: kind,
      label: kind,
      path: '/' + kind,
      group: 'hidden',
      order,
      workflow: kind === 'tasks' ? 'task' : kind === 'experiments' ? 'experiment' : kind,
      view: { kind },
      status: {},
      readable: true,
      ...(kind === 'tasks' ? { states: { queued: { idle: true as const } } } : {}),
    }),
  ),
  workflows: ['task', 'experiment', 'research'].map((name) => ({
    name,
    version: 1,
    initial: 'queued',
    states: ['queued', 'working', 'in_review', 'done'],
    terminal: ['done'],
    edges: [
      { from: 'queued', action: 'begin', to: 'working' },
      { from: 'working', action: 'submit', to: 'in_review' },
      { from: 'in_review', action: 'accept', to: 'done', tool: 'review.write' },
    ],
  })),
};
const at = () => new Date().toISOString();
const flow = (workflow: string, state: string) => ({
  workflow,
  version: 1,
  state,
  updatedAt: at(),
});
const task = (id: string, title: string, state: string, producerId = actor.id) => ({
  id,
  title,
  goal: 'Build a reproducible corpus for comparison.',
  producerId,
  dependencies: [],
  dependents: [],
  failure: null,
  workflow: flow('task', state),
  settled: state === 'done',
  failed: false,
});
const node = (id: string, title: string, extra: Partial<RunningNode> = {}): RunningNode => ({
  key: 'work:' + id,
  lane: 'work',
  kind: 'Task',
  title,
  lines: [['Ready']],
  look: 'solid',
  ...extra,
});
function fixture(t: TestContext) {
  setProject('work-test-' + Math.random());
  t.after(async () => {
    await unmount();
    setProject(null);
  });
  const home = {
    project,
    actors: [actor, other],
    reflections: [],
    workflows: { workflows: [] },
    research: [
      {
        id: 'cycle_current',
        name: 'Transfer study',
        ownerId: actor.id,
        workflow: flow('research', 'working'),
        researchDependencies: ['task_ready', 'experiment_running'],
        progress: { total: 2, settled: 1 },
        reflectionId: null,
        automation: null,
        writable: false,
        successorId: null,
      },
    ],
    reviews: [],
    tasks: [
      task('task_ready', 'Prepare corpus', 'queued'),
      {
        ...task('task_waiting', 'Choose dataset', 'working', other.id),
        dependencies: [{ id: 'task_ready', name: 'Prepare corpus', settled: false, failed: false }],
      },
      task('task_review', 'Audit measures', 'in_review', other.id),
      task('task_stalled', 'Recover corpus worker', 'working', other.id),
      task('task_merge', 'Merge reviewed results', 'done', other.id),
      task('task_done', 'Earlier baseline', 'done'),
    ],
    experiments: [
      {
        id: 'experiment_running',
        name: 'Validate transfer',
        intent: 'Compare calibrated transfer across domains.',
        ownerId: actor.id,
        conclusion: null,
        workflow: flow('experiment', 'working'),
        settled: false,
        failed: false,
      },
    ],
  };
  const board: RunningBoard = {
    observedAt: at(),
    edges: [
      {
        from: 'session:session_stalled',
        to: 'work:task_stalled',
        verb: 'works on',
        waiting: false,
      },
    ],
    lanes: {
      work: {
        nodes: [
          node('task_ready_wrapper', 'Prepare corpus', { aliases: ['work:task_ready'] }),
          node('task_waiting', 'Choose dataset', {
            look: 'dashed',
            lines: [['Waiting on Prepare corpus']],
          }),
          node('experiment_running', 'Validate transfer', {
            kind: 'Experiment',
            dot: 'moving',
            lines: [['Comparing results']],
          }),
          node('task_merge', 'Merge reviewed results', {
            attention: { says: ['Merge accepted code'] },
          }),
          node('task_stalled', 'Recover corpus worker'),
          node('orphan', 'Recover archived result', {
            attention: { says: ['Choose how to recover the result'] },
          }),
        ],
        summaries: [],
        needsYou: 2,
        failed: [],
      },
      sessions: {
        nodes: [
          {
            key: 'session:session_stalled',
            lane: 'sessions',
            kind: 'Worker',
            title: 'Corpus agent',
            lines: [['Waiting for machine']],
            look: 'dashed',
            attention: { says: ['Machine offline'] },
          },
        ],
        summaries: [],
        needsYou: 1,
        failed: [],
      },
      hardware: { nodes: [], summaries: [], needsYou: 0, failed: [] },
    },
  };
  serve('/tools/ui.home', { body: { result: home } });
  serve('/tools/ui.running', { body: { result: board } });
  serve('/tools/ui.shell', { body: { result: shell } });
  serve('/tools/project.read:actors', { body: { result: [actor, other] } });
  const opened: string[] = [];
  serve('/tools/ui.running_panel', (_call, input) => {
    opened.push(String(input.key));
    return {
      body: {
        result: {
          key: input.key,
          observedAt: at(),
          header: { kind: 'Task', title: 'Recovered inspector', says: ['Needs attention'] },
          sections: [
            {
              kind: 'text',
              title: 'Recovery plan',
              place: 'content',
              text: 'Recover the retained evidence before restarting this work.',
            },
          ],
          actions: [],
          live: false,
          route: '/tasks/orphan',
        },
      },
    };
  });
  const render = () =>
    mount(
      createElement(
        MemoryRouter,
        { initialEntries: ['/work'] },
        createElement(
          SessionContext.Provider,
          {
            value: {
              actor,
              project,
              account: { kind: 'credential' },
              chooseProject() {},
              signOut() {},
            } as never,
          },
          createElement(WorkView, { shell }),
        ),
      ),
    );
  return { home, board, opened, render };
}

async function select(label: string, value: string) {
  const control = [...document.querySelectorAll('select')].find(
    (item) =>
      item.getAttribute('aria-label') === label ||
      item.closest('label')?.textContent?.startsWith(label),
  );
  assert.ok(control, `Missing ${label} control`);
  const disclosure = control.closest('details');
  if (disclosure && !disclosure.open)
    await act(async () => disclosure.querySelector('summary')!.click());
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

const keys = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.work-row-title[data-key^="work:"]')]
    .map((button) => button.dataset.key!.slice('work:'.length))
    .sort();
const count = (label: string) => {
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.trim().startsWith(label),
  );
  assert.ok(button, `Missing ${label} counter`);
  return Number(button.textContent!.match(/(\d+)\s*$/)![1]);
};
const conserved = () => assert.equal(count('All'), count('Active') + count('History'));
const grouped = (label: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      `section[aria-label="${label}"] .work-row-title[data-key^="work:"]`,
    ),
  ]
    .map((button) => button.dataset.key!.slice('work:'.length))
    .sort();

test('Work groups actionable rows, filters them accurately and opens details on demand', async (t) => {
  const f = fixture(t);
  await f.render();
  const active = [
    'orphan',
    'task_merge',
    'task_ready',
    'task_review',
    'task_stalled',
    'task_waiting',
    'experiment_running',
  ].sort();
  assert.deepEqual(
    keys(),
    active,
    'home records and live nodes appear once; ended work with attention remains active',
  );
  assert.equal(count('Active'), 7);
  assert.equal(count('History'), 1);
  conserved();
  assert.deepEqual(grouped('Needs attention'), ['orphan', 'task_merge', 'task_stalled']);
  assert.deepEqual(grouped('In progress'), ['experiment_running']);
  assert.deepEqual(grouped('In review'), ['task_review']);
  assert.deepEqual(grouped('Waiting'), ['task_waiting']);
  assert.deepEqual(grouped('Planned'), ['task_ready']);
  const stalled = document
    .querySelector('.work-row-title[data-key="work:task_stalled"]')!
    .closest('li')!;
  const alert = stalled.querySelector<HTMLButtonElement>('button[aria-label="Machine offline"]');
  assert.ok(alert, 'the connected worker explains its attention through the alert label');
  assert.equal(alert.title, 'Machine offline');
  assert.equal(document.querySelector('section[aria-label="Other open work"]'), null);
  assert.equal(document.querySelector<HTMLDetailsElement>('details.work-filter-menu')!.open, false);

  await select('Work status', 'attention');
  assert.equal(document.querySelector<HTMLDetailsElement>('details.work-filter-menu')!.open, true);
  assert.deepEqual(keys(), ['orphan', 'task_merge', 'task_stalled']);
  conserved();
  await click('Reset filters');

  await select('Work type', 'tasks');
  assert.deepEqual(
    keys(),
    active.filter((id) => id !== 'experiment_running'),
  );
  assert.deepEqual(grouped('In progress'), []);
  conserved();
  await click('Reset filters');
  await select('Owner', 'mine');
  assert.deepEqual(keys(), ['experiment_running', 'task_ready']);
  assert.deepEqual(grouped('Needs attention'), []);
  conserved();
  await search('calibrated');
  assert.deepEqual(keys(), ['experiment_running'], 'search includes the scientific purpose');
  assert.equal(count('All'), 1);
  conserved();
  await select('Work type', 'tasks');
  assert.deepEqual(keys(), []);
  assert.match(text(), /Nothing matches/);
  conserved();
  await click('Reset filters');
  await select('Cycle', 'cycle_current');
  assert.deepEqual(keys(), ['experiment_running', 'task_ready']);
  conserved();
  await select('Cycle', 'none');
  assert.deepEqual(keys(), ['orphan', 'task_merge', 'task_review', 'task_stalled', 'task_waiting']);
  conserved();
  await click('Reset filters');
  await click('History');
  assert.deepEqual(keys(), ['task_done']);
  conserved();
  await click('Active');
  assert.deepEqual(keys(), active);
  const connectedAlert = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Machine offline"]',
  )!;
  await act(async () => connectedAlert.click());
  await settle();
  assert.deepEqual(f.opened, ['session:session_stalled'], 'the alert opens the attention owner');
  await act(async () =>
    document.querySelector<HTMLButtonElement>('#running-panel button[aria-label="Close"]')!.click(),
  );
  await settle();
  assert.equal(document.activeElement, connectedAlert, 'closing returns focus to the alert');
  await click('Recover archived result');
  assert.deepEqual(f.opened, ['session:session_stalled', 'work:orphan']);
  assert.equal(document.querySelector('#running-panel')!.hasAttribute('hidden'), false);
  assert.equal(document.querySelector('#running-panel-title')!.textContent, 'Recovered inspector');
  assert.match(
    document.querySelector('#running-panel')!.textContent!,
    /Recover the retained evidence before restarting this work/,
  );
  const filters = document.querySelector<HTMLDetailsElement>('details.work-filter-menu')!;
  const filterControl = filters.querySelector('select')!;
  await act(async () => {
    filterControl.focus();
    filterControl.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(filters.open, false);
  assert.equal(document.activeElement, filters.querySelector('summary'));
  assert.equal(
    document.querySelector('#running-panel')!.hasAttribute('hidden'),
    false,
    'dismissing Filter leaves the work inspector open',
  );
});

test('Work keeps available records during partial reads and failed refreshes, then recovers', async (t) => {
  const f = fixture(t);
  serve('/tools/ui.home', { body: { result: { ...f.home, tasks: null } } });
  await f.render();
  assert.match(text(), /Could not refresh/);
  assert.ok(keys().includes('experiment_running'));
  assert.ok(keys().includes('orphan'), 'attention stays visible when catalog data is unavailable');
  assert.doesNotMatch(text(), /No work yet/);
  conserved();
  const previous = keys();
  serve('/tools/ui.home', { network: true });
  serve('/tools/ui.running', { network: true });
  await act(async () => refreshTools('ui.home', 'ui.running'));
  await settle();
  assert.deepEqual(keys(), previous, 'failed polling retains the last available work');
  assert.match(text(), /could not refresh|did not answer/i);
  assert.doesNotMatch(text(), /No work yet/);
  serve('/tools/ui.home', { body: { result: f.home } });
  serve('/tools/ui.running', { body: { result: f.board } });
  await act(async () => refreshTools('ui.home', 'ui.running'));
  await settle();
  assert.equal(count('Active'), 7);
  assert.equal(count('History'), 1);
  conserved();
  assert.doesNotMatch(text(), /Could not read tasks|could not refresh|did not answer/i);
  assert.ok(
    keys().includes('task_review'),
    'the recovered catalog restores work absent from the live board',
  );
});
