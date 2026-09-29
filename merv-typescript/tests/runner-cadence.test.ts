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
  // A heartbeat is sent only once it would move the expiry by more than a minute.
  assert.equal(
    fake.calls.filter((call) => call.path === `/sessions/${work.id}/heartbeat`).length,
    0,
  );
});
