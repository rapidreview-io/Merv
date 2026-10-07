import assert from 'node:assert/strict';
import test from 'node:test';
import { codePlugin as code } from '@merv/code';
import { codePlugin as research } from '@merv/code-work';
import { codeStoreFixture, maintainStore } from './fixtures/code-store.js';

test('a retired repository backup setting is refused while the configuration is parsed', () => {
  for (const plugin of [code, research]) {
    const repositories = { ...(plugin === code ? { root: '/unused' } : {}), backup: {} };
    assert.equal(plugin.Config.safeParse({ repositories }).success, false);
    assert.ok(
      plugin.Config.safeParse(plugin === code ? { repositories: { root: '/unused' } } : {}).success,
    );
  }
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
  await maintainStore(f.code);
  assert.deepEqual(await history(), before);
  const status = await f.code.status(f.admin);
  assert.ok(status.store);
  assert.equal(Object.hasOwn(status.store, 'backup'), false);
  assert.deepEqual(status.operations, []);
});
