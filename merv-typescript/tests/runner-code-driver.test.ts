import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  sessionWorkspaceSchema,
  WorkspaceDeferred,
  type CodeCommitCommand,
  type WorkspaceHandle,
  type WorkspaceSession,
  type WorkspaceTransport,
} from '@merv/contracts';
import { CodeWorkspaceDriver, WorkspaceError } from '@merv/code/driver/index';
import { LocalLedger } from '@merv/runner/ledger';
import { RunnerWorkspaces } from '@merv/runner/workspaces';
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

test('one hosted work unit reuses its cwd across writer and review while Code freezes source', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_shared_1');
  let predecessor: WorkspaceHandle | undefined;
  const m = machine(t, f, undefined, true, f.unitId, () => predecessor);
  const driver = m.start();
  const first = m.launch('ses_shared_1');
  const writer = await driver.prepare(first, m.session('ses_shared_1'));
  assert.equal(
    writer.path,
    join(m.assignmentWorkspaceDirectory!, createHash('sha256').update(f.unitId).digest('hex')),
  );
  await f.event('session.workspace_attached', 'ses_shared_1');
  writeFileSync(join(writer.path, '.gitignore'), '.cache/\n');
  writeFileSync(join(writer.path, 'source.txt'), 'writer source\n');
  git(writer.path, ['config', '--local', 'merv.evil', 'reviewer-config']);
  mkdirSync(join(writer.path, '.cache'));
  writeFileSync(join(writer.path, '.cache/data.bin'), 'writer data');
  symlinkSync('/usr/bin/env', join(writer.path, '.cache/interpreter'));
  await f.event('session.closed', 'ses_shared_1');
  f.end('ses_shared_1');
  m.terminal.add(first.id);
  const submitted = await driver.capture(first);
  assert.ok(submitted);
  await driver.close(first);
  assert.ok(existsSync(writer.path));
  const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;
  if (linuxRoot) chownSync(writer.path, 12001, 12001);

  f.reviewer('ses_shared_review_1', submitted!.headOid);
  const reviewLaunch = m.launch('ses_shared_review_1');
  const review = await driver.prepare(reviewLaunch, m.session('ses_shared_review_1'));
  assert.equal(review.path, writer.path);
  assert.equal(review.snapshot!.headOid, submitted!.headOid);
  assert.equal(readFileSync(join(review.path, '.cache/data.bin'), 'utf8'), 'writer data');
  assert.equal(readlinkSync(join(review.path, '.cache/interpreter')), '/usr/bin/env');
  writeFileSync(join(review.path, 'source.txt'), 'reviewer edit\n');
  writeFileSync(join(review.path, '.cache/data.bin'), 'reviewer cache edit');
  writeFileSync(join(review.path, 'reviewer.tmp'), 'discard me');
  m.terminal.add(reviewLaunch.id);
  assert.equal((await driver.capture(reviewLaunch))!.headOid, submitted!.headOid);
  const reviewSql = new DatabaseSync(join(m.directory, 'ledger.sqlite'));
  reviewSql.exec(`CREATE TRIGGER interrupt_review_close BEFORE UPDATE OF status ON code_v2_workspaces
    WHEN NEW.status='closed' AND NEW.launch_id='launch-ses_shared_review_1'
    BEGIN SELECT RAISE(ABORT, 'interrupted before closed'); END`);
  await assert.rejects(driver.close(reviewLaunch), /interrupted before closed/);
  assert.equal(readFileSync(join(review.path, 'source.txt'), 'utf8'), 'writer source\n');
  reviewSql.exec('DROP TRIGGER interrupt_review_close');
  reviewSql.close();
  await driver.close(reviewLaunch);
  assert.ok(existsSync(review.path), 'review retain=false must not remove the shared path');
  if (linuxRoot)
    assert.deepEqual(
      [lstatSync(review.path).uid, lstatSync(review.path).gid],
      [12001, 12001],
      'review close restores the agent-owned writer checkout',
    );
  assert.equal(readFileSync(join(review.path, 'source.txt'), 'utf8'), 'writer source\n');
  assert.equal(existsSync(join(review.path, 'reviewer.tmp')), false);
  assert.equal((await f.unit()).canonicalHead, submitted!.headOid);

  // An execution review may send the same experiment through a new planning attempt.
  // Both scratch phases use this cwd before the next Code writer resumes.
  const ledger = new LocalLedger({
    directory: m.directory,
    binding: { baseUrl: 'http://127.0.0.1:7000', projectId: f.admin.projectId, sourceId: 'source' },
  });
  const scratch = new RunnerWorkspaces(
    ledger,
    undefined,
    m.assignmentWorkspaceDirectory,
    f.unitId,
    () => driver.get(reviewLaunch.id),
  );
  t.after(() => {
    scratch.dispose();
    ledger.close();
  });
  for (const [index, phase] of ['replan', 'redesign-review'].entries()) {
    const record = ledger.reserve({
      id: `scratch-${phase}`,
      sessionId: `session-${phase}`,
      deadline: Date.now() + 60_000,
    });
    const session = {
      id: record.sessionId,
      projectId: f.admin.projectId,
      instanceId: f.unitId,
      execution: {
        policy: { readOnly: index === 1, tools: [], workspace: { mode: 'none' } },
        references: {},
      },
    } as unknown as WorkspaceSession;
    const phaseWorkspace = await scratch.prepare(record, session as never);
    assert.equal(phaseWorkspace.path, writer.path);
    if (!index) {
      mkdirSync(join(writer.path, 'research'));
      writeFileSync(join(writer.path, 'research/replan.json'), '{"attempt":2}\n');
    } else
      assert.equal(
        readFileSync(join(writer.path, 'research/replan.json'), 'utf8'),
        '{"attempt":2}\n',
      );
    ledger.end(record.id, 'cancelled_before_spawn', 'reserved');
    assert.equal(await scratch.capture(record), undefined);
    await scratch.close(record);
    predecessor = scratch.get(record.id);
  }

  assert.equal((await f.lease('ses_shared_2')).generation, 2);
  const second = m.launch('ses_shared_2');
  // Simulate a crash after replacing the review view and clearing its private
  // writer sidecar, but before the new writer attachment becomes durable.
  const sqlLedger = new DatabaseSync(join(m.directory, 'ledger.sqlite'));
  sqlLedger.exec(`CREATE TRIGGER interrupt_shared_ready BEFORE UPDATE OF status ON code_v2_workspaces
    WHEN NEW.status='ready' AND NEW.launch_id='launch-ses_shared_2'
    BEGIN SELECT RAISE(ABORT, 'interrupted before ready'); END`);
  await assert.rejects(
    driver.prepare(second, m.session('ses_shared_2')),
    /interrupted before ready/,
  );
  sqlLedger.exec('DROP TRIGGER interrupt_shared_ready');
  sqlLedger.close();
  const next = await driver.prepare(second, m.session('ses_shared_2'));
  assert.equal(next.path, writer.path);
  assert.equal(readFileSync(join(next.path, 'source.txt'), 'utf8'), 'writer source\n');
  assert.equal(readFileSync(join(next.path, '.cache/data.bin'), 'utf8'), 'writer data');
  assert.equal(readFileSync(join(next.path, 'research/replan.json'), 'utf8'), '{"attempt":2}\n');
  assert.equal(readlinkSync(join(next.path, '.cache/interpreter')), '/usr/bin/env');
  assert.equal(existsSync(join(next.path, 'reviewer.tmp')), false);
  assert.equal(git(next.path, ['rev-parse', 'HEAD']), submitted!.headOid);
  assert.equal(
    readFileSync(join(next.path, '.git/config'), 'utf8').includes('reviewer-config'),
    false,
  );
  await f.event('session.workspace_attached', 'ses_shared_2');
  writeFileSync(join(next.path, 'second.txt'), 'writer two\n');
  await f.event('session.closed', 'ses_shared_2');
  f.end('ses_shared_2');
  m.terminal.add(second.id);
  const secondResult = await driver.capture(second);
  await driver.close(second);
  assert.ok(secondResult);

  f.reviewer('ses_shared_review_2', secondResult!.headOid);
  const reviewTwoLaunch = m.launch('ses_shared_review_2');
  const reviewTwo = await driver.prepare(reviewTwoLaunch, m.session('ses_shared_review_2'));
  assert.equal(reviewTwo.path, writer.path);
  assert.equal(readFileSync(join(reviewTwo.path, '.cache/data.bin'), 'utf8'), 'writer data');
  assert.equal(readFileSync(join(reviewTwo.path, 'second.txt'), 'utf8'), 'writer two\n');
  m.terminal.add(reviewTwoLaunch.id);
  assert.equal((await driver.capture(reviewTwoLaunch))!.headOid, secondResult!.headOid);
  await driver.close(reviewTwoLaunch);
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

test('a writer follows a closed Code review after the private writer view is restored', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_restore_writer');
  const m = machine(t, f, undefined, true, f.unitId);
  const driver = m.start();
  const first = m.launch('ses_restore_writer');
  const writer = await driver.prepare(first, m.session('ses_restore_writer'));
  await f.event('session.workspace_attached', 'ses_restore_writer');
  writeFileSync(join(writer.path, 'source.txt'), 'writer\n');
  await f.event('session.closed', 'ses_restore_writer');
  f.end('ses_restore_writer');
  m.terminal.add(first.id);
  const result = (await driver.capture(first))!;
  await driver.close(first);
  f.reviewer('ses_restore_review', result.headOid);
  const reviewLaunch = m.launch('ses_restore_review');
  const review = await driver.prepare(reviewLaunch, m.session('ses_restore_review'));
  writeFileSync(join(review.path, 'source.txt'), 'reviewer\n');
  m.terminal.add(reviewLaunch.id);
  await driver.capture(reviewLaunch);
  await driver.close(reviewLaunch);
  assert.equal(readFileSync(join(review.path, 'source.txt'), 'utf8'), 'writer\n');
  await f.lease('ses_restore_next');
  const next = await driver.prepare(m.launch('ses_restore_next'), m.session('ses_restore_next'));
  assert.equal(next.path, writer.path);
  assert.equal(readFileSync(join(next.path, 'source.txt'), 'utf8'), 'writer\n');
});

