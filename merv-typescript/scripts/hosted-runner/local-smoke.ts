/** Explicit real-model local acceptance; creates only an isolated synthetic Merv project.
 * Run with MERV_DB_URL set to a disposable local PostgreSQL service. The saved
 * runner API key is supplied privately through MERV_RUNNER_API_KEY or read from
 * its exact macOS Keychain account. Neither path prints the credential, and it stays
 * in this process: the container's Codex calls the model through Main's relay.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/app.js';
import { loadConfiguration } from '../../src/config.js';
import { useRunSchema } from '../database.js';
import { codexModelRelay } from '../../packages/fleet/src/codex-relay.js';

async function command(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.resume(); // Never include subprocess diagnostics in secret-bearing failures.
    child.on('error', () => {
      clearTimeout(timeout);
      fail(new Error(`${basename(executable)} acceptance command failed`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) done(output);
      else if (timedOut) fail(new Error(`${basename(executable)} timed out after 60 seconds`));
      else fail(new Error(`${basename(executable)} acceptance command exited ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const docker = (args: string[], input?: string) => command('docker', args, input);
let modelApiKey = process.env.MERV_RUNNER_API_KEY ?? '';
delete process.env.MERV_RUNNER_API_KEY;
const run = `hosted-smoke-${Date.now()}`;
const directory = resolve(`../output/${run}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const schema = useRunSchema(directory);
const managedSecretEnv = `MERV_SMOKE_MANAGED_${Date.now()}`;
process.env[managedSecretEnv] = randomBytes(48).toString('hex');
const config = loadConfiguration({
  directory: `${directory}/server`,
  api: true,
  host: '0.0.0.0',
  port: 0,
});
const app = await createApp({
  directory: `${directory}/server`,
  config: {
    plugins: config.entries.map((entry) =>
      entry.id === 'sessions' ? { ...entry, config: { ...entry.config, managedSecretEnv } } : entry,
    ),
  },
});
let allocated = false;
let sourceToken = '';
try {
  const boot = await app.ctx.scope.bootstrap({
    projectName: run,
    actorName: 'Synthetic acceptance',
  });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  sourceToken = boot.token;
  const source = await app.ctx.scope.delegationSource(caller);
  const allocationId = `local_${run}`;
  const profile = {
    name: 'hosted-codex',
    harness: 'codex' as const,
    model: 'gpt-6-luna',
    enabled: true,
    parallelism: 1,
  };
  app.ctx.sessions.registerManagedValidator({
    current: async (binding) =>
      binding.allocationId === allocationId &&
      binding.epoch === 1 &&
      binding.runtimeProfileId === 'local-codex-acceptance' &&
      binding.source.projectId === caller.projectId &&
      binding.source.actorId === caller.actorId,
    admits: async (id, epoch) => id === allocationId && epoch === 1,
  });
  const { enrollmentToken } = await app.ctx.sessions.ensureManagedEnrollment({
    allocationId,
    epoch: 1,
    source,
    runtimeProfileId: 'local-codex-acceptance',
    platform: profile,
    capabilities: ['code.v2'],
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  });
  if (!modelApiKey) {
    const home = resolve('../output/runner-codex/home');
    const account = `cli|${createHash('sha256').update(home).digest('hex').slice(0, 16)}`;
    const savedAuth = await command('security', [
      'find-generic-password',
      '-s',
      'Codex Auth',
      '-a',
      account,
      '-w',
    ]);
    try {
      const auth: unknown = JSON.parse(savedAuth);
      if (
        !auth ||
        typeof auth !== 'object' ||
        !('OPENAI_API_KEY' in auth) ||
        typeof auth.OPENAI_API_KEY !== 'string' ||
        !auth.OPENAI_API_KEY.trim()
      )
        throw new Error('missing key');
      modelApiKey = auth.OPENAI_API_KEY;
    } catch {
      // JSON parser errors can include secret-bearing input; never propagate them.
      throw new Error('Dedicated runner API key is unavailable or malformed');
    }
  }
  const task = await app.ctx.tasks.create(caller, {
    title: 'Hosted runner isolation acceptance',
    goal: 'Use the local shell to run id -u and calculate 6*7. Create a small Markdown artifact containing the commands and results. Submit the task using that evidence and one met confirmation per criterion. Do not read credentials or configuration files. This is a synthetic acceptance test.',
    checks: ['The shell reports UID 12001.', 'The calculation returns 42.'],
    requestId: run,
  });
  await app.ctx.sessions.setDispatch(caller, { enabled: true });
  const relay = await codexModelRelay(app.ctx.sessions, app.ctx.state, {
    providerKey: () => modelApiKey,
    dailyTokensPerPerson: 5_000_000,
  });
  app.ctx.api.mountModelRelay('/codex-model', relay);
  const port = new URL(app.ctx.api.url!).port;
  const image = (
    await docker(['image', 'inspect', '--format', '{{.Id}}', 'merv-hosted-codex:acceptance'])
  ).trim();
  await docker([
    'run',
    '-d',
    '--name',
    run,
    '--tmpfs',
    '/run/merv-runtime:rw,noexec,nosuid,mode=0700',
    '--entrypoint',
    '/bin/sh',
    'merv-hosted-codex:acceptance',
    '-c',
    // Main is loopback HTTP, as the runner requires, without a listener in the container for the
    // isolation probe to refuse: localhost names the Docker host. The probe also checks that the
    // release catalog, which Sandboxes' bootstrap writes, is private.
    "getent ahostsv4 host.docker.internal | sed -n '1s/ .*/ localhost/p' >/etc/hosts && " +
      'install -m 0600 /dev/null /opt/merv/runtime/releases.json && exec sleep 1800',
  ]);
  allocated = true;
  const bootstrap = JSON.stringify({
    baseUrl: `http://localhost:${port}`,
    projectId: boot.project.id,
    enrollmentToken,
  });
  const receiver = `import sys,json,io,hashlib\nfrom pathlib import Path\nsys.path.insert(0,'/opt/merv/python')\nfrom merv_sandboxes.runtimes.releases import RuntimeRelease,RuntimeReleases\nfrom merv_sandboxes.runtimes.receiver import dispatch_bootstrap\ndata=json.load(sys.stdin)\np=Path('/opt/merv/runtime/start-runner')\nr=RuntimeRelease(provider='local-acceptance',image_digest=data['image'],executable=str(p),executable_sha256=hashlib.sha256(p.read_bytes()).hexdigest())\nprint(dispatch_bootstrap(io.BytesIO(data['bootstrap'].encode()),'launch_smoke','job_smoke',r.release_id,releases=RuntimeReleases([r])).decode().strip())`;
  const receipt = await docker(
    ['exec', '-i', run, '/usr/bin/python3', '-c', receiver],
    JSON.stringify({ image, bootstrap }),
  );
  assert.equal(receipt.trim(), 'LAUNCHED');
  console.log('Runtime launched; waiting for one isolated Codex assignment.');
  let state = '';
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until) {
    const value = await docker([
      'exec',
      run,
      '/bin/sh',
      '-c',
      'test ! -f /var/lib/merv-runner/status.json || cat /var/lib/merv-runner/status.json',
    ]);
    if (value) {
      const next = JSON.parse(value).state;
      if (next !== state) {
        state = next;
        console.log(`Supervisor: ${state}`);
      }
      if (state === 'finished' || state === 'failed' || state === 'empty') break;
    }
    await delay(2000);
  }
  const finalTask = await app.ctx.tasks.get(caller, task.id);
  const sessions = await app.ctx.sessions.list(caller);
  const report = { run, schema, image, taskId: task.id, state, task: finalTask, sessions };
  const text = JSON.stringify(report, null, 2);
  assert.ok(
    !text.includes(sourceToken) &&
      !text.includes(modelApiKey) &&
      !text.includes(enrollmentToken) &&
      !/mr_[0-9a-f]{64}/.test(text),
  );
  writeFileSync(`${directory}/report.json`, text, { mode: 0o600 });
  assert.equal(state, 'finished');
  assert.equal(sessions.length, 1, 'One assignment only; no review assignment on this worker');
  assert.ok(finalTask.reviewId, 'Producer submitted evidence for review');
  console.log(
    `PASS: one managed Codex assignment submitted evidence. Report: ${directory}/report.json`,
  );
} finally {
  modelApiKey = '';
  sourceToken = '';
  try {
    if (allocated) await docker(['rm', '-f', run]);
  } finally {
    await app.stop();
    delete process.env[managedSecretEnv];
  }
}
