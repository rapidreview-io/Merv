import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeGoal } from './taskGoal.js';

test('composeGoal writes the three-part Goal the brief parser reads', () => {
  const goal = composeGoal({
    summary: '  Build the shared dataset and harness. ',
    deliverables: '- the dataset\n2. a harness\n\n  a model definition  ',
    purpose: 'So that Every experiment trains on identical data.',
  });
  assert.equal(
    goal,
    'Build the shared dataset and harness.\n\n'
    + 'Deliver:\n- the dataset\n- a harness\n- a model definition\n\n'
    + 'So that every experiment trains on identical data.',
  );
});

test('composeGoal leaves out empty parts', () => {
  assert.equal(composeGoal({ summary: 'Just a headline', deliverables: '', purpose: '' }), 'Just a headline');
  assert.equal(composeGoal({ summary: '', deliverables: 'x', purpose: '' }), 'Deliver:\n- x');
});