test('a closed scratch plan and scratch review hand their data to the first Code writer', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_after_plan');
  let predecessor: WorkspaceHandle | undefined;
  const m = machine(t, f, undefined, true, f.unitId, () => predecessor);
  const ledger = new LocalLedger({
    directory: m.directory,
    binding: { baseUrl: 'http://127.0.0.1:7000', projectId: f.admin.projectId, sourceId: 'source' },
  });
  const scratch = new RunnerWorkspaces(ledger, undefined, m.assignmentWorkspaceDirectory, f.unitId);
  t.after(() => {
    scratch.dispose();
    ledger.close();
  });
  let path = '';
  for (const [index, phase] of ['plan', 'design-review'].entries()) {
    const id = `scratch-${phase}`;
    const record = ledger.reserve({
      id,
      sessionId: `session-${phase}`,
      deadline: Date.now() + 60_000,
    });
    const session = {
      id: record.sessionId,
      projectId: f.admin.projectId,
      instanceId: f.unitId,
      execution: {
        policy: { readOnly: index === 1, tools: [], workspace: { mode: 'none' } },
        references: {},
      },
    } as unknown as WorkspaceSession;
    const handle = await scratch.prepare(record, session as never);
    path ||= handle.path;
    assert.equal(handle.path, path);
    if (!index) {
      mkdirSync(join(path, 'research'));
      writeFileSync(join(path, 'research/melodies.jsonl'), '{"melody":"CDE"}\n');
    } else
      assert.equal(
        readFileSync(join(path, 'research/melodies.jsonl'), 'utf8'),
        '{"melody":"CDE"}\n',
      );
    ledger.end(record.id, 'cancelled_before_spawn', 'reserved');
    assert.equal(await scratch.capture(record), undefined);
    await scratch.close(record);
    predecessor = scratch.get(record.id);
  }
  const launch = m.launch('ses_after_plan');
  const codeDriver = m.start();
  const closedScratch = predecessor!;
  predecessor = { ...closedScratch, path: m.directory };
  await assert.rejects(
    codeDriver.prepare(launch, m.session('ses_after_plan')),
    failed('workspace_foreign_checkout'),
  );
  predecessor = closedScratch;
  const code = await codeDriver.prepare(launch, m.session('ses_after_plan'));
  assert.equal(code.path, path);
  assert.equal(
    readFileSync(join(code.path, 'research/melodies.jsonl'), 'utf8'),
    '{"melody":"CDE"}\n',
  );
  assert.equal(readFileSync(join(code.path, 'README.md'), 'utf8'), 'root\n');
  assert.equal(git(code.path, ['rev-parse', '--show-toplevel']), code.path);
});

