import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  sessionWorkspaceSchema,
  WorkspaceDeferred,
  type CodeCommitCommand,
  type WorkspaceSession,
  type WorkspaceTransport,
} from '@merv/contracts';
import { CodeWorkspaceDriver, WorkspaceError } from '@merv/code/driver/index';
import { LocalLedger } from '@merv/runner/ledger';
import { GitWorkspaceManager } from '@merv/runner/workspaces';
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
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-drv-'));
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
    terminal,
    /** The driver as a newly started runner would construct it, on the same ledger. */
    start(transport = wrap ? wrap(direct) : direct) {
      const driver = new CodeWorkspaceDriver(
        {
          directory,
          path: join(directory, 'ledger.sqlite'),
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
  const f = await writerFixture(t, 'sqlite');
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

  // A reviewer that changes what it judges is refused.
  f.reviewer('ses_q', receipt.headOid);
  const judged = await reviewer.prepare(other.launch('ses_q'), other.session('ses_q'));
  writeFileSync(join(judged.path, 'a.txt'), 'edited\n');
  other.terminal.add('launch-ses_q');
  await assert.rejects(reviewer.capture(other.launch('ses_q')), failed('workspace_readonly_dirty'));
});

test('a quarantined commit leaves the checkout as it was and never rides along in the next bundle', async (t) => {
  const f = await writerFixture(t, 'sqlite');
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
  const f = await writerFixture(t, 'sqlite');
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
  const f = await writerFixture(t, 'sqlite');
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

test('a session that never attached hands over nothing, and its generation simply closes', async (t) => {
  const f = await writerFixture(t, 'sqlite');
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
  const f = await writerFixture(t, 'sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'merv-drv-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binding = {
    baseUrl: 'http://127.0.0.1:1',
    projectId: f.admin.projectId,
    sourceId: 'a'.repeat(64),
  };
  let ledger = new LocalLedger({ directory, binding });
  new GitWorkspaceManager(ledger).dispose();
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
  new GitWorkspaceManager(ledger).dispose();
  ledger.close();
  assert.ok(WorkspaceError);
});
