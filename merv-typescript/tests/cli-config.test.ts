import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { cliEnv, postgresUrl, schemaFor } from './fixtures/state.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface ReadyStatus {
  status: 'ready';
  directory: string;
  url: string;
  mcp: string;
  plugins: {
    id: string;
    name: string;
    state: string;
    required: boolean;
    missingDependencies: string[];
  }[];
}

function bounded<T>(operation: Promise<T>, description: string, milliseconds = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), milliseconds);
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

/** Whether the CLI created the PostgreSQL schema that holds `directory`'s state. */
async function stored(directory: string) {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [
      schemaFor(directory),
    ]);
    return rows[0].present as boolean;
  } finally {
    await client.end();
  }
}

function launch(t: TestContext, args: string[], env: Record<string, string> = {}) {
  // The CLI keeps a --dir data directory's state in the schema the test fixture assigns to it.
  const dir = args.indexOf('--dir');
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ...(dir < 0 ? {} : cliEnv(args[dir + 1]!)),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '',
    buffer = '';
  let readyResolve!: (value: ReadyStatus) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<ReadyStatus>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => undefined);
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.status === 'ready') readyResolve(value);
      } catch {
        /* Cordis may log ordinary diagnostic lines before readiness. */
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', (error) => {
        readyReject(error);
        reject(error);
      });
      child.once('close', (code, signal) => {
        readyReject(new Error(`CLI exited before readiness: ${code}; ${stderr}`));
        resolve({ code, signal });
      });
    },
  );
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try {
      return await bounded(finished, 'CLI did not stop after SIGTERM', 5_000);
    } catch (error) {
      child.kill('SIGKILL');
      await bounded(finished, 'CLI did not stop after SIGKILL', 5_000);
      throw error;
    }
  };
  t.after(stop);
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

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-cli-config-'));
  const dataDirectory = join(directory, 'data');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, dataDirectory };
}

async function initialize(t: TestContext, directory: string) {
  const process = launch(t, ['init', '--name', 'Configured CLI project', '--dir', directory]);
  const result = await bounded(process.finished, 'CLI init did not finish');
  assert.equal(result.code, 0, process.stderr);
  return JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf8'));
}

function defaultConfig() {
  return JSON.parse(readFileSync(join(root, 'config/default.json'), 'utf8')) as {
    plugins: {
      id: string;
      name: string;
      config?: Record<string, unknown>;
      disabled?: boolean;
      required?: boolean;
    }[];
  };
}

test('CLI help describes config; invalid options and init/actor config misuse fail promptly', async (t) => {
  const help = launch(t, ['help']);
  assert.equal((await bounded(help.finished, 'CLI help did not finish')).code, 0);
  assert.match(help.stdout, /--config PATH/);
  const { directory, dataDirectory } = fixture(t);
  for (const args of [
    ['serve', '--unknown', 'value'],
    ['serve', '--port', 'not-a-port'],
    ['serve', '--port', '0', '--port', '1'],
    ['init', '--config', join(directory, 'missing.json')],
    ['actor', '--config', join(directory, 'missing.json')],
    ['init', '--port', '0'],
    ['serve', '--config'],
  ]) {
    const process = launch(t, [...args, '--dir', dataDirectory]);
    const result = await bounded(process.finished, `CLI did not reject ${args.join(' ')}`);
    assert.equal(result.code, 1);
    assert.match(process.stderr, /"error":"arguments"/);
    assert.doesNotMatch(process.stdout, /"status":"ready"/);
    if (args[0] !== 'serve' && args.includes('--config'))
      assert.match(process.stderr, /supported only by serve/);
  }
  assert.equal(
    existsSync(dataDirectory),
    false,
    'Rejected arguments must not initialize local state',
  );
  assert.equal(await stored(dataDirectory), false, 'Rejected arguments must not create a schema');
});

test('init and actor refuse a deployment environment before opening its database', async (t) => {
  const { dataDirectory } = fixture(t);
  for (const args of [
    ['init', '--name', 'Stray project'],
    ['actor', '--name', 'Stray', '--role', 'producer'],
  ]) {
    const process = launch(t, [...args, '--dir', dataDirectory], {
      MERV_TS_DB_SCHEMA: 'merv_ts',
    });
    const result = await bounded(process.finished, `CLI did not refuse ${args[0]}`);
    assert.equal(result.code, 1);
    assert.match(process.stderr, /"error":"deployment_environment"/);
  }
  assert.equal(existsSync(dataDirectory), false, 'A refused init must not write credentials');
  assert.equal(await stored(dataDirectory), false, 'A refused init must not create a schema');
});

