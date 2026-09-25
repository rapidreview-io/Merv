/**
 * The verdict desk. A rejection goes where its reviewer sends it: every route the owning
 * domain accepts is offered on the desk, and only those.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { ReviewDetail } = await import('../packages/ui/web/views/reviews.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');

const REPORT = 'art_00000000000000000000000000000001';
const claimed = {
  id: 'review_1',
  subjectId: 'wf_wave',
  subjectRevision: 7,
  artifactIds: [REPORT],
  criteria: ['The synthesis reconciles the lenses.'],
  formatVersion: 2,
  status: 'started',
  reviewerId: 'actor_b',
  claimId: 'claim_1',
  verdict: null,
  notes: null,
  synopsis: null,
  findings: [],
  createdAt: new Date().toISOString(),
};
const desk = (workflow: string, state: string) => ({
  instanceId: 'wf_wave',
  workflow,
  version: 3,
  state,
  revision: 7,
  label: 'Wave',
  terminal: false,
  available: true,
  currentGate: state,
  nextAction: null,
  instruction: '',
  actions: [
    {
      action: 'submit_review',
      tool: 'review.submit',
      status: 'needs_input',
      arguments: { reviewId: 'review_1', claimId: 'claim_1', expectedRevision: 7 },
      blockers: [],
      instruction: '',
    },
  ],
  blockers: [],
  providerBlockers: [],
  references: [],
  dependencies: [],
  limits: [],
  workStart: null,
});
const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
const actor = { id: 'actor_b', projectId: project.id, name: 'Reviewer', role: 'reviewer' };
const page = () => {
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  return createElement(
    MemoryRouter,
    { initialEntries: ['/reviews/review_1'] },
    createElement(
      SessionProvider,
      null,
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/reviews/:id', element: createElement(ReviewDetail) }),
      ),
    ),
  );
};
const write = async (field: HTMLTextAreaElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  await act(async () => {
    set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle(0);
};
/** Answer the one criterion and the synopsis, then choose a rejection. */
const reject = async () => {
  await click('not met');
  await write(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes on check 1"]')!,
    'The methods disagreement is not resolved.',
  );
  await write(
    [...document.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Synopsis'))!
      .querySelector('textarea')!,
    'The synthesis reconciles the lenses but does not say how the methods disagreement was resolved.',
  );
  await click('needs changes');
};

/** The desk of one gate, answered and rejected: the routes it offers, and what it sends. */
const rejected = async (workflow: string, state: string) => {
  const submitted: { body?: Record<string, unknown> } = {};
  serve('/tools/review.get', { body: { result: claimed } });
  serve('/tools/workflow.status_and_next', { body: { result: desk(workflow, state) } });
  serve('/tools/review.submit', (_, body) => {
    submitted.body = body;
    return { body: { result: { id: 'review_1' } } };
  });
  await mount(page());
  await settle(10);
  await reject();
  const routes = [...document.querySelectorAll('button[aria-pressed]')]
    .map((button) => button.textContent)
    .filter((label) => label?.includes(','));
  return { routes, submitted };
};

test('a reflection rejection is sent back to synthesis or to five new lenses, as its reviewer chooses', async (t) => {
  t.after(async () => await unmount());
  const { routes, submitted } = await rejected('reflection', 'in_review');
  assert.deepEqual(routes, ['Synthesis, for a revised report', 'Lenses, for five new reports']);
  assert.ok(text().includes('Choose where the work returns.'), 'no route is chosen for them');
  await click('Lenses, for five new reports');
  await click('Submit verdict');
  assert.equal(submitted.body?.returnTo, 'reflecting');
  assert.equal(submitted.body?.verdict, 'needs_changes');
});

test('an experiment results rejection keeps its own two routes', async (t) => {
  t.after(async () => await unmount());
  const { routes } = await rejected('experiment', 'experiment_review');
  assert.deepEqual(routes, [
    'Planning, for a new design and attempt',
    'Running, to repair under the approved plan',
  ]);
});

test('a task review offers no return route, because its domain takes none', async (t) => {
  t.after(async () => await unmount());
  const { routes, submitted } = await rejected('task', 'in_review');
  assert.deepEqual(routes, []);
  assert.ok(!text().includes('Returns to'));
  await click('Submit verdict');
  assert.equal(submitted.body?.verdict, 'needs_changes');
  assert.equal('returnTo' in (submitted.body ?? {}), false);
});
