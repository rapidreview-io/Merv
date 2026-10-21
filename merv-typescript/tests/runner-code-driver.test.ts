import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import { diskBytes } from '@merv/code/store/repository';
import {
  WorkspaceDeferred,
  type CodeCommitCommand,
  type WorkspaceHandle,
  type WorkspaceSession,
  type WorkspaceTransport,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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

/** One machine: a ledger directory, and the driver talking to Code without HTTP in between. */
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
  const direct: WorkspaceTransport = {
    call: async (route, body) => await f.code.v2!.call(f.admin, route, body),
    putPart: async (id, offset, bytes) =>
      await f.code.v2!.putPart(f.admin, id, offset, Buffer.from(bytes)),
    readPart: async (id, input) => await f.code.v2!.readPart!(f.admin, id, input),
  };
  const terminal = new Set<string>();
  const drivers: CodeWorkspaceDriver[] = [];
  t.after(() => drivers.forEach((driver) => driver.dispose()));
  const self = {
    directory,
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
        { pollMs: 20, admissionMs: 20_000 },
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

test('a reused machine starts the next writer at Code’s admitted head, never on what the last session left unadmitted', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_reuse_1');
  const m = machine(t, f, undefined, true, f.unitId);
  const driver = m.start();
  const first = m.launch('ses_reuse_1');
  const writer = await driver.prepare(first, m.session('ses_reuse_1'));
  await f.event('session.workspace_attached', 'ses_reuse_1');
  writeFileSync(join(writer.path, 'admitted.txt'), 'admitted\n');
  writeFileSync(join(writer.path, '.gitignore'), '.cache/\n');
  const admitted = await driver.checkpointCommit(
    first,
    await command(f, driver, 'ses_reuse_1', f.root),
  );
  driver.acknowledgeCommit(admitted.commandId);
  // Its session closes (a handoff) with work it never committed: data Git ignores, a file the
  // agent committed on its own, and an edit. Its capture comes too late to be admitted.
  mkdirSync(join(writer.path, '.cache'));
  writeFileSync(join(writer.path, '.cache/data.bin'), 'data');
  writeFileSync(join(writer.path, 'wip.txt'), 'never committed\n');
  writeFileSync(join(writer.path, 'local.txt'), 'local\n');
  git(writer.path, ['add', 'local.txt']);
  git(writer.path, ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-qm', 'local']);
  writeFileSync(join(writer.path, 'admitted.txt'), 'edited after\n');
  await f.event('session.closed', 'ses_reuse_1');
  f.end('ses_reuse_1');
  m.terminal.add(first.id);
  assert.equal((await driver.capture(first))!.headOid, admitted.headOid);
  await driver.close(first);
  assert.equal((await f.unit()).canonicalHead, admitted.headOid);

  await f.lease('ses_reuse_2');
  const next = await driver.prepare(m.launch('ses_reuse_2'), m.session('ses_reuse_2'));
  assert.equal(next.path, writer.path);
  assert.equal(git(next.path, ['rev-parse', 'HEAD']), admitted.headOid);
  assert.equal(readFileSync(join(next.path, 'admitted.txt'), 'utf8'), 'admitted\n');
  assert.equal(existsSync(join(next.path, 'local.txt')), false, 'no unadmitted commit is built on');
  assert.equal(existsSync(join(next.path, 'wip.txt')), false);
  assert.equal(git(next.path, ['status', '--porcelain']), '');
  // What Git ignores is the machine's data, not Code's, and is kept.
  assert.equal(readFileSync(join(next.path, '.cache/data.bin'), 'utf8'), 'data');
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
  assert.ok(existsSync(foreign));
  rmSync(expected);
  const fresh = m.start();
  const handle = await fresh.prepare(m.launch('ses_fresh'), m.session('ses_fresh'));
  assert.equal(handle.path, expected);
  assert.equal(git(handle.path, ['rev-parse', 'HEAD']), f.root);
});

/**
 * The hosted launcher's precondition (Sandboxes `assignment._handoff_tree`): a checkout the
 * supervisor still owns is handed to the assignment only if every node in it is the
 * supervisor's, on the checkout's device, and a directory, a symlink or a singly linked file.
 * Anything else ends the launch before Codex with `assignment launch refused`, exit 70.
 */
function handoffRefusals(root: string): string[] {
  const device = lstatSync(root).dev;
  const uid = process.getuid!();
  const refused: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.uid !== uid || info.dev !== device) refused.push(`${path}: owner ${info.uid}`);
      else if (info.isDirectory()) visit(path);
      else if (!info.isSymbolicLink() && !(info.isFile() && info.nlink === 1))
        refused.push(`${path}: unsafe node`);
    }
  };
  visit(root);
  return refused;
}

