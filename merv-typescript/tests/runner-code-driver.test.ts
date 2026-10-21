import { gitTransport } from './fixtures/git-http.js';
import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import {
  type WorkspaceHandle,
  type WorkspaceSession,
  type WorkspaceTransport,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { git } from './fixtures/code-store.js';
import { writerFixture } from './fixtures/code-writers.js';

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

for (const hosted of [false, true])
  test(`ordinary session closure preserves uncommitted files and agent history across sessions (${hosted ? 'hosted' : 'local'})`, async (t) => {
    const f = await writerFixture(t);
    await f.lease('ses_first');
    const m = machine(t, f, undefined, hosted, hosted ? f.unitId : undefined);
    let driver = m.start();
    const first = m.launch('ses_first');
    const writer = await driver.prepare(first, m.session('ses_first'));
    await f.event('session.workspace_attached', 'ses_first');
    writeFileSync(join(writer.path, 'committed.txt'), 'agent committed\n');
    git(writer.path, ['add', '.']);
    git(writer.path, ['commit', '-qm', 'agent choice']);
    const agentHead = git(writer.path, ['rev-parse', 'HEAD']);
    writeFileSync(join(writer.path, 'committed.txt'), 'uncommitted edit\n');
    writeFileSync(join(writer.path, 'untracked.txt'), 'keep this\n');
    writeFileSync(join(writer.path, 'staged.txt'), 'keep staged version\n');
    git(writer.path, ['add', 'staged.txt']);
    writeFileSync(join(writer.path, 'staged.txt'), 'keep working version\n');
    m.terminal.add(first.id);
    await driver.capture(first);
    assert.equal(git(writer.path, ['rev-parse', 'HEAD']), agentHead);
    assert.equal(
      (await f.unit()).canonicalHead,
      agentHead,
      'the agent commit was pushed, no automatic commit was made',
    );
    await f.end('ses_first');
    await driver.close(first);
    driver.dispose();
    driver = m.start();
    await f.lease('ses_second');
    const second = await driver.prepare(m.launch('ses_second'), m.session('ses_second'));
    assert.equal(second.path, writer.path);
    assert.equal(git(second.path, ['rev-parse', 'HEAD']), agentHead);
    assert.equal(readFileSync(join(second.path, 'committed.txt'), 'utf8'), 'uncommitted edit\n');
    assert.equal(readFileSync(join(second.path, 'untracked.txt'), 'utf8'), 'keep this\n');
    assert.equal(git(second.path, ['show', ':staged.txt']), 'keep staged version');
    assert.equal(readFileSync(join(second.path, 'staged.txt'), 'utf8'), 'keep working version\n');
    assert.equal(git(second.path, ['rev-list', '--count', `${f.root}..HEAD`]), '1');
  });

for (const objectFormat of ['sha1', 'sha256'] as const)
  test(`hosted ${objectFormat} checkout supports ordinary agent fetch and push with independent metadata`, async (t) => {
    const f = await writerFixture(t, 900, { objectFormat });
    await f.lease('ses_git');
    const m = machine(t, f, undefined, true, f.unitId);
    const driver = m.start();
    const launch = m.launch('ses_git');
    const handle = await driver.prepare(launch, m.session('ses_git'));
    assert.ok(lstatSync(join(handle.path, '.git')).isDirectory());
    assert.equal(existsSync(join(handle.path, '.git/objects/info/alternates')), false);
    assert.equal(git(handle.path, ['rev-parse', '--git-common-dir']), '.git');
    assert.equal(git(handle.path, ['rev-parse', '--show-object-format']), objectFormat);
    assert.equal(git(handle.path, ['branch', '--show-current']), `merv/work/${f.unitId}`);
    assert.equal(git(handle.path, ['remote']), 'merv');
    const access = driver.agentGit(launch.id);
    assert.equal(access.startingCommit, f.root);
    assert.equal(
      readFileSync(join(handle.path, '.git/config'), 'utf8').includes(access.token),
      false,
    );
    writeFileSync(join(handle.path, 'agent.txt'), 'normal git\n');
    git(handle.path, ['add', '.']);
    git(handle.path, ['commit', '-qm', 'agent']);
    await agentGit(driver, launch.id, handle.path, ['push', 'merv', 'HEAD']);
    await agentGit(driver, launch.id, handle.path, ['fetch', 'merv']);
    assert.equal((await f.unit()).canonicalHead, git(handle.path, ['rev-parse', 'HEAD']));
    await assert.rejects(
      agentGit(driver, launch.id, handle.path, ['push', 'merv', 'HEAD:other']),
      /assigned branch|rejected/,
    );
  });

for (const descendant of [false, true])
  test(`local continuation ${descendant ? 'refuses an unrelated same-tree descendant' : 'adopts the approved frozen tree while preserving later dirt'}`, async (t) => {
    const f = await writerFixture(t);
    const sessionId = 'ses_submit_local';
    await f.lease(sessionId);
    let frozen = false;
    let submitted: { parentOid: string; treeOid: string } | undefined;
    const m = machine(t, f, (inner) => ({
      ...inner,
      call: async (route, body) => {
        const input = body as { sessionId: string; parentOid: string; treeOid: string };
        if (input.sessionId === sessionId && route === 'submission-status')
          return { ...((await inner.call(route, body)) as object), requested: true, frozen };
        if (input.sessionId === sessionId && route === 'submissions') {
          submitted = { parentOid: input.parentOid, treeOid: input.treeOid };
          await f.code.gitRemote.verifySubmission(f.admin.projectId, {
            ...submitted,
            sessionId,
            unitId: f.unitId,
          });
          await f.state.transaction((tx) =>
            f.core.writers.settle(tx, {
              projectId: f.admin.projectId,
              unitId: f.unitId,
              sessionId,
              generation: 1,
              leaseId: sessionId,
              expectedHead: input.parentOid,
              moves: false,
            }),
          );
          frozen = true;
          return {};
        }
        return await inner.call(route, body);
      },
    }));
    let driver = m.start();
    const first = m.launch(sessionId);
    const handle = await driver.prepare(first, m.session(sessionId));
    writeFileSync(join(handle.path, 'README.md'), 'approved tracked content\n');
    writeFileSync(join(handle.path, 'added.txt'), 'approved new file\n');
    writeFileSync(join(handle.path, 'deleted-later.txt'), 'approved then removed\n');
    git(handle.path, ['add', 'added.txt']);
    m.terminal.add(first.id);
    await driver.capture(first);
    await driver.close(first);
    await f.end(sessionId);
    assert.equal(git(handle.path, ['rev-parse', 'HEAD']), f.root);
    assert.ok(submitted);
    const approved = await f.code.gitRemote.materializeSubmission(f.admin.projectId, {
      ...submitted,
      sessionId,
      unitId: f.unitId,
      approvalId: 'review_local_plan',
      createdAt: '2026-10-21T00:00:00.000Z',
      message: 'Approved local plan',
    });
    const canonical = descendant
      ? git(f.paths.repository, [
          'commit-tree',
          approved.tree,
          '-p',
          approved.head,
          '-m',
          'unrelated descendant',
        ])
      : approved.head;
    await f.state.transaction((tx) =>
      tx.run(
        'UPDATE code_workspaces SET head_oid=? WHERE project_id=? AND unit_id=?',
        canonical,
        f.admin.projectId,
        f.unitId,
      ),
    );
    writeFileSync(join(handle.path, 'README.md'), 'post-submission edit\n');
    writeFileSync(join(handle.path, 'added.txt'), 'post-submission staged edit\n');
    git(handle.path, ['add', 'added.txt']);
    rmSync(join(handle.path, 'deleted-later.txt'));
    writeFileSync(join(handle.path, 'untracked.txt'), 'local data\n');
    const originalIndex = git(handle.path, ['write-tree']);
    driver.dispose();
    driver = m.start();
    await f.lease('ses_continue_local');
    const preparing = driver.prepare(
      m.launch('ses_continue_local'),
      m.session('ses_continue_local'),
    );
    if (descendant) {
      await assert.rejects(preparing, failed('workspace_continuity_conflict'));
      assert.equal(git(handle.path, ['rev-parse', 'HEAD']), f.root);
      assert.equal(git(handle.path, ['write-tree']), originalIndex);
    } else {
      const next = await preparing;
      assert.equal(next.path, handle.path);
      assert.equal(next.snapshot!.headOid, approved.head);
      assert.equal(git(handle.path, ['rev-parse', 'HEAD']), approved.head);
      assert.equal(
        git(handle.path, ['write-tree']),
        approved.tree,
        'index uses the approved baseline',
      );
      assert.equal(git(handle.path, ['diff', '--cached', '--name-only']), '');
      assert.equal(
        git(handle.path, ['diff', '--name-only']),
        'README.md\nadded.txt\ndeleted-later.txt',
      );
    }
    assert.equal(readFileSync(join(handle.path, 'README.md'), 'utf8'), 'post-submission edit\n');
    assert.equal(
      readFileSync(join(handle.path, 'added.txt'), 'utf8'),
      'post-submission staged edit\n',
    );
    assert.equal(existsSync(join(handle.path, 'deleted-later.txt')), false);
    assert.equal(readFileSync(join(handle.path, 'untracked.txt'), 'utf8'), 'local data\n');
  });

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

test('unchanged shutdown reuses the existing commit', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_no_change');
  const m = machine(t, f);
  const driver = m.start();
  const launch = m.launch('ses_no_change');
  await driver.prepare(launch, m.session('ses_no_change'));
  m.terminal.add(launch.id);
  await driver.capture(launch);
  await driver.close(launch);
  await f.end('ses_no_change');
  const receipts = await driver.shutdownCapture();
  assert.equal(receipts[0].headOid, f.root);
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
