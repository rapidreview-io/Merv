import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalLedger, terminalLaunch } from '../packages/runner/src/ledger.js';
import { ProcessHost } from '../packages/runner/src/process-host.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, milliseconds = 5000) {
  const end = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() > end) assert.fail('Timed out waiting for supervised process');
    await delay(20);
  }
}
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-process-'));
  const binding = {
    baseUrl: 'http://127.0.0.1:7000',
    sourceId: 'source-digest',
    projectId: 'project-a',
  };
  const ledger = new LocalLedger({ directory, binding });
  const host = new ProcessHost(ledger);
  t.after(async () => {
    for (const launch of ledger.list()) if (!terminalLaunch(launch)) await host.stop(launch.id);
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reserve = (id: string, duration = 15000) =>
    ledger.reserve({ id, sessionId: `session-${id}`, deadline: Date.now() + duration });
  const token = `ms_${randomBytes(32).toString('base64url')}`;
  const command = (source: string) => ({
    executable: process.execPath,
    args: ['-e', source],
    cwd: directory,
    env: { PATH: process.env.PATH ?? '' },
  });
  return { directory, binding, ledger, host, reserve, token, command };
}

test('local ledger binds identity, persists exact retry inputs without bearers, and holds one controller lock', (t) => {
  const { directory, binding, ledger } = setup(t);
  const release = ledger.acquireController();
  const second = new LocalLedger({ directory, binding });
  t.after(() => second.close());
  assert.throws(() => second.acquireController(), /Another runner controller/);
  const pending = ledger.request(
    { name: 'codex', harness: 'codex', model: 'model-a' },
    { hardDeadlineSeconds: 300 },
  );
  assert.deepEqual(
    second.request(
      { name: 'codex', harness: 'codex', model: 'changed' },
      { hardDeadlineSeconds: 600 },
    ),
    pending,
  );
  assert.deepEqual(second.pendingRequests(), [pending]);
  assert.equal(second.runnerId, ledger.runnerId);
  assert.equal(second.requestSecret(pending.requestId), pending.secret);
  assert.throws(
    () => new LocalLedger({ directory, binding: { ...binding, projectId: 'project-b' } }),
    /different server or source/,
  );
  const record = ledger.reserve({
    id: 'id',
    sessionId: 'session',
    deadline: Date.now() + 10000,
    metadata: { profile: { executable: '/bin/echo', args: ['hello'] } },
  });
  assert.throws(
    () => ledger.updateMetadata(record.id, { sessionToken: pending.secret }),
    /Credentials/,
  );
  ledger.updateMetadata(record.id, {
    attached: true,
    session: { source: { credentialId: 'credential-id' } },
  });
  assert.equal(second.get(record.id)?.metadata.attached, true);
  for (const file of readdirSync(directory).filter((file) => file.startsWith('ledger.sqlite'))) {
    assert.equal(statSync(join(directory, file)).mode & 0o077, 0);
    assert.ok(!readFileSync(join(directory, file)).includes(Buffer.from(pending.secret)));
  }
  release();
  const releaseSecond = second.acquireController();
  releaseSecond();
  ledger.completeRequest('codex', pending.requestId);
  assert.notEqual(ledger.request({ name: 'codex', harness: 'codex' }).requestId, pending.requestId);
});

test('two guardian attempts execute an exact durable launch once and redact split-token output', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('once');
  const input = {
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: command(
      `const fs=require('fs'); fs.appendFileSync('count','once\\n'); const s=process.env.MERV_AGENT_SESSION_TOKEN; process.stdout.write(s.slice(0,20)); setTimeout(()=>{process.stdout.write(s.slice(20)+'\\n');process.stderr.write(s);},20);`,
    ),
  };
  await Promise.all([await host.launch(input), await host.launch(input)]);
  await until(() => terminalLaunch(ledger.get(record.id)!));
  assert.equal(ledger.get(record.id)?.status, 'exited');
  assert.equal(ledger.get(record.id)?.exitCode, 0);
  assert.equal(readFileSync(join(input.command.cwd, 'count'), 'utf8'), 'once\n');
  assert.equal(readFileSync(join(record.runDirectory, 'stdout.log'), 'utf8'), '[REDACTED]\n');
  assert.equal(readFileSync(join(record.runDirectory, 'stderr.log'), 'utf8'), '[REDACTED]');
  await host.launch(input);
  assert.equal(readFileSync(join(input.command.cwd, 'count'), 'utf8'), 'once\n');
});

