/**
 * A unit of work on the Work page: its card counts while it is worked, and its sidebar draws
 * its stages, then its history beside the one thing to read. Each owner says which artifact
 * that is in which state; the page only draws what it is told, and names no state of any
 * workflow. Each test states one thing a person reading the page relies on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, serve, settle, unmount } from './ui-render.js';
import { board } from './ui-running-fixtures.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
await import('../packages/ui/web/components.js');
const { RunningSidebar } = await import('../packages/ui/web/views/running-panel.js');
const { WorkMap, WorkPlane } = await import('../packages/ui/web/views/work-map.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');
const { taskUnit } = await import('../packages/tasks/src/running.js');
const { experimentUnit } = await import('../packages/experiments/src/running.js');
const { waveUnit } = await import('../packages/reflections/src/running.js');
const { TASK_WORKFLOW } = await import('../packages/tasks/src/workflow.js');
const { EXPERIMENT_WORKFLOW } = await import('../packages/experiments/src/program.js');
const { REFLECTION_WORKFLOW, LENS_WORKFLOW } =
  await import('../packages/reflections/src/definitions.js');

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

const at = (minute: number) => `2026-10-06T12:${String(minute).padStart(2, '0')}:00.000Z`;
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const press = async (element: Element | null | undefined) => {
  assert.ok(element, 'the control is drawn');
  await act(async () => void (element as HTMLElement).click());
  await settle(10);
};
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );

// ─── The panel as an owner sends it ─────────────────────────────────────────────────────

const node = (state: string, current = false) => ({
  state,
  initial: state === 'planned',
  terminal: state === 'complete',
  current,
  entries: 0,
  firstEnteredAt: null,
  blockers: [],
});
const graph = {
  instanceId: 'wf_1',
  workflow: 'experiment',
  version: 1,
  revision: 3,
  state: 'planned',
  currentGate: 'planned',
  terminal: false,
  dependencies: [],
  nodes: [node('planned', true), node('design_review'), node('running'), node('complete')],
  edges: [
    ['planned', 'design_review'],
    ['design_review', 'planned'],
    ['design_review', 'running'],
    ['running', 'complete'],
  ].map(([from, to]) => ({
    from,
    to,
    action: 'act',
    traversals: [],
    status: null,
    tool: null,
    blockers: [],
  })),
};
const visit = (sessionId: string, offeredAt: string) => ({
  sessionId,
  status: 'released',
  offeredAt,
  startedAt: offeredAt,
  endedAt: offeredAt,
  outcome: 'submitted',
  launched: true,
  resumed: false,
  harness: 'claude',
  runnerId: 'mac-studio',
  hasConversation: true,
});
const threads = [
  {
    id: 'thr_plan',
    instanceId: 'wf_1',
    state: 'planned',
    role: 'producer',
    status: 'dormant',
    visits: [visit('ses_p1', at(1))],
  },
  {
    id: 'thr_rev',
    instanceId: 'wf_1',
    state: 'design_review',
    role: 'reviewer',
    status: 'retired',
    visits: [visit('ses_r1', at(6))],
  },
];
/** The owner's history: a design handed in, the verdict that returned it, the return. */
const history = [
  {
    role: 'producer',
    stage: 'planned',
    actor: 'actor_codex',
    at: at(5),
    said: 'Submitted the design',
    artifact: { id: 'art_v1', title: 'plan-v1.md' },
  },
  {
    role: 'reviewer',
    stage: 'design_review',
    actor: 'actor_claude',
    at: at(9),
    verdict: {
      word: 'needs_changes',
      met: 3,
      of: 4,
      text: 'Three seeds cannot separate the effect from noise.',
    },
    review: 'review_1',
  },
  { at: at(9), said: 'Returned to planned' },
];
const panel = (unit: unknown, sections: unknown[] = []) => ({
  key: 'work:wf_1',
  observedAt: new Date().toISOString(),
  header: { kind: 'Experiment', title: 'lr-warmup-ablation', says: ['Waiting for an agent'] },
  sections: [
    { title: 'Stage', place: 'progress', kind: 'ladder', graph },
    ...sections,
    {
      title: 'Code',
      place: 'code',
      kind: 'facts',
      rows: [{ label: 'Branch', value: [{ mono: 'merv/work/wf_1' }] }],
    },
    {
      title: 'Details',
      place: 'details',
      kind: 'facts',
      rows: [{ label: 'Owner', value: [{ actor: 'actor_codex' }] }],
    },
  ],
  actions: [],
  live: false,
  route: '/experiments/wf_1',
  unit,
});
const documents: Record<string, [string, string]> = {
  art_v1: ['plan-v1.md', '# Plan one\nThree seeds per arm.'],
  art_v2: ['plan-v2.md', '# Plan two\nTen seeds per arm, with a power estimate.'],
  art_log: ['run.log', 'step 4000: validation 0.04'],
};
const artifact = (id: string) => ({
  id,
  projectId: 'project_1',
  title: documents[id]![0],
  mediaType: 'text/markdown',
  size: documents[id]![1].length,
  sha256: 'a'.repeat(64),
  createdAt: at(0),
  createdBy: 'actor_codex',
});
const names: Record<string, string> = { actor_codex: 'Codex producer', actor_claude: 'Claude' };

