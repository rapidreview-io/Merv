/**
 * A workflow read as its stages: every state of the program in the order its edges reach
 * them, one place marked, every end one stage. The order is the program's own, so these
 * assertions are about what a person reads, not how a mark is drawn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount as render, serve, styled, unmount } from './ui-render.js';

const { createElement } = await import('react');
/**
 * Every page is drawn under the shell's read: the deployed program, whose reviews are left
 * through review.submit, and its owner's word that planning is work not yet begun.
 */
const mount = async (element: Parameters<typeof render>[0]) => {
  serve('/tools/ui.shell', {
    body: {
      result: {
        rows: [{ id: 'experiments', workflow: 'experiment', states: { planned: { idle: true } } }],
        plugins: [],
        workflows: [
          {
            name: 'experiment',
            version: 3,
            initial: 'planned',
            states: ['planned', 'design_review', 'running', 'complete'],
            terminal: ['complete'],
            edges: [
              { from: 'design_review', action: 'approve', to: 'running', tool: 'review.submit' },
            ],
          },
        ],
      },
    },
  });
  await render(element);
};
const { Gate, StageList, StageMark, stagesOfGraph, stagesOfShape, stageTimes } =
  await import('../packages/ui/web/process.js');

const node = (
  state: string,
  marks: { terminal?: boolean; current?: boolean; at?: string } = {},
) => ({
  state,
  initial: state === 'planned',
  terminal: !!marks.terminal,
  current: !!marks.current,
  entries: marks.at ? 1 : 0,
  firstEnteredAt: marks.at ?? null,
  blockers: [],
});
const edges = [
  { from: 'planned', to: 'design_review' },
  { from: 'design_review', to: 'running' },
  // The way back: a review that asks for a new design returns the record to planning.
  { from: 'design_review', to: 'planned' },
  { from: 'running', to: 'complete' },
];
const graph = {
  nodes: [
    node('planned', { at: '2026-09-17T10:00:00.000Z' }),
    node('design_review', { current: true, at: '2026-09-17T11:00:00.000Z' }),
    node('running'),
    node('complete', { terminal: true }),
  ],
  edges: edges.map((edge) => ({
    ...edge,
    action: 'act',
    traversals: [],
    status: null,
    tool: null,
  })),
};

test('a record’s gate is one card of every state of its program, the one it stands in marked', async (t) => {
  t.after(async () => await unmount());
  await mount(createElement(Gate, { graph: { ...graph, dependencies: [] } as never }));
  const card = document.querySelector('section.stage-card')!;
  assert.equal(card.getAttribute('aria-label'), 'Time in status');
  assert.equal(card.querySelector('.stage-card-title')!.textContent, 'Time in status');
  const rows = [...card.querySelectorAll('.stages > li')];
  assert.deepEqual(
    rows.map((row) => row.querySelector('.stage-word')!.textContent),
    ['planned', 'design review', 'running', 'complete'],
  );
  assert.deepEqual(
    rows.map((row) => row.getAttribute('aria-current')),
    [null, 'step', null, null],
  );
  // Behind and here are read; what the record never reached is quiet.
  assert.deepEqual(
    rows.map((row) => row.classList.contains('stage--ahead')),
    [false, false, true, true],
  );
  // The drawn ladder is gone: a stage is said one way, on a record's page as everywhere.
  assert.equal(document.querySelector('svg.pd'), null);
});

test('in the card only the stage the record stands in wears its colour', async (t) => {
  t.after(async () => await unmount());
  t.after(styled());
  const at = '2026-09-17T10:00:00.000Z';
  const running = {
    ...graph,
    nodes: [
      node('planned', { at }),
      node('design_review', { at }),
      node('running', { current: true, at }),
      node('complete', { terminal: true }),
    ],
  };
  await mount(createElement(StageList, { graph: running as never }));
  // What it has been through keeps its mark's shape in grey, a review's orange included;
  // where it stands is green, as running is; what it has not reached is the faintest ring.
  assert.deepEqual(
    [...document.querySelectorAll('.stages > li .stage-glyph')].map(
      (glyph) => getComputedStyle(glyph).color,
    ),
    ['var(--faint)', 'var(--faint)', 'var(--stage-live)', 'var(--ghost)'],
  );
});

test('a record read from a list is walked from the deployed shape: its place, and what is behind it', () => {
  const shape = {
    name: 'experiment',
    version: 3,
    initial: 'planned',
    states: ['planned', 'design_review', 'running', 'complete'],
    terminal: ['complete'],
    edges: edges.map((edge) => ({ ...edge, action: 'act' })),
  };
  const steps = stagesOfShape(shape, 'running');
  assert.deepEqual(
    steps.map((step) => step.state),
    ['planned', 'design_review', 'running', 'complete'],
  );
  assert.deepEqual(
    steps.filter((step) => step.current).map((step) => step.state),
    ['running'],
  );
  assert.deepEqual(
    steps.map((step) => step.entered),
    [true, true, true, false],
  );
});