test('a replacement host that first reviews discards edits before writer or scratch reuse', async (t) => {
  const f = await writerFixture(t);
  f.reviewer('ses_first_review', f.root);
  let predecessor: WorkspaceHandle | undefined;
  const m = machine(t, f, undefined, true, f.unitId, () => predecessor);
  const driver = m.start();
  const reviewLaunch = m.launch('ses_first_review');
  const review = await driver.prepare(reviewLaunch, m.session('ses_first_review'));
  writeFileSync(join(review.path, 'README.md'), 'reviewer changed source\n');
  writeFileSync(join(review.path, 'reviewer.tmp'), 'discard');
  m.terminal.add(reviewLaunch.id);
  assert.equal((await driver.capture(reviewLaunch))!.headOid, f.root);
  await driver.close(reviewLaunch);
  assert.equal(readFileSync(join(review.path, 'README.md'), 'utf8'), 'root\n');
  assert.equal(existsSync(join(review.path, 'reviewer.tmp')), false);

  const ledger = new LocalLedger({
    directory: m.directory,
    binding: { baseUrl: 'http://127.0.0.1:7000', projectId: f.admin.projectId, sourceId: 'source' },
  });
  const scratch = new RunnerWorkspaces(
    ledger,
    undefined,
    m.assignmentWorkspaceDirectory,
    f.unitId,
    () => driver.get(reviewLaunch.id),
  );
  t.after(() => {
    scratch.dispose();
    ledger.close();
  });
  const record = ledger.reserve({
    id: 'scratch-after-first-review',
    sessionId: 'scratch-session',
    deadline: Date.now() + 60_000,
  });
  const session = {
    id: record.sessionId,
    projectId: f.admin.projectId,
    instanceId: f.unitId,
    execution: {
      policy: { readOnly: false, tools: [], workspace: { mode: 'none' } },
      references: {},
    },
  } as unknown as WorkspaceSession;
  const scratchHandle = await scratch.prepare(record, session as never);
  assert.equal(scratchHandle.path, review.path);
  assert.equal(readFileSync(join(scratchHandle.path, 'README.md'), 'utf8'), 'root\n');
  ledger.end(record.id, 'cancelled_before_spawn', 'reserved');
  await scratch.capture(record);
  await scratch.close(record);
  predecessor = scratch.get(record.id);
  await f.lease('ses_after_first_review');
  const writer = await driver.prepare(
    m.launch('ses_after_first_review'),
    m.session('ses_after_first_review'),
  );
  assert.equal(writer.path, review.path);
  assert.equal(readFileSync(join(writer.path, 'README.md'), 'utf8'), 'root\n');
  assert.equal(existsSync(join(writer.path, 'reviewer.tmp')), false);
});

