/** First isolated runner acceptance, not production managed-principal enrollment.
 * An explicitly authorized synthetic project source stays in this root process.
 * Fleet production must replace that source with allocation-bound enrollment.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { MachineRunner } from '@merv/runner';

const schema = z
  .object({
    baseUrl: z.string().url(),
    projectId: z.string().min(1),
    sourceToken: z.string().min(16),
    modelApiKey: z.string().min(16),
  })
  .strict();
const directory = '/var/lib/merv-runner';
const launcher = '/opt/merv/python/merv_sandboxes/runtimes/assignment.py';
const codex = '/opt/merv/bin/codex';
const assignmentRoot = '/workspace/assignments';
const status = (state: string) =>
  writeFileSync(
    `${directory}/status.json`,
    JSON.stringify({ state, at: new Date().toISOString() }),
    { mode: 0o600 },
  );

async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw new Error('root Linux required');
  const bootstrap = process.env.MERV_BOOTSTRAP_FILE;
  if (!bootstrap?.startsWith('/run/merv-runtime/bootstrap-')) throw new Error('bootstrap missing');
  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(JSON.parse(readFileSync(bootstrap, 'utf8')));
  } finally {
    unlinkSync(bootstrap);
  }
  delete process.env.MERV_BOOTSTRAP_FILE;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const loginDirectory = `${assignmentRoot}/${createHash('sha256').update('model-login').digest('hex')}`;
  mkdirSync(loginDirectory, { mode: 0o700 });
  // The model key goes only to Codex login on stdin; the source credential does not.
  const login = spawnSync(launcher, ['--', codex, 'login', '--with-api-key'], {
    cwd: loginDirectory,
    input: data.modelApiKey + '\n',
    timeout: 30_000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  data.modelApiKey = '';
  if (login.error || login.status !== 0) throw new Error('model login failed');
  process.env.MERV_HOSTED_SOURCE = data.sourceToken;
  const runner = new MachineRunner(
    {
      directory,
      baseUrl: data.baseUrl,
      projectId: data.projectId,
      credentialEnv: 'MERV_HOSTED_SOURCE',
      capacity: 1,
      oneAssignment: true,
      assignmentWorkspaceDirectory: assignmentRoot,
      workspaceDrivers: [],
      profiles: [
        {
          name: 'hosted-codex',
          harness: 'codex',
          executable: codex,
          isolatedLauncher: launcher,
          model: 'gpt-6-luna',
          enabled: true,
          parallelism: 1,
        },
      ],
    },
    { autoPoll: false },
  );
  delete process.env.MERV_HOSTED_SOURCE;
  data.sourceToken = '';
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  const until = Date.now() + 20 * 60_000;
  const emptyUntil = Date.now() + 60_000;
  try {
    status('starting');
    await runner.start();
    status('connected');
    while (!stopping && Date.now() < until) {
      const snapshot = runner.snapshot();
      if (snapshot.launches.length > 1) throw new Error('one-assignment invariant failed');
      const launch = snapshot.launches[0];
      if (
        launch &&
        ['exited', 'stopped'].includes(launch.status) &&
        !launch.releasePending &&
        !launch.workspace?.capturePending
      ) {
        status('finished');
        return;
      }
      if (!launch && Date.now() > emptyUntil) {
        status('empty');
        return;
      }
      await delay(500);
      await runner.tick();
    }
    status('stopping');
  } finally {
    await runner.stop();
  }
}

main().catch(() => {
  try {
    status('failed');
  } catch {
    /* never disclose bootstrap or process errors */
  }
  process.exitCode = 1;
});
