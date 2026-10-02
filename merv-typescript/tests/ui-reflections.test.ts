/**
 * A reflection is read aggregated first: it opens on its report, the change
 * specification under it, and each lens is a tab of its own — who wrote it, where it
 * stands, its report in place and the instructions it was given. The tab in force is
 * in the address, so a reload or a link lands on it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter, Routes, Route, useLocation } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { ReflectionDetail } = await import('../packages/ui/web/views/research-programs.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');

const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
const actor = { id: 'actor_op', projectId: project.id, name: 'Operator', role: 'operator' };
const file = (n: number, title: string) => ({
  id: `art_0000000000000000000000000000000${n}`,
  projectId: project.id,
  createdBy: 'actor_ada',
  title,
  mediaType: 'text/markdown',
  hash: 'abc',
  size: 64,
  createdAt: '2026-10-01T09:00:00Z',
});
const REPORT = file(1, 'What the sweeps show');
const SPEC = file(2, 'Next wave');
const LENSES = ['evidence', 'theory', 'methods', 'synthesis', 'next_steps'];
const lens = (perspective: string, index: number) => {
  // The last lens has not reported yet.
  const artifact = index < 4 ? file(index + 3, `The ${perspective} lens`) : null;
  return {
    id: `wf_lens_${index + 1}`,
    reflectionId: 'wf_wave',
    attempt: 1,
    perspective,
    instructions: `Read the wave for its ${perspective.replace('_', ' ')}.`,
    producerId: artifact ? 'actor_ada' : null,
    artifact,
    workflow: {
      workflow: 'reflection.lens',
      state: artifact ? 'complete' : 'reflecting',
      revision: 1,
    },
  };
};
const wave = (over: Record<string, unknown> = {}) => ({
  id: 'wf_wave',
  title: 'Mid-point reflection',
  attempt: 1,
  createdAt: '2026-10-01T09:00:00Z',
  workflow: { workflow: 'reflection', state: 'in_review', revision: 4 },
  lenses: LENSES.map(lens),
  report: REPORT,
  changeSpec: SPEC,
  review: null,
  ...over,
});
const row = {
  id: 'reflections',
  label: 'Reflections',
  group: 'work',
  order: 1,
  path: '/reflections',
  view: { kind: 'reflections' },
  status: {},
  readable: true,
};
/** Where the page is, said where a test can read it. */
function Where() {
  return createElement('output', { id: 'where' }, useLocation().search);
}
const page = (entry: string, reflection = wave()) => {
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  serve('/tools/actor.list', {
    body: { result: [{ id: 'actor_ada', projectId: project.id, name: 'Ada Byron' }] },
  });
  serve('/tools/reflection.get', { body: { result: reflection } });
  serve('/tools/artifact.read', (_, sent) => ({
    body: {
      result: {
        artifact: REPORT,
        encoding: 'utf8',
        content: `# Read from ${String(sent.artifactId).slice(-1)}\nWhat it found.`,
      },
    },
  }));
  return createElement(
    MemoryRouter,
    { initialEntries: [entry] },
    createElement(
      SessionProvider,
      null,
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/reflections/:id',
          element: createElement('div', null, [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createElement(ReflectionDetail as any, { key: 'page', row, shell: { rows: [row] } }),
            createElement(Where, { key: 'where' }),
          ]),
        }),
      ),
    ),
  );
};
const tabs = () => [...document.querySelectorAll('[role="group"][aria-label="Lenses"] button')];
const pressed = () =>
  tabs()
    .filter((tab) => tab.getAttribute('aria-pressed') === 'true')
    .map((tab) => tab.textContent);
/** The files the panel reads in place, by the names their heads give them. */
const read = () => [...document.querySelectorAll('.doc-head .doc-name')].map((n) => n.textContent);

test('a wave opens on its report with the change specification under it, then a tab per lens', async (t) => {
  t.after(async () => await unmount());
  await mount(page('/reflections/wf_wave'));
  await settle(20);
  assert.deepEqual(
    tabs().map((tab) => tab.textContent),
    ['Report', 'evidence', 'theory', 'methods', 'synthesis', 'next steps'],
  );
  assert.deepEqual(pressed(), ['Report']);
  assert.deepEqual(read(), ['What the sweeps show', 'Next wave']);
  assert.ok(text().includes('Change specification'));
  assert.equal(document.querySelector('.doc-read .md-h')?.textContent, 'Read from 1');
  assert.doesNotMatch(text(), /perspective/i, 'the word is lens');

  // Choosing a lens is said in the address, and the lens is read on its own.
  await act(async () => (tabs()[2] as HTMLButtonElement).click());
  await settle(20);
  assert.equal(document.querySelector('#where')?.textContent, '?lens=wf_lens_2');
  assert.deepEqual(pressed(), ['theory']);
  assert.ok(text().includes('Ada Byron'), 'who wrote it');
  assert.equal(document.querySelector('.record-page .cluster .status')?.textContent, 'complete');
  assert.deepEqual(read(), ['The theory lens']);
  const fold = document.querySelector<HTMLDetailsElement>('details.ov-said')!;
  assert.equal(fold.querySelector('summary')?.textContent, 'Instructions');
  assert.ok(!fold.open, 'the instructions stay folded');
  assert.ok(fold.textContent!.includes('Read the wave for its theory.'));
});

test('an address naming a lens lands on it, and a lens with no report is its line alone', async (t) => {
  t.after(async () => await unmount());
  await mount(page('/reflections/wf_wave?lens=wf_lens_5'));
  await settle(20);
  assert.deepEqual(pressed(), ['next steps']);
  assert.deepEqual(read(), [], 'nothing to read in place');
  assert.equal(document.querySelector('.record-page .cluster')?.textContent, 'reflecting');
  assert.ok(text().includes('Read the wave for its next steps.'));
});

test('before its report a wave opens on its first lens, and an address it cannot answer too', async (t) => {
  t.after(async () => await unmount());
  await mount(page('/reflections/wf_wave?lens=report', wave({ report: null, changeSpec: null })));
  await settle(20);
  assert.equal(tabs()[0]?.textContent, 'evidence', 'no report, no tab for it');
  assert.deepEqual(pressed(), ['evidence']);
  assert.ok(document.querySelector('section[aria-label="Lenses"]'));
  assert.deepEqual(read(), ['The evidence lens']);
});