test('a replacement host can write directly after its first local Code review', async (t) => {
  const f = await writerFixture(t);
  f.reviewer('ses_initial_review', f.root);
  const m = machine(t, f, undefined, true, f.unitId);
  const driver = m.start();
  const launch = m.launch('ses_initial_review');
  const review = await driver.prepare(launch, m.session('ses_initial_review'));
  writeFileSync(join(review.path, 'reviewer.tmp'), 'discard');
  m.terminal.add(launch.id);
  await driver.capture(launch);
  await driver.close(launch);
  await f.lease('ses_first_writer');
  const writer = await driver.prepare(m.launch('ses_first_writer'), m.session('ses_first_writer'));
  assert.equal(writer.path, review.path);
  assert.equal(writer.snapshot!.headOid, f.root);
  assert.equal(existsSync(join(writer.path, 'reviewer.tmp')), false);
});

test('a symlink at the private preservation slot is refused without touching its target', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_sidecar');
  const m = machine(t, f, undefined, true, f.unitId);
  const foreign = mkdtempSync(join(tmpdir(), 'merv-foreign-'));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  const slot = join(
    m.directory,
    'code-v2/preserved',
    createHash('sha256').update(f.unitId).digest('hex'),
  );
  const driver = m.start();
  mkdirSync(join(m.directory, 'code-v2/preserved'), { recursive: true });
  symlinkSync(foreign, slot);
  await assert.rejects(
    driver.prepare(m.launch('ses_sidecar'), m.session('ses_sidecar')),
    failed('workspace_foreign_checkout'),
  );
  assert.ok(lstatSync(slot).isSymbolicLink());
  assert.ok(existsSync(foreign));
});

