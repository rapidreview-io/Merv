/**
 * An open record page keeps what it shows current without redoing work nobody asked for: an
 * ended task is not read again, a running experiment's exhibit is read again only when its
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
const shell = { rows: [row('tasks'), row('experiments')], plugins: [] };
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

test('an ended task’s page reads it once and stops', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', {
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
  });
  await open('/tasks/wf_1', TasksView);
  assert.ok(document.body.textContent!.includes('Reproduce grokking'));
  assert.equal(reads('/tools/ui.read'), 1);
  await settle(8_600);
  assert.equal(reads('/tools/ui.read'), 1, 'an ended task is not read again');
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
