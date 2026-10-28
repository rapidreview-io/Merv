/**
 * What dies before or around plugins reaches Issues: a refused boot's unready entries and the
 * plugin errors Cordis logs, before the boot disposes; and the marker a run that crashed or was
 * killed leaves, reported by the next run under the release that died.
 */
import type { IssueReport, IssueStore } from '@merv/contracts/issues';
import type { Context } from 'cordis';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './fixtures/app.js';

const seen: (IssueReport | 'disposed' | 'drained')[] = [];
/** This file as the `issues` entry: a store that keeps what reaches it, up only after the
 *  plugin that fails has failed. */
export default {
  name: 'issues-boot-store',
  async apply(ctx: Context) {
    await delay(30);
    ctx.effect(function* () {
      yield () => void seen.push('disposed');
      yield ctx.provide('issues', {
        report: (issue: IssueReport) => void seen.push(issue),
        resolve() {},
        drain: async () => void seen.push('drained'),
      } as unknown as IssueStore);
    });
  },
};

function temporary(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-issues-boot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a refused boot reports its unready entry and the plugin error to Issues before disposing', async (t) => {
  const directory = temporary(t);
  // A database failure as State throws one: Cordis logs its plain-object cause first, alone.
  const store = join(directory, 'store.mjs');
  writeFileSync(
    store,
    `export default { name: 'store-like', apply() {
  throw Object.assign(new Error('x', { cause: { sqlstate: '42P01' } }), { code: 'internal_error' });
} };`,
  );
  await assert.rejects(
    createApp({
      directory,
      config: {
        plugins: [
          { id: 'issues', name: import.meta.url, required: false },
          {
            id: 'marker',
            name: './tests/fixtures/loader-marker.ts',
            config: { value: 'fails', fail: true },
          },
          { id: 'store', name: pathToFileURL(store).href, required: false },
        ],
      },
    }),
    (error: { code?: string }) => error.code === 'plugin_unavailable',
  );
  const disposed = seen.indexOf('disposed');
  const failed = seen.findIndex((r) => typeof r === 'object' && r.code === 'plugin_failed');
  const unready = seen.findIndex((r) => typeof r === 'object' && r.code === 'failed');
  // The error came before Issues was up: it reached the store as the boot settled.
  const drained = seen.indexOf('drained');
  // Issues writes before anything is disposed: State may close before Issues' own disposer.
  assert.ok(
    failed >= 0 && unready > failed && drained > unready && disposed > drained,
    JSON.stringify(seen),
  );
  const { error, ...report } = seen[failed] as IssueReport;
  assert.deepEqual(report, {
    class: 'platform',
    where: 'plugin',
    code: 'plugin_failed',
    key: 'fixture-marker',
    level: 'severe',
  });
  assert.ok(error instanceof Error);
  assert.deepEqual(
    seen
      .filter((r) => typeof r === 'object' && r.key === 'store-like')
      .map((r) => (r as IssueReport).code),
    ['internal_error'],
  );
  assert.deepEqual(seen[unready], {
    class: 'platform',
    where: 'plugin',
    code: 'failed',
    key: 'marker',
    level: 'severe',
  });
});

test('a crashed or killed run is reported by the next under its release; a clean stop leaves nothing', async (t) => {
  const directory = temporary(t);
  const marker = join(directory, 'serve.json');
  const stub = join(directory, 'stub.mjs');
  writeFileSync(join(directory, 'credentials.json'), '{}');
  writeFileSync(
    stub,
    `export default { name: 'boot-stub', apply(ctx, config) {
  if (config.refuse) throw new Error('refused');
  // Serving, as the API's server would, until it is stopped.
  const serving = setInterval(() => {}, 1000);
  ctx.provide('api', { url: 'http://127.0.0.1:1', stop: () => clearInterval(serving) });
  if (config.crash) setTimeout(() => { throw new Error('private crash words'); }, 200);
} };`,
  );
  const serve = (release: string, crash = false, refuse = false) => {
    const config = join(directory, `${release}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        plugins: [{ id: 'api', name: pathToFileURL(stub).href, config: { crash, refuse } }],
      }),
    );
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'serve', '--dir', directory, '--config', config],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, MERV_RELEASE: release },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (data) => (stderr += data));
    const exited = once(child, 'exit').then(([code]) => code as number | null);
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (data) => (stdout += data).includes('"ready"') && resolve());
      void exited.then(() => reject(new Error(stderr)));
    });
    const reports = () =>
      stderr
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .filter((line) => line.event === 'process');
    return { child, ready, exited, reports, stderr: () => stderr };
  };

  // Node's own handling of the crash is untouched; the marker keeps its facts, never its words.
  assert.equal(await serve('r1', true).exited, 1);
  const left = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(left.release, 'r1');
  assert.equal(left.crash.origin, 'uncaughtException');
  assert.equal(left.crash.name, 'Error');
  assert.ok(left.crash.at.length);
  assert.ok(!readFileSync(marker, 'utf8').includes('private crash words'));
  // A refused start leaves the crash for the first run that comes up.
  await assert.rejects(serve('r1b', false, true).ready, /plugin_unavailable/);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), left);

  const second = serve('r2');
  await second.ready;
  const [crashed, ...more] = second.reports();
  assert.deepEqual(more, []);
  assert.deepEqual(
    { ...crashed, at: undefined },
    {
      event: 'process',
      code: 'crashed',
      level: 'severe',
      key: 'uncaughtException',
      release: 'r1',
      name: 'Error',
      at: undefined,
    },
  );
  assert.deepEqual(crashed.at, left.crash.at);
  assert.ok(!second.stderr().includes('private crash words'));
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).release, 'r2');
  // Killed, it leaves its marker as it was written at start.
  second.child.kill('SIGKILL');
  await second.exited;

  const third = serve('r3');
  await third.ready;
  assert.deepEqual(third.reports(), [
    { event: 'process', code: 'unclean_exit', level: 'severe', release: 'r2' },
  ]);
  third.child.kill('SIGTERM');
  assert.equal(await third.exited, 0);
  assert.equal(existsSync(marker), false);
  // A marker that cannot be written only goes unreported: the run serves and stops cleanly.
  mkdirSync(marker);
  const fourth = serve('r4');
  await fourth.ready;
  fourth.child.kill('SIGTERM');
  assert.equal(await fourth.exited, 0);
});
