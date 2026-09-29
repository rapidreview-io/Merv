import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceDriver, WorkspaceDriverFactory } from '@merv/contracts';
import { MachineRunner, type RunnerConfig } from '@merv/runner';
import { LocalLedger } from '../packages/runner/src/ledger.js';

/**
 * The lease path against a stand-in Sessions server: what one request's answer does to that
 * request, and that nothing a single lease or launch carries stops the others.
 */
const projectId = 'project_fixture';
const baseUrl = 'http://127.0.0.1:9';
type Body = Record<string, any>;
interface Call {
  path: string;
  body: Body | undefined;
}
class Refusal {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {}
}
const launchId = (sessionId: string) =>
  `launch_${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;

function offer(
  name: string,
  patch: { brief?: string; workspace?: unknown; assignment?: Body; expiresAt?: string } = {},
) {
  const instanceId = `instance_${name}`;
  const common = { instanceId, projectId, actorId: 'actor_fixture', revision: 0 };
  return {
    id: `session_${name}`,
    projectId,
    actorId: 'actor_fixture',
    instanceId,
    runnerId: '',
    hostRef: null as string | null,
    expectedRevision: 0,
    status: 'offered',
    closeReason: null as string | null,
    expiresAt: patch.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    hardDeadline: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    assignment: {
      ...common,
      label: 'Work',
      brief: patch.brief ?? 'Do the work.',
      execution: { readOnly: false },
      ...patch.assignment,
    },
    execution: {
      ...common,
      policy: {
        readOnly: false,
        tools: [],
        ...(patch.workspace ? { workspace: patch.workspace } : {}),
      },
      references: {},
    },
  } as Body;
}

/** Sessions as a runner sees it: presence, lease, the session controls and Code's next command. */
function server(
  lease: (body: Body) => Body | null | Refusal,
  settings: { version: number; platforms: unknown[] } = { version: 0, platforms: [] },
) {
  const calls: Call[] = [];
  const sessions = new Map<string, Body>();
  const reply = (value: unknown, status = 200) => Response.json(value, { status });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : undefined;
    calls.push({ path, body });
    if (path === '/sessions/runners/heartbeat')
      return reply({
        runner: {
          runnerId: body!.runnerId,
          desiredVersion: settings.version,
          desiredSettings: { platforms: settings.platforms },
        },
      });
    if (path === '/code/commands/next') return reply({ command: null });
    if (path === '/sessions/lease') {
      const answer = lease(body!);
      if (answer instanceof Refusal)
        return reply({ error: { code: answer.code, message: answer.code } }, answer.status);
      if (answer === null) return reply({ session: null, reason: 'no_candidates' });
      const session = sessions.get(answer.id) ?? { ...answer, runnerId: body!.runnerId };
      sessions.set(session.id, session);
      return reply({ session, reason: 'leased' });
    }
    const [, , id, action] = path.split('/');
    const session = sessions.get(decodeURIComponent(id ?? ''));
    if (!session) return reply({ error: { code: 'session_not_found', message: 'No' } }, 404);
    if (action === 'attach') {
      session.hostRef = body!.hostRef;
      if (body!.workspace) session.workspace = { attachment: body!.workspace, result: null };
    } else if (action === 'release') {
      session.status = 'released';
      session.closeReason = body!.outcome ?? 'released';
    }
    return reply({ session });
  };
  const leases = (platform: string) =>
    calls.filter(
      (call) => call.path === '/sessions/lease' && call.body?.platform.name === platform,
    );
  const releases = (sessionId: string) =>
    calls.filter((call) => call.path === `/sessions/${sessionId}/release`);
  return { fetch, calls, sessions, leases, releases };
}

function machine(
  t: TestContext,
  profiles: RunnerConfig['profiles'],
  fetcher: typeof fetch,
  options: { config?: Partial<RunnerConfig>; drivers?: WorkspaceDriverFactory[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'merv-lease-path-'));
  const credentialEnv = `MERV_LEASE_PATH_${process.pid}`;
  process.env[credentialEnv] = `mk_${'l'.repeat(43)}`;
  const config: RunnerConfig = {
    directory: join(root, 'machine'),
    baseUrl,
    projectId,
    credentialEnv,
    profiles,
    ...options.config,
  };
  const runners: MachineRunner[] = [];
  t.after(async () => {
    for (const runner of runners) await runner.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const make = () => {
    const runner = new MachineRunner(config, {
      autoPoll: false,
      fetch: fetcher,
      drivers: options.drivers ?? [],
    });
    runners.push(runner);
    return runner;
  };
  /** The runner's own ledger, opened before it starts; the same binding a runner derives. */
  const ledger = () =>
    new LocalLedger({
      directory: config.directory,
      binding: {
        baseUrl,
        projectId,
        sourceId: createHash('sha256').update(process.env[credentialEnv]!).digest('hex'),
      },
    });
  return { root, config, make, ledger };
}
const node = (name: string, source = 'process.exit(0)', parallelism = 1) => ({
  name,
  harness: 'command' as const,
  executable: process.execPath,
  args: ['-e', source],
  enabled: true,
  parallelism,
});
/** A stand-in agent that records its arguments and exits. */
function agent(root: string): string {
  const path = join(root, 'agent.sh');
  writeFileSync(path, `#!/bin/sh\necho "$@" > '${join(root, 'args')}'\nexit 0\n`, { mode: 0o700 });
  return path;
}
async function until(runner: MachineRunner, condition: () => boolean, label: string) {
  const end = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > end) assert.fail(`${label}: ${JSON.stringify(runner.snapshot())}`);
    await runner.tick();
    await delay(25);
  }
}
const stored = (directory: string) =>
  readdirSync(directory)
    .filter((file) => file.startsWith('ledger.sqlite'))
    .map((file) => readFileSync(join(directory, file)))
    .reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0));
/** A launch that ended before this runner started, as an earlier controller left it. */
const ended = (directory: string, id: string) => {
  const db = new DatabaseSync(join(directory, 'ledger.sqlite'));
  db.prepare("UPDATE launches SET status='stopped',reason='cancelled_before_spawn' WHERE id=?").run(
    id,
  );
  db.close();
};
const metadata = (directory: string, id: string) => {
  const db = new DatabaseSync(join(directory, 'ledger.sqlite'));
  try {
    return JSON.parse(
      String(db.prepare('SELECT metadata_json FROM launches WHERE id=?').get(id)!.metadata_json),
    );
  } finally {
    db.close();
  }
};

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
  const f = machine(t, [node('b')], fake.fetch);
  const ledger = f.ledger();
  const pending = ledger.request({ name: 'gone', harness: 'command' });
  ledger.close();
  const runner = f.make();
  await runner.start();
  await runner.tick();
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

test('presence names runner.1 on a source runner and only the enrolled drivers on a managed one', async (t) => {
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
  assert.deepEqual(await capabilities({}, []), ['runner.1']);
  assert.deepEqual(await capabilities({}, [driver]), ['code.v2', 'runner.1']);
  const managed = { oneAssignment: true, capacity: 1 };
  assert.deepEqual(await capabilities(managed, [driver]), ['code.v2']);
  assert.equal(await capabilities(managed, []), undefined);
});
