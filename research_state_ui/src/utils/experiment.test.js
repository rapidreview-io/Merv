import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewQueue, statusLine, targetPath } from './experiment.js';

test('only unanswered requests are open; submitted and expired ones are history', () => {
  const requests = [
    { id: 'a', status: 'requested' }, { id: 'b', status: 'started' },
    { id: 'c', status: 'submitted' }, { id: 'd', status: 'expired' },
  ];
  const { openRequests, byTarget } = reviewQueue({ requests, reviews: [{ target_id: 'exp_1' }, { target_id: 'exp_1' }] });
  assert.deepEqual(openRequests.map(r => r.id), ['a', 'b']);
  assert.equal(byTarget.get('exp_1').length, 2);
  assert.deepEqual(reviewQueue({}).openRequests, []);
});

test('review targets link to their own pages, reflections included', () => {
  assert.equal(targetPath('experiment', 'exp_1'), '/experiments/exp_1');
  assert.equal(targetPath('reflection', 'syn_1'), '/reflection/syn_1');
  assert.equal(targetPath('unknown', 'x'), null);
});

test('a review state says who is awaited, never "you"', () => {
  assert.equal(statusLine({}, 'design_review', 0), 'design review · awaiting design reviewer');
  assert.equal(statusLine({}, 'failed', 0), 'failed');
});