async function sidebar(sent: unknown, full = true, role = 'operator') {
  const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
  const actor = { id: 'actor_me', projectId: project.id, name: 'Me', role };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  serve('/tools/ui.running_panel', { body: { result: sent } });
  serve('/sessions/threads?instanceId=wf_1', { body: { threads } });
  serve('/sessions/threads/thr_plan/conversation', {
    body: {
      threadId: 'thr_plan',
      visits: [
        {
          sessionId: 'ses_p1',
          from: 'transcript',
          events: [
            {
              seq: 1,
              at: at(2),
              event: { kind: 'text', id: 'a', delta: 'Drafted the warmup plan.', done: true },
            },
          ],
        },
      ],
    },
  });
  serve('/sessions/threads/thr_rev/conversation', { body: { threadId: 'thr_rev', visits: [] } });
  serve('/tools/artifact.get', (_, input) => ({
    body: { result: artifact(String(input.artifactId)) },
  }));
  serve('/tools/artifact.read', (_, input) => {
    const id = String(input.artifactId);
    return {
      body: { result: { artifact: artifact(id), content: documents[id]![1], encoding: 'utf8' } },
    };
  });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(
        SessionProvider,
        null,
        createElement(RunningSidebar, {
          target: 'work:wf_1',
          full,
          onFull: () => undefined,
          onClose: () => undefined,
          nameOf: (id: string) => names[id],
          open: () => undefined,
        }),
      ),
    ),
  );
  await settle(30);
}
/** The unit's files as its owner lists them, newest first. */
const files = [
  {
    id: 'art_log',
    title: 'run.log',
    mediaType: 'text/plain',
    size: 26,
    at: at(12),
    stage: 'running',
    role: 'producer',
  },
  {
    id: 'art_v2',
    title: 'plan-v2.md',
    mediaType: 'text/markdown',
    size: 44,
    at: at(10),
    stage: 'planned',
    role: 'producer',
  },
  {
    id: 'art_v1',
    title: 'plan-v1.md',
    mediaType: 'text/markdown',
    size: 27,
    at: at(4),
    stage: 'planned',
    role: 'producer',
  },
];
const reading = () => $('.unit-reading')!;
const label = () => reading().querySelector('.unit-key-label')!.textContent;

test('the reading is the key artifact its owner names, under its label and its state', async (t) => {
  t.after(unmount);
  await sidebar(
    panel({
      key: { label: 'Current plan', state: 'draft', artifact: { id: 'art_v2', title: 'plan.md' } },
      history,
    }),
  );
  assert.equal(label(), 'Current plan');
  assert.match(reading().querySelector('.unit-key-head')!.textContent!, /draft/i);
  assert.match(reading().textContent!, /Ten seeds per arm/);
  // The stages and their agents stand above the two columns, the history on the left.
  assert.ok($('.stage-card .agent-chip'));
  assert.ok($('.unit-columns--wide > .unit-history'));
  // Who did each thing, by name, and what the producer handed in.
  const told = $('.unit-history')!.textContent!;
  assert.match(told, /Codex producer/);
  assert.match(told, /Submitted the design/);
  assert.match(told, /Returned to planned/);
});

test('a review in the history is its verdict and its squares, and its words open on a press', async (t) => {
  t.after(unmount);
  await sidebar(panel({ key: { label: 'Current plan', text: 'Draft to come.' }, history }));
  const verdict = $('.verdict-line')!;
  assert.match(verdict.textContent!, /needs changes/i);
  assert.equal(verdict.querySelector('.met-squares')!.getAttribute('aria-label'), '3 of 4 met');
  assert.equal(verdict.querySelectorAll('.met-square--met').length, 3);
  assert.equal($('.verdict-text'), null, 'the verdict’s words wait for a press');
  await press(verdict);
  assert.equal(
    $('.verdict-text')!.textContent,
    'Three seeds cannot separate the effect from noise.',
  );
});

