import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import type { Caller } from '@merv/contracts';
import { MachineRunner, type RunnerConfig } from '@merv/runner';
import type { Session } from '@merv/sessions/types';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { currentTask } from './fixtures/current-work.js';

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
async function fixture(t: TestContext, args: string[] = [], managed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-runner-integration-'));
  const managedSecretEnv = `MERV_RUNNER_MANAGED_${randomUUID().replaceAll('-', '')}`;
  if (managed) process.env[managedSecretEnv] = randomUUID().repeat(3);
  const serverDirectory = join(directory, 'server');
  const entries = managed
    ? loadConfiguration({ directory: serverDirectory, api: true, port: 0 }).entries.map((entry) =>
        entry.id === 'sessions'
          ? { ...entry, config: { ...entry.config, managedSecretEnv } }
          : entry,
      )
    : undefined;
  const app = await createApp({
    directory: serverDirectory,
    ...(managed ? {} : { api: true }),
    port: 0,
    ...(entries ? { config: { plugins: entries } } : {}),
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Machine runner',
    actorName: 'Owner',
  });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const task = await currentTask(app.ctx, source, {
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
    if (managed) delete process.env[managedSecretEnv];
    rmSync(directory, { recursive: true, force: true });
  });
  const make = (fetcher?: typeof fetch, clock?: () => number, code = !managed) => {
    const runner = new MachineRunner(config, {
      autoPoll: false,
      drivers: !code
        ? []
        : [
            {
              name: 'code.v2',
              create: (host, transport) => new CodeWorkspaceDriver(host, transport, { pollMs: 25 }),
            },
          ],
      ...(fetcher ? { fetch: fetcher } : {}),
      // A work host's trusted barrier between steps; here nothing escapes its launches.
      resetAssignment: async () => {},
      clock,
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
    await app.ctx.sessions.dispatch.setDispatch(source, { enabled: value });
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
    assert.equal((await f.sessions())[0].closeReason, 'local_process_exit_code_0_without_handoff');
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
  'definitive source revocation stops a real child even when release reporting is forbidden',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, ['--hold']);
    const runner = f.make();
    await runner.start();
    await f.enabled(true);
    await until(() => childResults(f.runnerDirectory).length === 1, runner, 'source-bound child');
    const replacement = await f.app.ctx.scope.credentials.issueActorCredential(f.source, {
      actorId: f.source.actorId,
    });
    await f.app.ctx.scope.credentials.revokeCredential(
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
    await f.app.ctx.sessions.dispatch.halt(f.source);
    await until(
      () => replacement.snapshot().launches.every((launch) => terminal(launch.status)),
      replacement,
      'reconnected worker shutdown',
    );
  },
);

// Model projection must preserve continuation comparison and changed budgets.
test('compact assignments resume unchanged but resend changed limits', async () => {
  const { buildLaunch, heldAssignment } = await import('../packages/runner/src/profiles.js');
  const offer = (name: string) => {
    const common = {
      instanceId: `instance_${name}`,
      projectId: 'project_fixture',
      actorId: 'actor_fixture',
      revision: 0,
    };
    return {
      ...common,
      id: `session_${name}`,
      expectedRevision: 0,
      status: 'offered',
      assignment: { ...common, label: 'Work', brief: 'Do the work.' },
      execution: { ...common, policy: { readOnly: false, tools: [] } },
    };
  };
  const id = '0199a0b2-1111-7222-8333-944445555666';
  const bearer = `ms_${'A'.repeat(43)}`;
  const codex = {
    name: 'codex',
    harness: 'codex' as const,
    executable: '/usr/local/bin/codex',
    enabled: true,
    parallelism: 1,
  };
  const rendered = (feedback: string) => {
    const block = (heading: string, body: string) => `\n### ${heading}\n~~~\n${body}\n~~~\n`;
    return `Do the work.\n\nAssignment: {"id":"instance_argv"}\n\n## Paper${block('paper:methods — Methods (text, 600 characters)', 'M'.repeat(600))}${block('paper:empty — Empty (text, 0 characters)', '')}\n## Previous reviews${block('feedback:instance_argv — Previous reviews (text)', feedback)}\n## Expected output\nSay what changed.\n`;
  };
  const visit = (feedback: string, registrationId: string) => {
    const base = offer('argv');
    return {
      ...base,
      continuity: { key: 'key' },
      assignment: {
        ...base.assignment,
        execution: { readOnly: false, registrationId, tools: [] },
        context: { hash: 'h', prompt: rendered(feedback), sources: [], omitted: [] },
      },
    } as unknown as import('@merv/sessions/types').Session;
  };
  const sent = (
    session: import('@merv/sessions/types').Session,
    held?: import('../packages/runner/src/profiles.js').LaunchRequest['held'],
    resume: string | null = id,
  ) =>
    buildLaunch(
      codex,
      {
        session,
        prompt: 'Worker prompt.',
        secret: bearer,
        mcpUrl: 'http://127.0.0.1:9/mcp',
        cwd: '/tmp',
        shellEnvFile: '/tmp/shell-env.sh',
        ...(resume && { resume }),
        ...(held !== undefined && { held }),
      },
      { PATH: '/usr/bin' },
    ).stdin;

  for (const workflow of ['experiment', 'task']) {
    const session = visit('Check the original request.', 'registration');
    session.assignment.references = [];
    session.assignment.workflow = session.execution.workflow = workflow;
    session.assignment.execution.policy = { ...session.execution.policy, maxModelTokens: 10000 };
    const original = JSON.stringify(session.assignment);
    const first = sent(session, undefined, null);
    const held = heldAssignment([first])!;
    const view = JSON.parse(held.copy);
    assert.equal(view.execution.limits.maxModelTokens, 10000);
    assert.ok(!('policy' in view.execution));
    assert.ok(!('sources' in view.context));
    assert.equal(JSON.stringify(session.assignment), original);
    assert.match(sent(session, held), /Frozen assignment: unchanged since the copy/);
    session.assignment.execution.policy.maxModelTokens = 5000;
    const changed = sent(session, held);
    assert.doesNotMatch(changed, /Frozen assignment: unchanged since the copy/);
    assert.match(changed, /"maxModelTokens":5000/);
  }
});
