import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const workspace = '/workspace/assignments/' + 'b'.repeat(64);
const ledger = '/var/lib/merv-runner/ledger.sqlite';
const launchId = 'linux_gate';
const role = process.argv[2];

function child(script, args, options = {}) {
  return spawn('/usr/local/bin/node', [script, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    ...options,
  });
}

function exited(process) {
  return new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', (code, signal) =>
      signal ? reject(new Error('unexpected signal')) : resolve(code),
    );
  });
}

if (!role) {
  assert.equal(process.getuid(), 0);
  for (const path of ['/var/lib/merv-runner', '/run/merv-runtime', '/var/lib/merv-runtime']) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  for (const path of [ledger, '/opt/merv/runtime/releases.json']) {
    writeFileSync(path, 'synthetic-root-private-canary', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  mkdirSync(workspace, { mode: 0o700 });
  chownSync(workspace, 12001, 12001);
  // Root's sshd on loopback, as the image configures it, is the one listener allowed.
  execFileSync('/usr/sbin/sshd', ['-o', 'ListenAddress=127.0.0.1']);
  const path = '/run/merv-isolation/' + 'b'.repeat(64) + '.json';
  const other = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => other.once('listening', resolve));
  const guard = (options) =>
    child('/opt/merv/runner/supervisor.mjs', ['guardian', ledger, launchId], options);
  const refused = guard({ stdio: 'ignore' });
  assert.notEqual(await exited(refused), 0, 'another loopback listener must refuse the launch');
  assert.equal(existsSync(path), false);
  other.close();
  const guardian = guard();
  assert.equal(await exited(guardian), 0);
  const report = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.listeners, ['0100007F:0016 0']);
  assert.equal(report.roots.supervisor.pid, process.pid);
  assert.equal(report.roots.guardian.pid, guardian.pid);
  assert.deepEqual(report.identity.uids, [12001, 12001, 12001]);
  assert.equal(report.outcomes.guardian_connect, 13);
  assert.equal(Object.keys(report.outcomes).length, 20);
  console.log(
    JSON.stringify({
      gate: 'linux-isolation-probe-synthetic-ancestry',
      report,
      otherListenerRefused: true,
      actualProtectedWorkflow: false,
      cloudflareEvidence: false,
    }),
  );
} else if (role === 'guardian') {
  const directory =
    '/tmp/merv-runner-0-' +
    createHash('sha256').update('/var/lib/merv-runner').digest('hex').slice(0, 16);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path =
    directory + '/' + createHash('sha256').update(launchId).digest('hex').slice(0, 24) + '.sock';
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(path, resolve));
  chmodSync(path, 0o600);
  const group = child('/opt/merv/runner/supervisor.mjs', ['group']);
  const code = await exited(group);
  server.close();
  process.exitCode = code;
} else if (role === 'group') {
  const assignment = spawn(
    '/opt/merv/runtime/assignment-probed.py',
    ['--', '/opt/merv/bin/codex', 'exec', '--version', '-C', workspace],
    {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        MERV_AGENT_SESSION_TOKEN: 'ms_' + 'a'.repeat(43),
        MERV_MCP_URL: 'https://example.invalid/mcp',
      },
    },
  );
  assignment.stdin.end();
  assignment.stdout.resume();
  assignment.stderr.resume();
  const code = await exited(assignment);
  assert.notEqual(code, 70, 'assignment/probe refused');
  assert.notEqual(code, null);
} else {
  throw new Error('unknown fixture role');
}
