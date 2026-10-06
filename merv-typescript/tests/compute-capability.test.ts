import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowExecutionPolicy } from '@merv/contracts';
import { computeEpoch, computeGuidance, computeProfile } from '@merv/sandboxes/compute-capability';

const policy = (readOnly: boolean, workspace?: WorkflowExecutionPolicy['workspace']) =>
  ({ readOnly, tools: [], ...(workspace ? { workspace } : {}) }) as WorkflowExecutionPolicy;
const persistent = {
  mode: 'persistent',
  namespace: 'tasks',
  base: 'reference:base',
  perBase: false,
  retain: true,
  advancesCentral: false,
  driver: 'code.v2',
} as const;
const ephemeral = {
  mode: 'ephemeral',
  namespace: 'task-reviews',
  base: 'reference:code',
  retain: false,
  driver: 'code.v2',
} as const;

test('the default profile executes only writable work with a persistent workspace', () => {
  // Task work and a running experiment.
  assert.equal(computeProfile(policy(false, persistent)), 'execute');
  // Task review and experiment reviews.
  assert.equal(computeProfile(policy(true, ephemeral)), 'check');
  // A planned experiment and every reflection stage: no workspace.
  assert.equal(computeProfile(policy(false)), 'check');
  assert.equal(computeProfile(policy(true)), 'check');
  assert.equal(computeProfile(policy(false, ephemeral)), 'check');
  assert.equal(computeProfile(policy(true, persistent)), 'check');
});

test('a unit overrides the profile with computeProfile, and an unknown one grants nothing', () => {
  // Conflict-resolution service tasks.
  assert.equal(computeProfile(policy(false, persistent), 'none'), 'none');
  assert.equal(computeProfile(policy(true), 'execute'), 'execute');
  assert.equal(computeProfile(policy(false, persistent), 'check'), 'check');
  assert.equal(computeProfile(policy(false, persistent), 'gpu'), 'none');
  assert.equal(computeProfile(policy(false, persistent), ['execute']), 'none');
});

test('the epoch is workflow data computeEpoch when set, else the revision', () => {
  assert.equal(computeEpoch({ computeEpoch: '2:running' }, 9), '2:running');
  assert.equal(computeEpoch({}, 9), '9');
  assert.equal(computeEpoch({ computeEpoch: 3 }, 9), '9');
  assert.equal(computeEpoch({ computeEpoch: '' }, 9), '9');
  assert.equal(computeEpoch({ computeEpoch: 'has space' }, 9), '9');
});

test('guidance follows the profile', () => {
  assert.equal(computeGuidance('none'), '');
  assert.match(computeGuidance('execute'), /native Sandboxes MCP/);
  assert.match(computeGuidance('execute'), /Execute only the authorized work/);
  assert.match(computeGuidance('check'), /at most 300 seconds/);
  assert.doesNotMatch(computeGuidance('check'), /Execute only/);
});
