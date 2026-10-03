import { CodeService as CoreCodeService } from '@merv/code/service';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { join } from 'node:path';
import { createService } from '@merv/contracts';
import type { CodeUnit } from '@merv/contracts';
import type { CodeUnitService } from '../packages/code-work/src/units.js';
import type { CodeRepositories } from '@merv/code/store/repository';
import { CodeService } from '@merv/code-work/service';
import { resolutionFixture } from './fixtures/resolution.js';
import { gitSource } from './fixtures/code-store.js';

async function fixture(t: TestContext) {
  const f = await resolutionFixture(t);
  const source = gitSource(t);
  const remoteHead = source.commit({ 'remote.txt': 'Existing remote work' });
  const core = await createService(
    new CoreCodeService(f.state, f.scope, {
      repositories: {
        root: join(f.directory, 'code'),
        quotaBytes: 10 * 1024 ** 3,
        reservedFreeBytes: 1,
      },
    }),
  );
  const code = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.workflows, core, {
      config: { settleMs: 60000 },
      remote: {
        read: async (_caller, use) =>
          use({
            url: source.repository,
            protocol: 'file',
            repository: { id: 42, fullName: 'team/research' },
            env: {},
          }),
      },
    }),
  );
  await f.state.transaction((tx) => code.ensureRepository(f.admin, tx));
  await (code as unknown as { store: { maintain(): Promise<void> } }).store.maintain();
  const release = f.tasks.bindCode(code);
  f.beforeClose.push(async () => {
    release();
    await code.close();
    await core.close();
  });
  let observedHead = remoteHead;
  t.mock.method(code.github, 'status', async () => ({
    revision: 1,
    repository: { id: 42, fullName: 'team/research' },
    baseBranch: 'main',
    automation: 'write',
  }));
  t.mock.method(code.github, 'branches', async () => [{ name: 'main', sha: observedHead }]);
  t.mock.method(code.github, 'assertBinding', async () => {});
  const initial = (await code.status(f.admin)).project!;
  const input = {
    expectedRevision: 1,
    baseBranch: 'main',
    headOid: remoteHead,
    expectedMainOid: initial.main.oid,
    requestId: 'connect',
  };
  return {
    ...f,
    code,
    source,
    remoteHead,
    initial,
    input,
    moveObservedHead: (head: string) => {
      observedHead = head;
    },
  };
}

test('connecting unrelated GitHub history retains Merv main and creates exactly one review task', async (t) => {
  const f = await fixture(t);
  const first = await f.code.prepareRepository(f.admin, f.input);
  assert.equal(first.state, 'review_required');
  assert.ok(first.taskId);
  const retry = await f.code.prepareRepository(f.admin, f.input);
  assert.equal(retry.taskId, first.taskId);
  const after = (await f.code.status(f.admin)).project!;
  assert.equal(after.repositoryId, f.initial.repositoryId);
  assert.equal(after.main.oid, f.initial.main.oid);
  const work = await f.tasks.get(f.admin, first.taskId!);
  assert.equal(work.workspace, 'git');
  const merge = await f.state.read((sql) =>
    sql.get<{ left_oid: string; right_oid: string }>(
      'SELECT left_oid,right_oid FROM code_pending_merges WHERE project_id=? AND unit_id=?',
      f.admin.projectId,
      first.taskId!,
    ),
  );
  assert.deepEqual(merge, { left_oid: f.initial.main.oid, right_oid: f.remoteHead });
});

test('a ref moving before fetch is refused without changing main or starting a review of the wrong head', async (t) => {
  const f = await fixture(t);
  f.source.commit({ 'late.txt': 'Arrived after selection' });
  const result = await f.code.prepareRepository(f.admin, f.input);
  assert.equal(result.state, 'failed');
  assert.equal(result.operation.error, 'code_branch_changed');
  assert.equal((await f.code.status(f.admin)).project!.main.oid, f.initial.main.oid);
  const tasks = await f.state.read((sql) => sql.all('SELECT task_id FROM code_repository_sync'));
  assert.equal(tasks.length, 0);
});

test('a changed local main refuses reconciliation and preserves both retained histories', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.code.prepareRepository(f.admin, { ...f.input, expectedMainOid: f.remoteHead }),
    { code: 'code_main_changed' },
  );
  assert.equal((await f.code.status(f.admin)).project!.main.oid, f.initial.main.oid);
});

