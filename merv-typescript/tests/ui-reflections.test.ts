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
const { WorkView } = await import('../packages/ui/web/views/work.js');
const { emptyBoard } = await import('./ui-running-fixtures.js');

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
/** The stage a wave stands at, as its row's read sends it beside the wave. */
const graph = (reflection: { id: string; workflow: { state: string } }) => ({
  instanceId: reflection.id,
  terminal: false,
  nodes: [],
  edges: [],
  dependencies: [],
  actions: [],
  state: reflection.workflow.state,
});
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
  // The page's one read: the wave and its stage, with no action checked.
  serve('/tools/ui.read', { body: { result: { reflection, process: graph(reflection) } } });
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
    ['Report', 'Evidence', 'Theory', 'Methods', 'Synthesis', 'Next steps'],
  );
  assert.deepEqual(pressed(), ['Report']);
  assert.ok(
    document.querySelector('section[aria-label="Lenses"]'),
    'never Synthesis, which is a lens',
  );
  assert.deepEqual(read(), ['What the sweeps show', 'Next wave']);
  assert.ok(text().includes('Change specification'));
  assert.equal(document.querySelector('.doc-read .md-h')?.textContent, 'Read from 1');
  assert.doesNotMatch(text(), /perspective/i, 'the word is lens');

  // Choosing a lens is said in the address, and the lens is read on its own.
  await act(async () => (tabs()[2] as HTMLButtonElement).click());
  await settle(20);
  assert.equal(document.querySelector('#where')?.textContent, '?lens=wf_lens_2');
  assert.deepEqual(pressed(), ['Theory']);
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
  assert.deepEqual(pressed(), ['Next steps']);
  assert.deepEqual(read(), [], 'nothing to read in place');
  assert.equal(document.querySelector('.record-page .cluster')?.textContent, 'reflecting');
  assert.ok(text().includes('Read the wave for its next steps.'));
});

test('before its report a wave opens on its first lens, and an address it cannot answer too', async (t) => {
  t.after(async () => await unmount());
  await mount(page('/reflections/wf_wave?lens=report', wave({ report: null, changeSpec: null })));
  await settle(20);
  assert.equal(tabs()[0]?.textContent, 'Evidence', 'no report, no tab for it');
  assert.deepEqual(pressed(), ['Evidence']);
  assert.ok(document.querySelector('section[aria-label="Lenses"]'));
  assert.deepEqual(read(), ['The evidence lens']);
});

test('an address naming a lens, as a lens lease opens, lands on its wave at that lens', async (t) => {
  t.after(async () => await unmount());
  const element = page('/reflections/wf_lens_2');
  serve('/tools/ui.read', (_, sent) =>
    (sent.params as { id: string }).id === 'wf_wave'
      ? { body: { result: { reflection: wave(), process: graph(wave()) } } }
      : {
          status: 404,
          body: { error: { code: 'reflection_not_found', message: 'Reflection not found' } },
        },
  );
  serve('/tools/reflection.lens', (_, sent) => ({
    body: { result: lens('theory', Number(String(sent.lensId).slice(-1)) - 1) },
  }));
  await mount(element);
  await settle(40);
  assert.equal(document.querySelector('#where')?.textContent, '?lens=wf_lens_2');
  assert.deepEqual(pressed(), ['Theory']);
  assert.deepEqual(read(), ['The theory lens']);
});

test('a read that fails after the wave was read keeps the wave on the page', async (t) => {
  t.after(async () => await unmount());
  await mount(page('/reflections/wf_wave'));
  await settle(20);
  serve('/tools/ui.read', {
    status: 503,
    body: { error: { code: 'unavailable', message: 'Reflections is reconnecting' } },
  });
  const { refreshTools } = await import('../packages/ui/web/api.js');
  await act(async () => refreshTools('ui.read'));
  await settle(20);
  assert.deepEqual(pressed(), ['Report']);
});