test('a review checkout hands the launcher only supervisor-owned nodes, whatever the writer left', async (t) => {
  // Ownership is only observable as root, as on a hosted work host: CI runs this file as root too.
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    return t.skip('needs root on Linux, as a hosted work host runs');
  const f = await writerFixture(t);
  await f.lease('ses_owner_writer');
  const m = machine(t, f, undefined, true, f.unitId);
  const driver = m.start();
  const writerLaunch = m.launch('ses_owner_writer');
  const writer = await driver.prepare(writerLaunch, m.session('ses_owner_writer'));
  await f.event('session.workspace_attached', 'ses_owner_writer');
  // What staging's c7 experiment did: its agent ignored the dataset it generates, so the dataset
  // stays untracked in the writer's checkout, and review receives it as a copy.
  writeFileSync(join(writer.path, '.gitignore'), 'data/dataset.csv\n__pycache__/\n');
  writeFileSync(join(writer.path, 'make_dataset.py'), 'print(1)\n');
  mkdirSync(join(writer.path, 'data'));
  writeFileSync(join(writer.path, 'data/dataset.csv'), 'x,label\n1,0\n');
  mkdirSync(join(writer.path, '__pycache__'));
  writeFileSync(join(writer.path, '__pycache__/m.cpython-311.pyc'), 'pyc');
  symlinkSync('../data/dataset.csv', join(writer.path, '__pycache__/link'));
  // The assignment wrote these in the checkout the launcher handed it. (Its Git metadata stays
  // root's here: this test captures with root Git, not the launcher's assignment Git.)
  for (const name of ['data', '__pycache__'])
    execFileSync('chown', ['-R', '--no-dereference', '12001:12001', join(writer.path, name)]);
  m.terminal.add(writerLaunch.id);
  const result = await driver.capture(writerLaunch);
  await f.event('session.closed', 'ses_owner_writer');
  f.end('ses_owner_writer');
  await driver.close(writerLaunch);

  f.reviewer('ses_owner_review', result!.headOid);
  const reviewLaunch = m.launch('ses_owner_review');
  const review = await driver.prepare(reviewLaunch, m.session('ses_owner_review'));
  assert.equal(review.path, writer.path);
  assert.equal(readFileSync(join(review.path, 'data/dataset.csv'), 'utf8'), 'x,label\n1,0\n');
  assert.equal(readlinkSync(join(review.path, '__pycache__/link')), '../data/dataset.csv');
  assert.equal(lstatSync(review.path).uid, 0, 'the review checkout is not handed off yet');
  assert.deepEqual(handoffRefusals(review.path), []);
});

