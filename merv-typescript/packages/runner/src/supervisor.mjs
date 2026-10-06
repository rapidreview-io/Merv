// Runtime resource: copied alongside process-host.js by the build. No loader or dependencies.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const resource = fileURLToPath(import.meta.url);
const PYTHON = '/usr/bin/python3';
const SUBREAPER = `import ctypes, os, sys
try: ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
except Exception: pass
os.execv(sys.argv[1], sys.argv[1:])`;
const mode = process.argv[2];
if (mode === 'group') groupOwner();
else if (mode === 'guardian') guardian(process.argv[3], process.argv[4]);
else process.exit(64);

/**
 * The live processes of process group `group` and everything descended from them, by parent
 * links: /proc on Linux, `ps` elsewhere. An agent's shell starts jobs in sessions of their own,
 * which a group signal misses; found here while their parents live, they end with the launch.
 */
function tree(group) {
  const rows = [];
  try {
    if (process.platform === 'linux')
      for (const name of readdirSync('/proc').filter((name) => /^\d+$/.test(name)))
        try {
          const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
          rows.push([
            Number(name),
            ...stat
              .slice(stat.lastIndexOf(')') + 4)
              .split(' ', 2)
              .map(Number),
          ]);
        } catch {
          /* Gone since the listing. */
        }
    else
      for (const line of execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
        encoding: 'utf8',
        timeout: 5000,
      }).split('\n'))
        if (line.trim()) rows.push(line.trim().split(/\s+/).map(Number));
  } catch {
    /* Best effort: the group signal still reaches the group. */
  }
  const found = new Set(rows.filter((row) => row[2] === group).map(([pid]) => pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of rows)
      if (!found.has(pid) && found.has(parent)) grew = found.add(pid);
  }
  return found;
}
const signalAll = (pids, signal) => {
  for (const pid of pids)
    try {
      process.kill(pid, signal);
    } catch {
      /* Gone, or not ours to signal. */
    }
};

function groupOwner() {
  let started = false,
    stopping = false,
    child,
    deadlineTimer,
    killTimer;
  let deadline = 0;
  const send = (value) => {
    if (process.connected) process.send(value, () => {});
  };
  const stop = (reason, code = null, signal = null) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(deadlineTimer);
    send({ type: 'shutdown', reason, exitCode: code, exitSignal: signal });
    // This process is the live group leader, and the agent's jobs are found while it lives.
    const jobs = tree(process.pid);
    jobs.delete(process.pid);
    signalAll(jobs, 'SIGTERM');
    process.kill(-process.pid, 'SIGTERM');
    killTimer = setTimeout(() => {
      // Before the group, so before the guardian records how the launch ended.
      for (const pid of tree(process.pid)) if (pid !== process.pid) jobs.add(pid);
      signalAll(jobs, 'SIGKILL');
      const killSelfGroup = () => process.kill(-process.pid, 'SIGKILL');
      if (process.connected) {
        send({ type: 'kill_ready' });
        // If the guardian is gone or stalled, deadline enforcement still closes this group.
        // That fallback alone is not an observed completion proof; its row stays uncertain.
        killTimer = setTimeout(killSelfGroup, 1000);
      } else killSelfGroup();
    }, 300);
  };
  const arm = () => {
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => stop('deadline'), Math.max(0, deadline - Date.now()));
  };
  // Graceful group signals must leave the owner alive to perform the final group kill.
  process.on('SIGTERM', () => {
    if (!stopping) stop('external_stop');
  });
  process.on('SIGINT', () => stop('external_stop'));
  process.on('disconnect', () => stop('guardian_lost'));
  process.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'deadline' && started && !stopping) {
      deadline = message.deadline;
      arm();
      send({ type: 'deadline', deadline });
      return;
    }
    if (message.type === 'stop') {
      stop(message.reason === 'deadline' ? 'deadline' : 'controller_stop');
      return;
    }
    if (message.type !== 'start' || started) return;
    started = true;
    const { command, sessionToken, runDirectory } = message;
    deadline = message.deadline;
    if (deadline <= Date.now()) {
      stop('deadline');
      return;
    }
    const env = { ...command.env, MERV_AGENT_SESSION_TOKEN: sessionToken };
    const secrets = [
      ...new Set([
        sessionToken,
        ...(command.secrets ?? []),
        ...Object.entries(env)
          .filter(
            ([key, value]) =>
              /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(key) &&
              typeof value === 'string' &&
              (key === 'HF_TOKEN' ? value.length > 0 : value.length >= 8),
          )
          .map(([, value]) => value),
      ]),
    ];
    const out = redactedFile(join(runDirectory, 'stdout.log'), secrets);
    const err = redactedFile(join(runDirectory, 'stderr.log'), secrets);
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
      child.stdout.on('data', (data) => out.write(data));
      child.stderr.on('data', (data) => err.write(data));
      child.once('spawn', () => {
        arm();
        send({ type: 'running' });
      });
      child.once('error', () => {
        out.end();
        err.end();
        stop('launch_failed', 127);
      });
      child.once('close', (code, signal) => {
        out.end();
        err.end();
        stop('exit', code, signal);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(command.stdin ?? '');
      // Arm even if spawn/error delivery stalls; a disconnected controller never extends this timer.
      arm();
    } catch {
      out.end();
      err.end();
      stop('launch_failed', 127);
    }
  });
  // A guardian lost between spawn and its first message cannot leave an idle owner forever.
  const startup = setTimeout(() => {
    if (!started) stop('launch_timeout');
  }, 10000);
  startup.unref();
  process.on('exit', () => {
    clearTimeout(deadlineTimer);
    clearTimeout(killTimer);
  });
}