test('special retained nodes cannot be copied into review and a retry keeps the writer sidecar', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_fifo_writer');
  const m = machine(t, f, undefined, true, f.unitId);
  const driver = m.start();
  const writerLaunch = m.launch('ses_fifo_writer');
  const writer = await driver.prepare(writerLaunch, m.session('ses_fifo_writer'));
  await f.event('session.workspace_attached', 'ses_fifo_writer');
  writeFileSync(join(writer.path, '.gitignore'), '.cache/\n');
  mkdirSync(join(writer.path, '.cache'));
  execFileSync('mkfifo', [join(writer.path, '.cache/pipe')]);
  await f.event('session.closed', 'ses_fifo_writer');
  f.end('ses_fifo_writer');
  m.terminal.add(writerLaunch.id);
  const result = await driver.capture(writerLaunch);
  await driver.close(writerLaunch);
  f.reviewer('ses_fifo_review', result!.headOid);
  const reviewLaunch = m.launch('ses_fifo_review');
  await assert.rejects(
    driver.prepare(reviewLaunch, m.session('ses_fifo_review')),
    failed('workspace_foreign_path'),
  );
  const sidecar = join(
    m.directory,
    'code-v2/preserved',
    createHash('sha256').update(f.unitId).digest('hex'),
  );
  assert.ok(lstatSync(join(sidecar, '.cache/pipe')).isFIFO());
  rmSync(join(sidecar, '.cache/pipe'));
  const review = await driver.prepare(reviewLaunch, m.session('ses_fifo_review'));
  assert.equal(review.path, writer.path);
  assert.equal(review.snapshot!.headOid, result!.headOid);
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
  await f.event('session.closed', 'ses_refused');
  f.end('ses_refused');
  m.terminal.add(writerLaunch.id);
  assert.equal((await driver.capture(writerLaunch))!.headOid, f.root);
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
  assert.ok(existsSync(join(retry.path, 'token.txt')), 'the writer can recover an unaccepted file');
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

test('a checkout is exactly the head Code names, its cache knows no remote, and HEAD moves only once Code admitted the commit', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_1');
  let beforeAck: string | undefined;
  let path = '';
  const m = machine(t, f, (inner) => ({
    ...inner,
    call: async (route, body) => {
      if (route.endsWith('/complete')) beforeAck = git(path, ['rev-parse', 'HEAD']);
      return await inner.call(route, body);
    },
  }));
  const driver = m.start();
  const handle = await driver.prepare(m.launch('ses_1'), m.session('ses_1'));
  path = handle.path;
  assert.equal(handle.status, 'ready');
  assert.ok(sessionWorkspaceSchema.safeParse(handle.snapshot).success);
  assert.equal(handle.snapshot!.headOid, f.root);
  assert.equal(handle.snapshot!.branch, `merv/work/${f.unitId}`);
  assert.equal(git(path, ['rev-parse', 'HEAD']), f.root);
  assert.equal(git(path, ['symbolic-ref', '--short', 'HEAD']), `merv/work/${f.unitId}`);
  const cache = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assert.equal(git(cache, ['remote']), '');
  assert.equal(git(cache, ['for-each-ref', 'refs/merv/central']), '');
  assert.deepEqual(await driver.prepare(m.launch('ses_1'), m.session('ses_1')), handle);

  await f.event('session.workspace_attached', 'ses_1');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  const first = await command(f, driver, 'ses_1', f.root);
  const receipt = await driver.checkpointCommit(m.launch('ses_1'), first);
  assert.equal(beforeAck, f.root, 'the branch had not moved while Code was still deciding');
  assert.equal(git(path, ['rev-parse', 'HEAD']), receipt.headOid);
  assert.equal(git(path, ['status', '--porcelain']), '');
  assert.equal((await f.unit()).canonicalHead, receipt.headOid);
  assert.deepEqual(driver.commitOutcome(first.id), { receipt });
  assert.deepEqual(await driver.checkpointCommit(m.launch('ses_1'), first), receipt);
  // The same command on the runner's own driver yields the same commit: one identity, one clock.
  assert.equal(
    git(path, ['log', '-1', '--format=%an <%ae> %at %s']),
    'Merv Agent Runner <merv@localhost> 1770091506 work',
  );
  driver.acknowledgeCommit(first.id);
  assert.deepEqual(driver.pendingCommits('launch-ses_1'), []);

  // Nothing to commit is still a command that succeeds, and moves nothing.
  const empty = await command(f, driver, 'ses_1', receipt.headOid);
  assert.equal((await driver.checkpointCommit(m.launch('ses_1'), empty)).headOid, receipt.headOid);

  // The session ends with uncommitted work: the final capture carries it to Code.
  writeFileSync(join(path, 'b.txt'), 'trailing\n');
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  await assert.rejects(
    driver.capture(m.launch('ses_1')),
    failed('workspace_process_stop_unconfirmed'),
  );
  m.terminal.add('launch-ses_1');
  const result = await driver.capture(m.launch('ses_1'));
  assert.ok(result && result.headOid !== receipt.headOid);
  assert.equal((await f.unit()).canonicalHead, result.headOid);
  assert.equal((await f.unit()).writerState, 'closed');
  assert.deepEqual(await driver.capture(m.launch('ses_1')), result);
  await driver.close(m.launch('ses_1'));
  assert.ok(existsSync(path), 'a writer’s checkout is kept for the next generation here');

  // Review on another machine, at exactly the delivered commit and nothing after it.
  f.reviewer('ses_r', receipt.headOid);
  const other = machine(t, f);
  const reviewer = other.start();
  const review = await reviewer.prepare(other.launch('ses_r'), other.session('ses_r'));
  assert.equal(review.snapshot!.headOid, receipt.headOid);
  assert.equal(review.snapshot!.baseOid, receipt.headOid);
  assert.equal(review.snapshot!.branch, null);
  assert.ok(!existsSync(join(review.path, 'b.txt')));
  writeFileSync(join(review.path, 'scratch.log'), 'untracked scratch is tolerated\n');
  other.terminal.add('launch-ses_r');
  assert.equal((await reviewer.capture(other.launch('ses_r')))!.headOid, receipt.headOid);
  await reviewer.close(other.launch('ses_r'));
  assert.ok(!existsSync(review.path), 'a reviewer keeps nothing');

  // Resume on that other machine: generation 2 starts from the head that includes the WIP.
  await f.lease('ses_2');
  const resumed = await reviewer.prepare(other.launch('ses_2'), other.session('ses_2'));
  assert.equal(resumed.snapshot!.headOid, result.headOid);
  assert.equal(resumed.snapshot!.baseOid, f.root);
  assert.equal(readFileSync(join(resumed.path, 'b.txt'), 'utf8'), 'trailing\n');

  // A reviewer that changes what it judges is reported as attached, and closes.
  f.reviewer('ses_q', receipt.headOid);
  const judged = await reviewer.prepare(other.launch('ses_q'), other.session('ses_q'));
  writeFileSync(join(judged.path, 'a.txt'), 'edited\n');
  git(judged.path, ['switch', '--quiet', '-c', 'elsewhere']);
  other.terminal.add('launch-ses_q');
  assert.equal((await reviewer.capture(other.launch('ses_q')))!.headOid, receipt.headOid);
  await reviewer.close(other.launch('ses_q'));
});

