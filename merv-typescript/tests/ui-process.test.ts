/**
 * The workflow diagram: one place marked, every way back drawn over the track, every
 * end one node. The layout is the program's own — states in the order its edges reach
 * them — so these assertions are about what a person sees, not how the paths are written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { ProcessDiagram, StageList, StageMark, diagramOfGraph, diagramOfShape, stageTimes } =
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

test('a record’s own graph marks one place, draws the way back, and names its states', async (t) => {
  t.after(async () => await unmount());
  await mount(
    createElement(ProcessDiagram, { ...diagramOfGraph(graph as never), kind: 'experiments' }),
  );
  assert.equal(document.querySelectorAll('.pd-node--here').length, 1);
  assert.equal(document.querySelectorAll('.pd-node--here title').length, 0);
  // Three steps of track forward, and the one way back as an arc over it.
  assert.equal(document.querySelectorAll('.pd-track').length, 3);
  assert.equal(document.querySelectorAll('.pd-arc').length, 1);
  // Behind, here, not reached, and one end cap: every state of the program is drawn.
  assert.equal(document.querySelectorAll('.pd-node').length, 4);
  assert.equal(document.querySelectorAll('.pd-node--behind').length, 1);
  assert.equal(document.querySelectorAll('.pd-cap').length, 1);
  assert.deepEqual(
    [...document.querySelectorAll('.pd-node text')].map((label) =>
      [...label.querySelectorAll('tspan')].map((word) => word.textContent).join(' '),
    ),
    ['planned', 'design review', 'running', 'complete'],
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
  const drawn = diagramOfShape(shape, 'running');
  assert.deepEqual(
    drawn.steps.map((step) => step.state),
    ['planned', 'design_review', 'running', 'complete'],
  );
  assert.deepEqual(
    drawn.steps.filter((step) => step.current).map((step) => step.state),
    ['running'],
  );
  assert.deepEqual(
    drawn.steps.map((step) => step.entered),
    [true, true, true, false],
  );
});

test('every end is one node, named for how the record ended', async (t) => {
  t.after(async () => await unmount());
  const out = ['abandoned', 'failed'].flatMap((to) =>
    ['planned', 'design_review', 'running'].map((from) => ({ from, to })),
  );
  const ended = {
    nodes: [
      node('planned', { at: '2026-09-17T10:00:00.000Z' }),
      node('design_review', { at: '2026-09-17T11:00:00.000Z' }),
      node('running'),
      node('abandoned', { terminal: true, current: true, at: '2026-09-17T12:00:00.000Z' }),
      node('failed', { terminal: true }),
      node('complete', { terminal: true }),
    ],
    edges: [...edges, ...out],
  };
  const drawn = diagramOfGraph(ended as never);
  assert.deepEqual(
    drawn.steps.map((step) => step.state),
    ['planned', 'design_review', 'running', 'abandoned'],
  );
  // No way out is drawn: the track still leads to the finish the program has.
  assert.deepEqual(
    drawn.ways.filter((way) => way.to === 3).map((way) => way.from),
    [2],
  );
  await mount(createElement(ProcessDiagram, drawn));
  assert.equal(document.querySelectorAll('.pd-node--stopped .pd-cap').length, 1);
  assert.equal(document.querySelectorAll('.pd-node--here').length, 0);
  assert.equal(document.querySelectorAll('.pd-halo').length, 0);
  // It got as far as design review, and the drawing says so.
  assert.equal(document.querySelectorAll('.pd-node--behind').length, 2);
  assert.equal(document.querySelectorAll('.pd-track--behind').length, 1);
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
