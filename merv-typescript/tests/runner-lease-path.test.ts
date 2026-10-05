import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkspaceDriver, WorkspaceDriverFactory } from '@merv/contracts';
import type { RunnerConfig } from '@merv/runner';
import {
  ended,
  launchId,
  machine,
  metadata,
  node,
  offer,
  Refusal,
  server,
  until,
  type Body,
} from './fixtures/runner-stand-in.js';

// The lease path: what one request's answer does to that request, and that nothing a single
// lease or launch carries stops the others.
/** A stand-in agent that records its arguments and exits. */
function agent(root: string): string {
  const path = join(root, 'agent.sh');
  writeFileSync(path, `#!/bin/sh\necho "$@" > '${join(root, 'args')}'\nexit 0\n`, { mode: 0o700 });
  return path;
}
const stored = (directory: string) =>
  readdirSync(directory)
    .filter((file) => file.startsWith('ledger.sqlite'))
    .map((file) => readFileSync(join(directory, file)))
    .reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0));

test('a large brief with credential-shaped words and a key named env launches', async (t) => {
  const words = Array.from({ length: 8000 }, (_, i) => `ms_${'word_of_the_brief'.repeat(2)}_${i}`);
  const brief = words.join(' ').slice(0, 300 * 1024);
  const work = offer('large', { brief, assignment: { env: { PATH: '/bin' } } });
  const fake = server(() => work);
  const f = machine(
    t,
    [node('worker', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))")],
    fake.fetch,
  );
  const runner = f.make();
  await runner.start();
  await until(runner, () => fake.releases(work.id).length === 1, 'released after its exit');
  const [launch] = runner.snapshot().launches;
  assert.equal(launch.exitCode, 0, 'the agent ran and read the whole assignment');
  // The launch keeps a projection of its session, not the assignment.
  const kept = metadata(f.config.directory, launch.id);
  assert.equal(kept.session.id, work.id);
  assert.equal(kept.session.assignment, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) < 8 * 1024);
});