test('a document in the history takes the reading’s place, and ← Current brings the key back', async (t) => {
  t.after(unmount);
  await sidebar(
    panel({
      key: { label: 'Current plan', state: 'draft', artifact: { id: 'art_v2', title: 'plan.md' } },
      history,
    }),
  );
  const handed = $('.thread-doc')!;
  assert.equal(handed.textContent, 'plan-v1.md');
  await press(handed);
  assert.equal(label(), 'plan-v1.md');
  assert.match(reading().textContent!, /Three seeds per arm/);
  assert.doesNotMatch(reading().textContent!, /Ten seeds per arm/);
  assert.equal(handed.getAttribute('aria-pressed'), 'true');
  await press(button('← Current'));
  assert.equal(label(), 'Current plan');
  assert.match(reading().textContent!, /Ten seeds per arm/);
});

test('an entry’s role mark opens the thread of its stage', async (t) => {
  t.after(unmount);
  await sidebar(panel({ key: { label: 'Current plan', text: 'Draft to come.' }, history }));
  const marks = all('.unit-history .role-mark').map((mark) => mark.textContent);
  assert.deepEqual(marks, ['P', 'R']);
  await press(button('Producer thread'));
  assert.equal($('dialog h2')!.textContent, 'Producer · planned · dormant');
  await press(button('Close'));
  await press(button('Reviewer thread'));
  assert.equal($('dialog h2')!.textContent, 'Reviewer · design review · retired');
});

test('everything but the stages and the reading folds under one closed Details', async (t) => {
  t.after(unmount);
  await sidebar(
    panel({ key: { label: 'Goal', text: 'Remove the leaked equations.' }, history: [] }, [
      {
        title: 'Waits on',
        place: 'relations',
        kind: 'links',
        rows: [{ to: { key: 'work:wf_2' }, kind: 'Task', name: 'Clean the split' }],
      },
    ]),
  );
  const details = $('details.unit-details') as HTMLDetailsElement;
  assert.ok(details && !details.open);
  for (const title of ['Waits on', 'Code', 'Owner', 'merv/work/wf_1'])
    assert.ok(details.textContent!.includes(title), `${title} is under Details`);
  assert.equal(details.querySelector('.stage-card'), null);
  // With no history yet, nothing stands in for it.
  assert.equal($('.unit-history'), null);
  assert.ok($('a[href="/experiments/wf_1"]'), 'Open record stays');
});

test('a task’s checks stand under its reading, met or still open', async (t) => {
  t.after(unmount);
  await sidebar(
    panel({
      key: { label: 'Goal', text: 'Remove the leaked equations.' },
      checks: [{ text: 'No held-out equation in training', met: true }, { text: 'Sizes recorded' }],
      history: [],
    }),
  );
  const checks = all('.unit-checks li').map((item) => item.textContent);
  assert.deepEqual(checks, ['✓No held-out equation in training', '○Sizes recorded']);
  assert.match($('.unit-checks .running-aside')!.textContent!, /1 of 2/);
});