test('every end is one stage, named for how the record ended', async (t) => {
  t.after(async () => await unmount());
  const out = ['abandoned', 'failed'].flatMap((to) =>
    ['planned', 'design_review', 'running'].map((from) => ({ from, to })),
  );
  const ended = {
    terminal: true,
    nodes: [
      node('planned', { at: '2026-09-17T10:00:00.000Z' }),
      node('design_review', { at: '2026-09-17T11:00:00.000Z' }),
      node('running'),
      node('abandoned', { terminal: true, current: true, at: '2026-09-17T12:00:00.000Z' }),
      node('failed', { terminal: true }),
      node('complete', { terminal: true }),
    ],
    edges: [...edges, ...out].map((edge) => ({ ...edge, traversals: [] })),
  };
  const steps = stagesOfGraph(ended as never);
  assert.deepEqual(
    steps.map((step) => [step.state, step.end, step.stopped, step.current]),
    [
      ['planned', false, false, false],
      ['design_review', false, false, false],
      ['running', false, false, false],
      ['abandoned', true, true, true],
    ],
  );
  await mount(createElement(StageList, { graph: ended as never }));
  const rows = [...document.querySelectorAll('.stages > li')];
  // It got as far as design review, and the card says so; the end it took wears a cross.
  assert.deepEqual(
    rows.map((row) => row.classList.contains('stage--ahead')),
    [false, false, true, false],
  );
  assert.ok(rows[3]!.querySelector('svg.stage-glyph--bad .stage-sign'));
  assert.equal(rows[3]!.getAttribute('aria-current'), 'step');
});

test('a stage is said the one way everywhere: a mark in the colour of its kind of standing, then its word', async (t) => {
  t.after(async () => await unmount());
  const shape = {
    name: 'experiment',
    version: 3,
    initial: 'planned',
    states: ['planned', 'design_review', 'running', 'complete', 'abandoned'],
    terminal: ['complete', 'abandoned'],
    edges: [
      ...edges,
      ...['planned', 'design_review', 'running'].map((from) => ({ from, to: 'abandoned' })),
    ].map((edge) => ({ ...edge, action: 'act' })),
  };
  const mark = async (workflow: { workflow?: string; version?: number; state: string }) => {
    await unmount();
    await mount(createElement(StageMark, { shapes: [shape], workflow }));
    return document.querySelector('.stage-mark')!;
  };
  const at = (state: string) => ({ workflow: 'experiment', version: 3, state });
  const hue = (item: Element) =>
    [...item.querySelector('svg')!.classList].find((name) => name.startsWith('stage-glyph--'));
  const running = await mark(at('running'));
  // The word is plain ink; the colour is the mark's alone.
  assert.equal(running.textContent, 'running');
  assert.equal(running.querySelector('svg')!.getAttribute('aria-hidden'), 'true');
  assert.equal(hue(running), 'stage-glyph--live');
  // Not begun is an empty grey ring; a review is orange; the further along, the fuller the pie.
  const planned = await mark(at('planned'));
  assert.equal(hue(planned), 'stage-glyph--idle');
  assert.equal(planned.querySelector('path.stage-fill'), null);
  const wedge = (item: Element) => item.querySelector('path.stage-fill')!.getAttribute('d')!;
  const review = await mark(at('design_review'));
  assert.equal(hue(review), 'stage-glyph--review');
  assert.match(wedge(review), / 0 1 /, 'under half a turn');
  assert.match(wedge(await mark(at('running'))), / 1 1 /, 'over half a turn');
  // The finish is a disc with a check; an end the record took another way, one with a cross.
  const done = await mark(at('complete'));
  assert.equal(hue(done), 'stage-glyph--done');
  assert.match(done.querySelector('.stage-sign')!.getAttribute('d')!, /^M4\.2 7\.3/);
  const stopped = await mark(at('abandoned'));
  assert.equal(hue(stopped), 'stage-glyph--bad');
  assert.match(stopped.querySelector('.stage-sign')!.getAttribute('d')!, /l4\.2 4\.2M/);
  // Work that is neither a review nor running is yellow.
  const task = {
    ...shape,
    name: 'task',
    initial: 'in_progress',
    states: ['in_progress', 'done'],
    terminal: ['done'],
    edges: [{ from: 'in_progress', action: 'act', to: 'done' }],
  };
  await unmount();
  await mount(
    createElement(StageMark, {
      shapes: [task],
      workflow: { workflow: 'task', version: 3, state: 'in_progress' },
    }),
  );
  assert.equal(hue(document.querySelector('.stage-mark')!), 'stage-glyph--work');
  // A program this build has no shape for keeps a dot in the state's tone.
  const unknown = await mark({ workflow: 'elsewhere', state: 'running' });
  assert.equal(unknown.querySelector('svg'), null);
  assert.ok(unknown.querySelector('.status-dot.status--ok'));
  // A record page that holds the record's own graph reads the stages from it.
  await unmount();
  await mount(
    createElement(StageMark, { graph: graph as never, workflow: { state: 'design_review' } }),
  );
  assert.equal(hue(document.querySelector('.stage-mark')!), 'stage-glyph--review');
});

