/**
 * Home, the project's pulse, rendered whole through the real shell against a fixture server.
 * Each test states one thing the page must do for a person: say where the project stands,
 * what needs them, which agents are at work and what each is doing, and what was lately
 * recorded, each the way to its record, and lose one part, never the page, to a read that
 * fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, requests, serve, settle, text, unmount } from './ui-render.js';

// The credential is read as api.ts is evaluated, so it is stored before anything loads.
sessionStorage.setItem('merv:token', 'fixture-token');
Object.assign(globalThis, {
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
});

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { App } = await import('../packages/ui/web/app.js');

const project = {
  id: 'project_1',
  name: 'Grokking replication',
  createdAt: '2026-09-01T00:00:00Z',
};
const actor = { id: 'actor_1', projectId: project.id, name: 'Ada', role: 'operator', active: true };
const row = (id: string, kind: string, group: string, order: number, label: string) => ({
  id,
  label,
  group,
  order,
  path: `/${id}`,
  view: { kind },
  status: {},
  readable: true,
});
const rows = [
  row('work', 'work', 'lead', 14, 'Work'),
  row('paper', 'paper', 'top', 15, 'Paper'),
  row('research', 'research', 'hidden', 14, 'Cycles'),
  row('tasks', 'tasks', 'hidden', 10, 'Tasks'),
  row('reviews', 'reviews', 'hidden', 17, 'Reviews'),
  row('artifacts', 'artifacts', 'research', 21, 'Files'),
  { ...row('settings', 'settings', 'settings', 100, 'Settings'), rooms: true },
];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const flow = (state: string, minutes = 30) => ({ state, updatedAt: ago(minutes), revision: 1 });
const task = (id: string, title: string, state: string) => ({
  id,
  title,
  goal: '',
  producerId: 'actor_bot',
  dependencies: [],
  dependents: [],
  workflow: flow(state),
});
const home = {
  project,
  actors: [actor, { id: 'actor_bot', name: 'Sweep agent', role: 'producer', active: true }],
  tasks: [
    task('wf_t1', 'Reproduce the baseline', 'done'),
    task('wf_t2', 'Tune the optimizer', 'in_progress'),
  ],
  experiments: [],
  reflections: [],
  research: [
    {
      id: 'wf_cycle',
      name: 'Cycle one',
      ownerId: 'actor_1',
      workflow: flow('researching', 5),
      researchDependencies: ['wf_t1', 'wf_t2'],
      reflectionId: null,
      automation: null,
    },
  ],
  reviews: [
    {
      id: 'review_1',
      subjectId: 'wf_t1',
      subjectRevision: 1,
      status: 'submitted',
      reviewerId: 'actor_1',
      verdict: 'pass',
      findings: [],
      createdAt: ago(20),
    },
  ],
  workflows: { workflows: [] },
};
/** The board as Sessions draws it: one agent at work on the optimizer, one offered and idle. */
const board = (doing?: unknown[]) => ({
  observedAt: new Date().toISOString(),
  lanes: {
    work: {
      nodes: [
        {
          key: 'work:wf_t2',
          lane: 'work',
          kind: 'Task',
          title: 'Tune the optimizer',
          lines: [],
          look: 'solid',
        },
      ],
      summaries: [],
      needsYou: 0,
      failed: [],
    },
    sessions: {
      nodes: [
        {
          key: 'session:ses_1',
          lane: 'sessions',
          title: 'Producer · claude',
          name: 'Tune the optimizer',
          lines: [doing ?? [{ mono: 'sandbox.run' }, ' · ', { since: ago(3) }], ['on a Fleet VM']],
          look: 'solid',
          dot: 'moving',
          links: [{ to: 'work:wf_t2', verb: 'works on' }],
        },
        {
          key: 'session:ses_2',
          lane: 'sessions',
          title: 'Reviewer',
          lines: [['Offered · not taken up']],
          look: 'dashed',
          dot: 'starting',
          links: [{ to: 'work:wf_t1', verb: 'reviews' }],
        },
      ],
      summaries: [],
      needsYou: 0,
      failed: [],
    },
    hardware: { nodes: [], summaries: [], needsYou: 0, failed: [] },
  },
  edges: [],
});

