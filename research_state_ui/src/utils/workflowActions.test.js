import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowActionButtons } from './workflowActions.js';

const primary = {
  submit_design: { transition: 'submit_design', label: 'Submit for design review' },
  submit_delivery: { transition: 'submit_delivery', label: 'Submit delivery for review' },
};
const secondary = [
  { transition: 'mark_failed', label: 'Mark failed' },
  { transition: 'abandon', label: 'Abandon' },
];

test('canonical available edges enable the suggested experiment or task submission', () => {
  for (const action of ['submit_design', 'submit_delivery']) {
    assert.deepEqual(workflowActionButtons({
      suggested_action: { action },
      available_actions: [{ action }, { action: 'abandon' }],
      allowed_actions: ['workflow.transition'],
    }, primary, secondary), { primary: primary[action], secondary: [secondary[1]] });
  }
});

test('a blocked suggested action never becomes a button from tool-level permission', () => {
  assert.deepEqual(workflowActionButtons({
    suggested_action: { action: 'submit_design', blockers: [{ reason: 'The plan needs evidence.' }] },
    available_actions: [{ action: 'mark_failed' }],
    allowed_actions: ['experiment.transition'],
    next_action: 'submit_design_for_review',
  }, primary, secondary), { primary: null, secondary: [secondary[0]] });
});

test('automatic approval and obsolete ready/start guidance do not create manual buttons', () => {
  for (const action of ['approve_design', 'mark_ready_to_run', 'start_running']) {
    assert.deepEqual(workflowActionButtons({
      suggested_action: { action }, available_actions: [{ action }],
      next_action: action, allowed_actions: ['experiment.transition'],
    }, primary, secondary), { primary: null, secondary: [] });
  }
});

test('historical tool permission and terminal snapshots cannot authorize transitions', () => {
  for (const workflow of [null, { outcome: 'completed', available_actions: [] },
    { next_action: 'submit_design_for_review', allowed_actions: ['experiment.transition'] }]) {
    assert.deepEqual(workflowActionButtons(workflow, primary, secondary), { primary: null, secondary: [] });
  }
});
