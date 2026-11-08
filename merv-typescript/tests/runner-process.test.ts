import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
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
  const source = `mr_${randomBytes(32).toString('hex')}`;
  const host = new ProcessHost(ledger, source);
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
  return { directory, binding, ledger, host, reserve, token, command, source };
}

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
  const pendingInput = { ...input };
  const first = host.launch(pendingInput);
  pendingInput.launchId = 'changed';
  pendingInput.sessionToken = 'changed';
  pendingInput.deadline = 0;
  await Promise.all([first, host.launch(input)]);
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
  const { directory, binding, ledger, host, reserve, token, command, source } = setup(t);
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
    const recovered = new ProcessHost(reopened, source);
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

/** An agent that starts a job in a session and group of its own, as a harness's shell does. */
const jobAgent = (ticks: string, after = `setInterval(()=>{},1000)`) =>
  `const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(
    `setInterval(()=>require('fs').appendFileSync(${JSON.stringify(ticks)},'x'),15)`,
  )}],{detached:true,stdio:'ignore'}).unref();require('fs').writeFileSync('agent.pid',String(process.pid));process.on('SIGTERM',()=>{});${after}`;
const stillTicking = async (path: string) => {
  const size = statSync(path).size;
  await delay(150);
  return statSync(path).size !== size;
};

test('a stop and the deadline end the jobs the agent started in groups of their own', async (t) => {
  const { directory, ledger, host, reserve, token, command } = setup(t);
  for (const [id, end] of [
    ['job-stop', 'stop'],
    ['job-deadline', 'deadline'],
    // Only Linux's subreaper keeps the jobs of an agent that already ended in the owner's tree.
    ...(process.platform === 'linux' ? [['job-exit', 'exit']] : []),
  ] as const) {
    const record = reserve(id, end === 'deadline' ? 1500 : 15000);
    const ticks = join(directory, `${id}-ticks`);
    await host.launch({
      launchId: record.id,
      sessionToken: token,
      deadline: record.deadline,
      // The agent that exits leaves its job behind, as a harness's background shell may.
      command: command(
        jobAgent(ticks, end === 'exit' ? 'setTimeout(()=>process.exit(0),400)' : undefined),
      ),
    });
    await until(() => existsSync(ticks));
    if (end === 'stop') await host.stop(record.id);
    await until(() => terminalLaunch(ledger.get(record.id)!));
    assert.equal(ledger.get(record.id)?.reason, end === 'stop' ? 'controller_stop' : end);
    // Ended before the launch's end was written: the job prints nothing more.
    assert.equal(await stillTicking(ticks), false, id);
  }
});

test('claimed intent without a reachable guardian stays uncertain and cannot be restarted or freed by remote status', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('unknown');
  const db = new DatabaseSync(ledger.path);
  db.prepare("UPDATE launches SET status='starting' WHERE id=?").run(record.id);
  db.close();
  await host.reconcile();
  assert.equal(ledger.get(record.id)?.status, 'uncertain');
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
  const { ledger, host, reserve, token, command, source } = setup(t);
  const record = reserve('cancel');
  assert.throws(
    () => ledger.reserve({ id: record.id, sessionId: 'different', deadline: record.deadline }),
    /UNIQUE constraint/,
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
  // The runner's own bearer is refused wherever it appears: arguments, stdin or environment.
  for (const leak of [
    { args: ['-e', `//${source}`] },
    { stdin: `{"brief":"${source}"}` },
    { env: { NOTE: `x${source}` } },
  ])
    await assert.rejects(
      async () =>
        host.launch({
          launchId: active.id,
          sessionToken: token,
          deadline: active.deadline,
          command: { ...command(''), ...leak },
        }),
      { code: 'unsafe_runner_launch' },
    );
  assert.equal(ledger.get(active.id)?.status, 'reserved');
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

test('native MCP bearers cross only IPC and process env and are redacted before persistence', async (t) => {
  const { ledger, host, reserve, token, command, directory } = setup(t);
  const record = reserve('native-mcp');
  const marker = 'sbxt_' + 'PrivateNativeMarker'.repeat(3);
  const child = command(
    `const s=process.env.MERV_NATIVE_MCP_TOKEN_0; if(!s) process.exit(7); process.stdout.write(s.slice(0,12)); setTimeout(()=>{process.stdout.write(s.slice(12)+'\\n');process.stderr.write(s);},20);`,
  );
  Object.assign(child.env, { MERV_NATIVE_MCP_TOKEN_0: marker });
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: child,
  });
  await until(() => terminalLaunch(ledger.get(record.id)!));
  assert.equal(ledger.get(record.id)?.exitCode, 0);
  assert.equal(readFileSync(join(record.runDirectory, 'stdout.log'), 'utf8'), '[REDACTED]\n');
  assert.equal(readFileSync(join(record.runDirectory, 'stderr.log'), 'utf8'), '[REDACTED]');
  for (const file of readdirSync(directory).filter((name) => name.startsWith('ledger.sqlite')))
    assert.ok(!readFileSync(join(directory, file)).includes(Buffer.from(marker)));
  assert.ok(!JSON.stringify(ledger.get(record.id)).includes(marker));
});