test('the Work page is its title line and the map: nothing is listed, and Filter narrows what is drawn', async (t) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const global = globalThis as any;
  global.ResizeObserver = class {
    constructor(private ran: (entries: { contentRect: { width: number } }[]) => void) {}
    observe() {
      this.ran([{ contentRect: { width: 1200 } }]);
    }
    disconnect() {}
  };
  t.after(async () => {
    delete global.ResizeObserver;
    await unmount();
  });
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  serve('/tools/actor.list', { body: { result: [] } });
  serve('/tools/ui.running', { body: { result: emptyBoard() } });
  const at = { revision: 1, updatedAt: '2026-10-01T09:00:00Z' };
  const task = (id: string, title: string, state: string) => ({
    id,
    title,
    goal: title,
    producerId: actor.id,
    workflow: { workflow: 'task', state, ...at },
  });
  // The wave is the home read's, each list under its row's id.
  serve('/tools/ui.home', {
    body: {
      result: {
        tasks: [task('wf_sweep', 'Seed sweep', 'in_progress'), task('wf_pin', 'Pin seeds', 'done')],
        reflections: [
          {
            ...wave(),
            ownerId: actor.id,
            workflow: { workflow: 'reflection', state: 'reflecting', ...at },
          },
        ],
      },
    },
  });
  const rows = [{ ...row, id: 'tasks', path: '/tasks', view: { kind: 'tasks' } }, row];
  // Open work is what no deployed shape has ended.
  const workflows = [
    {
      name: 'task',
      version: 1,
      initial: 'ready',
      states: ['ready', 'in_progress', 'done', 'failed'],
      terminal: ['done', 'failed'],
      edges: [],
    },
  ];
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/work'] },
      createElement(
        SessionProvider,
        null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createElement(WorkView as any, { shell: { rows, workflows } }),
      ),
    ),
  );
  await settle(20);
  const cards = () =>
    [...document.querySelectorAll('.wmap-node')].map((card) => card.getAttribute('data-key'));
  // As the page opens: the open work, drawn once and listed nowhere.
  assert.deepEqual(cards().sort(), ['work:wf_sweep', 'work:wf_wave']);
  assert.equal(document.querySelector('ul.rows'), null);
  // No row of tabs and chips stands over the map: one word in the title line opens them.
  assert.equal(document.querySelector('.action-row, .tabs--strip'), null);
  const word = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.page-actions button')].find(
      (button) => button.textContent === name,
    );
  assert.equal(document.querySelector('.narrowing-panel'), null);
  assert.equal(word('Reset'), undefined, 'nothing is narrowed yet');
  await act(async () => word('Filter')!.click());
  assert.ok(
    document.querySelector('.narrowing-panel [aria-label="Search work"], .narrowing-panel input'),
  );
  const press = async (label: string, name: string) => {
    const button = [...document.querySelectorAll(`[aria-label="${label}"] button`)].find((item) =>
      item.textContent?.startsWith(name),
    ) as HTMLButtonElement;
    await act(async () => button.click());
  };
  assert.ok(!text().includes('New reflection'));
  await press('Kind of work', 'Reflections');
  assert.deepEqual(cards(), ['work:wf_wave']);
  assert.ok(text().includes('New reflection'), 'the tab’s own thing to start');
  await press('Kind of work', 'All');
  await press('State of work', 'done');
  assert.deepEqual(cards(), ['work:wf_pin']);
  assert.equal(document.querySelector('ul.rows'), null);
  // Narrowed, the word is lit and Reset is the way back to how the page opens.
  assert.ok(word('Filter')!.classList.contains('btn--on'));
  await act(async () => word('Reset')!.click());
  assert.deepEqual(cards().sort(), ['work:wf_sweep', 'work:wf_wave']);
  assert.equal(word('Reset'), undefined);
});

test('with no room to draw, the Work page lists the same work as rows, a reflection among them', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  serve('/tools/actor.list', { body: { result: [] } });
  serve('/tools/ui.running', { body: { result: emptyBoard() } });
  serve('/tools/ui.home', {
    body: {
      result: {
        tasks: [],
        reflections: [
          {
            ...wave({
              // Home reads each lens as whether it has written, not its report.
              lenses: LENSES.map(lens).map(({ id, workflow, artifact }) => ({
                id,
                workflow,
                written: !!artifact,
              })),
            }),
            ownerId: actor.id,
            workflow: {
              workflow: 'reflection',
              state: 'reflecting',
              revision: 1,
              updatedAt: '2026-10-01T09:00:00Z',
            },
          },
        ],
      },
    },
  });
  const rows = [{ ...row, id: 'tasks', path: '/tasks', view: { kind: 'tasks' } }, row];
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/work'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(SessionProvider, null, createElement(WorkView as any, { shell: { rows } })),
    ),
  );
  await settle(20);
  assert.equal(document.querySelector('.wmap-node'), null);
  const link = document.querySelector<HTMLAnchorElement>('ul.rows a[href="/reflections/wf_wave"]');
  assert.equal(link?.textContent, 'Mid-point reflection');
  assert.ok(link!.closest('li')?.textContent?.includes('4 of 5 lenses written'));
});

test('a list of the wave that could not be read says so, rather than its records vanishing', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  serve('/tools/actor.list', { body: { result: [] } });
  serve('/tools/ui.running', { body: { result: emptyBoard() } });
  const task = {
    id: 'wf_sweep',
    title: 'Seed sweep',
    goal: 'Seed sweep',
    producerId: actor.id,
    workflow: {
      workflow: 'task',
      state: 'in_progress',
      revision: 1,
      updatedAt: '2026-10-01T09:00:00Z',
    },
  };
  // The reflections are there, but their read failed.
  serve('/tools/task.list', { body: { result: [task] } });
  serve('/tools/reflection.list', {
    status: 500,
    body: { error: { code: 'internal', message: 'Boom' } },
  });
  serve('/tools/ui.home', { body: { result: { tasks: [task], reflections: null } } });
  const rows = [{ ...row, id: 'tasks', path: '/tasks', view: { kind: 'tasks' } }, row];
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/work'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(SessionProvider, null, createElement(WorkView as any, { shell: { rows } })),
    ),
  );
  await settle(20);
  assert.ok(text().includes('Seed sweep'));
  assert.ok(text().includes('Could not refresh'), text().slice(0, 400));
});
