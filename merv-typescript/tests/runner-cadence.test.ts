import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Refusal,
  machine,
  node,
  offer,
  server,
  until,
  type Body,
} from './fixtures/runner-stand-in.js';

// Cadence: presence, lease retries, session heartbeat and deadline pushes happen only when they
// change something, so an idle runner costs the server almost nothing.

test('an idle minute costs at most five presences and thirteen leases per profile', async (t) => {
  const fake = server(() => null);
  let now = Date.now();
  const f = machine(t, [node('a'), node('b')], fake.fetch, { clock: () => now });
  const runner = f.make();
  await runner.start();
  for (let second = 1; second <= 60; second++) {
    now += 1_000;
    await runner.tick();
  }
  const presences = fake.calls.filter((call) => call.path === '/sessions/runners/heartbeat');
  assert.ok(presences.length <= 5, `${presences.length} presences`);
  for (const profile of ['a', 'b'])
    assert.ok(fake.leases(profile).length <= 13, `${fake.leases(profile).length} leases`);
  assert.equal(runner.snapshot().state, 'idle');
});

test('a decline backs off only its own profile, for five seconds', async (t) => {
  // b's lease replies are lost, so its request is kept and asked again on every tick.
  const fake = server((body) =>
    body.platform.name === 'a' ? null : new Refusal(503, 'state_busy'),
  );
  let now = Date.now();
  const f = machine(t, [node('a'), node('b')], fake.fetch, { clock: () => now });
  const runner = f.make();
  await runner.start();
  for (let second = 1; second <= 4; second++) {
    now += 1_000;
    await runner.tick();
  }
  assert.equal(fake.leases('a').length, 1, 'a is not asked again within 5 s of its decline');
  assert.equal(fake.leases('b').length, 5, 'b is asked on every tick');
  now += 1_000;
  await runner.tick();
  assert.equal(fake.leases('a').length, 2);
});

test('a settings_pending decline sends presence at the next cycle, not 15 s later', async (t) => {
  const fake = server(() => 'settings_pending');
  let now = Date.now();
  const f = machine(t, [node('a')], fake.fetch, { clock: () => now });
  const runner = f.make();
  await runner.start();
  const presences = () =>
    fake.calls.filter((call) => call.path === '/sessions/runners/heartbeat').length;
  const before = presences();
  now += 1_000;
  await runner.tick();
  assert.equal(presences(), before + 1);
  now += 1_000;
  await runner.tick();
  assert.equal(presences(), before + 1, 'unchanged presence waits again once sent');
});

test('after a restart, a kept request for a changed platform is asked once and completed', async (t) => {
  const answers: Body[] = [];
  const fake = server((body) => {
    answers.push(body);
    return body.platform.model === 'old-model' ? new Refusal(409, 'platform_mismatch') : null;
  });
  const f = machine(t, [node('a')], fake.fetch);
  const ledger = f.ledger();
  const kept = ledger.request({ name: 'a', harness: 'command', model: 'old-model' });
  ledger.close();
  const runner = f.make();
  await runner.start();
  await runner.tick();
  assert.deepEqual(
    answers.filter((body) => body.requestId === kept.requestId).length,
    1,
    'a final answer is recorded, never replayed',
  );
  assert.equal(runner.snapshot().pendingRequests, 0);
  assert.ok(
    answers.some((body) => body.requestId !== kept.requestId),
    'a fresh request follows',
  );
});

test('a launch that activates late still gets the deadline its session slid to', async (t) => {
  // Offered with little time left, as a launch activating near the end of its offer window is.
  const work = offer('late', { expiresAt: new Date(Date.now() + 8_000).toISOString() });
  let offered = false;
  const fake = server(() => (offered ? null : ((offered = true), work)));
  const f = machine(t, [node('a', 'setInterval(()=>{},1000)')], fake.fetch);
  const runner = f.make();
  await runner.start();
  await until(runner, () => runner.snapshot().launches[0]?.status === 'running', 'running');
  // The agent's first MCP call activates it, which slides its expiry four hours on.
  const session = fake.sessions.get(work.id)!;
  session.status = 'active';
  session.expiresAt = new Date(Date.now() + 4 * 3_600_000).toISOString();
  await runner.tick();
  await delay(Math.max(0, Date.parse(work.expiresAt) + 1_500 - Date.now()));
  await runner.tick();
  assert.equal(runner.snapshot().launches[0].status, 'running');
  // A heartbeat is sent only for a slide the server would keep: none moves this expiry forward.
  assert.equal(
    fake.calls.filter((call) => call.path === `/sessions/${work.id}/heartbeat`).length,
    0,
  );
});

test('a session heartbeat is sent only when the server would keep its slide', async (t) => {
  let now = Date.now();
  const work = offer('renewed');
  let offered = false;
  const fake = server(
    () => (offered ? null : ((offered = true), work)),
    undefined,
    undefined,
    () => now,
  );
  const f = machine(t, [node('a', 'setInterval(()=>{},1000)')], fake.fetch, { clock: () => now });
  const runner = f.make();
  await runner.start();
  await until(runner, () => runner.snapshot().launches[0]?.status === 'running', 'running');
  // Activated with a day to its hard deadline: the window starts four hours ahead.
  const session = fake.sessions.get(work.id)!;
  session.status = 'active';
  session.expiresAt = new Date(now + 4 * 3_600_000).toISOString();
  session.hardDeadline = new Date(now + 24 * 3_600_000).toISOString();
  const heartbeats = () =>
    fake.calls.filter((call) => call.path === `/sessions/${work.id}/heartbeat`).length;
  // Forty minutes a tick a minute: one that slid by over a minute would send from minute two.
  for (let minute = 1; minute <= 40; minute++) {
    now += 60_000;
    await runner.tick();
  }
  assert.equal(heartbeats(), 2, 'one at each 15-minute slide the server keeps');
  assert.equal(runner.snapshot().launches[0].status, 'running');
  // Near its hard deadline, one heartbeat takes the window to it and none follows.
  session.hardDeadline = new Date(now + 4 * 3_600_000 - 5 * 60_000).toISOString();
  for (let minute = 1; minute <= 3; minute++) {
    now += 60_000;
    await runner.tick();
  }
  assert.equal(heartbeats(), 3);
  assert.equal(session.expiresAt, session.hardDeadline);
});

test("one guardian's refusal is its launch's, never the tick's", async (t) => {
  const fake = server(() => null);
  const f = machine(t, [node('a')], fake.fetch);
  const ledger = f.ledger();
  ledger.reserve({ id: 'refused', sessionId: 'unknown', deadline: Date.now() + 60_000 });
  ledger.close();
  const runner = f.make();
  // What a guardian answers when its own SQLite fails it: anything but unreachable.
  (runner as any).host.inspect = async () => {
    throw new Error('Supervisor refused: supervisor_failed');
  };
  await runner.start();
  assert.ok(fake.calls.some((call) => call.path === '/sessions/runners/heartbeat'));
  assert.equal(runner.snapshot().state, 'degraded');
  assert.ok(runner.snapshot().lastError);
});
