import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clock,
  decisionLiveness,
  duration,
  elapsed,
  runnerLiveness,
  term,
} from '../packages/ui/web/liveness.js';

const now = Date.parse('2026-09-16T12:00:00.000Z');
const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();

test('a countdown counts to 0s; an elapsed clock reads at the coarseness a person needs', () => {
  const countdowns: [number, string][] = [
    [-5_000, '0s'],
    [0, '0s'],
    [21_000, '21s'],
    [381_000, '6m 21s'],
    [11_100_000, '3h 5m'],
    [187_200_000, '2d 4h'],
  ];
  for (const [ms, written] of countdowns) assert.equal(duration(ms), written);
  const clocks: [number, string][] = [
    [41_000, '41s'],
    [540_000, '9m'],
    [10_800_000, '3h'],
    [259_200_000, '3d'],
  ];
  for (const [ms, written] of clocks) assert.equal(elapsed(ms), written);
});

test('an enum reads as words and an absent one as the em dash, in one place', () => {
  assert.equal(term('halted_by_operator'), 'halted by operator');
  assert.equal(term(undefined), '—');
  assert.equal(term(''), '—');
});

test('a runner states the answer its last lease request received, or nothing', () => {
  const phrase = (runner: Parameters<typeof decisionLiveness>[0]) =>
    decisionLiveness(runner, now)?.phrase ?? null;
  assert.equal(
    phrase({ lastDecision: 'capacity_full', lastDecisionAt: at(120) }),
    'declined · capacity full · 2m ago',
  );
  assert.equal(phrase({ lastDecision: 'offered', lastDecisionAt: at(5) }), 'dispatched · 5s ago');
  assert.equal(phrase({ lastDecision: 'settings_pending' }), 'declined · settings pending');
  assert.equal(phrase({}), null);
});

test('a runner is present or offline, and silent where presence was not reported', () => {
  const phrase = (runner: Parameters<typeof runnerLiveness>[0]) =>
    runnerLiveness(runner, now)?.phrase ?? null;
  assert.equal(phrase({ live: true, lastSeenAt: at(12) }), 'live · seen 12s ago');
  // Quiet is a lease that has made no call; a machine with no heartbeat is offline.
  assert.equal(phrase({ live: false, lastSeenAt: at(180) }), 'offline · last seen 3m ago');
  assert.equal(phrase({ live: true }), 'live');
  assert.equal(phrase({ lastSeenAt: at(10) }), null);
});
