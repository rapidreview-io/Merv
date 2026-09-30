import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalLedger, terminalLaunch, type LaunchRecord } from '../packages/runner/src/ledger.js';
import { ProcessHost } from '../packages/runner/src/process-host.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary =
  process.env.MERV_RUNNER_OWNERSHIP_LEAN_BINARY ??
  join(root, 'verification/lean/.lake/build/bin/runner_ownership_model');
const options = {
  skip:
    !fs.existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build runner_ownership_model'
      : undefined,
};
const sourcePath = join(root, 'packages/runner/src/supervisor.mjs');
const original = fs.readFileSync(sourcePath, 'utf8');
const binding = {
  baseUrl: 'http://127.0.0.1:9',
  projectId: 'runner_lean',
  sourceId: 'runner_lean',
};
const source = `mk_${'s'.repeat(43)}`;
const token = `ms_${'t'.repeat(43)}`;
type Command = {
  kind: string;
  actor?: number;
  key?: number;
  evidence?: boolean;
  boot?: boolean;
  aged?: boolean;
  natural?: boolean;
};
type Observation = {
  reply: string | null;
  phase: string;
  pinned: number | null;
  claims: number;
  ownerSpawns: number;
  workerStarts: number;
};
type Mutation = 'claim-fence' | 'pin-guard' | 'uncertain-ownership';
function model(commands: Command[]): Observation[] {
  const result = spawnSync(binary, [], { encoding: 'utf8', input: JSON.stringify({ commands }) });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).observations;
}

/** Only OS scheduling is synthetic. Every SQL statement is the production statement,
 * executed by Node's SQLite against a real LocalLedger database. No SQL interpreter.
 * Import declarations are bound to their real modules or explicit OS event doubles;
 * supervisor functions and control flow are evaluated directly from the source file.
 */
class SupervisorHarness {
  directory = fs.mkdtempSync(join(tmpdir(), 'merv-runner-lean-'));
  ledger = new LocalLedger({ directory: this.directory, binding });
  host = new ProcessHost(this.ledger, source);
  record = this.ledger.reserve({
    id: 'launch',
    sessionId: 'session',
    deadline: Date.now() + 600_000,
  });
  claims = 0;
  owners: any[] = [];
  workers: any[] = [];
  guardians = new Map<number, any>();
  databases: DatabaseSync[] = [];
  socketDirectories = new Set<string>();
  hashes = new Map<string, number>();
  constructor(readonly mutation?: Mutation) {}

