import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Caller } from '@merv/contracts';
import type { RunnerSnapshot } from '@merv/runner';
import { createApp } from '../src/app.js';
import { loadConfiguration } from '../src/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/runner-worker.mjs', import.meta.url));
const credentialEnv = 'MERV_RUNNER_INTEGRATION_CLI_SOURCE';

interface Ready {
  status: 'ready';
  mode: 'runner';
  directory: string;
  runner: RunnerSnapshot;
  plugins: { id: string; name: string; state: string }[];
}
function bounded<T>(operation: Promise<T>, message: string, milliseconds = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
function launch(t: TestContext, args: string[], source?: string, noCode = false) {
  // Fail on runtime plugin imports, including transitive imports. A blank PATH also removes Git.
  const hook = `export async function resolve(specifier, context, next) {
    if (specifier.startsWith('@merv/code')) throw Error('Code must remain unloaded');
    const resolved = await next(specifier, context);
    if (resolved.url.includes('/packages/code/')) throw Error('Code must remain unloaded');
    return resolved;
  }`;
  const guard = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url);`;
  const preloads = noCode ? ['--import', `data:text/javascript,${encodeURIComponent(guard)}`] : [];
  const child = spawn(process.execPath, ['--import', 'tsx', ...preloads, cli, 'runner', ...args], {
    cwd: root,
    env: {
      PATH: noCode ? '' : process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ...(source === undefined ? {} : { [credentialEnv]: source }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '',
    buffer = '';
  let resolveReady!: (ready: Ready) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<Ready>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const value = JSON.parse(line);
        if (value.status === 'ready') resolveReady(value);
      } catch {
        /* Ordinary Cordis diagnostics are not readiness messages. */
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('error', (error) => {
      rejectReady(error);
      reject(error);
    });
    child.once('close', (code) => {
      rejectReady(new Error(`Runner CLI exited before readiness: ${code}; ${stderr}`));
      resolve(code);
    });
  });
  const stop = async (signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    try {
      return await bounded(finished, 'Runner CLI did not finish Cordis disposal', 10_000);
    } catch (error) {
      child.kill('SIGKILL');
      await finished;
      throw error;
    }
  };
  t.after(() => stop());
  return {
    ready,
    finished,
    stop,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}
function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}
function configuration(directory: string) {
  return {
    directory: './machine',
    baseUrl: 'http://127.0.0.1:1',
    projectId: 'synthetic-project',
    credentialEnv,
    requestTimeoutMs: 100,
    pollIntervalMs: 100,
    profiles: [
      {
        name: 'fixture',
        harness: 'command',
        executable: process.execPath,
        args: [worker, '--hold'],
        enabled: true,
        parallelism: 1,
      },
    ],
  };
}

test('runner CLI rejects unsafe or missing configuration without disclosing input', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-runner-cli-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'runner.json');
  const secret = 'SYNTHETIC_BEARER_MUST_NOT_APPEAR_IN_DIAGNOSTICS';
  for (const args of [
    [],
    ['--token', secret],
    ['--dir', directory],
    ['--config', path, '--config', path],
  ]) {
    const child = launch(t, args);
    assert.equal(await bounded(child.finished, 'Invalid runner arguments did not exit'), 1);
    assert.match(child.stderr, /"error":"arguments"/);
    assert.equal((child.stdout + child.stderr).includes(secret), false);
  }
  const invalid: unknown[] = [
    { ...configuration(directory), token: secret },
    { ...configuration(directory), credentialEnv: 'PATH' },
    { ...configuration(directory), workspaceDrivers: ['untrusted'] },
    { ...configuration(directory), workspaceDrivers: ['code', 'code'] },
    {
      ...configuration(directory),
      profiles: [{ ...configuration(directory).profiles[0], env: { TOKEN: secret } }],
    },
  ];
  for (const value of invalid) {
    writeFileSync(path, JSON.stringify(value));
    const child = launch(t, ['--config', path], secret);
    assert.equal(await bounded(child.finished, 'Invalid runner configuration did not exit'), 1);
    assert.match(child.stderr, /invalid_runner_(config|profile)/);
    assert.equal((child.stdout + child.stderr).includes(secret), false);
    assert.doesNotMatch(child.stdout, /"status":"ready"/);
  }
  writeFileSync(path, `{ "token": "${secret}", }`);
  const malformed = launch(t, ['--config', path]);
  assert.equal(await bounded(malformed.finished, 'Malformed runner JSON did not exit'), 1);
  assert.match(malformed.stderr, /invalid_runner_config/);
  assert.equal((malformed.stdout + malformed.stderr).includes(secret), false);
  writeFileSync(path, JSON.stringify(configuration(directory)));
  const missing = launch(t, ['--config', path]);
  assert.equal(await bounded(missing.finished, 'Missing source environment did not exit'), 1);
  assert.equal(existsSync(join(directory, 'machine')), false);
});

test('runner CLI retains the default Code driver and supports explicit opt-in', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-runner-cli-drivers-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const workspaceDrivers of [undefined, ['code']]) {
    const machine = workspaceDrivers ? 'explicit' : 'default';
    const path = join(directory, `${machine}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        ...configuration(directory),
        directory: `./${machine}`,
        workspaceDrivers,
      }),
    );
    const child = launch(t, ['--config', path], 'synthetic-offline-source');
    const ready = await bounded(child.ready, 'Code-enabled runner did not become ready');
    assert.equal(existsSync(join(ready.directory, 'code-v2')), true);
    assert.equal(await child.stop(), 0, child.stderr);
  }
});