test('reopened controller reconnects to its guardian and stop proves the entire inherited process group ended', async (t) => {
  const { directory, binding, ledger, host, reserve, token, command } = setup(t);
  const record = reserve('tree');
  const child = `const fs=require('fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync('ticks','x'),15)`;
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: command(
      `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
    ),
  });
  await until(() => ledger.get(record.id)?.status === 'running');
  const reopened = new LocalLedger({ directory, binding });
  try {
    const recovered = new ProcessHost(reopened);
    assert.equal((await recovered.inspect(record.id)).status, 'running');
    await delay(100);
    const stopped = await recovered.stop(record.id);
    assert.equal(stopped.status, 'stopped');
    const size = statSync(join(directory, 'ticks')).size;
    await delay(100);
    assert.equal(statSync(join(directory, 'ticks')).size, size);
  } finally {
    reopened.close();
  }
});

test('group owner enforces the deadline without controller polling and honours an acknowledged extension', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('deadline', 1200);
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: command(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`),
  });
  await until(() => ledger.get(record.id)?.status === 'running');
  const extended = Date.now() + 1800;
  await host.extendDeadline(record.id, extended);
  await delay(1250);
  assert.equal(ledger.get(record.id)?.status, 'running');
  await until(() => terminalLaunch(ledger.get(record.id)!));
  assert.equal(ledger.get(record.id)?.reason, 'deadline');
});

test('claimed intent without a reachable guardian stays uncertain and cannot be restarted or freed by remote status', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('unknown');
  const db = new DatabaseSync(ledger.path);
  db.prepare("UPDATE launches SET status='starting' WHERE id=?").run(record.id);
  db.close();
  assert.equal((await host.reconcile())[0].status, 'uncertain');
  ledger.updateMetadata(record.id, { session: { status: 'released' } });
  assert.equal((await host.stop(record.id)).status, 'uncertain');
  await assert.rejects(
    async () =>
      host.launch({
        launchId: record.id,
        sessionToken: token,
        deadline: record.deadline,
        command: command('process.exit(0)'),
      }),
    /uncertain launch/,
  );
  assert.equal(terminalLaunch(ledger.get(record.id)!), false);
});

test('cancellation before atomic claim prevents a later launch and rejects identity/credential confusion', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('cancel');
  assert.throws(
    () => ledger.reserve({ id: record.id, sessionId: 'different', deadline: record.deadline }),
    /conflicts/,
  );
  assert.equal((await host.stop(record.id)).status, 'stopped');
  assert.equal(
    (
      await host.launch({
        launchId: record.id,
        sessionToken: token,
        deadline: record.deadline,
        command: command('throw Error()'),
      })
    ).reason,
    'cancelled_before_spawn',
  );
  const active = reserve('credentials');
  await assert.rejects(
    async () =>
      host.launch({
        launchId: active.id,
        sessionToken: `mk_${'a'.repeat(43)}`,
        deadline: active.deadline,
        command: command(''),
      }),
    /scoped session token/,
  );
  await assert.rejects(
    async () =>
      host.launch({
        launchId: active.id,
        sessionToken: token,
        deadline: active.deadline,
        command: { ...command(''), env: { MERV_API_KEY: `mk_${'a'.repeat(43)}` } },
      }),
    /source credentials/,
  );
  assert.equal(ledger.get(active.id)?.status, 'reserved');
});