  evaluate(mode: string, proc: any, spawn: (...args: any[]) => any, createServer: any) {
    const self = this;
    class TrackedDatabase extends DatabaseSync {
      constructor(path: string) {
        super(path);
        self.databases.push(this);
      }
    }
    let text = original;
    if (this.mutation === 'claim-fence')
      text = text.replace("WHERE id=? AND status='reserved'", 'WHERE id=?');
    if (this.mutation === 'pin-guard')
      text = text.replace('if (row.command_hash) {', 'if (false) {');
    if (this.mutation === 'uncertain-ownership')
      text = text.replace(
        "WHERE id=? AND status='reserved'",
        "WHERE id=? AND status IN ('reserved','uncertain')",
      );
    const executable = text
      .replace(/^import .*;\n/gm, '')
      .replace('import.meta.url', JSON.stringify(new URL(`file://${sourcePath}`).href));
    const exit = Symbol('exit');
    proc.argv = ['node', sourcePath, mode, this.ledger.path, 'launch'];
    Object.assign(proc, {
      execPath: process.execPath,
      env: { PATH: process.env.PATH },
      getuid: process.getuid,
      exit: () => {
        throw exit;
      },
    });
    try {
      runInNewContext(
        executable,
        {
          ...crypto,
          ...fs,
          dirname,
          join,
          StringDecoder,
          fileURLToPath,
          DatabaseSync: TrackedDatabase,
          Buffer,
          process: proc,
          spawn,
          createServer,
          setTimeout: () => ({ unref() {} }),
          clearTimeout() {},
        },
        { filename: sourcePath, timeout: 2000 },
      );
    } catch (error) {
      if (error !== exit) throw error;
    }
  }
  claim(actor: number) {
    const guardian: any = { process: new EventEmitter(), live: true };
    guardian.process.kill = () => {
      guardian.killObserved = true;
    };
    const createServer = (accept: any) => {
      this.claims++;
      guardian.accept = accept;
      this.guardians.set(actor, guardian);
      const server: any = new EventEmitter();
      server.listen = (path: string, callback: () => void) => {
        this.socketDirectories.add(dirname(path));
        fs.writeFileSync(path, '');
        callback();
      };
      server.close = () => {
        guardian.live = false;
      };
      return server;
    };
    const spawnOwner = () => {
      assert.ok(
        this.ledger.get('launch')!.commandHash,
        'command pin must be committed before owner creation',
      );
      const owner: any = new EventEmitter();
      Object.assign(owner, {
        pid: 900_000 + this.owners.length,
        connected: true,
        exitCode: null,
        signalCode: null,
      });
      owner.process = new EventEmitter();
      Object.assign(owner.process, {
        connected: true,
        pid: owner.pid,
        kill() {},
        send: (message: any) => owner.emit('message', message),
      });
      owner.send = (message: any) => {
        if (message.type === 'start') owner.start = message;
        else owner.process.emit('message', message);
      };
      const spawnWorker = () => {
        assert.ok(
          this.ledger.get('launch')!.commandHash,
          'command pin must precede the actual worker spawn',
        );
        const worker: any = new EventEmitter();
        worker.stdout = new EventEmitter();
        worker.stderr = new EventEmitter();
        worker.stdin = Object.assign(new EventEmitter(), { end() {} });
        this.workers.push(worker);
        return worker;
      };
      this.evaluate('group', owner.process, spawnWorker, undefined);
      guardian.owner = owner;
      this.owners.push(owner);
      return owner;
    };
    this.evaluate('guardian', guardian.process, spawnOwner, createServer);
  }
  request(actor: number, body: Record<string, unknown>) {
    const g = this.guardians.get(actor);
    if (!g?.live) return undefined;
    const socket: any = new EventEmitter();
    let response: any;
    Object.assign(socket, {
      setTimeout() {},
      destroy() {},
      end: (text: string) => {
        response = JSON.parse(text);
      },
    });
    g.accept(socket);
    socket.emit(
      'data',
      Buffer.from(`${JSON.stringify({ ...body, auth: this.ledger.ipcToken('launch') })}\n`),
    );
    return response;
  }
  command(key: number) {
    return { executable: '/synthetic/worker', args: [String(key)], cwd: this.directory, env: {} };
  }
  async execute(commands: Command[]): Promise<Observation[]> {
    const output: Observation[] = [];
    for (const c of commands) {
      const owner = this.owners.at(-1);
      let replyCode: string | null = null;
      switch (c.kind) {
        case 'claim':
          this.claim(c.actor!);
          break;
        case 'cancel':
          this.ledger.end('launch', 'cancelled_before_spawn', 'reserved');
          break;
        case 'launch': {
          const before = this.ledger.get('launch')!;
          const reply = this.request(c.actor!, {
            action: 'launch',
            command: this.command(c.key!),
            sessionToken: token,
          });
          replyCode = reply ? (reply.error ?? 'ok') : 'unavailable';
          const after = this.ledger.get('launch')!;
          if (before.commandHash && this.mutation !== 'pin-guard') {
            const same = this.hashes.get(before.commandHash) === c.key;
            if (reply) assert.equal(reply.error ?? 'ok', same ? 'ok' : 'launch_conflict');
          }
          if (after.commandHash && !this.hashes.has(after.commandHash))
            this.hashes.set(after.commandHash, c.key!);
          break;
        }
        case 'groupStart':
          if (owner?.connected) owner.process.emit('message', owner.start);
          break;
        case 'running':
          this.workers.at(-1)?.emit('spawn');
          break;
        case 'shutdown':
          if (c.natural) this.workers.at(-1)?.emit('close', 0, null);
          else if (owner?.connected) owner.send({ type: 'stop' });
          break;
        case 'kill':
          if (owner) {
            const saved = owner.connected;
            owner.connected = c.evidence;
            owner.emit('message', { type: 'kill_ready' });
            owner.connected = saved;
          }
          break;
        case 'exit':
          if (owner) {
            owner.connected = false;
            owner.signalCode = c.evidence ? 'SIGKILL' : 'SIGTERM';
            owner.emit('exit', null, owner.signalCode);
          }
          break;
        case 'guardianCrash':
          for (const g of this.guardians.values()) g.live = false;
          break;
        case 'inspect': {
          const actor = [...this.guardians].find(([, g]) => g.live)?.[0];
          if (actor !== undefined) this.request(actor, { action: 'inspect' });
          break;
        }
        case 'lost': {
          this.ledger.updateMetadata('launch', {
            boot: c.boot ? 'earlier-boot' : 'same-boot',
            lostAt: Date.now() - (c.aged ? 61_000 : 0),
          });
          Object.defineProperty(this.host, 'boot', { value: 'same-boot', configurable: true });
          const internals = this.host as unknown as { request: (...a: unknown[]) => Promise<void> };
          const saved = internals.request;
          internals.request = async () => {
            throw Object.assign(new Error('unreachable'), { code: 'ENOENT' });
          };
          try {
            await this.host.inspect('launch');
          } finally {
            internals.request = saved;
          }
          break;
        }
      }
      const row = this.ledger.get('launch')!;
      output.push({
        reply: replyCode,
        phase: row.status,
        pinned: row.commandHash ? this.hashes.get(row.commandHash)! : null,
        claims: this.claims,
        ownerSpawns: this.owners.length,
        workerStarts: this.workers.length,
      });
    }
    return output;
  }
  close() {
    for (const worker of this.workers) {
      try {
        worker.emit('close', 0, null);
      } catch (error) {
        assert.match(String(error), /terminal launch/); // End log handles after simulated reboot.
      }
    }
    for (const db of this.databases)
      try {
        db.close();
      } catch {
        /* Already closed by guardian. */
      }
    this.ledger.close();
    for (const directory of this.socketDirectories)
      fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
async function implementation(commands: Command[], mutation?: Mutation) {
  const h = new SupervisorHarness(mutation);
  try {
    return await h.execute(commands);
  } finally {
    h.close();
  }
}
const claim = (actor: number): Command => ({ kind: 'claim', actor });
const launch = (actor = 1, key = 7): Command => ({ kind: 'launch', actor, key });
const start: Command[] = [claim(1), launch(), { kind: 'groupStart' }, { kind: 'running' }];
const traces: Command[][] = [
  [{ kind: 'cancel' }, claim(1), claim(2), { kind: 'lost', boot: true, aged: true }],
  [
    claim(1),
    claim(2),
    { kind: 'cancel' },
    launch(2),
    launch(),
    launch(),
    launch(1, 8),
    { kind: 'groupStart' },
    { kind: 'groupStart' },
    { kind: 'running' },
  ],
  [
    ...start,
    { kind: 'shutdown' },
    { kind: 'kill', evidence: true },
    { kind: 'exit', evidence: true },
    claim(9),
    { kind: 'cancel' },
  ],
  [
    ...start,
    { kind: 'shutdown', natural: true },
    { kind: 'kill', evidence: true },
    { kind: 'exit', evidence: true },
    claim(2),
  ],
  [
    ...start,
    { kind: 'shutdown' },
    { kind: 'kill', evidence: false },
    { kind: 'exit', evidence: true },
    claim(2),
  ],
  [...start, { kind: 'exit', evidence: false }, claim(2)],
  [
    claim(1),
    { kind: 'lost', boot: false, aged: false },
    claim(2),
    launch(),
    { kind: 'inspect' },
    launch(),
    { kind: 'groupStart' },
  ],
  [
    claim(1),
    { kind: 'guardianCrash' },
    { kind: 'lost', boot: false, aged: false },
    { kind: 'lost', boot: false, aged: true },
    claim(2),
  ],
  [
    ...start,
    { kind: 'guardianCrash' },
    { kind: 'lost', boot: false, aged: true },
    claim(2),
    { kind: 'lost', boot: true, aged: true },
  ],
];
test(
  'Runner Lean traces match real ledger, guardian, group-owner and ProcessHost effects',
  options,
  async () => {
    for (const commands of traces)
      assert.deepEqual(await implementation(commands), model(commands), JSON.stringify(commands));
    // Arbitrarily identified contenders, each ordering at the actual SQLite CAS boundary.
    for (let winner = 1; winner <= 8; winner++) {
      const commands = [
        claim(winner),
        ...Array.from({ length: 12 }, (_, i) => claim(20 + i)),
        launch(winner),
        launch(winner),
        { kind: 'groupStart' },
        { kind: 'groupStart' },
      ];
      assert.deepEqual(await implementation(commands), model(commands));
    }
  },
);
test(
  'ownership comparator detects removed claim/pin fences and uncertain replacement',
  options,
  async () => {
    const controls: [Mutation, Command[]][] = [
      ['claim-fence', [claim(1), claim(2), launch(1), launch(2)]],
      ['pin-guard', [claim(1), launch(), launch()]],
      [
        'uncertain-ownership',
        [claim(1), { kind: 'guardianCrash' }, { kind: 'lost', boot: false, aged: false }, claim(2)],
      ],
    ];
    async function collect() {
      for (const [mutation, commands] of controls)
        observations.set(mutation, await implementation(commands, mutation));
    }
    const observations = new Map<Mutation, Observation[]>();
    await collect();
    for (const [mutation, commands] of controls)
      assert.throws(
        () => assert.deepEqual(model(commands), observations.get(mutation)),
        assert.AssertionError,
        mutation,
      );
  },
);

test(
  'terminal SQL fence rejects a delayed production guardian write; mutation is detected',
  options,
  async () => {
    const commands = [
      claim(1),
      launch(),
      { kind: 'groupStart' },
      { kind: 'lost', boot: true, aged: false },
      { kind: 'running' },
    ];
    for (const mutate of [false, true]) {
      const h = new SupervisorHarness();
      try {
        const first = await h.execute(commands.slice(0, -1));
        if (mutate) {
          const db = new DatabaseSync(h.ledger.path);
          db.exec('DROP TRIGGER immutable_launch_terminal');
          db.close();
          const last = await h.execute(commands.slice(-1));
          assert.throws(
            () => assert.deepEqual([...first, ...last], model(commands)),
            assert.AssertionError,
          );
        } else {
          assert.throws(() => h.workers.at(-1).emit('spawn'), /terminal launch/);
          assert.equal(h.ledger.get('launch')!.status, 'stopped');
        }
      } finally {
        h.close();
      }
    }
  },
);

test(
  'real ProcessHost competing launches start one synthetic worker and retain terminality',
  { ...options, timeout: 20_000 },
  async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'merv-runner-lean-real-'));
    const ledger = new LocalLedger({ directory, binding });
    const host = new ProcessHost(ledger, source);
    const row = ledger.reserve({
      id: 'real',
      sessionId: 'real_session',
      deadline: Date.now() + 10_000,
    });
    const command = {
      executable: process.execPath,
      args: ['-e', "require('node:fs').appendFileSync('starts','x');setInterval(()=>{},1000)"],
      cwd: directory,
    };
    const input = { launchId: row.id, command, sessionToken: token, deadline: row.deadline };
    try {
      await Promise.all(Array.from({ length: 6 }, () => host.launch(input)));
      const until = Date.now() + 5000;
      while (!fs.existsSync(join(directory, 'starts')) && Date.now() < until) await delay(20);
      assert.equal(fs.readFileSync(join(directory, 'starts'), 'utf8'), 'x');
      await assert.rejects(
        host.launch({ ...input, command: { ...command, args: ['-e', 'process.exit(0)'] } }),
        /launch_conflict/,
      );
      const stopped = await host.stop(row.id);
      assert.ok(terminalLaunch(stopped));
      assert.equal((await host.launch(input)).status, stopped.status);
      assert.equal(fs.readFileSync(join(directory, 'starts'), 'utf8'), 'x');
      const expected = model([
        ...start,
        { kind: 'shutdown' },
        { kind: 'kill', evidence: true },
        { kind: 'exit', evidence: true },
      ]).at(-1)!;
      assert.equal(stopped.status, expected.phase);
      assert.equal(
        fs.readFileSync(join(directory, 'starts'), 'utf8').length,
        expected.workerStarts,
      );
    } finally {
      await host.stop(row.id).catch(() => {});
      ledger.close();
      fs.rmSync(directory, { recursive: true, force: true });
      const socket = `/tmp/merv-runner-${process.getuid!()}-${crypto.createHash('sha256').update(directory).digest('hex').slice(0, 16)}`;
      fs.rmSync(socket, { recursive: true, force: true });
    }
  },
);