test('a profile naming a third-party MCP bearer never stores its value', async (t) => {
  const bearerEnv = `MERV_LEASE_PATH_BEARER_${process.pid}`;
  const bearer = `third-party-${'b'.repeat(40)}`;
  process.env[bearerEnv] = bearer;
  t.after(() => delete process.env[bearerEnv]);
  const work = offer('bearer');
  const fake = server(() => work);
  const root = mkdtempSync(join(tmpdir(), 'merv-lease-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = machine(
    t,
    [
      {
        name: 'claude',
        harness: 'claude',
        executable: agent(root),
        enabled: true,
        parallelism: 1,
        servers: [{ name: 'extra', url: 'https://mcp.example/', bearerEnv }],
      },
    ],
    fake.fetch,
  );
  const runner = f.make();
  await runner.start();
  await until(runner, () => fake.releases(work.id).length === 1, 'released after its exit');
  assert.equal(runner.snapshot().launches[0].exitCode, 0);
  const kept = metadata(f.config.directory, launchId(work.id));
  assert.equal(kept.profile.servers[0].bearerEnv, bearerEnv);
  assert.ok(!stored(f.config.directory).includes(Buffer.from(bearer)));
});

test('an assignment too large to launch is released once as launch_failed and leasing goes on', async (t) => {
  const huge = offer('huge', { brief: 'x'.repeat(1536 * 1024) });
  const next = offer('next');
  const fake = server((body) => (body.platform.name === 'a' ? huge : next));
  const f = machine(t, [node('a'), node('b', 'setInterval(()=>{},1000)')], fake.fetch, {
    config: { capacity: 2 },
  });
  const runner = f.make();
  await runner.start();
  assert.equal(fake.releases(huge.id).length, 1);
  assert.equal(fake.releases(huge.id)[0].body?.outcome, 'launch_failed');
  assert.equal(fake.releases(huge.id)[0].body?.reason, 'local_process_not_started');
  assert.equal(fake.sessions.get(next.id)?.hostRef, launchId(next.id), 'b leased on that tick');
  for (let i = 0; i < 3; i++) await runner.tick();
  assert.equal(fake.releases(huge.id).length, 1, 'released exactly once');
});

test('a final lease refusal completes that request and later profiles lease on the same tick', async (t) => {
  const work = offer('b');
  const fake = server((body) =>
    body.platform.name === 'a' ? new Refusal(409, 'platform_mismatch') : work,
  );
  const f = machine(t, [node('a'), node('b', 'setInterval(()=>{},1000)')], fake.fetch, {
    config: { capacity: 2 },
  });
  const runner = f.make();
  await runner.start();
  assert.equal(fake.leases('a').length, 1);
  assert.equal(fake.sessions.get(work.id)?.hostRef, launchId(work.id));
  assert.equal(runner.snapshot().pendingRequests, 0, 'the refused request is answered');
  await runner.tick();
  assert.notEqual(
    fake.leases('a')[1].body?.requestId,
    fake.leases('a')[0].body?.requestId,
    'the next lease for a is a new request',
  );
});

test('a kept request for a removed profile does not stop the other profiles', async (t) => {
  const kept = offer('kept');
  const fake = server((body) => (body.platform.name === 'gone' ? kept : null));
  // Each tick comes 5 s after the last, past b's back-off after its decline.
  let now = Date.now();
  const f = machine(t, [node('b')], fake.fetch, { clock: () => now });
  const ledger = f.ledger();
  const pending = ledger.request({ name: 'gone', harness: 'command' });
  ledger.close();
  const runner = f.make();
  await runner.start();
  now += 5_000;
  await runner.tick();
  now += 5_000;
  await runner.tick();
  assert.equal(fake.leases('b').length, 3, 'b asks on every tick');
  assert.deepEqual(
    fake.leases('gone').map((call) => call.body?.requestId),
    [pending.requestId, pending.requestId, pending.requestId],
    'the kept request is replayed with its own id',
  );
  assert.equal(runner.snapshot().lastError, 'runner_profile_missing');
});

test('a request whose answer is unknown is kept and replayed with its own id', async (t) => {
  let answer: Body | Refusal = new Refusal(503, 'state_busy');
  const fake = server(() => answer);
  const f = machine(t, [node('a')], fake.fetch);
  const runner = f.make();
  await runner.start();
  // A reservation this machine cannot make is a local failure, not the server's answer.
  answer = offer('past', { expiresAt: new Date(Date.now() - 1000).toISOString() });
  await runner.tick();
  assert.equal(runner.snapshot().lastError, 'runner_operation_failed');
  answer = new Refusal(409, 'transaction_conflict');
  await runner.tick();
  const ids = fake.leases('a').map((call) => call.body?.requestId);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 1, 'every retry replays the same request');
  assert.equal(runner.snapshot().pendingRequests, 1);
});

test('a history row whose driver is not composed does not stop leasing', async (t) => {
  const fake = server(() => null);
  const f = machine(t, [node('a')], fake.fetch);
  const ledger = f.ledger();
  const old = offer('old', { workspace: { mode: 'ephemeral', driver: 'code.v2' } });
  const record = ledger.reserve({
    id: launchId(old.id),
    sessionId: old.id,
    deadline: Date.now() + 60_000,
    metadata: {
      session: { id: old.id, status: 'released' },
      platform: 'a',
      requestId: 'request_old',
      workspaceDriver: 'code.v2',
      remoteClosed: true,
      usageReported: true,
    },
  });
  ledger.close();
  ended(f.config.directory, record.id);
  const runner = f.make();
  await runner.start();
  assert.equal(fake.leases('a').length, 1, 'leasing went on');
  assert.equal(runner.snapshot().state, 'degraded');
  assert.equal(runner.snapshot().lastError, 'workspace_driver_missing');
});

