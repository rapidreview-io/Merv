import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
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

test('local ledger binds identity, persists exact retry inputs without bearers, and holds one controller lock', (t) => {
  const { directory, binding, ledger } = setup(t);
  const release = ledger.acquireController();
  const second = new LocalLedger({ directory, binding });
  t.after(() => second.close());
  assert.throws(() => second.acquireController(), /Another runner controller/);
  const pending = ledger.request({ name: 'codex', harness: 'codex', model: 'model-a' });
  assert.deepEqual(second.request({ name: 'codex', harness: 'codex', model: 'changed' }), pending);
  assert.deepEqual(second.pendingRequests(), [pending]);
  assert.equal(second.runnerId, ledger.runnerId);
  assert.equal(second.sessionSecret(pending.requestId), pending.secret);
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
  ledger.updateMetadata(record.id, {
    attached: true,
    session: { source: { credentialId: 'credential-id' } },
  });
  assert.equal(second.get(record.id)?.metadata.attached, true);
  let callbacks = 0;
  const disguised = ['ordinary value'];
  Object.defineProperty(disguised, 'toJSON', {
    value() {
      callbacks++;
      return [pending.secret];
    },
  });
  const accessor = Object.defineProperty({}, 'profile', {
    enumerable: true,
    get() {
      callbacks++;
      return callbacks === 1 ? 'ordinary value' : pending.secret;
    },
  });
  for (const metadata of [{ profile: disguised }, accessor]) {
    assert.throws(() =>
      ledger.reserve({
        id: 'unsafe',
        sessionId: 'unsafe',
        deadline: record.deadline,
        metadata,
      }),
    );
    assert.throws(() => ledger.updateMetadata(record.id, metadata));
  }
  assert.equal(callbacks, 0);
  assert.equal(ledger.get('unsafe'), undefined);
  assert.equal(second.get(record.id)?.metadata.attached, true);
  assert.throws(() =>
    ledger.request(
      Object.defineProperty({ name: 'unsafe', harness: 'codex' }, 'model', {
        enumerable: true,
        get() {
          callbacks++;
          return 'model-a';
        },
      }),
    ),
  );
  assert.equal(callbacks, 0);
  assert.equal(ledger.pendingRequests().length, 1);
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

test("an owner lost on its own ends its agent and the agent's jobs, and stays uncertain", async (t) => {
  const { directory, ledger, host, reserve, token, command } = setup(t);
  const record = reserve('owner-lost');
  const ticks = join(directory, 'owner-lost-ticks');
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: command(jobAgent(ticks)),
  });
  await until(() => ledger.get(record.id)?.status === 'running' && existsSync(ticks));
  // The owner alone dies, as to the OOM killer: the agent's group is the owner's.
  const agent = readFileSync(join(directory, 'agent.pid'), 'utf8');
  const group = Number(spawnSync('ps', ['-o', 'pgid=', '-p', agent], { encoding: 'utf8' }).stdout);
  process.kill(group, 'SIGKILL');
  await until(() => ledger.get(record.id)?.status === 'uncertain');
  assert.equal(ledger.get(record.id)?.reason, 'owner_lost');
  assert.equal(spawnSync('kill', ['-0', agent]).status !== 0, true, 'the agent is gone');
  assert.equal(await stillTicking(ticks), false);
});