test(
  'workspace-free CLI runs real MCP children without Code or Git and drains them on both signals',
  { timeout: 45_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-runner-cli-live-'));
    const serverDirectory = join(directory, 'server');
    const composition = loadConfiguration({ directory: serverDirectory, api: true, port: 0 });
    const app = await createApp({
      directory: serverDirectory,
      config: { plugins: composition.entries.filter((entry) => !entry.id.startsWith('code')) },
    });
    t.after(async () => {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'CLI runner',
      actorName: 'Operator',
    });
    const caller: Caller = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    symlinkSync(process.execPath, join(directory, 'relative-node'));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const task = await app.ctx.tasks.create(caller, {
        title: signal,
        goal: 'Prove CLI shutdown.',
        checks: ['Real child used MCP.'],
        requestId: signal,
      });
      const machine = `machine-${signal}`;
      const config = {
        ...configuration(directory),
        directory: `./${machine}`,
        baseUrl: app.ctx.api.url!,
        projectId: boot.project.id,
        requestTimeoutMs: 1000,
        capacity: 1,
        workspaceDrivers: [],
        profiles: [
          {
            name: 'fixture',
            harness: 'command',
            executable: './relative-node',
            args: [worker, '--hold', '${ARGV_MUST_REMAIN_LITERAL}'],
            enabled: true,
            parallelism: 1,
          },
        ],
      };
      const path = join(directory, `${signal}.json`);
      writeFileSync(path, JSON.stringify(config));
      await app.ctx.sessions.setDispatch(caller, { enabled: true });
      const child = launch(t, ['--config', path], boot.token, true);
      const ready = await bounded(child.ready, 'Runner-only Cordis provider did not become ready');
      assert.equal(ready.mode, 'runner');
      assert.equal(ready.directory, join(directory, machine));
      assert.deepEqual(ready.plugins, [{ id: 'runner', name: '@merv/runner', state: 'active' }]);
      assert.ok(ready.runner.runnerId);
      assert.equal(existsSync(join(ready.directory, 'code-v2')), false);
      const deadline = Date.now() + 15_000;
      let outputs: string[] = [];
      while (
        (outputs = files(ready.directory).filter((file) => file.endsWith('/worker-result.json')))
          .length === 0
      ) {
        assert.ok(Date.now() < deadline, `CLI worker did not reach MCP: ${child.stderr}`);
        await delay(50);
      }
      const output = JSON.parse(readFileSync(outputs[0], 'utf8'));
      assert.equal(output.taskId, task.id);
      assert.equal(output.sourceEnvironmentAbsent, true);
      assert.equal(output.scopedCatalog, true);
      const active = (await app.ctx.sessions.list(caller)).find(
        (session) => session.runnerId === ready.runner.runnerId,
      )!;
      assert.equal(active.status, 'active');
      const presence = (await app.ctx.sessions.projectStatus(caller)).runners.find(
        (runner) => runner.runnerId === ready.runner.runnerId,
      );
      assert.ok(presence);
      assert.ok(!presence.capabilities?.includes('code.v2'));
      await app.ctx.sessions.setDispatch(caller, { enabled: false });
      assert.equal(await child.stop(signal), 0, child.stderr);
      const closed = await app.ctx.sessions.get(caller, active.id);
      assert.equal(closed.status, 'released');
      assert.equal(existsSync(join(ready.directory, 'state.sqlite')), false);
      assert.equal(existsSync(join(ready.directory, 'credentials.json')), false);
      assert.equal((child.stdout + child.stderr).includes(boot.token), false);
      for (const file of files(ready.directory))
        assert.equal(
          readFileSync(file).includes(Buffer.from(boot.token)),
          false,
          'Source bearer must never persist',
        );
      await app.ctx.tasks.markFailed(caller, {
        taskId: task.id,
        expectedRevision: 0,
        reason: 'CLI test complete.',
        requestId: `finish-${signal}`,
      });
    }
  },
);
