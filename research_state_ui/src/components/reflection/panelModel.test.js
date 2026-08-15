import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBraid } from './braidModel.js';
import {
  consolidationSummary, debtMeter, expTimeline, gateSummary, hasGhost,
  lineageOf, outcomeOf, reviewHistory, roleWord, seedStrands, waveLenses, waveStory,
} from './panelModel.js';

const wave = (id, status, extra = {}) => ({
  id, status, title: id, attempt_index: 1,
  materialized_experiments: [], corpus: { terminal_experiments: [] },
  ...extra,
});

const review = (role, verdict, extra = {}) => ({
  id: `${role}:${verdict}:${extra.created_at || ''}`, role, verdict, synopsis: `${role} says ${verdict}`, ...extra,
});

// A braid with a seed, one published wave that consumed the seed and proposed
// two experiments, and one open wave the survivors dangle toward.
function braidFixture({ open = true } = {}) {
  const w1 = wave('w1', 'published', {
    corpus: {
      terminal_experiments: [{ id: 'seed', name: 'seed', status: 'complete' }],
      new_terminal_experiments: [{ id: 'seed' }],
    },
    materialized_experiments: [
      { experiment_id: 'a', name: 'alpha', status: 'complete', created_at: '2026-08-01' },
      { experiment_id: 'b', name: 'beta', status: 'running', created_at: '2026-08-02' },
    ],
  });
  const w2 = wave('w2', open ? 'reflecting' : 'published', {
    corpus: { terminal_experiments: [{ id: 'seed' }, { id: 'a' }], new_terminal_experiments: [{ id: 'a' }] },
  });
  const experiments = [
    { id: 'seed', name: 'seed', status: 'complete', created_at: '2026-07-01' },
    { id: 'a', name: 'alpha', status: 'complete' },
    { id: 'b', name: 'beta', status: 'running' },
    { id: 'hand', name: 'by-hand', status: 'planned', created_at: '2026-08-05' },
  ];
  return buildBraid([w1, w2], experiments);
}

test('roleWord humanizes known and unknown reviewer roles', () => {
  assert.equal(roleWord('experiment_reviewer'), 'experiment review');
  assert.equal(roleWord('human'), 'human review');
  assert.equal(roleWord('safety_reviewer'), 'safety review');
  assert.equal(roleWord('peer_review'), 'peer review');
});

test('reviewHistory sorts oldest first and words the verdict as an event', () => {
  const rows = reviewHistory([
    review('experiment_reviewer', 'pass', { created_at: '2026-08-03' }),
    review('design_reviewer', 'pass', { created_at: '2026-08-01' }),
    review('experiment_reviewer', 'needs_changes', { created_at: '2026-08-02', return_to: 'running' }),
  ]);
  assert.deepEqual(rows.map(r => [r.roleWord, r.verdictWord, r.returnTo, r.tone]), [
    ['design review', 'passed', '', 'supports'],
    ['experiment review', 'sent back', 'running', 'qualifies'],
    ['experiment review', 'passed', '', 'supports'],
  ]);
});

test('outcomeOf: finished work leads with the experiment review, live work with its latest review', () => {
  const reviews = [
    review('design_reviewer', 'pass', { created_at: '2026-08-01', synopsis: 'plan is fine' }),
    review('experiment_reviewer', 'pass', { created_at: '2026-08-03', synopsis: 'result holds' }),
  ];
  const done = outcomeOf({ tone: 'done' }, { reviews, conclusion: 'ignored when a synopsis exists' });
  assert.equal(done.eyebrow, 'Outcome');
  assert.equal(done.line, 'passed experiment review');
  assert.equal(done.text, 'result holds');
  assert.equal(done.tone, 'supports');

  // No review synopsis → the recorded conclusion stands in.
  const doneNoRv = outcomeOf({ tone: 'done' }, { reviews: [], conclusion: 'threshold met' });
  assert.equal(doneNoRv.text, 'threshold met');

  const live = outcomeOf({ tone: 'live' }, { reviews: reviews.slice(0, 1) });
  assert.equal(live.eyebrow, 'Latest review');
  assert.equal(live.line, 'design review · passed');
  assert.equal(live.text, 'plan is fine');

  const sentBack = outcomeOf({ tone: 'live' }, {
    reviews: [review('experiment_reviewer', 'needs_changes', { created_at: '2026-08-04', return_to: 'running', synopsis: 'seeds differ' })],
  });
  assert.equal(sentBack.line, 'experiment review · sent back to running');
  assert.equal(sentBack.tone, 'qualifies');

  // A design-review pass must not masquerade as the outcome of a failure.
  const failed = outcomeOf({ tone: 'failed' }, { reviews: reviews.slice(0, 1) });
  assert.equal(failed.line, 'marked failed');
  assert.equal(failed.text, '');
  const failedRv = outcomeOf({ tone: 'failed' }, {
    reviews: [review('experiment_reviewer', 'fail', { created_at: '2026-08-04', synopsis: 'did not hold' })],
  });
  assert.equal(failedRv.line, 'failed experiment review');
  assert.equal(failedRv.text, 'did not hold');

  assert.equal(outcomeOf({ tone: 'abandoned' }, {}).line, 'abandoned');
  assert.equal(outcomeOf({ tone: 'queued' }, { reviews: [] }), null);
});

