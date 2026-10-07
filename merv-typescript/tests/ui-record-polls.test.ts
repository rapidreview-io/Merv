/**
 * An open record page keeps what it shows current without redoing work nobody asked for: no
 * page runs an action's check it does not draw, an ended cycle or wave is not read again, an
 * ended task or experiment is read again only slowly, for its Code section, a running experiment's exhibit is read again only when its
 * evidence changed, and an attempt shows its own figures, never an earlier attempt's.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, requests, serve, settle, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter, Route, Routes } = await import('react-router-dom');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { TasksView } = await import('../packages/ui/web/views/tasks.js');
const { ExperimentsView } = await import('../packages/ui/web/views/experiments.js');
const { ResearchView } = await import('../packages/ui/web/views/research.js');
const { ReflectionsView } = await import('../packages/ui/web/views/research-programs.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');

const now = new Date().toISOString();
const row = (id: string) => ({
  id,
  label: id,
  group: 'work',
  order: 1,
  path: `/${id}`,
  view: { kind: id },
  readable: true,
});
const shell = {
  rows: [row('tasks'), row('experiments'), row('research'), row('reflections')],
  plugins: [],
};
const graph = (state: string, terminal: boolean) => ({
  instanceId: 'wf_1',
  workflow: 'x',
  version: 1,
  revision: 3,
  state,
  currentGate: state,
  terminal,
  dependencies: [],
  nodes: [
    {
      state,
      initial: true,
      terminal,
      current: true,
      entries: 1,
      firstEnteredAt: now,
      blockers: [],
    },
  ],
  edges: [],
});
async function open(path: string, view: unknown) {
  const project = { id: 'project_1', name: 'Grokking', createdAt: now };
  const actor = { id: 'actor_me', projectId: project.id, name: 'Me', role: 'reader' };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        SessionProvider,
        null,
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: `/${path.split('/')[1]}/*`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            element: createElement(view as any, { row: row(path.split('/')[1]!), shell }),
          }),
        ),
      ),
    ),
  );
  await settle(20);
}
const reads = (path: string) => requests.filter((request) => request === `POST ${path}`).length;

const endedTask = {
  body: {
    result: {
      task: {
        id: 'wf_1',
        title: 'Reproduce grokking',
        goal: 'Show the curve.',
        checks: ['The curve is attached'],
        deliveryConfirmations: [],
        producerId: 'actor_1',
        briefId: 'art_00000000000000000000000000000001',
        deliveryIds: [],
        reviewId: null,
        workflow: { state: 'done', revision: 3, updatedAt: now },
        failure: null,
        dependencies: [],
        dependents: [],
        createdAt: now,
      },
      process: graph('done', true),
      codeUnit: null,
    },
  },
};

test('an ended task’s page is not read again at the open cadence', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', endedTask);
  await open('/tasks/wf_1', TasksView);
  assert.ok(document.body.textContent!.includes('Reproduce grokking'));
  assert.equal(reads('/tools/ui.read'), 1);
  await settle(8_600);
  assert.equal(reads('/tools/ui.read'), 1, 'an ended task is not read at the open cadence');
});

test('an ended task’s page still refreshes, slowly: its Code section can change after it ends', async (t) => {
  t.after(unmount);
  // Every wait the page sets, by its length.
  const waits: number[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    return real(handler, ms);
  }) as typeof setTimeout;
  t.after(() => void (globalThis.setTimeout = real));
  serve('/tools/ui.read', endedTask);
  await open('/tasks/wf_1', TasksView);
  await settle(20);
  assert.ok(
    waits.some((ms) => ms > 30_000 && ms <= 60_000),
    `a slow cadence stands for the ended task: ${waits.filter((ms) => ms > 1000).join(', ')}`,
  );
});

const evidence = (id: string, attemptIndex = 2) => ({
  id,
  experimentId: 'wf_1',
  attemptIndex,
  role: 'result',
  path: `${id}.json`,
  artifactId: `art_${id}`,
  hash: 'abc',
  figureIds: [],
  createdBy: 'actor_1',
  sessionId: null,
  createdAt: now,
  sequence: 1,
  current: true,
});
const experiment = (ids: string[]) => ({
  id: 'wf_1',
  projectId: 'project_1',
  name: 'grokking',
  intent: 'Does weight decay matter?',
  details: '',
  ownerId: 'actor_1',
  createdBy: 'actor_1',
  createdAt: now,
  workflow: { state: 'running', revision: 9, updatedAt: now },
  settled: false,
  failed: false,
  attempt: { index: 2, startedRevision: 7, endedRevision: null, feedback: [] },
  attempts: [],
  evidence: ids.map((id) => evidence(id)),
  // The first attempt's results review sent it back to planning with its figure.
  submissions: [
    {
      id: 'sub_1',
      attemptIndex: 1,
      stage: 'results',
      round: 1,
      subjectRevision: 5,
      producerId: 'actor_1',
      sessionId: null,
      evidence: [],
      figureIds: ['art_old_figure'],
      manifestHash: 'h',
      reviewId: 'review_1',
      createdAt: now,
    },
  ],
  reviewId: null,
  conclusion: null,
});

test('an ended experiment’s page still refreshes, slowly: its accepted code can be published later', async (t) => {
  t.after(unmount);
  const waits: number[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    return real(handler, ms);
  }) as typeof setTimeout;
  t.after(() => void (globalThis.setTimeout = real));
  serve('/tools/ui.read', {
    body: {
      result: {
        experiment: {
          ...experiment([]),
          workflow: { state: 'complete', revision: 12, updatedAt: now },
          settled: true,
        },
        process: graph('complete', true),
        codeUnit: null,
      },
    },
  });
  serve('/tools/review.list', { body: { result: [] } });
  await open('/experiments/wf_1', ExperimentsView);
  await settle(20);
  assert.ok(document.body.textContent!.includes('grokking'));
  assert.ok(
    waits.some((ms) => ms > 30_000 && ms <= 60_000),
    `a slow cadence stands for the ended experiment: ${waits.filter((ms) => ms > 1000).join(', ')}`,
  );
});

test('an experiment sent back to planning shows its new attempt’s figures, not the last one’s', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', {
    body: {
      result: {
        experiment: experiment(['ev_1']),
        process: graph('running', false),
        codeUnit: null,
      },
    },
  });
  serve('/tools/review.list', { body: { result: [] } });
  await open('/experiments/wf_1', ExperimentsView);
  assert.ok(document.body.textContent!.includes('Does weight decay matter?'));
  // This attempt submitted nothing yet: the figure the earlier attempt submitted is not its own.
  assert.ok(
    ![...document.querySelectorAll('.ev-role')].some((band) => band.textContent === 'figures'),
  );
  assert.ok(!requests.some((request) => request.includes('art_old_figure')));
});

test('a running experiment reads its exhibit again only when its evidence changed', async (t) => {
  t.after(unmount);
  // The record's evidence is the same on the second read and grows on the third.
  serve('/tools/ui.read', (call) => ({
    body: {
      result: {
        experiment: experiment(call < 3 ? ['ev_1'] : ['ev_1', 'ev_2']),
        process: graph('running', false),
        codeUnit: null,
      },
    },
  }));
  serve('/tools/review.list', { body: { result: [] } });
  serve('/tools/experiment.exhibit', {
    body: {
      result: {
        experimentId: 'wf_1',
        attemptIndex: 2,
        path: 'experiments/grokking/metrics_exhibit.json',
        content: '{}',
        hash: 'h',
        willPin: false,
        sources: [],
        startedAt: now,
      },
    },
  });
  await open('/experiments/wf_1', ExperimentsView);
  assert.equal(reads('/tools/experiment.exhibit'), 1);
  await settle(8_600);
  assert.equal(reads('/tools/ui.read'), 2);
  assert.equal(reads('/tools/experiment.exhibit'), 1, 'the same evidence, the same exhibit');
  await settle(8_600);
  assert.equal(reads('/tools/ui.read'), 3);
  assert.equal(reads('/tools/experiment.exhibit'), 2, 'new evidence, a new exhibit');
});

const ended = {
  research: {
    record: {
      id: 'wf_1',
      name: 'Grokking cycle',
      ownerId: 'actor_1',
      workflow: { workflow: 'research', state: 'complete', revision: 9, updatedAt: now },
      researchDependencies: [],
      reflectionId: null,
      integrations: [],
      writable: false,
      automation: null,
    },
    process: graph('complete', true),
  },
  reflections: {
    reflection: {
      id: 'wf_1',
      title: 'Grokking wave',
      attempt: 1,
      ownerId: 'actor_1',
      createdAt: now,
      workflow: { workflow: 'reflection', state: 'approved', revision: 7, updatedAt: now },
      lenses: [],
      report: null,
      changeSpec: null,
      plan: null,
      review: null,
    },
    process: graph('approved', true),
  },
};
for (const [kind, view, name] of [
  ['research', ResearchView, 'Grokking cycle'],
  ['reflections', ReflectionsView, 'Grokking wave'],
] as const)
  test(`an ended ${kind} record’s page reads once, and runs no action’s check`, async (t) => {
    t.after(unmount);
    serve('/tools/ui.read', { body: { result: ended[kind] } });
    await open(`/${kind}/wf_1`, view);
    assert.ok(document.body.textContent!.includes(name));
    assert.equal(reads('/tools/ui.read'), 1);
    await settle(8_600);
    assert.equal(reads('/tools/ui.read'), 1, 'an ended record is not read again');
    for (const tool of ['workflow.process', 'research.get', 'reflection.get'])
      assert.equal(reads(`/tools/${tool}`), 0, `${tool} is not read`);
  });