test('a lease for a driver this machine does not compose is deferred as driver_absent', async (t) => {
  const work = offer('driver', {
    workspace: { mode: 'ephemeral', namespace: 'n', retain: false, driver: 'code.v2' },
  });
  let offered = false;
  const fake = server(() => (offered ? null : ((offered = true), work)));
  const f = machine(t, [node('a')], fake.fetch);
  const runner = f.make();
  await runner.start();
  assert.equal(fake.releases(work.id).length, 1);
  assert.deepEqual(fake.releases(work.id)[0].body, {
    runnerId: runner.snapshot().runnerId,
    outcome: 'preparation_deferred',
    reason: 'local_process_not_started',
    deferral: { cause: 'driver_absent', code: 'workspace_driver_missing' },
  });
  assert.equal(fake.leases('a').length, 1);
  await runner.tick();
  assert.equal(fake.leases('a').length, 2, 'the next tick leases again');
});

test('a profile enabled remotely and disabled locally runs as leased', async (t) => {
  const work = offer('remote');
  const fake = server(() => work, {
    version: 1,
    platforms: [
      { name: 'claude', enabled: true, parallelism: 1, model: 'remote-model', effort: 'high' },
    ],
  });
  const f = machine(
    t,
    [
      {
        name: 'claude',
        harness: 'claude',
        executable: '/bin/false',
        model: 'local-model',
        enabled: false,
        parallelism: 1,
      },
    ],
    fake.fetch,
  );
  f.config.profiles[0] = { ...f.config.profiles[0], executable: agent(f.root) };
  const runner = f.make();
  await runner.start();
  assert.deepEqual(fake.leases('claude')[0].body?.platform, {
    name: 'claude',
    harness: 'claude',
    model: 'remote-model',
    effort: 'high',
  });
  await until(runner, () => fake.releases(work.id).length === 1, 'released after its exit');
  assert.equal(runner.snapshot().launches[0].exitCode, 0);
  assert.match(readFileSync(join(f.root, 'args'), 'utf8'), /--model remote-model/);
  const { profile } = metadata(f.config.directory, launchId(work.id));
  assert.equal(profile.enabled, true);
  assert.equal(profile.model, 'remote-model');
  assert.equal(profile.effort, 'high');
});

const codex = {
  name: 'codex',
  harness: 'codex' as const,
  executable: process.execPath,
  isolatedLauncher: process.execPath,
  enabled: true,
  parallelism: 1,
};
test('a one-assignment runner replays only the request of its own launch', async (t) => {
  const own = offer('own');
  const fake = server(() => ({ ...own, status: 'released', closeReason: 'handoff' }));
  const f = machine(t, [codex], fake.fetch, { config: { oneAssignment: true, capacity: 1 } });
  const ledger = f.ledger();
  const pending = ledger.request({ name: 'codex', harness: 'codex' });
  const record = ledger.reserve({
    id: launchId(own.id),
    sessionId: own.id,
    deadline: Date.now() + 60_000,
    metadata: {
      platform: 'codex',
      requestId: pending.requestId,
      remoteClosed: true,
      usageReported: true,
    },
  });
  ledger.close();
  ended(f.config.directory, record.id);
  const runner = f.make();
  await runner.start();
  assert.deepEqual(
    fake.leases('codex').map((call) => call.body?.requestId),
    [pending.requestId],
  );
  assert.equal(runner.snapshot().pendingRequests, 0);
  await runner.tick();
  assert.equal(fake.leases('codex').length, 1, 'it never asks for a successor');
});

test('presence names runner.2 (and git.local) on a source runner and only the enrolled drivers on a managed one', async (t) => {
  const driver: WorkspaceDriverFactory = {
    name: 'code.v2',
    create: () => ({ get: () => undefined, dispose: () => {} }) as unknown as WorkspaceDriver,
  };
  const capabilities = async (config: Partial<RunnerConfig>, drivers: WorkspaceDriverFactory[]) => {
    const fake = server(() => null);
    const f = machine(t, config.oneAssignment ? [codex] : [node('a')], fake.fetch, {
      config,
      drivers,
    });
    await f.make().start();
    return fake.calls.find((call) => call.path === '/sessions/runners/heartbeat')!.body!
      .capabilities;
  };
  assert.deepEqual(await capabilities({}, []), ['runner.2']);
  assert.deepEqual(await capabilities({}, [driver]), ['code.v2', 'runner.2']);
  // A runner with a repository of its own says so, for work that names no driver.
  const workspace = { repository: '/nonexistent/source', baseRef: 'main' };
  assert.deepEqual(await capabilities({ workspace }, []), ['git.local', 'runner.2']);
  const managed = { oneAssignment: true, capacity: 1 };
  assert.deepEqual(await capabilities(managed, [driver]), ['code.v2']);
  assert.equal(await capabilities(managed, []), undefined);
});