test('lineageOf names the proposer, the origin for seeds, and where uncovered work is headed', () => {
  const braid = braidFixture();
  const by = Object.fromEntries(braid.strands.map(s => [s.id, s]));

  const seed = lineageOf(by.seed, braid);
  assert.equal(seed.from.kind, 'origin');
  assert.equal(seed.to.kind, 'wave');
  assert.equal(seed.to.epoch.id, 'w1');
  assert.equal(seed.to.word, 'consolidated by');

  const alpha = lineageOf(by.a, braid);
  assert.equal(alpha.from.kind, 'wave');
  assert.equal(alpha.from.epoch.id, 'w1');
  assert.equal(alpha.to.epoch.id, 'w2');

  // Still running, proposed by w1, uncovered: will feed the open wave.
  const beta = lineageOf(by.b, braid);
  assert.equal(beta.to.kind, 'wave');
  assert.equal(beta.to.epoch.id, 'w2');
  assert.equal(beta.to.pending, true);
  assert.equal(beta.to.word, 'will feed');

  // Added by hand mid-stream: no proposer, dangling toward the open wave.
  const hand = lineageOf(by.hand, braid);
  assert.equal(hand.from.kind, 'none');
  assert.equal(hand.to.epoch.id, 'w2');
});

test('lineageOf points uncovered work at the ghost when nothing is open', () => {
  const braid = braidFixture({ open: false });
  assert.equal(hasGhost(braid), true);
  const beta = braid.strands.find(s => s.id === 'b');
  const l = lineageOf(beta, braid);
  assert.equal(l.to.kind, 'ghost');
  assert.equal(l.to.word, 'will feed');
  const seeds = seedStrands(braid).map(s => s.id);
  assert.deepEqual(seeds, ['seed']);
});

test('gateSummary leads with blockers and counts lens items separately', () => {
  const g = gateSummary({
    status: 'reflecting', transition: 'submit_reflections', leads_to: 'synthesizing', ready: false,
    items: [
      { id: 'lens:a', kind: 'reflection_lens', label: 'A reflection submitted', satisfied: true },
      { id: 'lens:b', kind: 'reflection_lens', label: 'B reflection submitted', satisfied: false },
      { id: 'art', kind: 'artifact', label: 'Plan submitted and valid.', satisfied: true },
      { id: 'rv', kind: 'review', label: 'Design review passed', satisfied: false },
    ],
  });
  assert.equal(g.leadsTo, 'synthesizing');
  assert.equal(g.lensesMissing, 1);
  assert.deepEqual(g.items.map(i => [i.label, i.satisfied]), [
    ['Design review passed', false],
    ['Plan submitted and valid', true],
  ]);
  assert.equal(g.missing, 1);
  assert.equal(gateSummary(null), null);
});

test('waveLenses joins roster, coverage, and each lens TLDR; waveStory reads the reflection doc', () => {
  const w = {
    roster: [{ id: 'amplify', title: 'Amplify what works', core: true }, { id: 'cost', title: 'Cost', charter: 'Price it.' }],
    reflection_coverage: { lenses: [
      { lens_id: 'amplify', covered: true, artifact_id: 'art_1' },
      { lens_id: 'cost', covered: false },
    ] },
    current_attempt_artifacts: [
      { role: 'reflection_lens_doc', lens_id: 'amplify', tldr: 'more of this' },
      { role: 'reflection_doc', tldr: 'the wave in one line' },
    ],
  };
  const lenses = waveLenses(w);
  assert.deepEqual(lenses.map(l => [l.id, l.covered, l.artifactId, l.tldr, l.charter]), [
    ['amplify', true, 'art_1', 'more of this', ''],
    ['cost', false, null, '', 'Price it.'],
  ]);
  assert.equal(waveStory(w), 'the wave in one line');
  assert.equal(waveStory(null), '');
});

test('consolidationSummary keeps the summary and only the promoted decisions', () => {
  const s = consolidationSummary({ consolidation: {
    proposal: { summary: 'No source changes.' },
    decisions: [
      { experiment_name: 'x', disposition: 'reviewed_not_used' },
      { experiment_name: 'y', disposition: 'adapted' },
      { experiment_name: 'z', disposition: 'pending' },
    ],
  } });
  assert.equal(s.summary, 'No source changes.');
  assert.deepEqual(s.promoted, [{ name: 'y', disposition: 'adapted' }]);
  assert.equal(consolidationSummary({ consolidation: { proposal: null, decisions: [{ disposition: 'pending' }] } }), null);
});

test('debtMeter reads the thresholds and flags nudge and block', () => {
  assert.equal(debtMeter(null), null);
  assert.equal(debtMeter({ new_terminal_since_publish: 2 }), null);
  const m = debtMeter({ new_terminal_since_publish: 3, nudge_new_terminal_threshold: 3, block_new_terminal_threshold: 5 });
  assert.deepEqual(m, { n: 3, m: 5, nudge: 3, blocked: false, nudged: true });
  assert.equal(debtMeter({ new_terminal_since_publish: 5, block_new_terminal_threshold: 5 }).blocked, true);
  assert.equal(debtMeter({ new_terminal_since_publish: 1, block_new_terminal_threshold: 5, experiment_create_blocked: true }).blocked, true);
});

test('expTimeline gives finished work a span and live work a since', () => {
  const now = Date.parse('2026-08-10T00:00:00Z');
  const done = expTimeline({ tone: 'done' }, { created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-03T00:00:00Z' }, now);
  assert.equal(done.ended, '2026-08-03T00:00:00Z');
  assert.equal(done.spanMs, 2 * 86400000);
  assert.equal(done.sinceMs, null);
  assert.equal(done.endWord, 'finished');
  const live = expTimeline({ tone: 'live' }, { created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-08T00:00:00Z' }, now);
  assert.equal(live.ended, null);
  assert.equal(live.sinceMs, 2 * 86400000);
  assert.equal(live.endWord, '');
});
