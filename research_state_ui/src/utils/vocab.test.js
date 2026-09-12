import assert from 'node:assert/strict';
import test from 'node:test';

import { agentPrompt, gateLabel, reviewKind, stateLabel, stateLine, transitionButton } from './vocab.js';

test('states, transitions and roles read as one vocabulary; unknown ids fall back to words', () => {
  assert.equal(stateLabel('experiment_review'), 'Experiment review');
  assert.equal(stateLabel('some_new_state'), 'some new state');
  assert.deepEqual(transitionButton('submit_design'), { transition: 'submit_design', label: 'Submit for design review' });
  assert.equal(reviewKind('experiment_reviewer'), 'experiment review');
  assert.equal(reviewKind('human'), 'human review');
  assert.equal(reviewKind('safety_reviewer'), 'safety review');
  assert.equal(reviewKind('peer_review'), 'peer review');
});

test('a review gate names the reviewer being waited on, never the person reading', () => {
  assert.equal(gateLabel('design_reviewer_required', 'design_review'), 'Waiting for a design reviewer');
  assert.equal(gateLabel('consolidation_reviewer_required'), 'Waiting for a consolidation reviewer');
  assert.equal(gateLabel('results_report_required', 'running'), 'Results report missing');
  assert.equal(gateLabel('', 'running'), 'Running');
  assert.equal(stateLine('design_review'), 'design review · awaiting design reviewer');
  assert.equal(stateLine('ready_to_run'), 'ready to run');
});

test("the agent's move is one pasteable sentence about the named record, or nothing while waiting", () => {
  assert.equal(agentPrompt('request_review', { state: 'design_review', name: 'probe' }), 'review the plan for probe');
  assert.equal(agentPrompt('request_review', { state: 'experiment_review', name: 'probe' }), 'review the results of probe');
  assert.equal(agentPrompt('run_experiment_and_retain_results', { name: 'probe' }), 'run probe and retain its results');
  assert.equal(agentPrompt('create_claim_or_experiment', {}), 'create the first claim or experiment');
  assert.equal(agentPrompt('do_something_new', { name: 'probe' }), 'do something new for probe');
  for (const idle of ['none', '', null, 'wait_for_sandbox']) assert.equal(agentPrompt(idle, { name: 'probe' }), null);
});