test('a guardian that cannot own its socket ends the launch it claimed, which is released', async (t) => {
  const work = offer('socket');
  let offered = false;
  const fake = server(() => (offered ? null : ((offered = true), work)));
  const f = machine(t, [node('a', 'setInterval(()=>{},1000)')], fake.fetch);
  // A socket directory the guardian refuses: it has claimed the launch, and nothing was spawned.
  const sockets = `/tmp/merv-runner-${process.getuid!()}-${createHash('sha256').update(resolve(f.config.directory)).digest('hex').slice(0, 16)}`;
  symlinkSync(f.root, sockets);
  t.after(() => rmSync(sockets, { force: true }));
  const runner = f.make();
  await runner.start();
  const id = launchId(work.id);
  await until(runner, () => fake.releases(work.id).length > 0, 'released');
  const ledger = f.ledger();
  const launch = ledger.get(id)!;
  ledger.close();
  assert.deepEqual([launch.status, launch.reason], ['stopped', 'socket_failed']);
  assert.equal(fake.releases(work.id).length, 1);
  assert.equal(fake.releases(work.id)[0].body?.reason, 'local_process_socket_failed');
  assert.ok(['crash_loop', 'host_failed'].includes(fake.releases(work.id)[0].body?.outcome));
});

test('a guardian lost before it launched anything is ended a minute later and released', async (t) => {
  const work = offer('lost');
  const fake = server(() => null);
  const f = machine(t, [node('a')], fake.fetch);
  // Claimed, then gone before it pinned a command: a guardian killed before it listened, or one
  // from before guardians ended such a launch themselves.
  const ledger = f.ledger();
  const id = launchId(work.id);
  ledger.reserve({ id, sessionId: work.id, deadline: Date.now() + 3_600_000, metadata: {} });
  fake.sessions.set(work.id, { ...work, runnerId: ledger.runnerId, hostRef: id, status: 'active' });
  ledger.close();
  ended(f.config.directory, id, { status: 'starting', reason: null });
  const runner = f.make();
  await runner.start();
  const first = metadata(f.config.directory, id);
  assert.equal(runner.snapshot().launches[0].status, 'uncertain');
  assert.equal(typeof first.lostAt, 'number');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await runner.tick();
  assert.equal(runner.snapshot().launches[0].status, 'uncertain');
  assert.equal(metadata(f.config.directory, id).lostAt, first.lostAt, 'kept across saves');
  assert.equal(fake.releases(work.id).length, 0);
  t.mock.timers.tick(61_000);
  await runner.tick();
  assert.equal(runner.snapshot().launches[0].status, 'stopped');
  assert.equal(fake.releases(work.id).length, 1);
  assert.ok(['crash_loop', 'host_failed'].includes(fake.releases(work.id)[0].body?.outcome));
  assert.equal(fake.releases(work.id)[0].body?.reason, 'local_process_guardian_lost_before_launch');
});

test('a guardian no launch reached in time is released as a launch timeout', async (t) => {
  const work = offer('timeout');
  const fake = server(() => null);
  const f = machine(t, [node('a')], fake.fetch);
  const ledger = f.ledger();
  const id = launchId(work.id);
  ledger.reserve({ id, sessionId: work.id, deadline: Date.now() + 3_600_000, metadata: {} });
  fake.sessions.set(work.id, { ...work, runnerId: ledger.runnerId, hostRef: id, status: 'active' });
  ledger.close();
  ended(f.config.directory, id, { reason: 'launch_timeout' });
  const runner = f.make();
  await runner.start();
  await until(runner, () => fake.releases(work.id).length > 0, 'released');
  assert.equal(fake.releases(work.id)[0].body?.reason, 'local_process_launch_timeout');
});
