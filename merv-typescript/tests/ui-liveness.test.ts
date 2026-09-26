import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clock,
  decisionLiveness,
  duration,
  elapsed,
  leaseLiveness,
  runnerLiveness,
  term,
  type LeaseFacts,
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

test('a lease states its behaviour, and says nothing where the server did not', () => {
  const table: [LeaseFacts, string | null][] = [
    [{ status: 'offered', createdAt: at(120) }, 'offered · not taken up · for 2m'],
    [{ status: 'active', activatedAt: at(540), expiresAt: at(-3600) }, 'active · for 9m'],
    // Past its expiry and not yet swept: behaviour, not the lifecycle word.
    [
      { status: 'active', activatedAt: at(9000), expiresAt: at(240) },
      'lapsed · lease ran out · for 4m',
    ],
    [{ status: 'released', closedAt: at(720), outcome: 'halted' }, 'released · halted · 12m ago'],
    // An ending that says no more than the state word is not a second clause.
    [{ status: 'released', closedAt: at(720), outcome: 'released' }, 'released · 12m ago'],
    // The clock clause is dropped, not zeroed, when its stamp is missing.
    [{ status: 'expired', expiresAt: at(10_800) }, 'expired'],
    [{ status: 'quarantined' }, null],
    [{}, null],
  ];
  for (const [lease, phrase] of table)
    assert.equal(leaseLiveness(lease, now)?.phrase ?? null, phrase, JSON.stringify(lease));
  const tone = (lease: LeaseFacts) => leaseLiveness(lease, now)?.tone;
  assert.equal(tone({ status: 'active', activatedAt: at(540), expiresAt: at(-60) }), 'ok');
  assert.equal(tone({ status: 'active', expiresAt: at(60) }), 'bad');
  assert.equal(tone({ status: 'released', closedAt: at(60) }), 'dim');
  assert.equal(tone({ status: 'offered', createdAt: at(60) }), 'warn');
});

test('a verdict cannot outrun the payload it was drawn from', () => {
  const observedAt = new Date(now - 240_000).toISOString();
  // The page has been open four minutes on a payload that is four minutes old.
  const stale = clock(observedAt, observedAt, now, 8_000);
  assert.equal(stale.stale, true);
  assert.equal(stale.since, 240_000);
  // Anchored to the server's own clock, so a browser 10 minutes fast changes nothing.
  assert.equal(clock(observedAt, observedAt, now + 600_000, 8_000).at - now, 600_000);
  // A lease that had 60s left when the payload was read is still active: no
  // heartbeat since then has been seen, and absence of news is not an expiry.
  const lease: LeaseFacts = {
    status: 'active',
    activatedAt: new Date(now - 900_000).toISOString(),
    expiresAt: new Date(now - 180_000).toISOString(),
  };
  assert.equal(leaseLiveness(lease, stale)?.verdict, 'active');
  // The same lease read by a payload young enough to have seen the window close.
  const fresh = clock(new Date(now).toISOString(), new Date(now).toISOString(), now, 8_000);
  assert.equal(leaseLiveness(lease, fresh)?.phrase, 'lapsed · lease ran out · for 3m');
  // A bare millisecond reading is its own moment, so the old table still holds.
  assert.equal(leaseLiveness(lease, now)?.verdict, 'lapsed');
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
