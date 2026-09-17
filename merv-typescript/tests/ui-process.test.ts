/**
 * The workflow diagram: one place marked, every way back drawn. The layout is the
 * program's own — states in the order its edges reach them — so these assertions are
 * about what a person sees, not about how the path data is written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { ProcessDiagram, stepsOfGraph, stepsOfShape } =
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
    createElement(ProcessDiagram, {
      steps: stepsOfGraph(graph as never),
      edges: graph.edges,
      kind: 'experiments',
    }),
  );
  assert.equal(document.querySelectorAll('.pd-node--here').length, 1);
  assert.equal(document.querySelectorAll('.pd-node--here title').length, 0);
  assert.equal(document.querySelectorAll('.pd-edge--back').length, 1);
  // Passed, here, not reached, and one end cap: every state of the program is drawn.
  assert.equal(document.querySelectorAll('.pd-node').length, 4);
  assert.equal(document.querySelectorAll('.pd-node--passed').length, 1);
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
  const steps = stepsOfShape(shape, 'running');
  assert.deepEqual(
    steps.map((step) => step.state),
    ['planned', 'design_review', 'running', 'complete'],
  );
  assert.deepEqual(
    steps.filter((step) => step.current).map((step) => step.state),
    ['running'],
  );
  await mount(createElement(ProcessDiagram, { steps, edges: shape.edges, compact: true }));
  assert.equal(document.querySelectorAll('.pd-node--here').length, 1);
  assert.equal(document.querySelectorAll('.pd-edge--back').length, 1);
  assert.equal(document.querySelectorAll('.pd-node text').length, 0);
  assert.equal(document.querySelectorAll('.pd-node title').length, 4);
});