test('shared review cannot overwrite Code head after a refused writer capture', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_refused');
  const m = machine(t, f, undefined, true, f.unitId);
  const driver = m.start();
  const writerLaunch = m.launch('ses_refused');
  const writer = await driver.prepare(writerLaunch, m.session('ses_refused'));
  await f.event('session.workspace_attached', 'ses_refused');
  writeFileSync(join(writer.path, 'token.txt'), `ghp_${'a'.repeat(36)}\n`);
  m.terminal.add(writerLaunch.id);
  assert.equal((await driver.capture(writerLaunch))!.headOid, f.root);
  await f.event('session.closed', 'ses_refused');
  f.end('ses_refused');
  await driver.close(writerLaunch);
  f.reviewer('ses_refused_review', f.root);
  const reviewLaunch = m.launch('ses_refused_review');
  const review = await driver.prepare(reviewLaunch, m.session('ses_refused_review'));
  assert.equal(review.path, writer.path);
  assert.equal(review.snapshot!.headOid, f.root);
  assert.equal(
    existsSync(join(review.path, 'token.txt')),
    false,
    'rejected files stay outside review',
  );
  assert.equal((await f.unit()).canonicalHead, null);
  m.terminal.add(reviewLaunch.id);
  assert.equal((await driver.capture(reviewLaunch))!.headOid, f.root);
  await driver.close(reviewLaunch);
  assert.ok(
    existsSync(
      join(
        m.directory,
        'code-v2/preserved',
        createHash('sha256').update(f.unitId).digest('hex'),
        'token.txt',
      ),
    ),
    'the rejected writer checkout is retained privately without entering review',
  );
  await f.code.fenceUnit(await f.human(), { unitId: f.unitId, requestId: 'fence-refused-test' });
  await f.lease('ses_refused_retry');
  const retry = await driver.prepare(m.launch('ses_refused_retry'), m.session('ses_refused_retry'));
  assert.equal(retry.snapshot!.headOid, f.root, 'unaccepted source never advances Code');
  // The next writer starts at Code's admitted head: what was refused stays private, never in it.
  assert.equal(existsSync(join(retry.path, 'token.txt')), false);
  assert.ok(
    existsSync(
      join(
        m.directory,
        'code-v2/rejected',
        createHash('sha256').update(writerLaunch.id).digest('hex'),
        'token.txt',
      ),
    ),
    'the rejected checkout remains available privately after its sidecar is reused',
  );
});
let commands = 0;
async function command(
  f: Fixture,
  driver: CodeWorkspaceDriver,
  sessionId: string,
  expectedHead: string,
  message = 'work',
): Promise<CodeCommitCommand> {
  const id = `cmd-${++commands}`;
  await f.dispatched(sessionId, id);
  return {
    id,
    projectId: f.admin.projectId,
    sessionId,
    actorId: f.admin.actorId,
    instanceId: f.unitId,
    expectedRevision: 0,
    runnerId: 'runner-1',
    hostRef: `launch-${sessionId}`,
    workspace: driver.get(`launch-${sessionId}`)!.snapshot!,
    expectedHead,
    message,
    createdAt: '2026-02-03T04:05:06.000Z',
  };
}

for (const objectFormat of ['sha1', 'sha256'] as const)
  test(`hosted ${objectFormat} Code checkout has independent Git metadata and its edits pass through Code capture`, async (t) => {
    const f = await writerFixture(t, 900, { objectFormat });
    await f.lease('ses_hosted');
    const m = machine(t, f, undefined, true, f.unitId);
    const driver = m.start();
    const launch = m.launch('ses_hosted');
    const handle = await driver.prepare(launch, m.session('ses_hosted'));
    assert.equal(
      handle.path,
      join(m.assignmentWorkspaceDirectory!, createHash('sha256').update(f.unitId).digest('hex')),
    );
    assert.ok(lstatSync(join(handle.path, '.git')).isDirectory());
    assert.equal(existsSync(join(handle.path, '.git/objects/info/alternates')), false);
    assert.equal(git(handle.path, ['rev-parse', '--git-common-dir']), '.git');
    assert.equal(git(handle.path, ['rev-parse', '--show-object-format']), objectFormat);
    assert.equal(git(handle.path, ['remote']), '');
    assert.equal(git(handle.path, ['rev-parse', 'HEAD']), f.root);
    await f.event('session.workspace_attached', 'ses_hosted');
    writeFileSync(join(handle.path, 'hosted.txt'), 'work from assignment\n');
    const first = await command(f, driver, 'ses_hosted', f.root);
    const receipt = await driver.checkpointCommit(launch, first);
    assert.equal((await f.unit()).canonicalHead, receipt.headOid);
    writeFileSync(join(handle.path, 'after.txt'), 'capture this too\n');
    // A killed agent's Git left HEAD and its branch locked; the session is confirmed stopped.
    const branch = git(handle.path, ['symbolic-ref', '-q', 'HEAD']) || 'refs/heads/left';
    const locks = ['HEAD.lock', `${branch}.lock`].map((name) => join(handle.path, '.git', name));
    for (const lock of locks) writeFileSync(lock, '');
    m.terminal.add(launch.id);
    const final = await driver.capture(launch);
    await f.event('session.closed', 'ses_hosted');
    f.end('ses_hosted');
    assert.equal((await f.unit()).canonicalHead, final?.headOid);
    assert.equal(git(handle.path, ['show', 'HEAD:after.txt']), 'capture this too');
    assert.deepEqual(
      locks.filter((lock) => existsSync(lock)),
      [],
    );
    await driver.close(launch);
    assert.deepEqual(
      readdirSync(join(handle.path, '.git')).filter((name) => name.startsWith('index-')),
      [],
    );
    f.reviewer('ses_hosted_review', receipt.headOid);
    const reviewLaunch = m.launch('ses_hosted_review');
    const review = await driver.prepare(reviewLaunch, m.session('ses_hosted_review'));
    assert.equal(review.snapshot?.headOid, receipt.headOid);
    assert.ok(lstatSync(join(review.path, '.git')).isDirectory());
    assert.equal(git(review.path, ['rev-parse', '--git-common-dir']), '.git');
    m.terminal.add(reviewLaunch.id);
    assert.equal((await driver.capture(reviewLaunch))?.headOid, receipt.headOid);
    await driver.close(reviewLaunch);
    // The work item keeps its one cwd: the review read it in place and it stays.
    assert.equal(review.path, handle.path);
    assert.ok(existsSync(review.path));
  });