test('hosted Code checkout has independent Git metadata and its edits pass through Code capture', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_hosted');
  const m = machine(t, f, undefined, true);
  const driver = m.start();
  const launch = m.launch('ses_hosted');
  const handle = await driver.prepare(launch, m.session('ses_hosted'));
  assert.equal(
    handle.path,
    join(m.assignmentWorkspaceDirectory!, createHash('sha256').update(launch.id).digest('hex')),
  );
  assert.ok(lstatSync(join(handle.path, '.git')).isDirectory());
  assert.equal(existsSync(join(handle.path, '.git/objects/info/alternates')), false);
  assert.equal(git(handle.path, ['rev-parse', '--git-common-dir']), '.git');
  assert.equal(git(handle.path, ['remote']), '');
  assert.equal(git(handle.path, ['rev-parse', 'HEAD']), f.root);
  await f.event('session.workspace_attached', 'ses_hosted');
  writeFileSync(join(handle.path, 'hosted.txt'), 'work from assignment\n');
  const first = await command(f, driver, 'ses_hosted', f.root);
  const receipt = await driver.checkpointCommit(launch, first);
  assert.equal((await f.unit()).canonicalHead, receipt.headOid);
  writeFileSync(join(handle.path, 'after.txt'), 'capture this too\n');
  await f.event('session.closed', 'ses_hosted');
  f.end('ses_hosted');
  m.terminal.add(launch.id);
  const final = await driver.capture(launch);
  assert.equal((await f.unit()).canonicalHead, final?.headOid);
  assert.equal(git(handle.path, ['show', 'HEAD:after.txt']), 'capture this too');
  await driver.close(launch);
  f.reviewer('ses_hosted_review', receipt.headOid);
  const reviewLaunch = m.launch('ses_hosted_review');
  const review = await driver.prepare(reviewLaunch, m.session('ses_hosted_review'));
  assert.equal(review.snapshot?.headOid, receipt.headOid);
  assert.ok(lstatSync(join(review.path, '.git')).isDirectory());
  assert.equal(git(review.path, ['rev-parse', '--git-common-dir']), '.git');
  m.terminal.add(reviewLaunch.id);
  assert.equal((await driver.capture(reviewLaunch))?.headOid, receipt.headOid);
  await driver.close(reviewLaunch);
  assert.equal(existsSync(review.path), false);
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
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  m.terminal.add('launch-ses_1');
  driver.dispose();
  let finalizes = 0;
  driver = m.start({
    call: async (route, body) => {
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
  assert.equal(result!.headOid, captured);
  assert.equal(git(path, ['rev-list', '--count', `${receipt.headOid}..HEAD`]), '1');
  assert.equal((await f.unit()).canonicalHead, captured);
  assert.equal((await f.unit()).writerState, 'closed');
});

test('a final capture Code quarantines reports the last admitted head, and what was refused stays on the machine', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_1');
  const m = machine(t, f);
  const driver = m.start();
  const { path } = await driver.prepare(m.launch('ses_1'), m.session('ses_1'));
  await f.event('session.workspace_attached', 'ses_1');
  writeFileSync(join(path, 'token.txt'), `ghp_${'a'.repeat(36)}\n`);
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  m.terminal.add('launch-ses_1');
  const result = await driver.capture(m.launch('ses_1'));
  assert.equal(result!.headOid, f.root);
  assert.notEqual(git(path, ['rev-parse', 'HEAD']), f.root);
  const unit = await f.unit();
  assert.equal(unit.writerState, 'recovery_required');
  assert.ok(unit.quarantine);
});

test('a final capture Code refuses to read ends the capture instead of being sent forever', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_1');
  // A bundle larger than one transfer may be is refused at the schema, before Code looks at
  // any state, and every replay sends the identical bytes. The capture must end at the last
  // admitted head and give the launch back, not ask again for as long as the runner lives.
  const m = machine(t, f, (inner) => ({
    ...inner,
    call: async (route, body) => {
      if (route === 'finalize')
        throw Object.assign(new Error('bundle bytes: too large'), {
          code: 'invalid_code_input',
          status: 400,
        });
      return await inner.call(route, body);
    },
  }));
  const driver = m.start();
  const { path } = await driver.prepare(m.launch('ses_1'), m.session('ses_1'));
  await f.event('session.workspace_attached', 'ses_1');
  writeFileSync(join(path, 'huge.bin'), 'more than may be sent\n');
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  m.terminal.add('launch-ses_1');
  const result = await driver.capture(m.launch('ses_1'));
  assert.equal(result!.headOid, f.root);
  assert.equal(driver.get('launch-ses_1')!.status, 'captured');
  await driver.close(m.launch('ses_1'));
  assert.equal(driver.get('launch-ses_1')!.status, 'closed');
});

