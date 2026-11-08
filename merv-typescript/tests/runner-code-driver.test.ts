import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import {
  type WorkspaceHandle,
  type WorkspaceSession,
  type WorkspaceTransport,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { git } from './fixtures/code-store.js';
import { writerFixture } from './fixtures/code-writers.js';
import { gitTransport } from './fixtures/git-http.js';

type Fixture = Awaited<ReturnType<typeof writerFixture>>;
const failed = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code, String(error));
  return true;
};

/** One machine, native HTTP Git bytes, and direct metadata controls. */
function machine(
  t: TestContext,
  f: Fixture,
  wrap?: (inner: WorkspaceTransport) => WorkspaceTransport,
  hosted = false,
  workInstanceId?: string,
  previousWorkspace?: (launchId: string) => WorkspaceHandle | undefined,
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-drv-'));
  const assignmentWorkspaceDirectory = hosted
    ? join(realpathSync(directory), 'assignments')
    : undefined;
  if (assignmentWorkspaceDirectory) mkdirSync(assignmentWorkspaceDirectory, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const http = gitTransport(() => f.code, f.admin);
  t.after(() => http.close());
  const direct = http.transport;
  const terminal = new Set<string>();
  const drivers: CodeWorkspaceDriver[] = [];
  t.after(() => drivers.forEach((driver) => driver.dispose()));
  const self = {
    directory,
    transport: direct,
    assignmentWorkspaceDirectory,
    terminal,
    /** The driver as a newly started runner would construct it, on the same ledger. */
    start(transport = wrap ? wrap(direct) : direct) {
      const driver = new CodeWorkspaceDriver(
        {
          directory,
          path: join(directory, 'ledger.sqlite'),
          assignmentWorkspaceDirectory,
          assignmentUser: { uid: 12001, gid: 12001, git: '/nonexistent/assignment-git' },
          workInstanceId,
          previousWorkspace,
          terminal: (id) => terminal.has(id),
        },
        transport,
      );
      drivers.push(driver);
      return driver;
    },
    launch: (sessionId: string) => ({
      id: `launch-${sessionId}`,
      sessionId,
      runDirectory: directory,
    }),
    session: (sessionId: string) => f.session(sessionId) as unknown as WorkspaceSession,
  };
  return self;
}

const exec = promisify(execFile);
async function agentGit(
  driver: CodeWorkspaceDriver,
  launchId: string,
  path: string,
  args: string[],
) {
  const access = driver.agentGit(launchId);
  return (
    await exec('git', args, {
      cwd: path,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${access.url}.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`merv:${access.token}`).toString('base64')}`,
      },
    })
  ).stdout.trim();
}

test('a fresh hosted ledger derives the same work path and a foreign symlink cannot claim it', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_fresh');
  const m = machine(t, f, undefined, true, f.unitId);
  const expected = join(
    m.assignmentWorkspaceDirectory!,
    createHash('sha256').update(f.unitId).digest('hex'),
  );
  const foreign = mkdtempSync(join(tmpdir(), 'merv-foreign-'));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  symlinkSync(foreign, expected);
  await assert.rejects(
    m.start().prepare(m.launch('ses_fresh'), m.session('ses_fresh')),
    failed('workspace_foreign_checkout'),
  );
  assert.ok(lstatSync(expected).isSymbolicLink());
  rmSync(expected);
  const handle = await m.start().prepare(m.launch('ses_fresh'), m.session('ses_fresh'));
  assert.equal(handle.path, expected);
  assert.equal(git(handle.path, ['rev-parse', 'HEAD']), f.root);
});

test('planned shutdown captures remaining files exactly once and retries a lost durability response', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_shutdown');
  let lost = true;
  const m = machine(t, f, (inner) => ({
    ...inner,
    call: async (route, body) => {
      const answer = await inner.call(route, body);
      if (route === 'pushed' && lost) {
        lost = false;
        throw Object.assign(new Error('lost response'), { code: 'control_unavailable', status: 0 });
      }
      return answer;
    },
  }));
  let driver = m.start();
  const launch = m.launch('ses_shutdown');
  const handle = await driver.prepare(launch, m.session('ses_shutdown'));
  writeFileSync(join(handle.path, 'progress.txt'), 'retained before release\n');
  await assert.rejects(driver.shutdownCapture(), failed('workspace_process_stop_unconfirmed'));
  m.terminal.add(launch.id);
  await driver.capture(launch);
  await driver.close(launch);
  await f.end('ses_shutdown');
  assert.equal(git(handle.path, ['rev-parse', 'HEAD']), f.root);
  assert.equal((await f.unit()).canonicalHead, null);
  await assert.rejects(driver.shutdownCapture());
  const durable = (await f.unit()).canonicalHead;
  assert.ok(durable && durable !== f.root);
  driver.dispose();
  driver = m.start();
  const receipts = await driver.shutdownCapture();
  assert.equal(receipts[0].headOid, durable);
  assert.deepEqual(await driver.shutdownCapture(), receipts);
  assert.equal(git(f.paths.repository, ['rev-list', '--count', `${f.root}..${durable}`]), '1');
  assert.equal(
    git(f.paths.repository, ['show', `${durable}:progress.txt`]),
    'retained before release',
  );
});

test('review receives a separate read-only credential and cannot push through ordinary Git', async (t) => {
  const f = await writerFixture(t);
  await f.reviewer('ses_review', f.root);
  const m = machine(t, f, undefined, true, f.unitId);
  const driver = m.start();
  const launch = m.launch('ses_review');
  const review = await driver.prepare(launch, m.session('ses_review'));
  assert.equal(review.readOnly, true);
  assert.equal(git(review.path, ['rev-parse', 'HEAD']), f.root);
  assert.equal(driver.agentGit(launch.id).branch, null);
  assert.ok(lstatSync(join(review.path, '.git')).isDirectory());
  await assert.rejects(
    agentGit(driver, launch.id, review.path, ['push', 'merv', 'HEAD:other']),
    /403|read.only/,
  );
  m.terminal.add(launch.id);
  assert.equal((await driver.capture(launch))!.headOid, f.root);
  await driver.close(launch);
});