test('a quarantined commit leaves the checkout as it was and never rides along in the next bundle', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_1');
  const m = machine(t, f);
  const driver = m.start();
  const { path } = await driver.prepare(m.launch('ses_1'), m.session('ses_1'));
  const key = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n';
  writeFileSync(join(path, 'key.pem'), key);
  const bad = await command(f, driver, 'ses_1', f.root);
  await assert.rejects(
    driver.checkpointCommit(m.launch('ses_1'), bad),
    failed('code_capture_quarantined'),
  );
  assert.deepEqual(driver.commitOutcome(bad.id), { error: 'code_capture_quarantined' });
  assert.equal(git(path, ['rev-parse', 'HEAD']), f.root);
  assert.equal(readFileSync(join(path, 'key.pem'), 'utf8'), key);
  const cache = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assert.equal(git(cache, ['for-each-ref', 'refs/merv/pending']), '');
  assert.equal((await f.unit()).canonicalHead, null);

  rmSync(join(path, 'key.pem'));
  writeFileSync(join(path, 'a.txt'), 'clean\n');
  const good = await command(f, driver, 'ses_1', f.root);
  const receipt = await driver.checkpointCommit(m.launch('ses_1'), good);
  assert.equal(receipt.parentOid, f.root);
  assert.equal((await f.unit()).canonicalHead, receipt.headOid);
});

test("an agent commit during admission is rescued: the receipt names Code's commit and the final capture carries the agent's files", async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_1');
  let path = '';
  let race = true;
  const m = machine(t, f, (inner) => ({
    ...inner,
    call: async (route, body) => {
      const answer = await inner.call(route, body);
      if (race && route.endsWith('/complete')) {
        race = false;
        // The agent, still running, commits on its own while Code admits; then the answer is lost.
        writeFileSync(join(path, 'agent.txt'), 'agent\n');
        const as = ['-c', 'user.name=a', '-c', 'user.email=a@a'];
        git(path, [...as, 'add', '-A']);
        git(path, [...as, 'commit', '-q', '-m', 'agent']);
        throw Object.assign(new Error('control_unavailable'), {
          code: 'control_unavailable',
          status: 0,
        });
      }
      return answer;
    },
  }));
  const driver = m.start();
  ({ path } = await driver.prepare(m.launch('ses_1'), m.session('ses_1')));
  await f.event('session.workspace_attached', 'ses_1');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  const work = await command(f, driver, 'ses_1', f.root);
  await assert.rejects(driver.checkpointCommit(m.launch('ses_1'), work), WorkspaceDeferred);
  const agent = git(path, ['rev-parse', 'HEAD']);
  // The retry learns Code admitted the journalled commit; the moved head is no conflict.
  const receipt = await driver.checkpointCommit(m.launch('ses_1'), work);
  assert.equal((await f.unit()).canonicalHead, receipt.headOid);
  assert.deepEqual(driver.commitOutcome(work.id), { receipt });
  assert.equal(git(path, ['rev-parse', 'HEAD']), receipt.headOid);
  assert.equal(git(path, ['for-each-ref', '--format=%(objectname)', 'refs/merv/rescued']), agent);
  // A command built on a head the checkout no longer has is still a conflict.
  const stale = await command(f, driver, 'ses_1', f.root);
  await assert.rejects(
    driver.checkpointCommit(m.launch('ses_1'), stale),
    failed('workspace_head_conflict'),
  );
  m.terminal.add('launch-ses_1');
  const result = await driver.capture(m.launch('ses_1'));
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  assert.equal(git(path, ['rev-parse', 'HEAD^']), receipt.headOid);
  assert.equal(git(path, ['show', `${result!.headOid}:agent.txt`]), 'agent');
  assert.equal((await f.unit()).canonicalHead, result!.headOid);
});

