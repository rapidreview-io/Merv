import assert from 'node:assert/strict';
import test from 'node:test';

import { runnerPresentation } from './runnerPresentation.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');
const machine = { hostname: 'lucia.local', system: 'Darwin', architecture: 'arm64' };

function row(overrides = {}) {
  return {
    runner_ref: 'ref-24-chars-000000000000',
    machine,
    last_seen_at: new Date(NOW - 5_000).toISOString(),
    live: true,
    desired_version: 0,
    applied_version: 0,
    inventory: {},
    ...overrides,
  };
}

test('a runner seen within 45s is live and identified by its machine', () => {
  const view = runnerPresentation(row(), NOW);
  assert.equal(view.state, 'Live');
  assert.equal(view.tone, 'live');
  assert.equal(view.machineName, 'lucia.local');
  assert.equal(view.machineDetails, 'macOS · arm64');
  assert.equal(view.settings, '');
});

test('a runner unseen for a few minutes is stale, then offline', () => {
  const stale = runnerPresentation(
    row({ live: false, last_seen_at: new Date(NOW - 120_000).toISOString() }),
    NOW,
  );
  assert.equal(stale.state, 'Stale');
  assert.equal(stale.tone, 'warning');
  const offline = runnerPresentation(
    row({ live: false, last_seen_at: new Date(NOW - 10 * 60_000).toISOString() }),
    NOW,
  );
  assert.equal(offline.state, 'Offline');
  assert.equal(offline.tone, 'error');
});

test('no runner at all reads as not connected', () => {
  const view = runnerPresentation(null, NOW);
  assert.equal(view.state, 'Not connected');
  assert.equal(view.tone, 'off');
  assert.equal(view.machineName, 'Runner');
});

test('settings pending and rejected badges come from versions and inventory', () => {
  const pending = runnerPresentation(row({ desired_version: 3, applied_version: 2 }), NOW);
  assert.equal(pending.settings, 'Settings pending');
  assert.equal(pending.settingsTone, 'warning');
  const waiting = runnerPresentation(
    row({
      desired_version: 3,
      applied_version: 2,
      inventory: { pending: { reason: 'workspace change waits for 2 running jobs' } },
    }),
    NOW,
  );
  assert.equal(waiting.settings, 'Settings pending — workspace change waits for 2 running jobs');
  const offlinePending = runnerPresentation(
    row({
      desired_version: 1,
      applied_version: 0,
      live: false,
      last_seen_at: new Date(NOW - 10 * 60_000).toISOString(),
    }),
    NOW,
  );
  assert.equal(offlinePending.settings, 'Settings pending — applies when the runner reconnects');
  const rejected = runnerPresentation(
    row({ desired_version: 3, applied_version: 3, inventory: { settings_error: 'codex: unsupported platform field(s): command' } }),
    NOW,
  );
  assert.equal(rejected.settings, 'Settings rejected: codex: unsupported platform field(s): command');
  assert.equal(rejected.settingsTone, 'error');
});