test(
  'the subreaper reaps the jobs it adopts instead of keeping them as zombies',
  {
    skip: process.platform !== 'linux',
  },
  async (t) => {
    const { directory, ledger, host, reserve, token, command } = setup(t);
    const record = reserve('reaped');
    const count = join(directory, 'zombies');
    // Twenty jobs orphaned at once end 0.2s later; the agent then counts its group's zombies.
    const zombies = `require('fs').writeFileSync(${JSON.stringify(count)},String(require('fs').readdirSync('/proc').filter((p)=>/^\\d+$/.test(p)).filter((p)=>{try{const s=require('fs').readFileSync('/proc/'+p+'/stat','utf8').slice(require('fs').readFileSync('/proc/'+p+'/stat','utf8').lastIndexOf(')')+2).split(' ');return s[0]==='Z'&&Number(s[2])===mine}catch{return false}}).length))`;
    await host.launch({
      launchId: record.id,
      sessionToken: token,
      deadline: record.deadline,
      command: command(
        `const mine=Number(require('fs').readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[2]);require('child_process').spawnSync('sh',['-c','for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do (sleep 0.2 &); done']);setTimeout(()=>{${zombies};setInterval(()=>{},1000)},1500)`,
      ),
    });
    await until(() => existsSync(count));
    assert.equal(readFileSync(count, 'utf8'), '0');
    await host.stop(record.id);
  },
);

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

test('a user key standing alone is refused, but mk_ inside another token is not', (t) => {
  const { host, token, command } = setup(t);
  const validate = (value: string) =>
    (host as unknown as { validateCommand(c: object, t: string): void }).validateCommand(
      { ...command(''), env: { VALUE: value } },
      token,
    );
  assert.throws(() => validate(`mk_${'a'.repeat(43)}`), /source credentials/);
  assert.throws(() => validate(`key=mk_${'a'.repeat(43)}\n`), /source credentials/);
  // After a URL escape or a JSON escape, or a separator.
  for (const before of ['Bearer%20', '{"a":"x\\n', '{"a":"\\u0022', 'x-', 'x_'])
    assert.throws(() => validate(`${before}mk_${'a'.repeat(43)}`), /source credentials/, before);
  // An HF grant (a JWE) or a session token can hold "mk_" by chance.
  validate(`eyJhbGciOiJkaXIifQ..abc.Xmk_${'b'.repeat(40)}.tag`);
  validate(`ms_${'c'.repeat(5)}mk_${'d'.repeat(35)}`);
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

test('a launch claimed in another boot is proven gone; the same boot stays uncertain', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('booted');
  await host.launch({
    launchId: record.id,
    sessionToken: token,
    deadline: record.deadline,
    command: command('process.exit(0)'),
  });
  assert.ok(host.boot, 'this machine names its boot');
  assert.equal(ledger.get(record.id)?.metadata.boot, host.boot, 'recorded before the spawn');
  const db = new DatabaseSync(ledger.path);
  t.after(() => db.close());
  const orphan = (id: string, boot: string) => {
    const row = reserve(id);
    ledger.updateMetadata(row.id, { boot });
    db.prepare("UPDATE launches SET status='running',command_hash='pinned' WHERE id=?").run(id);
    return row.id;
  };
  const same = orphan('same-boot', host.boot!);
  const other = orphan('other-boot', 'other');
  await host.reconcile();
  assert.equal(ledger.get(same)?.status, 'uncertain');
  assert.deepEqual(
    [ledger.get(other)?.status, ledger.get(other)?.reason],
    ['stopped', 'host_rebooted'],
  );
});

test('a reservation no guardian could claim is cancelled, not left uncertain', async (t) => {
  const { ledger, host, reserve, token, command } = setup(t);
  const record = reserve('locked', 60_000);
  ledger.updateMetadata(record.id, { boot: host.boot ?? 'unknown' });
  // Another process holds the ledger longer than the guardian waits for its claim.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const db=new (require('node:sqlite').DatabaseSync)(${JSON.stringify(ledger.path)});db.exec('BEGIN EXCLUSIVE');process.stdout.write('locked');setTimeout(()=>db.exec('COMMIT'),7000)`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  await assert.rejects(
    host.launch({
      launchId: record.id,
      sessionToken: token,
      deadline: record.deadline,
      command: command('process.exit(0)'),
    }),
  );
  assert.deepEqual(
    [ledger.get(record.id)?.status, ledger.get(record.id)?.reason],
    ['stopped', 'cancelled_before_spawn'],
  );
});

