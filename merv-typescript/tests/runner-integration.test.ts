import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Caller } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { MachineRunner, type RunnerConfig } from '@merv/runner';
import { createApp } from '../src/app.js';

const executable = fileURLToPath(new URL('./fixtures/runner-worker.mjs', import.meta.url));
const terminal = (status: string) => status === 'exited' || status === 'stopped';
const diagnostics = new WeakMap<MachineRunner, () => string>();
function files(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
interface ChildResult {
  pid: number;
  artifactId: string;
  actorId: string;
  taskId: string;
  sourceEnvironmentAbsent: boolean;
  scopedCatalog: boolean;
  secretInArgvOrPrompt: boolean;
}
function childResults(directory: string): ChildResult[] {
  // A child may still be writing its result when a poll reads it; a partial
  // file is not a result yet, so it is skipped and the next poll reads it whole.
  return files(directory)
    .filter((path) => path.endsWith('/worker-result.json'))
    .flatMap((path) => {
      try {
        return [JSON.parse(readFileSync(path, 'utf8')) as ChildResult];
      } catch {
        return [];
      }
    });
}
async function until(
  condition: () => boolean | Promise<boolean>,
  runner: MachineRunner,
  label: string,
  options: { drive?: boolean; timeout?: number } = {},
) {
  const deadline = Date.now() + (options.timeout ?? 15_000);
  while (!(await condition())) {
    if (
      runner
        .snapshot()
        .launches.some(
          (launch) =>
            terminal(launch.status) &&
            launch.exitCode !== undefined &&
            launch.exitCode !== null &&
            launch.exitCode !== 0,
        )
    )
      throw new Error(`Child failed before ${label}: ${diagnostics.get(runner)?.() ?? ''}`);
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(runner.snapshot())}`);
    if (options.drive !== false) await runner.tick();
    await delay(50);
  }
}
async function fixture(t: TestContext, args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-runner-integration-'));
  const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Machine runner', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const task = await app.ctx.tasks.create(source, {
    title: 'Prove an actual child runs',
    goal: 'Retain evidence through the session MCP boundary.',
    checks: ['A real child created attributed evidence.'],
    requestId: 'task',
  });
  const credentialEnv = `MERV_RUNNER_INTEGRATION_${randomUUID().replaceAll('-', '')}`;
  process.env[credentialEnv] = boot.token;
  const runnerDirectory = join(directory, 'machine');
  const config: RunnerConfig = {
    directory: runnerDirectory,
    baseUrl: app.ctx.api.url!,
    projectId: boot.project.id,
    credentialEnv,
    profiles: [
      {
        name: 'test-worker',
        harness: 'command',
        executable: process.execPath,
        args: [executable, ...args],
        enabled: true,
        parallelism: 1,
      },
    ],
    capacity: 1,
    pollIntervalMs: 100,
    requestTimeoutMs: 1000,
  };
  const runners = new Set<MachineRunner>();
  t.after(async () => {
    for (const runner of runners) await runner.stop();
    await app.stop();
    delete process.env[credentialEnv];
    rmSync(directory, { recursive: true, force: true });
  });
  const make = (fetcher?: typeof fetch) => {
    const runner = new MachineRunner(config, {
      autoPoll: false,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
    diagnostics.set(runner, () =>
      files(runnerDirectory)
        .filter((path) => path.endsWith('/stderr.log'))
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n')
        .slice(-12000),
    );
    runners.add(runner);
    return runner;
  };
  const sessions = async (): Promise<Session[]> => await app.ctx.sessions.list(source);
  const enabled = async (value: boolean) =>
    await app.ctx.sessions.setDispatch(source, { enabled: value });
  return {
    app,
    source,
    task,
    config,
    make,
    sessions,
    enabled,
    runnerDirectory,
    credentialEnv,
    token: boot.token,
  };
}

test(
  'a real runner child receives only its session authority, calls MCP and releases after process exit',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const runner = f.make();
    await runner.start();
    assert.equal(runner.snapshot().launches.length, 0, 'Dispatch is off by default');
    // And says so. An idle runner with a queue behind it looks exactly like one with
    // nothing to do, which is an hour of anyone's time the first time they meet it.
    await until(
      () => runner.snapshot().lastDeclined === 'dispatch_disabled',
      runner,
      'the runner reporting why it was given nothing',
    );
    await f.enabled(true);
    await until(
      () => childResults(f.runnerDirectory).length === 1,
      runner,
      'actual MCP child evidence',
    );
    await f.enabled(false);
    const result = childResults(f.runnerDirectory)[0];
    assert.equal(result.taskId, f.task.id);
    assert.equal(result.sourceEnvironmentAbsent, true);
    assert.equal(result.scopedCatalog, true);
    assert.equal(result.secretInArgvOrPrompt, false);
    const session = (await f.sessions())[0];
    assert.equal(result.actorId, session.actorId);
    assert.notEqual(result.actorId, f.source.actorId);
    assert.ok(session.hostRef);
    assert.equal(
      (await f.app.ctx.artifacts.get(f.source, result.artifactId)).createdBy,
      session.actorId,
    );
    assert.equal((await f.app.ctx.workflows.workStarts(f.source, f.task.id)).length, 1);
    await until(
      () => runner.snapshot().launches.every((launch) => terminal(launch.status)),
      runner,
      'observed child exit',
    );
    await until(
      async () => (await f.sessions())[0].status === 'released',
      runner,
      'server release',
    );
    assert.equal(runner.snapshot().launches.length, 1);
    assert.equal(runner.snapshot().launches[0].exitCode, 0);
    assert.equal((await f.sessions()).length, 1);
    for (const path of files(f.runnerDirectory))
      assert.equal(
        readFileSync(path).includes(Buffer.from(f.token)),
        false,
        `Source credential absent from ${path}`,
      );
  },
);

test(
  'lost lease, attach and release responses retain one request and launch across retries',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t);
    const dropped = new Set<string>();
    const leaseInputs: { requestId: string; secret: string }[] = [];
    const attachInputs: { hostRef: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const operation =
        url.pathname === '/sessions/lease'
          ? 'lease'
          : url.pathname.endsWith('/attach')
            ? 'attach'
            : url.pathname.endsWith('/release')
              ? 'release'
              : undefined;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const response = await fetch(input, init);
      if (operation === 'lease' && response.ok) {
        const value = (await response.clone().json()) as { session: Session | null };
        if (!value.session) return response;
        leaseInputs.push(body);
      }
      if (operation === 'attach') attachInputs.push(body);
      if (operation && response.ok && !dropped.has(operation)) {
        dropped.add(operation);
        throw new TypeError(`Injected lost ${operation} response after commit`);
      }
      return response;
    };
    const runner = f.make(fetcher);
    await runner.start();
    await f.enabled(true);
    await until(
      () => childResults(f.runnerDirectory).length === 1,
      runner,
      'retried launch and MCP evidence',
    );
    await f.enabled(false);
    await until(
      async () => dropped.has('release') && (await f.sessions())[0].status === 'released',
      runner,
      'committed release with lost reply',
    );
    await runner.tick();
    assert.equal(runner.snapshot().launches.length, 1);
    assert.equal((await f.sessions()).length, 1);
    assert.ok(leaseInputs.length >= 2);
    assert.equal(new Set(leaseInputs.map((input) => input.requestId)).size, 1);
    assert.equal(new Set(leaseInputs.map((input) => input.secret)).size, 1);
    assert.ok(attachInputs.length >= 1);
    assert.equal(new Set(attachInputs.map((input) => input.hostRef)).size, 1);
    assert.deepEqual([...dropped].sort(), ['attach', 'lease', 'release']);
    assert.equal((await f.app.ctx.workflows.workStarts(f.source, f.task.id)).length, 1);
    for (const path of files(f.runnerDirectory)) {
      const data = readFileSync(path);
      assert.equal(data.includes(Buffer.from(f.token)), false, 'Source bearer is not persisted');
      assert.equal(
        data.includes(Buffer.from(leaseInputs[0].secret)),
        false,
        'Step bearer is not persisted',
      );
    }
  },
);

test(
  'pause preserves a running process; transient outage retains its slot; explicit halt stops it',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, ['--hold']);
    let outage = false;
    const runner = f.make(async (input, init) => {
      if (outage) throw new TypeError('Injected control-plane outage');
      return fetch(input, init);
    });
    await runner.start();
    await f.enabled(true);
    await until(() => childResults(f.runnerDirectory).length === 1, runner, 'holding MCP worker');
    await f.enabled(false);
    await runner.tick();
    assert.equal((await f.sessions())[0].status, 'active');
    assert.equal(runner.snapshot().launches.length, 1);
    assert.ok(runner.snapshot().launches.some((launch) => !terminal(launch.status)));
    outage = true;
    await runner.tick();
    await delay(100);
    assert.equal(runner.snapshot().launches.length, 1);
    assert.ok(runner.snapshot().launches.some((launch) => !terminal(launch.status)));
    outage = false;
    await f.app.ctx.sessions.halt(f.source);
    await until(
      () => runner.snapshot().launches.every((launch) => terminal(launch.status)),
      runner,
      'halted process tree',
    );
    assert.equal((await f.sessions())[0].outcome, 'halted');
    assert.equal(runner.snapshot().launches.length, 1);
  },
);

test(
  'a session the server closed still has its usage file reported once; a malformed file is never sent',
  { timeout: 40_000 },
  async (t) => {
    const usage = { inputTokens: 4200, outputTokens: 800, costUsd: 0.25, model: 'fixture-model' };
    const f = await fixture(t, ['--hold', `--usage=${JSON.stringify(usage)}`]);
    const reports: unknown[] = [];
    const runner = f.make(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname.endsWith('/release') && body?.usage) reports.push(body);
      return fetch(input, init);
    });
    await runner.start();
    await f.enabled(true);
    await until(() => childResults(f.runnerDirectory).length === 1, runner, 'holding worker');
    // The server ends the session, as a landed handoff does; the runner never releases it.
    await f.app.ctx.sessions.halt(f.source);
    await until(
      async () => (await f.app.ctx.sessions.usage(f.source)).totals.reportedSessions === 1,
      runner,
      'usage reported for a remotely closed session',
    );
    await runner.tick();
    await runner.tick();
    assert.equal(reports.length, 1, 'The ledger remembers the report was answered');
    assert.deepEqual((reports[0] as { usage: unknown }).usage, usage);
    const read = await f.app.ctx.sessions.usage(f.source, { instanceId: f.task.id });
    assert.deepEqual(
      [read.totals.sessions, read.totals.inputTokens, read.totals.outputTokens],
      [1, 4200, 800],
    );
    assert.equal(read.totals.costMicros, 250_000);
    assert.ok(read.totals.toolCalls >= 3, 'The worker’s own MCP calls are counted beside it');
  },
);

test(
  'a usage file that is not the closed report shape is not sent with the release',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, ['--usage={"inputTokens":1,"outputTokens":1,"note":"extra"}']);
    const releases: { usage?: unknown }[] = [];
    const runner = f.make(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/release')) releases.push(JSON.parse(String(init?.body)));
      return fetch(input, init);
    });
    await runner.start();
    await f.enabled(true);
    await until(
      async () => (await f.sessions())[0]?.status === 'released',
      runner,
      'server release',
    );
    await f.enabled(false);
    assert.ok(releases.length >= 1);
    assert.ok(releases.every((body) => body.usage === undefined));
    const read = await f.app.ctx.sessions.usage(f.source);
    assert.deepEqual([read.totals.sessions, read.totals.reportedSessions], [1, 0]);
    assert.ok(read.totals.wallMs > 0, 'Lease wall-clock is measured whether or not anyone reports');
  },
);

test(
  'definitive source revocation stops a real child even when release reporting is forbidden',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, ['--hold']);
    const runner = f.make();
    await runner.start();
    await f.enabled(true);
    await until(() => childResults(f.runnerDirectory).length === 1, runner, 'source-bound child');
    const replacement = await f.app.ctx.scope.issueActorCredential(f.source, {
      actorId: f.source.actorId,
    });
    await f.app.ctx.scope.revokeCredential(
      { ...f.source, credentialId: replacement.credential.id },
      f.source.credentialId!,
    );
    await until(
      () => runner.snapshot().launches.every((launch) => terminal(launch.status)),
      runner,
      'revoked source process stop',
    );
    assert.equal(runner.snapshot().launches.length, 1);
    assert.equal(
      await f.app.ctx.state.read(
        async (sql) =>
          (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM worker_sessions'))!.n,
      ),
      1,
    );
  },
);

test(
  'source refusal between presence and a lease request stops existing children in the same tick',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, ['--hold']);
    f.config.capacity = 2;
    f.config.profiles[0].parallelism = 2;
    let refuseLease = false;
    const runner = f.make(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (refuseLease && url.pathname === '/sessions/lease')
        return new Response('Source revoked', { status: 403 });
      return fetch(input, init);
    });
    await runner.start();
    await f.enabled(true);
    await until(
      () => childResults(f.runnerDirectory).length === 1,
      runner,
      'live worker before source refusal',
    );
    refuseLease = true;
    await runner.tick();
    assert.equal(runner.snapshot().state, 'unauthorized');
    assert.ok(runner.snapshot().launches.every((launch) => terminal(launch.status)));
    assert.equal(runner.snapshot().launches.length, 1);
  },
);

test(
  'a replacement controller reconnects an existing MCP worker after a real controller crash',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, ['--hold']);
    await f.enabled(true);
    const configPath = join(f.runnerDirectory, '..', 'controller-config.json');
    writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
    const controller = fork(
      fileURLToPath(new URL('./fixtures/runner-controller.mjs', import.meta.url)),
      [configPath],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const exited = once(controller, 'exit');
    t.after(async () => {
      if (controller.exitCode === null && controller.signalCode === null) {
        controller.send?.('stop');
        await Promise.race([exited, delay(4000)]);
        if (controller.exitCode === null && controller.signalCode === null)
          controller.kill('SIGKILL');
        await exited;
      }
    });
    const ready = await Promise.race([
      once(controller, 'message').then(([message]) => message as { type: string }),
      exited.then(() => {
        throw new Error('Controller exited before ready');
      }),
      delay(10_000).then(() => {
        throw new Error('Controller did not become ready');
      }),
    ]);
    assert.equal(ready.type, 'ready');
    const deadline = Date.now() + 15_000;
    while (childResults(f.runnerDirectory).length === 0) {
      assert.ok(Date.now() < deadline, 'Real controller must launch its MCP worker');
      await delay(50);
    }
    const first = childResults(f.runnerDirectory)[0];
    const sessionId = (await f.sessions())[0].id;
    const duplicate = f.make();
    await assert.rejects(async () => duplicate.start(), /lock|controller|database/i);
    await duplicate.stop();
    await delay(100);
    assert.equal(
      (await f.sessions())[0].status,
      'active',
      'An unowned controller disposal must not close the original lease',
    );
    controller.kill('SIGKILL');
    await exited;
    const replacement = f.make();
    await replacement.start();
    await replacement.tick();
    assert.equal((await f.sessions()).length, 1);
    assert.equal((await f.sessions())[0].id, sessionId);
    assert.equal(childResults(f.runnerDirectory).length, 1);
    assert.equal(childResults(f.runnerDirectory)[0].pid, first.pid);
    assert.equal(replacement.snapshot().launches.length, 1);
    assert.equal(replacement.snapshot().launches[0].sessionId, sessionId);
    assert.ok(!terminal(replacement.snapshot().launches[0].status));
    assert.equal((await f.app.ctx.workflows.workStarts(f.source, f.task.id)).length, 1);
    await f.app.ctx.sessions.halt(f.source);
    await until(
      () => replacement.snapshot().launches.every((launch) => terminal(launch.status)),
      replacement,
      'reconnected worker shutdown',
    );
  },
);

test(
  'scratch runner refuses a declared persistent workspace before spawning or activating work',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    await f.app.ctx.tasks.markFailed(f.source, {
      taskId: f.task.id,
      expectedRevision: 0,
      reason: 'This fixture tests a different workflow workspace.',
      requestId: 'close-scratch-task',
    });
    const handle = await f.app.ctx.workflows.register(
      {
        name: 'runner-workspace-required',
        version: 1,
        initial: 'working',
        states: ['working', 'done'],
        terminal: ['done'],
        edges: [{ from: 'working', action: 'finish', to: 'done' }],
      },
      {
        actions: [
          {
            name: 'finish',
            states: ['working'],
            transitions: ['finish'],
            tool: 'finish',
            instruction: 'Finish.',
            check: async () => {},
          },
        ],
        assignments: [
          {
            state: 'working',
            check: async ({ caller, tx }) => {
              await f.app.ctx.scope.require(caller, 'write', tx);
            },
            build: async () => ({
              role: 'producer',
              label: 'Requires a code checkout',
              brief: 'This work requires a pinned code workspace.',
              references: [],
              handoff: { instruction: 'Finish.', tools: [] },
              execution: { readOnly: false, tools: [] },
              context: null,
            }),
            execution: {
              readOnly: false,
              tools: [],
              workspace: {
                mode: 'persistent',
                namespace: 'test-work',
                base: 'reference:code',
                perBase: true,
                retain: true,
                advancesCentral: false,
              },
            },
            lease: {
              role: async ({
                caller,
                tx,
              }): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => {
                await f.app.ctx.scope.require(caller, 'write', tx);
                return 'producer';
              },
              acquire: async () => ({}),
              check: async () => {},
              release: async () => {},
            },
          },
        ],
      },
    );
    const target = await handle.start(f.source, {
      workflow: 'runner-workspace-required',
      requestId: 'workspace',
    });
    const runner = f.make();
    await runner.start();
    await f.enabled(true);
    await until(
      async () => (await f.sessions()).some((session) => session.outcome === 'workspace_failed'),
      runner,
      'explicit workspace refusal',
    );
    await f.enabled(false);
    assert.equal(runner.snapshot().launches.length, 1);
    assert.ok(terminal(runner.snapshot().launches[0].status));
    assert.equal(childResults(f.runnerDirectory).length, 0);
    assert.equal((await f.app.ctx.workflows.workStarts(f.source, target.id)).length, 0);
    assert.equal(
      (await f.sessions())[0].hostRef,
      null,
      'No process was bound for the unsupported workspace',
    );
    assert.equal((await f.sessions())[0].execution.policy.workspace?.mode, 'persistent');
  },
);

test(
  'halting a second lease between get and attach preserves the first running worker',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, ['--hold']);
    f.config.capacity = 2;
    f.config.profiles[0].parallelism = 2;
    let secondTaskId: string | undefined;
    let haltedSessionId: string | undefined;
    let attachRefusal: { status: number; code: string } | undefined;
    const fetchedSessions = new Set<string>();
    const runner = f.make(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const match = url.pathname.match(/^\/sessions\/([^/]+)(\/attach)?$/);
      if (match && !match[2] && init?.method === 'GET') fetchedSessions.add(match[1]);
      if (match?.[2] && !haltedSessionId && secondTaskId) {
        const pending = (await f.sessions()).find((session) => session.id === match[1]);
        if (pending?.instanceId === secondTaskId) {
          assert(fetchedSessions.has(pending.id), 'The offer was read before this attachment');
          assert.equal(pending.status, 'offered');
          haltedSessionId = pending.id;
          const halt = await fetch(`${f.app.ctx.api.url}/sessions/${pending.id}/halt`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${f.token}`,
              'x-merv-project-id': f.source.projectId,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ reason: 'Cancel only the second worker before attachment.' }),
          });
          assert.equal(halt.status, 200);
          assert.deepEqual(await halt.json(), { halted: 1 });
          const response = await fetch(input, init);
          const body = (await response.clone().json()) as { error: { code: string } };
          attachRefusal = { status: response.status, code: body.error.code };
          return response;
        }
      }
      return fetch(input, init);
    });
    await runner.start();
    await f.enabled(true);
    await until(() => childResults(f.runnerDirectory).length === 1, runner, 'first holding worker');
    const firstChild = childResults(f.runnerDirectory)[0];
    const firstSession = (await f.sessions()).find(
      (session) => session.actorId === firstChild.actorId,
    )!;
    assert.equal(firstSession.status, 'active');

    const second = await f.app.ctx.tasks.create(f.source, {
      title: 'A separate worker to cancel',
      goal: 'Exercise cancellation before a process is launched.',
      checks: ['The unrelated worker continues running.'],
      requestId: 'second-task-race',
    });
    secondTaskId = second.id;
    await runner.tick();
    assert.deepEqual(attachRefusal, { status: 401, code: 'session_closed' });
    assert(haltedSessionId);
    assert.equal(runner.snapshot().state, 'degraded', 'A session refusal is not source revocation');
    const firstLaunch = () =>
      runner.snapshot().launches.find((launch) => launch.sessionId === firstSession.id)!;
    assert(!terminal(firstLaunch().status), 'The unrelated process must survive the refusal');
    assert.doesNotThrow(() => process.kill(firstChild.pid, 0));

    // Pause new offers while the controller reconciles the cancelled reservation.
    await f.enabled(false);
    await until(
      () =>
        runner
          .snapshot()
          .launches.some(
            (launch) => launch.sessionId === haltedSessionId && terminal(launch.status),
          ),
      runner,
      'cancelled second reservation',
    );
    await runner.tick();
    assert(!terminal(firstLaunch().status));
    assert.doesNotThrow(() => process.kill(firstChild.pid, 0));
    assert.equal(
      (await f.sessions()).find((session) => session.id === firstSession.id)?.status,
      'active',
    );
    assert.equal(
      (await f.sessions()).find((session) => session.id === haltedSessionId)?.outcome,
      'halted',
    );
    assert.equal(childResults(f.runnerDirectory).length, 1, 'The second child never starts');
    assert.equal(
      (await f.app.ctx.workflows.workStarts(f.source, firstSession.instanceId)).length,
      1,
    );
    assert.equal((await f.app.ctx.workflows.workStarts(f.source, second.id)).length, 0);
  },
);