test('what needs a person is one line with its move at the head of the reading', async (t) => {
  t.after(unmount);
  const sent = panel({ key: { label: 'Current plan', text: 'Draft.' }, history });
  sent.header = {
    ...sent.header,
    says: ['Out of review rounds'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attention: {
      says: ['Out of review rounds'],
      who: 'An operator allows another round',
      to: { route: '/reviews/review_1', text: 'Open the review' },
    },
  } as never;
  await sidebar(sent);
  const ask = reading().querySelector('.unit-ask')!;
  assert.match(ask.textContent!, /An operator allows another round/);
  assert.match(ask.textContent!, /Open the review/);
  // The head keeps the line itself, and says the rest once, in the reading.
  assert.doesNotMatch($('.running-panel-head')!.textContent!, /An operator allows/);
});

// ─── The reading's tabs ─────────────────────────────────────────────────────────────────

const tabs = () => all('.unit-tabs button').map((item) => item.textContent);
const tab = (name: string) =>
  all('.unit-tabs button').find((item) => item.textContent!.startsWith(name));
const unitOf = () => ({
  key: { label: 'Current plan', state: 'draft', artifact: { id: 'art_v2', title: 'plan.md' } },
  history,
  artifacts: files,
});

test('the reading opens on its document, and its tabs count its agents and its files', async (t) => {
  t.after(unmount);
  t.after(() => localStorage.clear());
  localStorage.clear();
  await sidebar(panel(unitOf()));
  assert.deepEqual(tabs(), ['Document', 'Agents2', 'Artifacts3']);
  assert.equal(tab('Document')!.getAttribute('aria-pressed'), 'true');
  assert.equal(label(), 'Current plan');
  assert.match(reading().textContent!, /Ten seeds per arm/);
  // Nothing in the default view is an id.
  assert.doesNotMatch($('.unit-columns')!.textContent!, /art_|thr_|ses_|wf_1/);
});

test('the tab chosen is kept for the kind, and a kind without one reads its document', async (t) => {
  t.after(unmount);
  t.after(() => localStorage.clear());
  localStorage.clear();
  await sidebar(panel(unitOf()));
  await press(tab('Artifacts'));
  assert.equal(localStorage.getItem('merv:unit-tab:experiment'), 'artifacts');
  await unmount();
  await sidebar(panel(unitOf()));
  assert.equal(tab('Artifacts')!.getAttribute('aria-pressed'), 'true');
  assert.ok($('.unit-row--file'));
  await unmount();
  const task = panel(unitOf());
  task.header = { ...task.header, kind: 'Task' };
  await sidebar(task);
  assert.equal(tab('Document')!.getAttribute('aria-pressed'), 'true');
  // A unit whose owner lists no files has no Artifacts tab, and its remembered one reads the document.
  await unmount();
  await sidebar(panel({ ...unitOf(), artifacts: undefined }));
  assert.deepEqual(tabs(), ['Document', 'Agents2']);
  assert.equal(label(), 'Current plan');
});

test('a browser that keeps nothing still opens on the document and switches tabs', async (t) => {
  t.after(unmount);
  const storage = Object.getPrototypeOf(localStorage);
  const { getItem, setItem } = storage;
  storage.getItem = () => {
    throw new Error('blocked');
  };
  storage.setItem = () => {
    throw new Error('blocked');
  };
  t.after(() => Object.assign(storage, { getItem, setItem }));
  await sidebar(panel(unitOf()));
  assert.equal(tab('Document')!.getAttribute('aria-pressed'), 'true');
  await press(tab('Agents'));
  assert.equal(tab('Agents')!.getAttribute('aria-pressed'), 'true');
});

test('Agents lists every thread by stage in stage order, and reads one in place', async (t) => {
  t.after(unmount);
  t.after(() => localStorage.clear());
  localStorage.clear();
  await sidebar(panel(unitOf()));
  await press(tab('Agents'));
  const groups = all('.unit-group').map((group) => [
    group.querySelector('.unit-group-head')!.textContent,
    [...group.querySelectorAll('.unit-row')].map((row) =>
      [...row.children].map((cell) => cell.textContent).slice(0, 5),
    ),
  ]);
  assert.deepEqual(groups, [
    ['Planned', [['P', 'Producer', 'planned', 'dormant', '1 visit']]],
    ['Design review', [['R', 'Reviewer', 'design review', 'retired', '1 visit']]],
  ]);
  assert.ok(all('.unit-row--agent time').length === 2, 'each row says when it was last active');
  await press(button('Producer · planned · dormant'));
  assert.equal($('dialog[open]'), null, 'no dialog opens');
  await settle(30);
  assert.match(reading().textContent!, /Drafted the warmup plan\./);
  assert.match(reading().querySelector('.unit-key-label')!.textContent!, /Producer · planned/);
  await press(button('← Agents'));
  assert.equal(all('.unit-row--agent').length, 2);
});

test('Agents also lists the threads of the records its owner names inside the unit', async (t) => {
  t.after(unmount);
  t.after(() => localStorage.clear());
  localStorage.clear();
  // A wave's lens is a record of its own: its agents are read by its own id.
  serve('/sessions/threads?instanceId=wf_lens', {
    body: {
      threads: [
        {
          id: 'thr_lens',
          instanceId: 'wf_lens',
          state: 'reflecting',
          role: 'producer',
          status: 'live',
          visits: [visit('ses_l1', at(3))],
        },
      ],
    },
  });
  await sidebar(panel({ ...unitOf(), instances: ['wf_lens'] }));
  assert.deepEqual(tabs(), ['Document', 'Agents3', 'Artifacts3']);
  await press(tab('Agents'));
  assert.deepEqual(
    all('.unit-group-head').map((head) => head.textContent),
    ['Planned', 'Design review', 'Reflecting'],
  );
});

test('a reader who is not an operator reads a thread’s visits in place, never its conversation', async (t) => {
  t.after(unmount);
  t.after(() => localStorage.clear());
  localStorage.setItem('merv:unit-tab:experiment', 'agents');
  await sidebar(panel(unitOf()), true, 'reader');
  await press(button('Producer · planned · dormant'));
  assert.ok(reading().querySelector('[aria-label="Visits"]'));
  assert.equal(button('Conversation'), undefined);
});

test('Artifacts lists the unit’s files newest first, and previews one in place', async (t) => {
  t.after(unmount);
  t.after(() => localStorage.clear());
  localStorage.clear();
  await sidebar(panel(unitOf()));
  await press(tab('Artifacts'));
  const rows = all('.unit-row--file').map((row) => [
    row.querySelector('.unit-row-name')!.textContent,
    row.querySelector('.unit-row-by')!.textContent,
  ]);
  assert.deepEqual(rows, [
    ['run.log', 'Prunning'],
    ['plan-v2.md', 'Pplanned'],
    ['plan-v1.md', 'Pplanned'],
  ]);
  assert.match(all('.unit-row--file')[1]!.textContent!, /44 B/);
  await press(all('.unit-row--file')[2]);
  assert.match(reading().textContent!, /Three seeds per arm/);
  assert.equal($('.unit-row--file'), null);
  await press(button('← Artifacts'));
  assert.equal(all('.unit-row--file').length, 3);
});

test('a history document read from another tab opens in Document, and ← Current comes back', async (t) => {
  t.after(unmount);
  t.after(() => localStorage.clear());
  localStorage.clear();
  await sidebar(panel(unitOf()));
  await press(tab('Artifacts'));
  await press($('.thread-doc'));
  assert.equal(tab('Document')!.getAttribute('aria-pressed'), 'true');
  assert.equal(label(), 'plan-v1.md');
  await press(button('← Current'));
  assert.equal(label(), 'Current plan');
});

// ─── The card's clock ───────────────────────────────────────────────────────────────────

test('a card counts the time since its work began only while a visit works it', async (t) => {
  t.after(unmount);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    constructor(private ran: (entries: { contentRect: { width: number } }[]) => void) {}
    observe() {
      this.ran([{ contentRect: { width: 1200 } }]);
    }
    disconnect() {}
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t.after(() => delete (globalThis as any).ResizeObserver);
  const now = Date.now();
  const given = board(now);
  const started = new Date(now - 754_000).toISOString();
  for (const item of given.lanes.work.nodes)
    if (item.key === 'work:wf_index' || item.key === 'work:wf_review') item.started = started;
  serve('/tools/ui.running', { body: { result: given } });
  const flow = (state: string) => ({ state, updatedAt: at(0), workflow: 'task', version: 6 });
  const wave = {
    items: ['wf_index', 'wf_review'].map((id) => ({
      id,
      kind: 'tasks',
      name: id,
      flow: flow('in_progress'),
      at: at(0),
      held: true,
    })),
    edges: [],
  };
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/work'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(
        WorkPlane as any,
        { nameOf: () => undefined },
        createElement(WorkMap as any, { wave }),
      ),
    ),
  );
  await settle(20);
  const timer = (key: string) => $(`[data-key="${key}"] .wmap-timer`);
  // Worked now (the board lends it a moving dot): 12 minutes and some seconds, in tabular figures.
  assert.match(timer('work:wf_index')!.textContent!, /^12m 3[4-9]s$/);
  assert.ok(timer('work:wf_index')!.classList.contains('tabular'));
  // Waiting on its prerequisite, nobody on it: nothing new on the card.
  assert.equal(timer('work:wf_review'), null);
});

