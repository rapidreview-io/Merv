/**
 * Real Trackio for the seeded demo: its own server (packages/metrics/trackio/serve.py) on a
 * free port, and training runs logged by the real Trackio client through Merv's /trackio proxy
 * (scripts/trackio/demo_runs.py), exactly as an agent's training code would after
 * metrics.write connect. MERV_TRACKIO_PYTHON names a Python with trackio==0.43.0 installed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const free = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

export interface DemoRun {
  name: string;
  curve: 'grok' | 'fit' | 'diverge';
  steps: number;
  every?: number;
  /** Where the curve turns: grokking's jump, divergence's blow-up. */
  at?: number;
  seed?: number;
  config?: Record<string, unknown>;
  /** Seconds between logged points: a run still training while the demo is looked at. */
  delay?: number;
  /** The step until which a delayed run logs at once: what it had trained before the demo. */
  fast_until?: number;
  cost_per_step?: number;
}
export interface DemoTrackio {
  upstream: string;
  writeToken: string;
  secret: string;
  mediaDir: string;
  /** Logs these runs with the environment connect returned; resolves once they have finished. */
  log(env: Record<string, string>, project: string, runs: DemoRun[]): Promise<void>;
  /** Starts runs that keep training in the background, for live curves. */
  live(env: Record<string, string>, project: string, runs: DemoRun[]): void;
  close(): Promise<void>;
}

export async function startTrackio(python: string): Promise<DemoTrackio> {
  const data = mkdtempSync(join(tmpdir(), 'merv-demo-trackio-'));
  const work = join(data, 'client');
  mkdirSync(work);
  const port = await free();
  const writeToken = randomBytes(24).toString('hex');
  const children: ChildProcess[] = [];
  const server = spawn(python, [join(root, 'packages/metrics/trackio/serve.py')], {
    env: {
      ...process.env,
      TRACKIO_DIR: data,
      TRACKIO_WRITE_TOKEN: writeToken,
      TRACKIO_PORT: String(port),
      TRACKIO_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.push(server);
  const upstream = `http://127.0.0.1:${port}`;
  for (let tries = 0; ; tries++) {
    const ok = await fetch(`${upstream}/trackio/api/get_all_projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"kwargs":{}}',
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) break;
    if (tries > 120 || server.exitCode !== null) throw new Error('Trackio did not start');
    await new Promise((done) => setTimeout(done, 250));
  }
  const run = (env: Record<string, string>, project: string, runs: DemoRun[]) => {
    // Run from an empty directory, isolated: the client imports nothing of ours.
    const child = spawn(
      python,
      ['-I', join(root, 'scripts/trackio/demo_runs.py'), JSON.stringify({ project, runs })],
      { cwd: work, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    children.push(child);
    return child;
  };
  return {
    upstream,
    writeToken,
    secret: randomBytes(32).toString('hex'),
    mediaDir: join(data, 'media'),
    log: (env, project, runs) =>
      new Promise((done, fail) =>
        run(env, project, runs).once('exit', (code) =>
          code === 0 ? done() : fail(new Error(`Trackio runs exited ${code}`)),
        ),
      ),
    live: (env, project, runs) => {
      for (const one of runs) run(env, project, [one]);
    },
    close: async () => {
      for (const child of children) child.kill();
    },
  };
}