test('a guardian that cannot own its socket ends its claim as stopped, and replaces a stale socket file', async (t) => {
  const { directory, ledger, host, reserve, token, command } = setup(t);
  const sockets = `/tmp/merv-runner-${process.getuid!()}-${createHash('sha256').update(ledger.directory).digest('hex').slice(0, 16)}`;
  const socket = (id: string) =>
    join(sockets, `${createHash('sha256').update(id).digest('hex').slice(0, 24)}.sock`);
  t.after(() => rmSync(sockets, { recursive: true, force: true }));
  // A socket directory that is not this user's own directory: nothing was spawned.
  symlinkSync(directory, sockets);
  const refused = reserve('foreign-socket-directory');
  const input = (id: string, deadline: number) => ({
    launchId: id,
    sessionToken: token,
    deadline,
    command: command('process.exit(0)'),
  });
  const ended = await host.launch(input(refused.id, refused.deadline));
  assert.deepEqual([ended.status, ended.reason], ['stopped', 'socket_failed']);
  rmSync(sockets);
  // A socket an earlier process left behind when it was killed: this claim listens anyway.
  const stale = reserve('stale-socket');
  mkdirSync(sockets, { mode: 0o700 });
  const path = JSON.stringify(socket(stale.id));
  spawnSync(process.execPath, [
    '-e',
    `require('net').createServer().listen(${path},()=>process.kill(process.pid,'SIGKILL'))`,
  ]);
  assert.ok(statSync(socket(stale.id)).isSocket());
  await host.launch(input(stale.id, stale.deadline));
  await until(() => ledger.get(stale.id)?.status === 'exited');
  assert.equal(ledger.get(stale.id)?.exitCode, 0);
});

test('a claimed launch with no pinned command ends a minute after it was first found unreachable', async (t) => {
  const { ledger, host, reserve } = setup(t);
  const record = reserve('unlaunched');
  const db = new DatabaseSync(ledger.path);
  t.after(() => db.close());
  db.prepare("UPDATE launches SET status='starting' WHERE id=?").run(record.id);
  await host.reconcile();
  const first = ledger.get(record.id)!;
  assert.equal(first.status, 'uncertain', 'a fresh loss may still be a live guardian');
  assert.equal(typeof first.metadata.lostAt, 'number');
  ledger.updateMetadata(record.id, { session: { status: 'active' } });
  await host.reconcile();
  assert.equal(ledger.get(record.id)?.metadata.lostAt, first.metadata.lostAt);
  assert.equal(ledger.get(record.id)?.status, 'uncertain');
  ledger.updateMetadata(record.id, { lostAt: Date.now() - 61_000 });
  await host.reconcile();
  assert.deepEqual(
    [ledger.get(record.id)?.status, ledger.get(record.id)?.reason],
    ['stopped', 'guardian_lost_before_launch'],
  );
  // A pinned command is never ended by that rule.
  const pinned = reserve('pinned');
  db.prepare("UPDATE launches SET status='uncertain',command_hash='pinned' WHERE id=?").run(
    pinned.id,
  );
  ledger.updateMetadata(pinned.id, { lostAt: Date.now() - 61_000 });
  await host.reconcile();
  assert.equal(ledger.get(pinned.id)?.status, 'uncertain');
});

test('HF process environment is delivered through IPC and split output is redacted before persistence', async (t) => {
  const { ledger, host, reserve, token, command, directory } = setup(t);
  const record = reserve('hf-credential');
  const marker = 'hf_' + 'PrivateAccountMarker'.repeat(2);
  const child = command(
    `const s=process.env.HF_TOKEN; if(!s) process.exit(7); process.stdout.write(s.slice(0,10)); setTimeout(()=>{process.stdout.write(s.slice(10)+'\\n');process.stderr.write(s);},20);`,
  );
  Object.assign(child.env, { HF_TOKEN: marker });
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
