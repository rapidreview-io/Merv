import assert from 'node:assert/strict';
import test from 'node:test';

import { summarize } from '../components/autorunSummary.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');
const runner = (hostname, secondsAgo, capacity = 2) => ({
  runner_ref: hostname,
  machine: { hostname },
  capacity,
  last_seen_at: new Date(NOW - secondsAgo * 1000).toISOString(),
});

test('nothing fetched yet is unknown, and an empty project reads not connected', () => {
  assert.equal(summarize({ now: NOW }).known, false);
  const empty = summarize({ runners: [], sessions: [], fetchedAt: NOW, now: NOW });
  assert.deepEqual(
    [empty.known, empty.runnerCount, empty.running, empty.state, empty.tone],
    [true, 0, 0, 'Not connected', 'off'],
  );
});

test('running jobs and live machines aggregate; the first live machine names the strip', () => {
  const summary = summarize({
    runners: [runner('stale-box', 400, 4), runner('lucia.local', 5, 3), runner('gpu-box', 10, 1)],
    sessions: [{ status: 'active' }, { status: 'offered' }, { status: 'released' }],
    fetchedAt: NOW,
    now: NOW,
  });
  assert.equal(summary.running, 2);
  assert.equal(summary.liveRunnerCount, 2);
  assert.equal(summary.machineName, 'lucia.local');
  assert.equal(summary.capacity, 4); // only live machines count
  assert.equal(summary.state, 'Live');
});

test('a paired machine that went quiet keeps its name and reads stale', () => {
  const summary = summarize({ runners: [runner('lucia.local', 120)], sessions: [], fetchedAt: NOW, now: NOW });
  assert.equal(summary.liveRunnerCount, 0);
  assert.equal(summary.state, 'Stale');
  assert.equal(summary.machineName, 'lucia.local');
});
