import assert from 'node:assert/strict';
import test from 'node:test';
import { dailyTokens } from '@merv/fleet/model-ledger';
import { openState } from './fixtures/state.js';

test('admin allowance survives a lower personal limit and clearing restores the default', async () => {
  const state = await openState();
  await state.transaction(async (sql) => {
    await sql.run('CREATE TABLE test_caps(person TEXT PRIMARY KEY,tokens BIGINT NOT NULL)');
    await sql.run('CREATE TABLE test_own(person TEXT PRIMARY KEY,tokens BIGINT NOT NULL)');
    await sql.run(
      'CREATE TABLE test_usage(person TEXT,day TEXT,tokens BIGINT,PRIMARY KEY(person,day))',
    );
    const ledger = dailyTokens('test_usage', 'test_caps', 'test_own');
    const read = () => ledger.used(sql, ['person'], '2026-10-23', '2026-10-24', 100_000_000);
    await ledger.setOwn!(sql, 'person', 20_000_000);
    await ledger.setLimit(sql, 'person', 200_000_000);
    assert.deepEqual(await read(), [{ used: 0, limit: 20_000_000, cap: 200_000_000, own: true }]);
    assert.equal(await ledger.charge(sql, 'person', '2026-10-23', 21_000_000, 100_000_000), false);
    await ledger.setLimit(sql, 'person', null);
    assert.deepEqual(await read(), [{ used: 0, limit: 20_000_000, cap: 100_000_000, own: false }]);
    await ledger.setOwn!(sql, 'person', null);
    assert.equal(await ledger.charge(sql, 'person', '2026-10-23', 21_000_000, 100_000_000), true);
    assert.deepEqual(await read(), [
      { used: 21_000_000, limit: 100_000_000, cap: 100_000_000, own: false },
    ]);
  });
});