test('a checkout Code would never keep ends its generation at the last admitted commit', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_1');
  const m = machine(t, f);
  const driver = m.start();
  const { path } = await driver.prepare(m.launch('ses_1'), m.session('ses_1'));
  await f.event('session.workspace_attached', 'ses_1');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  const work = await command(f, driver, 'ses_1', f.root);
  const receipt = await driver.checkpointCommit(m.launch('ses_1'), work);
  // The session leaves a file larger than any repository of Code's keeps. No capture can be
  // built from this checkout, now or on any later attempt, so asking for one again is asking
  // forever: the launch would never be given back and the unit would wait for a machine that
  // can no longer answer. The generation is handed over at the commit Code already admitted.
  const huge = join(path, 'huge.bin');
  writeFileSync(huge, '');
  truncateSync(huge, 51 * 1024 * 1024);
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  m.terminal.add('launch-ses_1');
  const result = await driver.capture(m.launch('ses_1'));
  assert.equal(result!.headOid, receipt.headOid);
  assert.equal(driver.get('launch-ses_1')!.status, 'captured');
  assert.equal((await f.unit()).canonicalHead, receipt.headOid);
  assert.equal((await f.unit()).writerState, 'closed');
  await driver.close(m.launch('ses_1'));
  assert.equal(driver.get('launch-ses_1')!.status, 'closed');
  assert.ok(existsSync(huge), 'what Code cannot take stays on the machine');
  // The machine keeps why it handed over nothing, as it does for a refused commit command.
  const db = new DatabaseSync(join(m.directory, 'ledger.sqlite'));
  try {
    const final = db.prepare("SELECT error FROM code_v2_transfers WHERE kind='final'").get() as {
      error: string;
    };
    assert.equal(final.error, 'workspace_file_too_large');
  } finally {
    db.close();
  }
  // The unit's checkout on this machine is the next generation's again, and preparing it
  // takes away what this one left: a retained checkout is put back on the head Code names
  // and cleaned, so the file Code refused is not handed to a generation that would be
  // refused for it in turn. The refusal ends one generation, never every later one.
  assert.equal((await f.lease('ses_2')).generation, 2);
  assert.equal((await driver.prepare(m.launch('ses_2'), m.session('ses_2'))).path, path);
  assert.equal(existsSync(huge), false, 'what Code refused is not the next generation’s');
  await f.event('session.workspace_attached', 'ses_2');
  writeFileSync(join(path, 'b.txt'), 'two\n');
  const next = await command(f, driver, 'ses_2', receipt.headOid);
  const admitted = await driver.checkpointCommit(m.launch('ses_2'), next);
  assert.equal((await f.unit()).canonicalHead, admitted.headOid);
});

