import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBraid, coveredDelta, laneOffset, openAnatomy, strandGroups, strandTone } from './braidModel.js';

const wave = (id, status, extra = {}) => ({
  id, status, title: id, attempt_index: 1,
  materialized_experiments: [], corpus: { terminal_experiments: [] },
  ...extra,
});

test('coveredDelta prefers the explicit delta', () => {
  const w = wave('w2', 'published', {
    corpus: {
      terminal_experiments: [{ id: 'a' }, { id: 'b' }],
      new_terminal_experiments: [{ id: 'b' }],
    },
  });
  assert.deepEqual(coveredDelta(w, null), ['b']);
});

test('coveredDelta falls back to subtracting the previous snapshot', () => {
  const w1 = wave('w1', 'published', { corpus: { terminal_experiments: [{ id: 'a' }] } });
  const w2 = wave('w2', 'published', { corpus: { terminal_experiments: [{ id: 'a' }, { id: 'b' }] } });
  assert.deepEqual(coveredDelta(w2, w1), ['b']);
  assert.deepEqual(coveredDelta(w1, null), ['a']);
});

test('buildBraid joins spawn and cover edges across waves', () => {
  const w1 = wave('w1', 'published', {
    corpus: { terminal_experiments: [{ id: 'e0', name: 'seed', status: 'complete' }] },
    materialized_experiments: [
      { experiment_id: 'eA', name: 'alpha', status: 'complete', created_at: '2026-08-01' },
    ],
  });
  const w2 = wave('w2', 'reflection_review', {
    attempt_index: 2,
    corpus: {
      terminal_experiments: [{ id: 'e0' }, { id: 'eA', attempt_index: 3 }],
      new_terminal_experiments: ['eA'],
    },
  });
  const live = [
    { id: 'eA', status: 'complete', attempt_index: 3 },
    { id: 'eU', name: 'user-made', status: 'running', created_at: '2026-08-05' },
  ];
  const { epochs, strands } = buildBraid([w1, w2], live);
  assert.equal(epochs.length, 2);
  assert.equal(epochs[0].isOpen, false);
  assert.equal(epochs[1].isOpen, true);
  const byId = Object.fromEntries(strands.map(s => [s.id, s]));
  assert.equal(byId.e0.coverIdx, 0);              // consolidated into wave 1
  assert.equal(byId.e0.spawnIdx, -1);             // pre-wave experiment
  assert.equal(byId.eA.spawnIdx, 0);              // born from wave 1
  assert.equal(byId.eA.coverIdx, 1);              // absorbed by wave 2
  assert.equal(byId.eA.attemptIndex, 3);
  assert.equal(byId.eU.coverIdx, -1);             // open-ended: reflection debt
  assert.equal(byId.eU.tone, 'live');
});

test('first covering wave wins over later snapshots', () => {
  const w1 = wave('w1', 'published', {
    corpus: { terminal_experiments: [{ id: 'x' }], new_terminal_experiments: ['x'] },
  });
  const w2 = wave('w2', 'published', {
    corpus: { terminal_experiments: [{ id: 'x' }], new_terminal_experiments: ['x'] },
  });
  const { strands } = buildBraid([w1, w2], []);
  assert.equal(strands.find(s => s.id === 'x').coverIdx, 0);
});

test('strandGroups buckets by gap and open-endedness', () => {
  const strands = [
    { id: 'a', spawnIdx: 0, coverIdx: 1 },
    { id: 'b', spawnIdx: -1, coverIdx: 1 },
    { id: 'c', spawnIdx: -1, coverIdx: -1 },
  ];
  const g = strandGroups(strands, 2);
  assert.deepEqual([...g.keys()].sort(), ['g0', 'open', 'pre1']);
});

test('laneOffset fans symmetrically', () => {
  assert.deepEqual([0, 1, 2, 3].map(laneOffset), [1, -1, 2, -2]);
});

test('strandTone stays lifecycle-honest', () => {
  assert.equal(strandTone('complete'), 'done');
  assert.equal(strandTone('experiment_review'), 'queued');
  assert.equal(strandTone('running'), 'live');
});

test('openAnatomy summarizes lens fan-in and gates', () => {
  const a = openAnatomy({
    status: 'reflection_review', attempt_index: 2, revision_context: 'redo lens 3',
    reflection_coverage: { lenses: [{ lens_id: 'l1', covered: true }, { lens_id: 'l2', covered: false }] },
    gate_checklist: { items: [{ kind: 'review', status: 'requested' }] },
    reviews: [],
    consolidation: { coverage: { considered: 3, total: 5 }, advance: { status: 'bound' } },
  });
  assert.equal(a.lensesCovered, 1);
  assert.equal(a.reviewState, 'requested');
  assert.equal(a.consolidation.advanceStatus, 'bound');
  assert.equal(openAnatomy(null), null);
});

test('buildBraid carries task strands beside experiments', () => {
  const w1 = {
    id: 'w1', status: 'published',
    materialized_experiments: [{ experiment_id: 'exp_a', name: 'a', status: 'complete' }],
    materialized_tasks: [{ task_id: 'task_p', name: 'prep-data', status: 'in_progress' }],
    corpus: { new_terminal_experiments: [], new_terminal_tasks: [{ id: 'task_0', name: 'seed', status: 'done' }] },
  };
  const { strands } = buildBraid([w1], [{ id: 'exp_a', status: 'complete' }], [
    { id: 'task_p', name: 'prep-data', status: 'in_review' },
    { id: 'task_live', name: 'lit-sweep', status: 'in_progress' },
  ]);
  const byId = Object.fromEntries(strands.map(s => [s.id, s]));
  assert.equal(byId.task_p.kind, 'task');
  assert.equal(byId.task_p.spawnIdx, 0);           // born from wave 1
  assert.equal(byId.task_p.status, 'in_review');   // live row wins
  assert.equal(byId.task_p.tone, 'queued');
  assert.equal(byId.task_0.coverIdx, 0);           // read by wave 1
  assert.equal(byId.task_0.tone, 'done');
  assert.equal(byId.task_live.tone, 'live');
  assert.equal(byId.task_live.coverIdx, -1);
  assert.equal(byId.exp_a.kind, 'experiment');
});
