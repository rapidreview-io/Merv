import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowExecutionPolicy } from '@merv/contracts';
import { computeEpoch, computeGuidance, computeProfile } from '@merv/sessions/compute';

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
  // A planned experiment measures feasibility.
  assert.equal(computeProfile(policy(true, ephemeral), 'plan'), 'plan');
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
  assert.match(computeGuidance('execute'), /Sandboxes MCP/);
  assert.match(computeGuidance('execute'), /Execute only the authorized work/);
  assert.match(computeGuidance('check'), /at most 300 seconds/);
  assert.doesNotMatch(computeGuidance('check'), /Execute only/);
  assert.match(computeGuidance('plan'), /GPUs included, and storage/);
  assert.match(computeGuidance('plan'), /within an hour/);
  assert.match(computeGuidance('plan'), /Do not run full training/);
  assert.doesNotMatch(computeGuidance('plan'), /300 seconds/);
});

test('every profile says how captures register and how inputs reach a machine', () => {
  for (const profile of ['execute', 'plan', 'check'] as const) {
    const text = computeGuidance(profile);
    // Sandboxes' capture registration titles each collection with these ids first.
    assert.match(text, /titled "Compute capture <workflow id> \/ <node id>"/);
    assert.match(
      text,
      /a successful one shortly after it ends and any other once its workflow finishes/,
    );
    assert.match(text, /never by recency/);
    assert.match(text, /job logs included/);
    assert.match(text, /after ten minutes, ask the owner/);
    assert.match(
      text,
      /stage node: upload workspace files with storage_upload and storage_complete/,
    );
    assert.match(text, /metadata\.outputObjects/);
    assert.match(text, /Never paste file contents or signed URLs into job commands/);
  }
});