// ─── What each owner names as the key artifact ─────────────────────────────────────────

const review = (over: Record<string, unknown>) => ({
  id: 'review_1',
  subjectId: 'wf_1',
  subjectRevision: 2,
  artifactIds: [],
  criteria: ['one', 'two'],
  findings: [],
  status: 'submitted',
  verdict: null,
  reviewerId: 'actor_claude',
  synopsis: null,
  notes: null,
  createdAt: at(5),
  ...over,
});
const crossing = (from: string, to: string, revision: number, minute: number) => ({
  from,
  to,
  action: `${from}_${to}`,
  status: null,
  tool: null,
  blockers: [],
  traversals: [{ revision, actorId: 'actor_codex', requestId: `r${revision}`, at: at(minute) }],
});
const process = (state: string, edges: ReturnType<typeof crossing>[], states: string[]) => ({
  ...graph,
  workflow: 'unit',
  state,
  nodes: states.map((each) => node(each, each === state)),
  edges,
});

test('a task reads its goal and open checks, then what it delivered with each check as judged', () => {
  const task = {
    id: 'wf_1',
    goal: 'Remove the leaked equations.',
    briefId: 'art_brief',
    acceptanceChecks: [
      { number: 1, text: 'No leak' },
      { number: 2, text: 'Sizes recorded' },
    ],
    deliveryIds: [] as string[],
    deliveryConfirmations: [] as { checkNumber: number; status: string; evidenceIds: string[] }[],
  };
  const states = ['in_progress', 'in_review', 'done'];
  const before = taskUnit(
    task as never,
    process('in_progress', [], states) as never,
    [],
    new Map(),
  );
  assert.deepEqual(before.key, { label: 'Goal', text: 'Remove the leaked equations.' });
  assert.deepEqual(
    before.checks!.map((check) => check.met),
    [undefined, undefined],
  );

  const delivered = process('in_review', [crossing('in_progress', 'in_review', 2, 5)], states);
  const pinned = new Map([
    ['art_brief', { id: 'art_brief', title: 'Brief', mediaType: 'text/markdown' }],
    ['art_code', { id: 'art_code', title: 'Commit', mediaType: 'application/json' }],
    ['art_report', { id: 'art_report', title: 'Delivery', mediaType: 'text/markdown' }],
  ]);
  const open = review({
    status: 'requested',
    artifactIds: ['art_brief', 'art_code', 'art_report'],
  });
  const claimed = {
    ...task,
    deliveryConfirmations: [
      { checkNumber: 1, status: 'met', evidenceIds: ['art_report'] },
      { checkNumber: 2, status: 'met', evidenceIds: [] },
    ],
  };
  const inReview = taskUnit(claimed as never, delivered as never, [open] as never, pinned);
  assert.deepEqual(inReview.key, {
    label: 'Delivery',
    state: 'in_review',
    artifact: { id: 'art_report', title: 'Delivery' },
  });
  assert.deepEqual(
    inReview.checks!.map((check) => check.met),
    [true, true],
  );
  // The verdict, not the claim, says which checks were met once there is one.
  const judged = review({
    artifactIds: ['art_brief', 'art_report'],
    verdict: 'needs_changes',
    findings: [
      { criterionNumber: 1, status: 'met' },
      { criterionNumber: 2, status: 'not_met' },
    ],
  });
  const returned = process(
    'in_progress',
    [crossing('in_progress', 'in_review', 2, 5), crossing('in_review', 'in_progress', 3, 9)],
    states,
  );
  const back = taskUnit(claimed as never, returned as never, [judged] as never, pinned);
  assert.equal(back.key!.state, 'needs_changes');
  assert.deepEqual(
    back.checks!.map((check) => check.met),
    [true, false],
  );
  assert.deepEqual(
    back.history!.map((entry) => entry.said ?? entry.verdict?.word),
    ['Delivered', 'needs_changes', 'Returned to in progress'],
  );
  assert.deepEqual(back.history![0]!.artifact, { id: 'art_report', title: 'Delivery' });
});