test('a killed guardian closes its inherited group but leaves uncertain occupancy without an observer proof', async (t) => {
  const { directory, ledger, host, reserve, token, command } = setup(t);
  const record = reserve('guardian-crash');
  const guardian = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../packages/runner/src/supervisor.mjs', import.meta.url)),
      'guardian',
      ledger.path,
      record.id,
    ],
    { detached: true, stdio: 'ignore' },
  );
  await until(() => ledger.get(record.id)?.status === 'starting');
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: command(
      `const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('crash-ticks','x'),15)`,
    ),
  });
  await until(() => ledger.get(record.id)?.status === 'running');
  await delay(100);
  // The test owns this live ChildProcess handle; production never signals saved PIDs.
  const died = new Promise<void>((resolve) => guardian.once('exit', () => resolve()));
  guardian.kill('SIGKILL');
  await died;
  await delay(500);
  const size = statSync(join(directory, 'crash-ticks')).size;
  await delay(100);
  assert.equal(statSync(join(directory, 'crash-ticks')).size, size);
  assert.equal((await host.inspect(record.id)).status, 'uncertain');
  assert.equal(terminalLaunch(ledger.get(record.id)!), false);
});

test('a wrong local IPC credential cannot stop another live launch', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('ipc');
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: command('setInterval(()=>{},1000)'),
  });
  await until(() => ledger.get(record.id)?.status === 'running');
  const socketDirectory = `/tmp/merv-runner-${process.getuid!()}-${createHash('sha256').update(ledger.directory).digest('hex').slice(0, 16)}`;
  const path = join(
    socketDirectory,
    `${createHash('sha256').update(record.id).digest('hex').slice(0, 24)}.sock`,
  );
  const response = await new Promise<string>((resolve, reject) => {
    let body = '';
    const socket = createConnection(path);
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ action: 'stop', auth: 'incorrect' })}\n`),
    );
    socket.on('data', (data) => {
      body += data.toString();
    });
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
  });
  assert.deepEqual(JSON.parse(response), { error: 'unauthorized' });
  assert.equal((await host.inspect(record.id)).status, 'running');
  assert.equal((await host.stop(record.id)).status, 'stopped');
});

test('the original guardian repairs a timeout assessment and resumes its unstarted claim exactly once', async (t) => {
  const { directory, ledger, host, reserve, token, command } = setup(t);
  const record = reserve('resume-claim');
  const guardian = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../packages/runner/src/supervisor.mjs', import.meta.url)),
      'guardian',
      ledger.path,
      record.id,
    ],
    { detached: true, stdio: 'ignore' },
  );
  guardian.unref();
  await until(() => ledger.get(record.id)?.status === 'starting');
  await delay(50);
  ledger.markUncertain(record.id);
  assert.equal((await host.inspect(record.id)).status, 'starting');
  const input = {
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: command(`require('fs').appendFileSync('resumed','once');setInterval(()=>{},1000)`),
  };
  await host.launch(input);
  await until(() => ledger.get(record.id)?.status === 'running');
  ledger.markUncertain(record.id);
  assert.equal((await host.inspect(record.id)).status, 'running');
  await host.launch(input);
  await until(() => existsSync(join(directory, 'resumed')));
  assert.equal(readFileSync(join(directory, 'resumed'), 'utf8'), 'once');
  await assert.rejects(
    async () => host.launch({ ...input, command: command('process.exit(0)') }),
    /launch_conflict/,
  );
  assert.equal((await host.stop(record.id)).status, 'stopped');
});

test('diagnostic redaction hooks never replace the memory-only process environment or stdin', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('json-hooks');
  const spec = {
    ...command(
      `let body='';process.stdin.on('data',d=>body+=d);process.stdin.on('end',()=>{process.stdout.write(process.env.MERV_MCP_URL+' '+body)})`,
    ),
    stdin: 'the real assignment',
    env: { MERV_MCP_URL: 'http://127.0.0.1:1234/mcp' },
  };
  Object.defineProperty(spec, 'toJSON', { value: () => ({ redacted: true }) });
  Object.defineProperty(spec.env, 'toJSON', { value: () => ({ MERV_MCP_URL: '[redacted]' }) });
  assert.equal(JSON.stringify(spec), '\{"redacted":true\}');
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: spec,
  });
  await until(() => terminalLaunch(ledger.get(record.id)!));
  assert.equal(
    readFileSync(join(record.runDirectory, 'stdout.log'), 'utf8'),
    'http://127.0.0.1:1234/mcp the real assignment',
  );
});
