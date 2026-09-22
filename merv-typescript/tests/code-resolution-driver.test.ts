import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodeCommitCommand, Transaction, WorkspaceSession } from '@merv/contracts';
import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import { CodeRepositories } from '@merv/code/store/repository';
import { MERGE_SETTINGS } from '../packages/code/src/merge-settings.js';
import { baseKey } from '../packages/code/src/base-plan.js';
import { pendingMerge, pinMerge, verifyResolution } from '../packages/code/src/pending-merge.js';
import { backends, optional, git, type Backend } from './fixtures/code-store.js';
import { writerFixture } from './fixtures/code-writers.js';

async function fixture(t: TestContext, backend: Backend) {
  // The writer lock is covered by the repository suite. Everything after that lock is real.
  t.mock.method(
    CodeRepositories.prototype as unknown as { acquire(): Promise<void> },
    'acquire',
    async () => {},
  );
  const f = await writerFixture(t, backend);
  const left = f.source.commit({ 'README.md': 'left\n' });
  assert.equal((await f.deliver(f.source.bundle(left, [f.root]))).status, 'completed');
  f.source.git('checkout', '--detach', f.root);
  const right = f.source.commit({ 'README.md': 'right\n' });
  assert.equal((await f.deliver(f.source.bundle(right, [f.root]))).status, 'completed');
  await f.state.transaction(async (tx) => {
    await tx.run(
      'UPDATE code_projects SET main_json=? WHERE project_id=?',
      JSON.stringify({ oid: left, stored: true, operationId: 'fixture' }),
      f.admin.projectId,
    );
    await pinMerge(tx, f.admin.projectId, f.unitId, baseKey([left, right]), left, right);
  });
  const inside = new AsyncLocalStorage<boolean>();
  const transaction = f.state.transaction.bind(f.state);
  t.mock.method(f.state, 'transaction', (fn: (tx: Transaction) => Promise<unknown>) =>
    transaction((tx) => inside.run(true, () => fn(tx))),
  );
  // Git is invoked through one ServerGit per repository; check its run seam across admission.
  const repositories = (f.code as unknown as { store: { repositories: CodeRepositories } }).store
    .repositories;
  const gitRun = repositories.git.run.bind(repositories.git);
  t.mock.method(repositories.git, 'run', (...args: Parameters<typeof gitRun>) => {
    assert.notEqual(inside.getStore(), true, 'Git cannot run in a database transaction');
    return gitRun(...args);
  });
  let sequence = 0;
  const machine = () => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-merge-machine-'));
    const stopped = new Set<string>();
    const driver = new CodeWorkspaceDriver(
      { directory, path: join(directory, 'ledger.sqlite'), terminal: (id) => stopped.has(id) },
      {
        call: (route, body) => f.code.v2!.call(f.admin, route, body),
        putPart: (id, offset, bytes) => f.code.v2!.putPart(f.admin, id, offset, Buffer.from(bytes)),
        readPart: (id, input) => f.code.v2!.readPart!(f.admin, id, input),
      },
      { pollMs: 10 },
    );
    t.after(() => {
      driver.dispose();
      rmSync(directory, { recursive: true, force: true });
    });
    const launch = (sessionId: string) => ({
      id: `launch-${sessionId}`,
      sessionId,
      runDirectory: directory,
    });
    return {
      driver,
      stopped,
      launch,
      prepare: (sessionId: string) =>
        driver.prepare(launch(sessionId), f.session(sessionId) as unknown as WorkspaceSession),
      async command(sessionId: string, expectedHead: string, merge?: 'start' | 'complete') {
        const id = `merge-command-${++sequence}`;
        await f.dispatched(sessionId, id);
        const command: CodeCommitCommand = {
          id,
          projectId: f.admin.projectId,
          sessionId,
          actorId: f.admin.actorId,
          instanceId: f.unitId,
          expectedRevision: 0,
          runnerId: 'runner-1',
          hostRef: launch(sessionId).id,
          workspace: driver.get(launch(sessionId).id)!.snapshot!,
          expectedHead,
          message: 'Resolve the input conflict',
          createdAt: '2026-09-21T00:00:00.000Z',
          ...(merge ? { merge } : {}),
        };
        return { command, receipt: await driver.checkpointCommit(launch(sessionId), command) };
      },
    };
  };
  return { ...f, left, right, machine, repositories };
}