test('an experiment reads its draft or newest design, its approved design while running, then its report', () => {
  const states = ['planned', 'design_review', 'running', 'experiment_review', 'complete'];
  const evidence = (id: string, role: string, path: string, attemptIndex = 2) => ({
    id: `ev_${id}`,
    artifactId: id,
    role,
    path,
    attemptIndex,
    current: true,
  });
  const submission = (
    id: string,
    stage: string,
    reviewId: string,
    item: { attemptIndex: number },
    minute: number,
  ) => ({
    id,
    stage,
    reviewId,
    attemptIndex: item.attemptIndex,
    evidence: [item],
    createdAt: at(minute),
  });
  const experiment = (state: string, submissions: unknown[], drafts: unknown[] = []) => ({
    id: 'wf_1',
    intent: 'Does warmup move the grokking step?',
    workflow: { state },
    attempt: { index: 2 },
    evidence: drafts,
    submissions,
  });
  const unit = (record: unknown, state: string, reviews: unknown[] = []) =>
    experimentUnit(record as never, process(state, [], states) as never, reviews as never).key;

  assert.deepEqual(unit(experiment('planned', []), 'planned'), {
    label: 'Question',
    text: 'Does warmup move the grokking step?',
  });
  assert.deepEqual(
    unit(experiment('planned', [], [evidence('art_draft', 'plan', 'plans/plan.md', 2)]), 'planned'),
    { label: 'Current plan', state: 'draft', artifact: { id: 'art_draft', title: 'plan.md' } },
  );
  const design = submission('s1', 'design', 'rv1', evidence('art_v1', 'plan', 'plan.md', 1), 4);
  const returned = review({ id: 'rv1', verdict: 'needs_changes' });
  // A design returned began a new attempt: its plan is the new draft, the returned one history.
  assert.deepEqual(unit(experiment('planned', [design]), 'planned', [returned]), {
    label: 'Question',
    text: 'Does warmup move the grokking step?',
  });
  assert.deepEqual(
    unit(
      experiment('planned', [design], [evidence('art_draft', 'plan', 'plans/plan.md')]),
      'planned',
      [returned],
    ),
    { label: 'Current plan', state: 'draft', artifact: { id: 'art_draft', title: 'plan.md' } },
  );
  const submitted = submission('s1b', 'design', 'rv1b', evidence('art_v1b', 'plan', 'plan.md'), 6);
  assert.equal(
    unit(experiment('design_review', [design, submitted]), 'design_review', [
      returned,
      review({ id: 'rv1b', verdict: null, status: 'started' }),
    ])!.state,
    'in_review',
  );
  const approved = submission('s2', 'design', 'rv2', evidence('art_v2', 'plan', 'plan-2.md'), 8);
  assert.deepEqual(
    unit(experiment('running', [design, approved]), 'running', [
      returned,
      review({ id: 'rv2', verdict: 'pass' }),
    ]),
    { label: 'Current plan', state: 'approved', artifact: { id: 'art_v2', title: 'plan-2.md' } },
  );
  const results = submission(
    's3',
    'results',
    'rv3',
    evidence('art_rep', 'report', 'report.md'),
    12,
  );
  for (const state of ['experiment_review', 'complete'])
    assert.deepEqual(
      unit(experiment(state, [approved, results]), state, [
        review({ id: 'rv2', verdict: 'pass' }),
        review({
          id: 'rv3',
          ...(state === 'complete' ? { verdict: 'pass' } : { status: 'started' }),
        }),
      ]),
      {
        label: 'Report',
        state: state === 'complete' ? 'pass' : 'in_review',
        artifact: { id: 'art_rep', title: 'report.md' },
      },
    );
});