async function acceptedIntegration(t: TestContext) {
  const f = await fixture(t);
  const prepared = await f.code.prepareRepository(f.admin, f.input);
  const internal = f.code as unknown as {
    store: { repositories: CodeRepositories };
    unitStore: CodeUnitService;
  };
  const path = internal.store.repositories.paths(f.admin.projectId).repository;
  f.source.git('fetch', path, 'refs/merv/initial');
  f.source.git('checkout', '--detach', f.initial.main.oid);
  f.source.git(
    'merge',
    '--no-ff',
    '--allow-unrelated-histories',
    '-m',
    'Reviewed integration',
    f.remoteHead,
  );
  const head = f.source.git('rev-parse', 'HEAD');
  f.source.git('push', path, `${head}:refs/merv/test-reviewed`);
  const unit = await f.code.unit(f.admin, prepared.taskId!);
  const accepted: CodeUnit = {
    ...unit,
    acceptance: {
      unitId: prepared.taskId!,
      hash: 'reviewed-acceptance',
      acceptedAt: new Date().toISOString(),
      terminalRevision: 2,
      submissionRef: 'delivery',
      reviewRef: 'review',
      acceptedBy: 'reviewer',
      reference: head,
      reviewAttached: true,
      storage: 'code',
    },
  };
  // The independent task-review contract is covered by code-publish-unit. This seam tests
  // reconciliation of that immutable verdict against real Git histories and moving heads.
  t.mock.method(internal.unitStore, 'unit', async () => accepted);
  return { ...f, head };
}

test('a reviewed merge advances local main once and preserves both real Git histories', async (t) => {
  const f = await acceptedIntegration(t);
  const [result, simultaneous] = await Promise.all([
    f.code.prepareRepository(f.admin, f.input),
    f.code.prepareRepository(f.admin, f.input),
  ]);
  assert.equal(simultaneous.mainOid, f.head);
  assert.equal(result.state, 'ready');
  assert.equal(result.mainOid, f.head);
  assert.equal((await f.code.status(f.admin)).project!.main.oid, f.head);
  assert.equal((await f.code.prepareRepository(f.admin, f.input)).mainOid, f.head);
  assert.equal(
    f.source.git('rev-parse', 'refs/heads/main'),
    f.remoteHead,
    'connecting never overwrites remote main',
  );
});

test('remote movement during review refuses promotion of the stale integration', async (t) => {
  const f = await acceptedIntegration(t);
  f.moveObservedHead('b'.repeat(40));
  await assert.rejects(f.code.prepareRepository(f.admin, f.input), { code: 'code_branch_changed' });
  assert.equal((await f.code.status(f.admin)).project!.main.oid, f.initial.main.oid);
});

for (const relation of ['equal', 'local-ahead', 'remote-ahead', 'diverged'] as const) {
  test(`connecting related histories (${relation}) preserves main until any required review`, async (t) => {
    const f = await fixture(t);
    const internal = f.code as unknown as { store: { repositories: CodeRepositories } };
    const path = internal.store.repositories.paths(f.admin.projectId).repository;
    f.source.git('fetch', path, 'refs/merv/initial');
    f.source.git('checkout', '-B', 'main', f.initial.main.oid);
    let local = f.initial.main.oid;
    if (relation === 'local-ahead' || relation === 'diverged')
      local = f.source.commit({ 'local.txt': 'Local work' });
    f.source.git('push', path, `${local}:refs/merv/test-local`);
    f.source.git('checkout', '-B', 'main', f.initial.main.oid);
    const remote =
      relation === 'remote-ahead' || relation === 'diverged'
        ? f.source.commit({ 'remote.txt': 'Remote work' })
        : f.initial.main.oid;
    f.moveObservedHead(remote);
    await f.state.transaction((tx) =>
      tx.run(
        'UPDATE code_projects SET main_json=? WHERE project_id=?',
        JSON.stringify({ ...f.initial.main, oid: local }),
        f.admin.projectId,
      ),
    );
    const result = await f.code.prepareRepository(f.admin, {
      ...f.input,
      expectedMainOid: local,
      headOid: remote,
    });
    assert.equal(
      result.state,
      relation === 'equal' || relation === 'local-ahead' ? 'ready' : 'review_required',
    );
    assert.equal((await f.code.status(f.admin)).project!.main.oid, local);
    const rows = await f.state.read((sql) => sql.all('SELECT task_id FROM code_repository_sync'));
    assert.equal(rows.length, result.state === 'ready' ? 0 : 1);
  });
}