test(
  'ProcessHost no-pin timeout rechecks the pin when a guardian wins the SQL race',
  options,
  async () => {
    const h = new SupervisorHarness();
    try {
      await h.execute([claim(1)]);
      h.ledger.updateMetadata('launch', { lostAt: Date.now() - 61_000 });
      const stale = h.ledger.get('launch')!;
      const end = h.ledger.end.bind(h.ledger);
      h.ledger.end = (id, reason, which) => {
        assert.equal(which, 'unlaunched');
        assert.equal(
          h.request(1, { action: 'launch', command: h.command(7), sessionToken: token }).ok,
          true,
        );
        return end(id, reason, which);
      };
      (h.host as unknown as { lost: (record: typeof stale) => void }).lost(stale);
      assert.ok(h.ledger.get('launch')!.commandHash);
      const expected = model([claim(1), launch(), { kind: 'lost', boot: false, aged: true }]).at(
        -1,
      )!;
      assert.equal(h.ledger.get('launch')!.status, expected.phase);
      assert.equal(h.owners.length, expected.ownerSpawns);
      await assert.rejects(
        h.host.launch({
          launchId: 'launch',
          command: h.command(7),
          sessionToken: token,
          deadline: stale.deadline,
        }),
        /uncertain launch cannot be restarted/,
      );
      assert.equal(h.owners.length, 1);
    } finally {
      h.close();
    }
  },
);

test('missing boot evidence leaves a pinned unreachable launch uncertain', options, async () => {
  const h = new SupervisorHarness();
  try {
    await h.execute([claim(1), launch()]);
    h.ledger.updateMetadata('launch', { boot: 'old-boot', lostAt: Date.now() - 61_000 });
    Object.defineProperty(h.host, 'boot', { value: undefined });
    const record = h.ledger.get('launch')!;
    (h.host as unknown as { lost: (record: LaunchRecord) => void }).lost(record);
    assert.equal(h.ledger.get('launch')!.status, 'uncertain');
  } finally {
    h.close();
  }
});