test('an experiment lists its files newest first, each under the stage and role that made it', () => {
  const states = ['planned', 'design_review', 'running', 'experiment_review', 'complete'];
  const graph = process(
    'experiment_review',
    [
      crossing('planned', 'design_review', 1, 5),
      crossing('design_review', 'running', 2, 9),
      crossing('running', 'experiment_review', 3, 20),
    ],
    states,
  );
  const file = (id: string, minute: number, mediaType = 'text/markdown') => ({
    id,
    title: `${id}.md`,
    mediaType,
    size: 100 + minute,
    createdAt: at(minute),
  });
  const evidence = (artifactId: string, role: string, systemGenerated = false) => ({
    artifactId,
    role,
    path: `${role}.md`,
    figureIds: [],
    sessionId: null,
    systemGenerated,
    current: true,
    attemptIndex: 1,
  });
  const experiment = {
    id: 'wf_1',
    intent: 'Does warmup move the grokking step?',
    workflow: { state: 'experiment_review' },
    attempt: { index: 1 },
    evidence: [evidence('plan', 'plan'), evidence('report', 'report')],
    submissions: [
      {
        stage: 'results',
        reviewId: 'rv1',
        createdAt: at(20),
        sessionId: 'ses_run',
        figureIds: [],
        evidence: [evidence('exhibit', 'exhibit', true)],
      },
    ],
  };
  const reviewed = review({
    id: 'rv1',
    findings: [{ criterionNumber: 1, status: 'met', evidenceIds: ['plan', 'check'] }],
  });
  const found = new Map(
    [
      file('plan', 3),
      file('report', 18),
      file('exhibit', 20, 'application/json'),
      file('check', 22),
    ].map((item) => [item.id, item]),
  );
  const unit = experimentUnit(experiment as never, graph as never, [reviewed] as never, {
    found,
    made: [file('log', 12, 'text/plain'), file('report', 18)],
  });
  assert.deepEqual(
    unit.artifacts!.map((item) => [item.title, item.stage, item.role]),
    [
      ['check.md', 'experiment_review', 'reviewer'],
      ['exhibit.md', 'running', undefined],
      ['report.md', 'running', 'producer'],
      ['log.md', 'running', 'producer'],
      ['plan.md', 'planned', 'producer'],
    ],
  );
  assert.deepEqual(unit.artifacts![0], {
    id: 'check',
    title: 'check.md',
    mediaType: 'text/markdown',
    size: 122,
    at: at(22),
    stage: 'experiment_review',
    role: 'reviewer',
  });
});