test('how long a record stood in each state is read from its crossings, a state it came back to counted twice', async (t) => {
  t.after(async () => await unmount());
  const crossed = (from: string, to: string, times: [number, string][]) => ({
    from,
    to,
    action: 'act',
    traversals: times.map(([revision, at]) => ({
      revision,
      actorId: 'actor_1',
      requestId: 'r',
      at,
    })),
    status: null,
    tool: null,
  });
  const looped = {
    terminal: false,
    nodes: [
      { ...node('planned', { at: '2026-09-17T10:00:00.000Z' }), entries: 1 },
      { ...node('design_review', { current: true, at: '2026-09-17T11:00:00.000Z' }), entries: 2 },
      node('running'),
      node('complete', { terminal: true }),
    ],
    edges: [
      crossed('planned', 'design_review', [
        [1, '2026-09-17T11:00:00.000Z'],
        [3, '2026-09-17T12:30:00.000Z'],
      ]),
      crossed('design_review', 'planned', [[2, '2026-09-17T11:30:00.000Z']]),
      // Staying in a state is no crossing.
      crossed('design_review', 'design_review', [[4, '2026-09-17T12:45:00.000Z']]),
      crossed('design_review', 'running', []),
      crossed('running', 'complete', []),
    ],
  };
  const now = Date.parse('2026-09-17T13:00:00.000Z');
  const spent = stageTimes(looped as never, now);
  const minutes = (state: string) => (spent.get(state) ?? 0) / 60_000;
  assert.equal(minutes('planned'), 120, 'an hour, then an hour again after the return');
  assert.equal(minutes('design_review'), 60, 'half an hour, then half an hour still open');
  assert.equal(spent.has('running'), false);
  // The list: every state top to bottom, the one it stands in marked, what it never reached quiet.
  t.mock.timers.enable({ apis: ['Date'], now });
  await mount(createElement(StageList, { graph: looped as never }));
  const rows = [...document.querySelectorAll('.stages > li')];
  // The mark, the word and the time: how often it came back is the thread's to tell.
  assert.deepEqual(
    rows.map((row) => row.textContent),
    ['planned2h', 'design review1h', 'running', 'complete'],
  );
  // What it has not reached is a grey ring, whatever colour it will wear.
  assert.deepEqual(
    rows.map((row) => [...row.querySelector('svg')!.classList].at(-1)),
    ['stage-glyph--idle', 'stage-glyph--review', 'stage-glyph--idle', 'stage-glyph--idle'],
  );
  assert.equal(rows[1]!.getAttribute('aria-current'), 'step');
  assert.ok(rows[1]!.classList.contains('stage--here'));
  assert.deepEqual(
    rows.map((row) => row.classList.contains('stage--ahead')),
    [false, false, true, true],
  );
});

test('a record on a retired version reads its program from any version still registered', async () => {
  const { ended } = await import('../packages/ui/web/process.js');
  // The catalog lists only the versions still registered: tasks v40, not the v38 a done task ran.
  const shapes = [
    {
      name: 'task',
      version: 40,
      initial: 'open',
      states: ['open', 'done', 'abandoned'],
      terminal: ['done', 'abandoned'],
      edges: [{ from: 'open', to: 'done', action: 'act' }],
    },
  ] as never;
  assert.equal(ended(shapes, { workflow: 'task', version: 38, state: 'done' }), true);
  assert.equal(ended(shapes, { workflow: 'task', version: 38, state: 'open' }), false);
  assert.equal(ended(shapes, { workflow: 'experiment', version: 30, state: 'done' }), false);
  await mount(
    createElement(StageMark, {
      shapes,
      workflow: { workflow: 'task', version: 38, state: 'open' },
    }),
  );
  // Its stages are drawn from the registered version, not a bare dot.
  assert.ok(document.querySelector('.stage-mark svg'));
  assert.equal(document.querySelector('.stage-mark .status-dot'), null);
  unmount();
});