test('CLI serves a temporary Cordis configuration with placeholders and reports only safe status', async (t) => {
  const { directory, dataDirectory } = fixture(t);
  const credentials = await initialize(t, dataDirectory);
  const config = defaultConfig();
  const blobs = config.plugins.find((entry) => entry.id === 'blobs')!;
  blobs.config = { root: '${directory}/SYNTHETIC_CONFIG_VALUE_MUST_NOT_BE_LOGGED' };
  const api = config.plugins.find((entry) => entry.id === 'api')!;
  api.config = { ...api.config, host: '${host}', port: '${port}' };
  const configPath = join(directory, 'cordis.json');
  writeFileSync(configPath, JSON.stringify(config));
  const process = launch(t, [
    'serve',
    '--dir',
    dataDirectory,
    '--config',
    configPath,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ]);
  const ready = await bounded(process.ready, 'Configured CLI did not become ready');
  assert.equal(ready.directory, resolve(dataDirectory));
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(ready.mcp, `${ready.url}/mcp`);
  assert.deepEqual(
    ready.plugins.map((entry: { id: string }) => entry.id).sort(),
    config.plugins.map((entry) => entry.id).sort(),
  );
  for (const entry of ready.plugins) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'id',
      'missingDependencies',
      'name',
      'required',
      'state',
    ]);
    const configured = config.plugins.find(({ id }) => id === entry.id)!;
    assert.equal(entry.state, configured.disabled ? 'disabled' : 'active');
    assert.equal(entry.required, configured.required !== false);
    assert.deepEqual(entry.missingDependencies, []);
  }
  assert.doesNotMatch(process.stdout, /SYNTHETIC_CONFIG_VALUE_MUST_NOT_BE_LOGGED/);
  assert.ok(!process.stdout.includes(credentials.token));
  assert.equal((await fetch(`${ready.url}/health`)).status, 200);
  const response = await fetch(`${ready.url}/tools`, {
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  assert.equal(response.status, 200);
  const catalog = (await response.json()) as { tools: { name: string }[] };
  assert.equal(catalog.tools.length, 97);
  for (const name of ['reflection.end', 'session.dispatch', 'session.halt', 'session.observe'])
    assert.ok(
      catalog.tools.some((tool) => tool.name === name),
      `${name} is served`,
    );
  assert.ok(catalog.tools.some((tool) => tool.name === 'task.reissue_review'));
  assert.ok(catalog.tools.some((tool) => tool.name === 'ui.shell'));
  assert.ok(!catalog.tools.some((tool) => tool.name.startsWith('feed.')));
  assert.ok(await stored(dataDirectory), 'serve keeps its state in the data directory schema');
  assert.equal((await process.stop()).code, 0);
  await assert.rejects(fetch(`${ready.url}/health`));
});

test('CLI preserves a literal config port when no port override is supplied', async (t) => {
  const { directory, dataDirectory } = fixture(t);
  await initialize(t, dataDirectory);
  const config = defaultConfig();
  const api = config.plugins.find((entry) => entry.id === 'api')!;
  api.config = { ...api.config, port: 0 };
  const configPath = join(directory, 'cordis.json');
  writeFileSync(configPath, JSON.stringify(config));
  const process = launch(t, ['serve', '--dir', dataDirectory, '--config', configPath]);
  const ready = await bounded(process.ready, 'Configured CLI did not preserve its port');
  assert.notEqual(new URL(ready.url).port, '3081');
  assert.equal((await process.stop()).code, 0);
});

test('CLI rejects a serve config without API and disposes other active plugins', async (t) => {
  const { directory, dataDirectory } = fixture(t);
  await initialize(t, dataDirectory);
  const config = defaultConfig();
  config.plugins = config.plugins.filter((entry) => entry.id === 'state' || entry.id === 'scope');
  const cleanupPath = join(directory, 'disposed.txt');
  writeFileSync(
    join(directory, 'keepalive.mjs'),
    `
    import { writeFileSync } from 'node:fs';
    export default { name: 'keepalive', apply(ctx, config) {
      ctx.effect(() => {
        const timer = setInterval(() => {}, 100);
        return () => { clearInterval(timer); writeFileSync(config.cleanupPath, 'disposed'); };
      });
    } };
  `,
  );
  config.plugins.push({ id: 'keepalive', name: './keepalive.mjs', config: { cleanupPath } });
  const configPath = join(directory, 'no-api.json');
  writeFileSync(configPath, JSON.stringify(config));
  const process = launch(t, ['serve', '--dir', dataDirectory, '--config', configPath]);
  const result = await bounded(
    process.finished,
    'CLI failed to dispose the active timer after missing API',
  );
  assert.equal(result.code, 1);
  assert.match(process.stderr, /"error":"api_unavailable"/);
  assert.match(process.stderr, /configured, active API service/);
  assert.doesNotMatch(process.stdout, /"status":"ready"/);
  assert.equal(readFileSync(cleanupPath, 'utf8'), 'disposed');
});