function boot() {
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'actor', actor, projects: [project] } });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows, plugins: [] } } });
  serve('/tools/project.get', { body: { result: project } });
  serve('/tools/actor.list', { body: { result: home.actors } });
  serve('/tools/ui.home', { body: { result: home } });
  serve('/tools/ui.running', { body: { result: board() } });
  serve('/tools/artifact.list', {
    body: {
      result: [{ id: 'art_1', title: 'loss-curve.png', mediaType: 'image/png', createdAt: ago(2) }],
    },
  });
  serve('/tools/paper.read', {
    body: {
      result: {
        documents: {
          methods: {
            current: {
              kind: 'methods',
              revision: 3,
              updatedBy: 'actor_1',
              updatedAt: ago(10),
              sections: [],
            },
            published: null,
          },
          results: {
            current: {
              kind: 'results',
              revision: 0,
              updatedBy: null,
              updatedAt: null,
              sections: [],
            },
            published: null,
          },
        },
        citations: [],
        proposals: [],
      },
    },
  });
}
const open = async (path = '/') => {
  await mount(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
  await settle(30);
};
const part = (title: string) => document.querySelector(`section[aria-label="${title}"]`)!;
const texts = (scope: Element, selector: string) =>
  [...scope.querySelectorAll(selector)].map((node) => node.textContent);

// First: every read keeps its last good answer for the life of the page, as a refresh that
// fails must, so a read that never answered is one no earlier test has made.
test('Latest says the home read failed, rather than loading for ever, when nothing else stands', async (t) => {
  t.after(async () => await unmount());
  boot();
  const down = { status: 500, body: { error: { code: 'internal', message: 'Broken' } } };
  serve('/tools/ui.home', down);
  serve('/tools/ui.running', down);
  serve('/tools/paper.read', down);
  serve('/tools/artifact.list', { body: { result: [] } });
  await open();
  const latest = part('Latest');
  assert.equal(
    latest.querySelector('.home-failed')?.textContent,
    'Could not read the paper or reviews.',
  );
  assert.ok(!latest.querySelector('[aria-label="Loading"]'), 'and is not still loading');
});

test('a part whose read fails says so on its own line, and the rest of Home stands', async (t) => {
  t.after(async () => await unmount());
  boot();
  serve('/tools/ui.running', {
    status: 503,
    body: { error: { code: 'unavailable', message: 'Down' } },
  });
  serve('/tools/paper.read', {
    status: 500,
    body: { error: { code: 'internal', message: 'Broken' } },
  });
  await open();
  assert.equal(
    part('Live now').querySelector('.home-failed')!.textContent,
    'Could not read what is running.',
  );
  assert.equal(
    part('Latest').querySelector('.home-failed')!.textContent,
    'Could not read the paper.',
  );
  // The file and the verdict still stand, and so does everything above them.
  assert.deepEqual(texts(part('Latest'), '.ov-name'), ['loss-curve.png', 'Reproduce the baseline']);
  assert.ok(text().includes('Cycle one'));
  assert.ok(text().includes('Nothing needs you'));
});

test('Home says where the project stands, what needs you, who is at work and what was recorded', async (t) => {
  t.after(async () => await unmount());
  boot();
  await open();
  // The project, and the cycle it is on with how much of its work is done.
  assert.equal(document.querySelector('h1')!.textContent, 'Grokking replication');
  const cycle = document.querySelector('.home-cycle')!;
  assert.equal(cycle.querySelector('a')!.getAttribute('href'), '/research/wf_cycle');
  assert.ok(cycle.textContent!.includes('Cycle one'));
  assert.ok(cycle.textContent!.includes('1 of 2 done'));
  assert.ok(cycle.querySelector('a[href="/work"]'), 'the way to the work it frames');

  assert.deepEqual(
    [...document.querySelectorAll('.home .ov-h')].map((node) => node.textContent),
    ['Needs you', 'Live now 1', 'Latest'],
  );
  assert.ok(part('Needs you').textContent!.includes('Nothing needs you'));

  // Only the agent at work is live; it is the way to its unit's sidebar on the Work page.
  const live = part('Live now').querySelector<HTMLAnchorElement>('a.home-live')!;
  assert.equal(part('Live now').querySelectorAll('a.home-live').length, 1);
  assert.equal(live.getAttribute('href'), '/work?key=work:wf_t2');
  assert.equal(live.querySelector('.home-live-unit')!.textContent, 'Tune the optimizer');
  assert.equal(live.querySelector('.home-live-who')!.textContent, 'Producer · claude');
  assert.match(live.querySelector('.home-live-doing')!.textContent!, /^sandbox\.run · 3m/);

  // Newest first: the file, the paper's revised section, then the verdict.
  const latest = part('Latest');
  assert.deepEqual(texts(latest, '.ov-name'), [
    'loss-curve.png',
    'Methods',
    'Reproduce the baseline',
  ]);
  assert.deepEqual(
    [...latest.querySelectorAll('a.ov-name')].map((link) => link.getAttribute('href')),
    ['/artifacts/art_1', '/paper', '/reviews/review_1'],
  );
  assert.deepEqual(texts(latest, '.home-latest-says'), [
    'New file',
    'Revision 3 · Ada',
    'pass· Ada',
  ]);
  assert.ok(latest.querySelector('.crit-word--pass'));
  assert.ok(requests.includes('POST /tools/artifact.list'));

  // The rail: Home leads, with Work and the paper after it.
  const rail = [...document.querySelectorAll('.sidebar .rail-nav a')].slice(0, 3);
  assert.deepEqual(
    rail.map((link) => link.getAttribute('href')),
    ['/', '/work', '/paper'],
  );
});

test('the newest-action line Sessions writes says what the agent is doing', async (t) => {
  t.after(async () => await unmount());
  boot();
  serve('/tools/ui.running', { body: { result: board(['thinking']) } });
  await open();
  assert.equal(part('Live now').querySelector('.home-live-doing')!.textContent, 'thinking');
});

test('the old Now address opens Home', async (t) => {
  t.after(async () => await unmount());
  boot();
  await open('/now');
  assert.equal(document.querySelector('h1')!.textContent, 'Grokking replication');
  assert.equal(document.querySelector('.sidebar [aria-current="page"]')!.getAttribute('href'), '/');
});