test('an interrupted upload continues where Code stands, and a final capture is replayed and never rebuilt', async (t) => {
  const f = await writerFixture(t);
  await f.open({ config: { partBytes: 1024 } });
  await f.lease('ses_1');
  let parts = 0;
  let cut = true;
  const sent: number[] = [];
  const unavailable = () =>
    Object.assign(new Error('control_unavailable'), { code: 'control_unavailable', status: 0 });
  const m = machine(t, f, (inner) => ({
    ...inner,
    putPart: async (id, offset, bytes) => {
      if (cut && ++parts === 3) throw unavailable();
      sent.push(offset);
      return await inner.putPart(id, offset, bytes);
    },
  }));
  let driver = m.start();
  const { path } = await driver.prepare(m.launch('ses_1'), m.session('ses_1'));
  await f.event('session.workspace_attached', 'ses_1');
  writeFileSync(join(path, 'blob.bin'), randomBytes(6000));
  const work = await command(f, driver, 'ses_1', f.root);
  await assert.rejects(
    driver.checkpointCommit(m.launch('ses_1'), work),
    (error: unknown) =>
      error instanceof WorkspaceDeferred && error.cause === 'transport_unavailable',
  );
  assert.equal(driver.commitOutcome(work.id), null, 'an outage is no outcome');
  assert.deepEqual(sent, [0, 1024]);
  // The runner restarts; the journal names the same commit and Code says where it stands.
  cut = false;
  driver.dispose();
  driver = m.start();
  assert.deepEqual(driver.pendingCommits('launch-ses_1'), [work]);
  const receipt = await driver.checkpointCommit(m.launch('ses_1'), work);
  assert.equal(sent[2], 2048, 'nothing Code already held was sent again');
  assert.equal((await f.unit()).canonicalHead, receipt.headOid);

  // The final capture: the first attempt dies after it journalled the commit, before Code
  // heard of it; the second dies after Code began it. Every retry hands over the same commit.
  writeFileSync(join(path, 'wip.txt'), 'left behind\n');
  m.terminal.add('launch-ses_1');
  driver.dispose();
  let finalizes = 0;
  let finalBegin: unknown;
  driver = m.start({
    call: async (route, body) => {
      if (route === 'finalize') finalBegin = body;
      if (route === 'finalize' && ++finalizes === 1) throw unavailable();
      const answer = await f.code.v2!.call(f.admin, route, body);
      if (route === 'finalize' && finalizes === 2) throw unavailable();
      return answer;
    },
    putPart: async (id, offset, bytes) =>
      await f.code.v2!.putPart(f.admin, id, offset, Buffer.from(bytes)),
    readPart: async (id, input) => await f.code.v2!.readPart!(f.admin, id, input),
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(driver.capture(m.launch('ses_1')), WorkspaceDeferred);
  assert.equal(driver.get('launch-ses_1')!.status, 'capturing');
  const captured = git(path, ['rev-parse', 'HEAD']);
  driver.dispose();
  driver = m.start();
  const result = await driver.capture(m.launch('ses_1'));
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  assert.equal(result!.headOid, captured);
  assert.equal(git(path, ['rev-list', '--count', `${receipt.headOid}..HEAD`]), '1');
  assert.equal((await f.unit()).canonicalHead, captured);
  assert.equal((await f.unit()).writerState, 'closed');
  // A begin whose answer was lost is replayed even when its own bytes filled the quota.
  await f.open({ config: { quotaBytes: await diskBytes(f.paths.directory) } });
  const replayed = (await f.code.v2!.call(f.admin, 'finalize', finalBegin)) as {
    operation: { status: string };
  };
  assert.equal(replayed.operation.status, 'completed');
});
