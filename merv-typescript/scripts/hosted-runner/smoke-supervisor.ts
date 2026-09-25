/** Fixed one-assignment supervisor. Bootstrap carries expiring enrollment only; Codex calls the
 *  model through Main's relay with its session bearer, so no provider key reaches the machine. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { MachineRunner } from '@merv/runner';
import { codeWorkspaceDriver } from '@merv/code/driver/index';

const schema = z
  .object({
    baseUrl: z.string().url(),
    projectId: z.string().min(1),
    enrollmentToken: z.string().regex(/^me_[0-9a-f]{64}$/),
  })
  .strict();
const directory = '/var/lib/merv-runner';
const launcher = '/opt/merv/runtime/assignment-probed.py';
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
  // Enrollment can precede Fleet observing the protected launch receipt. Retry the
  // same token briefly; never fall back to an ordinary project credential.
  let controlToken = '';
  const workerNonce = randomBytes(32).toString('hex');
  const enrollUntil = Date.now() + 60_000;
  while (Date.now() < enrollUntil) {
    const response = await fetch(`${data.baseUrl.replace(/\/$/, '')}/sessions/runners/enroll`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${data.enrollmentToken}`,
        'content-type': 'application/json',
        'x-merv-project-id': data.projectId,
      },
      body: JSON.stringify({ workerNonce }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (response?.ok) {
      const result = z
        .object({ controlToken: z.string().regex(/^mr_[0-9a-f]{64}$/) })
        .parse(await response.json());
      controlToken = result.controlToken;
      break;
    }
    await delay(1000);
  }
  data.enrollmentToken = '';
  if (!controlToken) throw new Error('managed enrollment failed');
  process.env.MERV_HOSTED_SOURCE = controlToken;
  const runner = new MachineRunner(
    {
      directory,
      baseUrl: data.baseUrl,
      projectId: data.projectId,
      credentialEnv: 'MERV_HOSTED_SOURCE',
      capacity: 1,
      oneAssignment: true,
      assignmentWorkspaceDirectory: assignmentRoot,
      workspaceDrivers: ['code'],
      profiles: [
        {
          name: 'hosted-codex',
          harness: 'codex',
          executable: codex,
          isolatedLauncher: launcher,
          hosted: true,
          model: 'gpt-6-luna',
          enabled: true,
          parallelism: 1,
        },
      ],
    },
    { autoPoll: false, drivers: [codeWorkspaceDriver] },
  );
  delete process.env.MERV_HOSTED_SOURCE;
  controlToken = '';
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  // The step's own deadline, which the server sets, ends the launch; this adds no clock of its own.
  const emptyUntil = Date.now() + 60_000;
  try {
    status('starting');
    await runner.start();
    status('connected');
    while (!stopping) {
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
