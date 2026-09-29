import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { codePlugin as code } from '@merv/code';
import { codePlugin as research } from '@merv/code-research';
import { CodeStore } from '@merv/code/store/operations';
import { codeStoreFixture } from './fixtures/code-store.js';

const retired = { code: 'code_backup_retired', message: /deploy\/recovery-snapshot\.py.*legacy/ };

test('retired repository backup settings fail before publication or storage access', async () => {
  for (const plugin of [code, research]) {
    for (const backup of [{}, null, false, undefined]) {
      const repositories = { ...(plugin === code ? { root: '/unused' } : {}), backup };
      assert.throws(() => plugin.Config.parse({ repositories }), retired);
      // Direct application must not silently drop a retired setting when a caller bypasses Config.
      await assert.rejects(plugin.apply({} as never, { repositories } as never), retired);
    }
    assert.ok(plugin.Config.safeParse({}).success);
  }
  assert.throws(
    () =>
      new CodeStore(
        {} as never,
        {} as never,
        { root: '/unused', backup: {} } as never,
        {} as never,
      ),
    retired,
  );
});

test('historical backup receipts and interrupted rows survive restart and maintenance untouched', async (t) => {
  const f = await codeStoreFixture(t);
  const at = '2020-01-01T00:00:00.000Z';
  await f.state.transaction(async (tx) => {
    for (const status of ['prepared', 'completed'])
      await tx.run(
        'INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        `legacy-${status}`,
        f.admin.projectId,
        'system:code',
        `legacy-${status}`,
        'backup',
        'legacy',
        '{}',
        status,
        status === 'completed' ? '{"legacyReceipt":true}' : null,
        at,
        status === 'completed' ? at : null,
        at,
      );
  });
  const history = () =>
    f.state.read((sql) =>
      sql.all('SELECT * FROM code_operations WHERE kind=? ORDER BY id', 'backup'),
    );
  const before = await history();
  await f.open();
  await f.code.maintainStore();
  assert.deepEqual(await history(), before);
  const status = await f.code.status(f.admin);
  assert.ok(status.store);
  assert.equal(Object.hasOwn(status.store, 'backup'), false);
  assert.deepEqual(status.operations, []);
});

test('retired restore command directs operators to the deployment and legacy recovery tools', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'code-restore', '--verify-only'],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /code_backup_retired/);
  assert.match(result.stderr, /deploy\/recovery-snapshot\.py/);
  assert.match(result.stderr, /preserved legacy recovery kit/);
});