for (const backend of backends) {
  test(
    `${backend}: pending second parent survives a handoff and the first merge joins the saved checkpoint exactly`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.lease('first');
      const first = f.machine();
      const work = await first.prepare('first');
      assert.equal(work.snapshot!.pendingMerge!.secondParent, f.right);
      await f.event('session.workspace_attached', 'first');
      git(work.path, ['config', 'merge.conflictStyle', 'diff3']);
      git(work.path, ['config', 'merge.renames', 'false']);
      const planned = await f.repositories.git.run(
        [...MERGE_SETTINGS, 'merge-tree', '--write-tree', f.left, f.right],
        { env: f.repositories.environment(f.admin.projectId) },
      );
      assert.equal(planned.code, 1);
      const started = await first.command('first', f.left, 'start');
      assert.equal(git(work.path, ['write-tree']), planned.stdout.toString('utf8').split('\n')[0]);
      assert.equal(started.receipt.headOid, f.left);
      assert.match(readFileSync(join(work.path, 'README.md'), 'utf8'), /<<<<<<< /);
      assert.deepEqual(
        await first.driver.checkpointCommit(first.launch('first'), started.command),
        started.receipt,
      );
      writeFileSync(join(work.path, 'README.md'), 'partial resolution retained\n');
      first.stopped.add('launch-first');
      f.end('first');
      await f.event('session.released', 'first');
      const captured = (await first.driver.capture(first.launch('first')))!;
      const wip = captured.headOid;
      assert.equal(git(work.path, ['show', '-s', '--format=%P', wip]), f.left);
      assert.equal(captured.pendingMerge!.firstMerge, null);
      await first.driver.close(first.launch('first'));
      await f.lease('second');
      const second = f.machine();
      const resumed = await second.prepare('second');
      assert.equal(resumed.snapshot!.headOid, wip);
      assert.equal(resumed.snapshot!.pendingMerge!.checkpoint, wip);
      assert.equal(resumed.snapshot!.pendingMerge!.secondParent, f.right);
      assert.equal(
        readFileSync(join(resumed.path, 'README.md'), 'utf8'),
        'partial resolution retained\n',
      );
      await f.event('session.workspace_attached', 'second');
      // No tree change: completing still creates the required merge commit.
      const completed = await second.command('second', wip, 'complete');
      assert.notEqual(completed.receipt.headOid, wip);
      assert.equal(completed.receipt.treeOid, captured.treeOid);
      assert.equal(
        git(resumed.path, ['show', '-s', '--format=%P', completed.receipt.headOid]),
        `${wip} ${f.right}`,
      );
      const stored = await f.state.read((sql) => pendingMerge(sql, f.admin.projectId, f.unitId));
      assert.equal(stored!.firstMerge, completed.receipt.headOid);
      assert.equal(stored!.checkpoint, completed.receipt.headOid);
      writeFileSync(join(resumed.path, 'README.md'), 'corrected after independent review\n');
      const corrected = await second.command('second', completed.receipt.headOid);
      assert.equal(
        git(resumed.path, ['show', '-s', '--format=%P', corrected.receipt.headOid]),
        completed.receipt.headOid,
      );
      assert.deepEqual(
        await verifyResolution(
          f.repositories.git,
          f.repositories.environment(f.admin.projectId),
          f.left,
          f.right,
          corrected.receipt.headOid,
        ),
        { firstMerge: completed.receipt.headOid, error: null },
      );
      second.stopped.add('launch-second');
      f.end('second');
      await f.event('session.released', 'second');
      const final = (await second.driver.capture(second.launch('second')))!;
      assert.equal(final.pendingMerge!.firstMerge, completed.receipt.headOid);
      assert.ok(f.refs().some((ref) => ref.includes('-second ')));
      await f.repositories.sweep(async () => false, Date.now() + 3_600_000);
      assert.ok(!f.refs().some((ref) => ref.startsWith('refs/merv/exports/')));
      // A later publication round keeps the same branch, but freezes another pair of inputs.
      const newerMain = f.source.commit({ 'new-main.txt': 'Another publication advanced main.\n' });
      await f.deliver(f.source.bundle(newerMain, [f.right]));
      const nextPlan = baseKey([corrected.receipt.headOid, newerMain]);
      await f.state.transaction((tx) =>
        pinMerge(
          tx,
          f.admin.projectId,
          f.unitId,
          nextPlan,
          corrected.receipt.headOid,
          newerMain,
          1,
        ),
      );
      await f.lease('third');
      const third = f.machine();
      const thirdWork = await third.prepare('third');
      await f.event('session.workspace_attached', 'third');
      assert.equal(thirdWork.snapshot!.branch, resumed.snapshot!.branch);
      assert.equal(thirdWork.snapshot!.pendingMerge!.plan, nextPlan);
      await third.command('third', corrected.receipt.headOid, 'start');
      const next = await third.command('third', corrected.receipt.headOid, 'complete');
      assert.equal(
        git(thirdWork.path, ['show', '-s', '--format=%P', next.receipt.headOid]),
        `${corrected.receipt.headOid} ${newerMain}`,
      );
      const rounds = await f.state.read((sql) =>
        sql.all<{ first_merge: string; right_oid: string }>(
          'SELECT first_merge,right_oid FROM code_pending_merges WHERE unit_id=? ORDER BY round',
          f.unitId,
        ),
      );
      assert.equal(rounds.length, 2);
      assert.deepEqual(
        { ...rounds[0] },
        { first_merge: completed.receipt.headOid, right_oid: f.right },
      );
      assert.deepEqual(
        { ...rounds[1] },
        { first_merge: next.receipt.headOid, right_oid: newerMain },
      );
      await assert.rejects(
        f.state.transaction((tx) =>
          tx.run(
            'UPDATE code_pending_merges SET head_oid=? WHERE project_id=? AND unit_id=? AND round=0',
            newerMain,
            f.admin.projectId,
            f.unitId,
          ),
        ),
        backend === 'sqlite' ? /frozen/ : { code: /^state_/ },
      );
    },
  );

  test(
    `${backend}: start requires a clean checkout and admission refuses the wrong second parent`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.lease('dirty');
      const machine = f.machine();
      const work = await machine.prepare('dirty');
      await f.event('session.workspace_attached', 'dirty');
      writeFileSync(join(work.path, 'untracked.txt'), 'keep my work');
      await assert.rejects(machine.command('dirty', f.left, 'start'), {
        code: 'workspace_merge_dirty',
      });
      assert.equal(readFileSync(join(work.path, 'untracked.txt'), 'utf8'), 'keep my work');
      const tree = f.source.git('rev-parse', `${f.left}^{tree}`);
      const wrong = f.source.git(
        'commit-tree',
        tree,
        '-p',
        f.left,
        '-p',
        f.root,
        '-m',
        'Wrong parent',
      );
      const refused = await f.upload(
        'checkpoint',
        'dirty',
        1,
        f.left,
        f.source.bundle(wrong, [f.left]),
      );
      assert.equal(refused.status, 'failed');
      assert.equal(refused.error, 'code_resolution_parents');
      assert.equal((await f.unit()).canonicalHead, null);
      assert.equal(
        (await f.state.read((sql) => pendingMerge(sql, f.admin.projectId, f.unitId)))!.firstMerge,
        null,
      );
    },
  );
}
