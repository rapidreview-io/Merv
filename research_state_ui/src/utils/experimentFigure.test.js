import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ARTIFACT_FANOUT_CAP, experimentFigure } from './experimentFigure.js';

/**
 * Parity with the figure the backend used to derive. Each fixture pairs the
 * payloads the experiment page fetches — the /status payload's `experiment`
 * and `sandboxes`, and the /reviews payload — with the exact nodes and edges
 * `GET …/figure` returned for that state, captured before the route was
 * deleted. Eight fixtures are whole HTTP responses from a real brain walking
 * an experiment's lifecycle; five are synthetic states that reach shapes a
 * live lifecycle does not (three attempts and four result rounds, the fan-out
 * cap, a failing verdict, out-of-range attempt indexes).
 *
 * Generated snapshots, so they live on one line each — read them with `jq`.
 */
const FIXTURES = JSON.parse(readFileSync(
  fileURLToPath(new URL('./__fixtures__/experimentFigure.json', import.meta.url)),
  'utf8',
));

// Node order is incidental: the layout ranks nodes off the edges, and edge
// order never reaches the canvas at all. Both sides are keyed by id so a
// mismatch names the node or edge that drifted.
const byId = (rows) => Object.fromEntries(rows.map(row => [row.id, row]));

test('every captured scenario derives the figure the backend served', () => {
  assert.ok(FIXTURES.length >= 13, 'fixtures were not loaded');
  for (const { name, input, expected } of FIXTURES) {
    const figure = experimentFigure(input);
    assert.deepEqual(byId(figure.nodes), byId(expected.nodes), `${name}: nodes`);
    assert.deepEqual(byId(figure.edges), byId(expected.edges), `${name}: edges`);
    assert.equal(figure.nodes.length, expected.nodes.length, `${name}: duplicate node ids`);
    assert.equal(figure.edges.length, expected.edges.length, `${name}: duplicate edge ids`);
  }
});

const fixture = (name) => {
  const found = FIXTURES.find(row => row.name === name);
  assert.ok(found, `no fixture named ${name}`);
  return found;
};

test('the fixtures cover the shapes the figure has rules for', () => {
  const nodes = FIXTURES.flatMap(row => row.expected.nodes);
  const types = new Set(nodes.map(node => node.type));
  for (const type of ['attempt', 'submission', 'review', 'artifact', 'artifact_group',
    'sandbox', 'conclusion', 'claim']) {
    assert.ok(types.has(type), `no fixture produces a ${type} node`);
  }
  const edgeTypes = new Set(FIXTURES.flatMap(row => row.expected.edges).map(edge => edge.type));
  for (const type of ['reviewed_by', 'then', 'revised_to', 'feeds', 'produced', 'ran_on',
    'concludes', 'tests']) {
    assert.ok(edgeTypes.has(type), `no fixture produces a ${type} edge`);
  }
  const statuses = new Set(nodes.map(node => node.status));
  for (const status of ['pending', 'active', 'done', 'failed', 'superseded', 'abandoned',
    'returned', 'open', 'pass', 'needs_changes']) {
    assert.ok(statuses.has(status), `no fixture produces a ${status} node`);
  }
});

test('an empty state still yields the attempt marker, and no state yields nothing', () => {
  const { nodes, edges } = experimentFigure({});
  assert.deepEqual(nodes.map(node => node.id), ['attempt:1']);
  assert.deepEqual(edges, []);
  assert.deepEqual(experimentFigure(), experimentFigure({ experiment: {} }));
});

test('the fan-out cap is per beat and per lane', () => {
  const { input, expected } = fixture('story_three_attempts_four_rounds');
  const { nodes } = experimentFigure(input);
  const shown = nodes.filter(node => node.type === 'artifact' && node.anchor === 'submission:3.1');
  assert.equal(shown.length, ARTIFACT_FANOUT_CAP);
  // The cap keeps the load-bearing files, nearest the spine first.
  assert.deepEqual(shown.slice(0, 2).map(node => node.meta.role), ['report', 'result']);
  const group = nodes.find(node => node.id === 'artifact_group:submission:3.1:evidence');
  assert.equal(group.meta.count, expected.nodes.find(n => n.id === group.id).meta.count);
  // A neighbouring round is untouched by 3.1's overflow.
  assert.equal(nodes.some(node => node.id === 'artifact_group:submission:3.4:evidence'), false);
});

test('an open gate outlives the workflow that opened it', () => {
  // Abandoning with a request still open leaves the gate on the figure, which
  // is why the open requests are read from /reviews and not from the
  // workflow's current review gate (it reports none here).
  const { input } = fixture('live_abandoned_open_gate');
  const { nodes } = experimentFigure(input);
  const gate = nodes.find(node => node.ref.kind === 'review_request');
  assert.equal(gate.status, 'open');
  assert.equal(gate.sublabel, 'awaiting verdict');
  assert.equal(nodes.find(node => node.id === 'attempt:1').status, 'abandoned');
});

test('a closed review request is not an open gate', () => {
  const { input } = fixture('live_complete');
  assert.ok(input.reviews.requests.length > 0, 'the fixture has no requests to filter');
  const { nodes } = experimentFigure(input);
  assert.equal(nodes.some(node => node.ref.kind === 'review_request'), false);
});

test('the live sandbox wins over an older released one', () => {
  const { input } = fixture('failed_round_and_odd_rows');
  const sandbox = experimentFigure(input).nodes.find(node => node.type === 'sandbox');
  assert.equal(sandbox.status, 'active');
  assert.equal(sandbox.sublabel, 'gpu_8x_h100');
  const stale = experimentFigure({ ...input, sandboxes: [input.sandboxes[0]] });
  assert.equal(stale.nodes.find(node => node.type === 'sandbox').status, 'done');
});
