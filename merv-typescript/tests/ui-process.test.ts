/**
 * The workflow diagram: one place marked, every way back drawn over the track, every
 * end one node. The layout is the program's own — states in the order its edges reach
 * them — so these assertions are about what a person sees, not how the paths are written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { ProcessDiagram, diagramOfGraph, diagramOfShape } =
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

test('a row draws the same machine from the deployed shape, unlabelled', async (t) => {
  t.after(async () => await unmount());
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
  await mount(createElement(ProcessDiagram, { ...drawn, compact: true }));
  assert.equal(document.querySelectorAll('.pd-node--here').length, 1);
  assert.equal(document.querySelectorAll('.pd-node--behind').length, 2);
  // A row says where the record stands and nothing about the ways back.
  assert.equal(document.querySelectorAll('.pd-arc').length, 0);
  assert.equal(document.querySelectorAll('.pd-node text').length, 0);
  assert.equal(document.querySelectorAll('.pd-node title').length, 4);
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