test('a task lists its brief, its delivery and what its delivering session made', () => {
  const states = ['in_progress', 'in_review', 'done'];
  const graph = process('in_review', [crossing('in_progress', 'in_review', 2, 5)], states);
  const file = (id: string, minute: number) => ({
    id,
    title: id,
    mediaType: 'text/markdown',
    size: 10,
    createdAt: at(minute),
  });
  const task = {
    id: 'wf_1',
    goal: 'Remove the leaked equations.',
    briefId: 'brief',
    deliveryIds: ['report'],
    deliveryCodeArtifactId: 'commit',
    deliveryCode: { sessionId: 'ses_work' },
    acceptanceChecks: [{ number: 1, text: 'No leak' }],
    deliveryConfirmations: [{ checkNumber: 1, status: 'met', evidenceIds: ['report'] }],
  };
  const open = review({ status: 'requested', artifactIds: ['brief', 'commit', 'report'] });
  const artifacts = new Map(
    [file('brief', 0), file('commit', 5), file('report', 4)].map((item) => [item.id, item]),
  );
  const unit = taskUnit(task as never, graph as never, [open] as never, artifacts, [
    file('audit', 2),
  ]);
  assert.deepEqual(
    unit.artifacts!.map((item) => [item.id, item.stage, item.role]),
    [
      ['commit', 'in_progress', 'producer'],
      ['report', 'in_progress', 'producer'],
      ['audit', 'in_progress', 'producer'],
      ['brief', 'in_progress', undefined],
    ],
  );
});

test('a reflection reads its lenses, then its synthesis, then the next wave’s plan item by item', () => {
  const states = ['reflecting', 'synthesizing', 'in_review', 'approved'];
  const lens = (id: string, perspective: string, report?: string) => ({
    id,
    perspective,
    producerId: 'actor_codex',
    workflow: { state: report ? 'complete' : 'reflecting' },
    artifact: report ? { id: report, title: `${perspective} report`, createdAt: at(3) } : null,
  });
  const wave = (state: string, over: Record<string, unknown> = {}) => ({
    wave: {
      id: 'wf_1',
      workflow: { state },
      lenses: [lens('l1', 'evidence', 'art_l1'), lens('l2', 'data_quality')],
      review: null,
      report: null,
      changeSpec: null,
      plan: null,
      ...over,
    },
    leases: [],
    exhausted: false,
  });
  const keyOf = (facts: unknown, state: string) =>
    waveUnit(facts as never, process(state, [], states) as never).key!;
  assert.deepEqual(keyOf(wave('reflecting'), 'reflecting'), {
    label: 'Lenses',
    parts: [
      {
        title: 'Evidence',
        state: 'submitted',
        actor: 'actor_codex',
        artifact: { id: 'art_l1', title: 'evidence report' },
      },
      { title: 'Data quality', actor: 'actor_codex' },
    ],
  });
  const report = { id: 'art_syn', title: 'Synthesis' };
  assert.deepEqual(
    keyOf(wave('in_review', { report, review: { status: 'started', verdict: null } }), 'in_review'),
    { label: 'Synthesis', state: 'in_review', artifact: report },
  );
  const plan = {
    next: { decision: 'continue' },
    items: [
      { key: 'seeds', kind: 'task', title: 'Pin ten seeds', dependsOn: [] },
      { key: 'warmup', kind: 'experiment', name: 'warmup-v2', dependsOn: ['seeds'] },
    ],
  };
  assert.deepEqual(keyOf(wave('approved', { report, plan }), 'approved'), {
    label: 'Next-wave plan',
    state: 'continue',
    items: [
      { key: 'seeds', kind: 'task', title: 'Pin ten seeds', dependsOn: [] },
      { key: 'warmup', kind: 'experiment', title: 'warmup-v2', dependsOn: ['seeds'] },
    ],
  });
  // The lens's report is the history's, its disc the way to the lens's own thread.
  const lensEntry = waveUnit(
    wave('reflecting') as never,
    process('reflecting', [], states) as never,
  ).history![0]!;
  assert.deepEqual(
    [lensEntry.role, lensEntry.stage, lensEntry.instance, lensEntry.artifact?.id],
    ['producer', 'reflecting', 'l1', 'art_l1'],
  );
});

test('the unit’s page names no state of any workflow: every word of one is its owner’s', () => {
  const states = new Set(
    [TASK_WORKFLOW, EXPERIMENT_WORKFLOW, REFLECTION_WORKFLOW, LENS_WORKFLOW].flatMap(
      (definition) => definition.states,
    ),
  );
  for (const file of ['views/unit.tsx', 'thread.tsx', 'views/threads.tsx']) {
    const source = readFileSync(new URL(`../packages/ui/web/${file}`, import.meta.url), 'utf8');
    const quoted = [...source.matchAll(/['"`]([a-z_]+)['"`]/g)].map((match) => match[1]!);
    const named = quoted.filter((word) => states.has(word));
    assert.deepEqual(named, [], `${file} names ${named.join(', ')}`);
  }
});