test('an export Code no longer holds defers the launch rather than failing it', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_1');
  // A cut export lives on the server and can go while a machine is reading it — it expired,
  // or Code was restarted. That is the server's business, not a fault of this launch, and the
  // machine simply asks for the download again.
  const m = machine(t, f, (inner) => ({
    ...inner,
    readPart: async () => {
      throw Object.assign(new Error('no such export'), {
        code: 'code_export_not_found',
        status: 404,
      });
    },
  }));
  const driver = m.start();
  await assert.rejects(
    driver.prepare(m.launch('ses_1'), m.session('ses_1')),
    (error: unknown) => error instanceof WorkspaceDeferred && error.cause === 'store_busy',
  );
  assert.equal(driver.get('launch-ses_1'), undefined);
  assert.equal((await f.unit()).writerState, 'reserved');
});

test('a session that never attached hands over nothing, and its generation simply closes', async (t) => {
  const f = await writerFixture(t);
  await f.lease('ses_1');
  // The download fails after Code was asked what to prepare.
  const m = machine(t, f, (inner) => ({
    ...inner,
    readPart: async () => {
      throw Object.assign(new Error('gone'), { code: 'code_store_unavailable', status: 503 });
    },
  }));
  const driver = m.start();
  await assert.rejects(
    driver.prepare(m.launch('ses_1'), m.session('ses_1')),
    (error: unknown) => error instanceof WorkspaceDeferred && error.cause === 'store_busy',
  );
  assert.equal(driver.get('launch-ses_1'), undefined);
  assert.equal((await f.unit()).writerState, 'reserved', 'asking Code changed nothing');
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  assert.equal((await f.unit()).writerState, 'closed');
  assert.equal((await f.lease('ses_2')).generation, 2);
});

test('the driver keeps its own tables beside an existing ledger and leaves the runner’s untouched', async (t) => {
  const f = await writerFixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'merv-drv-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binding = {
    baseUrl: 'http://127.0.0.1:1',
    projectId: f.admin.projectId,
    sourceId: 'a'.repeat(64),
  };
  let ledger = new LocalLedger({ directory, binding });
  new RunnerWorkspaces(ledger).dispose();
  const schema = () => {
    const db = new DatabaseSync(ledger.path);
    try {
      return db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE tbl_name NOT LIKE 'code_v2_%' ORDER BY name",
        )
        .all();
    } finally {
      db.close();
    }
  };
  const before = schema();
  const driver = new CodeWorkspaceDriver(
    { directory: ledger.directory, path: ledger.path, terminal: () => false },
    { call: async () => ({}), putPart: async () => ({}), readPart: async () => Buffer.alloc(0) },
  );
  assert.equal(driver.get('launch-none'), undefined);
  driver.dispose();
  assert.deepEqual(schema(), before);
  ledger.close();
  ledger = new LocalLedger({ directory, binding });
  new RunnerWorkspaces(ledger).dispose();
  ledger.close();
  assert.ok(WorkspaceError);
});