test('the controller speaks to no listener outside a private socket folder of its own', async (t) => {
  const { directory, ledger, host, reserve } = setup(t);
  const sockets = `/tmp/merv-runner-${process.getuid!()}-${createHash('sha256').update(ledger.directory).digest('hex').slice(0, 16)}`;
  t.after(() => rmSync(sockets, { recursive: true, force: true }));
  const records = [reserve('linked-folder'), reserve('open-folder')];
  const db = new DatabaseSync(ledger.path);
  for (const { id } of records)
    db.prepare("UPDATE launches SET status='starting' WHERE id=?").run(id);
  db.close();
  const heard: string[] = [];
  for (const [index, { id }] of records.entries()) {
    // A folder linked elsewhere, then one anybody may enter, each with a listener where this
    // launch's guardian would be.
    if (index === 0) symlinkSync(mkdtempSync(join(directory, 'elsewhere-')), sockets);
    else {
      mkdirSync(sockets);
      chmodSync(sockets, 0o777);
    }
    const server = createServer((socket) =>
      socket.on('data', (data) => {
        heard.push(String(data));
        socket.end('{"ok":true}\n');
      }),
    );
    t.after(() => server.close());
    const path = join(
      sockets,
      `${createHash('sha256').update(id).digest('hex').slice(0, 24)}.sock`,
    );
    await new Promise((resolve) => server.listen(path, () => resolve(undefined)));
    assert.equal((await host.inspect(id)).status, 'uncertain');
    rmSync(sockets, { recursive: true, force: true });
  }
  assert.deepEqual(heard, []);
});

test('JSON-escaped MCP credentials are redacted before persistence across process writes', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('escaped-native-mcp');
  const marker = 'opaque-credential-"-\\-é-123456789';
  const child = command(
    `const s=JSON.stringify({authorization:process.env.MERV_NATIVE_MCP_TOKEN_0}); process.stdout.write(s.slice(0,-4)); setTimeout(()=>{process.stdout.write(s.slice(-4)+'\\n');process.stderr.write(s);},20);`,
  );
  Object.assign(child.env, { MERV_NATIVE_MCP_TOKEN_0: marker });
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: { ...child, secrets: [marker] },
  });
  await until(() => terminalLaunch(ledger.get(record.id)!));
  assert.equal(ledger.get(record.id)?.exitCode, 0);
  assert.equal(
    readFileSync(join(record.runDirectory, 'stdout.log'), 'utf8'),
    '{"authorization":"[REDACTED]"}\n',
  );
  assert.equal(
    readFileSync(join(record.runDirectory, 'stderr.log'), 'utf8'),
    '{"authorization":"[REDACTED]"}',
  );
});
