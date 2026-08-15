import assert from 'node:assert/strict';
import test from 'node:test';

import { autorunHeadline } from './autorunHeadline.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');
const runner = (hostname, ageMs, extra = {}) => ({
  runner_ref: hostname,
  machine: { hostname },
  last_seen_at: new Date(NOW - ageMs).toISOString(),
  capacity: 2,
  ...extra,
});
const active = { status: 'active' };

test('no machine paired reads as setup, whatever else is true', () => {
  const out = autorunHeadline({ dispatch: true, runners: [], sessions: [active], now: NOW });
  assert.equal(out.tone, 'quiet');
  assert.match(out.text, /No machine paired yet/);
});

test('unknown dispatch says nothing rather than guessing', () => {
  assert.deepEqual(
    autorunHeadline({ dispatch: null, runners: [runner('a', 0)], now: NOW }),
    { text: '', tone: '' },
  );
});

test('dispatch off names what keeps running and what will not start', () => {
  const idle = autorunHeadline({ dispatch: false, runners: [runner('a', 0)], sessions: [], now: NOW });
  assert.equal(idle.tone, 'off');
  assert.equal(idle.text, 'Dispatch is off — nothing will start until it is on.');
  const busy = autorunHeadline({ dispatch: false, runners: [runner('a', 0)], sessions: [active, active], now: NOW });
  assert.equal(busy.text, 'Dispatch is off — 2 jobs still running; nothing new will start.');
});

test('no live machine tells the user where to start the runner', () => {
  const one = autorunHeadline({ dispatch: true, runners: [runner('lucia', 10 * 60_000)], now: NOW });
  assert.equal(one.tone, 'warning');
  assert.equal(one.text, 'No machine is live — start the runner on lucia.');
  const many = autorunHeadline({
    dispatch: true, runners: [runner('a', 10 * 60_000), runner('b', 60 * 60_000)], waiting: 3, now: NOW,
  });
  assert.equal(many.text, 'No machine is live · 3 items waiting — start the runner.');
});

test('live and running counts machines, jobs, and the queue when known', () => {
  const out = autorunHeadline({
    dispatch: true, runners: [runner('a', 0), runner('b', 5_000)], sessions: [active, active, { status: 'released' }], waiting: 3, now: NOW,
  });
  assert.equal(out.tone, 'live');
  assert.equal(out.text, 'Dispatching to 2 live machines · 2 running · 3 waiting.');
  const unknownQueue = autorunHeadline({ dispatch: true, runners: [runner('a', 0)], sessions: [active], now: NOW });
  assert.equal(unknownQueue.text, 'Dispatching to 1 live machine · 1 running.');
});

test('live and idle distinguishes an empty queue from an unknown one', () => {
  const unknown = autorunHeadline({ dispatch: true, runners: [runner('a', 0)], now: NOW });
  assert.equal(unknown.text, '1 live machine · idle.');
  const empty = autorunHeadline({ dispatch: true, runners: [runner('a', 0)], waiting: 0, now: NOW });
  assert.equal(empty.text, '1 live machine · nothing to run right now — no experiment is awaiting an agent.');
  const queued = autorunHeadline({ dispatch: true, runners: [runner('a', 0)], waiting: 2, now: NOW });
  assert.equal(queued.text, '1 live machine · 2 items waiting to start.');
});

test('rejected settings are appended as the attention clause', () => {
  const out = autorunHeadline({
    dispatch: true,
    runners: [runner('lucia', 0, { inventory: { settings_error: 'codex has no model' } })],
    sessions: [active],
    now: NOW,
  });
  assert.equal(out.text, 'Dispatching to 1 live machine · 1 running. lucia rejected its settings — open the machine to fix them.');
});