function redactedFile(path, secrets) {
  const fd = openSync(path, 'wx', 0o600);
  const decoder = new StringDecoder('utf8');
  const max = Math.max(1, ...secrets.map((secret) => secret.length));
  let pending = '',
    closed = false;
  // A secret starting before the boundary is whole in `pending`; the earliest is redacted first,
  // the first listed where two start together.
  const flush = (final) => {
    let result = '',
      index = 0;
    const boundary = final ? pending.length : Math.max(0, pending.length - max + 1);
    for (;;) {
      let at = boundary,
        length = 0;
      for (const secret of secrets) {
        const found = pending.indexOf(secret, index);
        if (found !== -1 && found < at) [at, length] = [found, secret.length];
      }
      if (!length) break;
      result += `${pending.slice(index, at)}[REDACTED]`;
      index = at + length;
    }
    if (index < boundary) {
      result += pending.slice(index, boundary);
      index = boundary;
    }
    pending = pending.slice(index);
    if (result) writeSync(fd, result);
  };
  return {
    write(data) {
      if (!closed) {
        pending += decoder.write(data);
        flush(false);
      }
    },
    end() {
      if (!closed) {
        pending += decoder.end();
        flush(true);
        closed = true;
        closeSync(fd);
      }
    },
  };
}

function guardian(path, id) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;');
  // Irreversible local claim precedes any child creation. Retried guardians cannot launch twice.
  const claim = db
    .prepare("UPDATE launches SET status='starting',updated_at=? WHERE id=? AND status='reserved'")
    .run(Date.now(), id);
  if (Number(claim.changes) !== 1) {
    db.close();
    process.exit(0);
  }
  const machine = db.prepare('SELECT machine_key FROM machine WHERE singleton=1').get();
  const ipcToken = createHmac('sha256', machine.machine_key)
    .update(`ipc:${id}`)
    .digest('base64url');
  let owner,
    shutdown,
    killProof = false,
    startupTimer,
    finished = false;
  let observedState = 'starting';
  const current = () => db.prepare('SELECT * FROM launches WHERE id=?').get(id);
  const update = (status, reason = null, code = null, signal = null) => {
    if (finished) return;
    observedState = status;
    db.prepare(
      'UPDATE launches SET status=?,reason=?,exit_code=?,exit_signal=?,updated_at=? WHERE id=?',
    ).run(status, reason, code, signal, Date.now(), id);
  };
  // Without an owner nothing was spawned, so the launch has provably ended.
  const socketFailed = () => {
    update(owner ? 'uncertain' : 'stopped', 'socket_failed');
    db.close();
    process.exit(70);
  };
  const socketDir = `/tmp/merv-runner-${process.getuid()}-${createHash('sha256').update(dirname(path)).digest('hex').slice(0, 16)}`;
  const socketPath = join(
    socketDir,
    `${createHash('sha256').update(id).digest('hex').slice(0, 24)}.sock`,
  );
  try {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(socketDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
      throw new Error('foreign socket directory');
    chmodSync(socketDir, 0o700);
    // Only this launch's one claimed guardian listens here: whatever is left is stale.
    rmSync(socketPath, { force: true });
  } catch {
    socketFailed();
  }
  const finish = (status, reason, code = null, signal = null) => {
    update(status, reason, code, signal);
    finished = true;
    clearTimeout(startupTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 200).unref();
  };
  const killOwnedGroup = () => {
    // This standalone guardian has exactly one direct child and installs no async hooks.
    // libuv waitpid -> exit_cb is synchronous on its event loop; Node sets exitCode or
    // signalCode before emitting user events. Check and kill stay in this JS callback,
    // so an exited-but-unreaped owner retains its PID; a reaped owner fails this guard.
    // https://github.com/nodejs/node/blob/v22.13.1/deps/uv/src/unix/process.c#L101-L174
    // https://github.com/nodejs/node/blob/v22.13.1/src/process_wrap.cc#L327-L342
    // https://github.com/nodejs/node/blob/v22.13.1/lib/internal/child_process.js#L269-L295
    if (
      !owner ||
      !owner.connected ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.exitCode !== null ||
      owner.signalCode !== null
    )
      return;
    try {
      process.kill(-owner.pid, 'SIGKILL');
      killProof = true;
    } catch {
      /* No successful group kill means no terminal proof. */
    }
  };
  const server = createServer((socket) => {
    let body = '',
      done = false;
    socket.setTimeout(3000, () => socket.destroy());
    const reply = (value) => {
      done = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.on('data', (data) => {
      if (done) return;
      body += data.toString('utf8');
      if (Buffer.byteLength(body) > 1048576) {
        socket.destroy();
        return;
      }
      const line = body.indexOf('\n');
      if (line < 0) return;
      let message;
      try {
        message = JSON.parse(body.slice(0, line));
      } catch {
        reply({ error: 'invalid_request' });
        return;
      }
      const candidate = Buffer.from(String(message.auth ?? ''));
      const expected = Buffer.from(ipcToken);
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        reply({ error: 'unauthorized' });
        return;
      }
      try {
        if (message.action === 'inspect') {
          // A controller timeout may conservatively mark a still-live guardian uncertain.
          // Only this original guardian's own child lifecycle can repair that assessment.
          const row = current();
          if (
            row.status === 'uncertain' &&
            observedState !== 'uncertain' &&
            ((!owner && !row.command_hash) ||
              (owner?.connected && owner.exitCode === null && owner.signalCode === null))
          ) {
            update(
              observedState,
              shutdown?.reason ?? null,
              shutdown?.exitCode ?? null,
              shutdown?.exitSignal ?? null,
            );
          }
          reply({ ok: true });
          return;
        }
        if (message.action === 'stop') {
          if (!owner) finish('stopped', 'controller_stop');
          else {
            update('stopping', 'controller_stop');
            owner.send({ type: 'stop' });
          }
          reply({ ok: true });
          return;
        }
        if (message.action === 'deadline') {
          if (
            !Number.isSafeInteger(message.deadline) ||
            message.deadline <= Date.now() ||
            message.deadline > Date.now() + 7 * 86400000
          )
            throw new Error('invalid_deadline');
          const row = current();
          if (row.status === 'stopping' || row.status === 'uncertain')
            throw new Error('not_running');
          db.prepare('UPDATE launches SET deadline=?,updated_at=? WHERE id=?').run(
            message.deadline,
            Date.now(),
            id,
          );
          if (owner) owner.send({ type: 'deadline', deadline: message.deadline });
          reply({ ok: true });
          return;
        }
        if (message.action !== 'launch') throw new Error('invalid_request');
        const row = current();
        const hash = createHmac('sha256', machine.machine_key)
          .update(JSON.stringify(message.command))
          .update(message.sessionToken)
          .digest('hex');
        if (row.command_hash) {
          if (row.command_hash !== hash) throw new Error('launch_conflict');
          reply({ ok: true });
          return;
        }
        if (row.status !== 'starting') throw new Error('not_startable');
        if (row.deadline <= Date.now()) {
          finish('stopped', 'deadline');
          reply({ ok: true });
          return;
        }
        db.prepare('UPDATE launches SET command_hash=?,updated_at=? WHERE id=?').run(
          hash,
          Date.now(),
          id,
        );
        clearTimeout(startupTimer);
        // On Linux the owner adopts what its agent leaves behind (PR_SET_CHILD_SUBREAPER, which
        // an exec keeps), so the jobs of an agent that already ended are still its tree.
        const python = process.platform === 'linux' && existsSync(PYTHON) ? [PYTHON] : [];
        try {
          owner = spawn(
            python[0] ?? process.execPath,
            [...(python.length ? ['-c', SUBREAPER, process.execPath] : []), resource, 'group'],
            {
              detached: true,
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
              env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
            },
          );
        } catch {
          finish('exited', 'launch_failed', 127); // nothing was spawned
          reply({ ok: true });
          return;
        }
        owner.on('message', (message) => {
          if (message.type === 'running') {
            if (current().status !== 'stopping') update('running');
          } else if (message.type === 'shutdown') {
            shutdown = message;
            update('stopping', message.reason, message.exitCode, message.exitSignal);
          } else if (message.type === 'kill_ready' && shutdown) killOwnedGroup();
        });
        owner.once('error', () => finish('uncertain', 'owner_spawn_uncertain'));
        owner.once('exit', (_code, signal) => {
          if (finished) return;
          if (killProof && shutdown && signal === 'SIGKILL') {
            finish(
              shutdown.reason === 'exit' || shutdown.reason === 'launch_failed'
                ? 'exited'
                : 'stopped',
              shutdown.reason,
              shutdown.exitCode,
              shutdown.exitSignal,
            );
          } else {
            // An owner lost on its own leaves its agent unsupervised: the agent's group and what
            // descends from it end now, found before the group is signalled.
            const left = tree(owner.pid);
            try {
              process.kill(-owner.pid, 'SIGKILL');
            } catch {
              /* The group had already ended. */
            }
            signalAll(left, 'SIGKILL');
            finish('uncertain', 'owner_lost');
          }
        });
        owner.send({
          type: 'start',
          command: message.command,
          sessionToken: message.sessionToken,
          deadline: row.deadline,
          runDirectory: row.run_directory,
        });
        reply({ ok: true });
      } catch (error) {
        reply({
          error: [
            'invalid_deadline',
            'invalid_request',
            'not_running',
            'launch_conflict',
            'not_startable',
          ].includes(error.message)
            ? error.message
            : 'supervisor_failed',
        });
      }
    });
    socket.on('error', () => {});
  });
  server.on('error', socketFailed);
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  startupTimer = setTimeout(
    () => {
      if (!owner) finish('stopped', 'launch_timeout');
    },
    Math.max(0, Math.min(30000, current().deadline - Date.now())),
  );
  process.on('SIGTERM', () => {
    if (owner?.connected) owner.send({ type: 'stop' });
    else if (!owner) finish('stopped', 'controller_stop');
  });
}
