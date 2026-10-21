import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DurableEvents } from '@merv/domain-events';
import { createService } from '@merv/contracts';
import { openState } from './fixtures/state.js';

test('maintenance preserves durable cursors/retry decisions and queued events replay once after restart', async () => {
  const state = await openState();
  const events = await createService(new DurableEvents(state));
  await state.migrate('maintenance_probe', [
    { version: 1, sql: 'CREATE TABLE maintenance_probe (event BIGINT PRIMARY KEY);' },
  ]);
  await events.subscribe({
    id: 'maintenance.probe',
    types: ['probe.created'],
    from: 'now',
    handle: async () => {
      throw Error('must stay paused');
    },
  });
  await events.close();
  await state.transaction(async (tx) => {
    await tx.run(
      "UPDATE event_consumers SET attempts=3,error='original_retry',retry_at=? WHERE id='maintenance.probe'",
      Date.now() + 1200,
    );
    await state.appendEvent(tx, {
      projectId: 'p',
      actorId: 'a',
      subjectId: 'one',
      type: 'probe.created',
      data: {},
    });
  });
  const before = await state.read((sql) => sql.all('SELECT * FROM event_consumers'));
  const schema = await state.read(
    async (sql) => (await sql.get<{ schema: string }>('SELECT current_schema() AS schema'))!.schema,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, MAINTENANCE_TEST_SCHEMA: schema };
  delete env.NODE_TEST_CONTEXT;
  const run = (active: boolean) => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/maintenance-events.ts'],
      {
        env: { ...env, MERV_BOOT_MAINTENANCE: active ? '1' : '0' },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verified/);
  };
  try {
    run(true);
    assert.deepEqual(await state.read((sql) => sql.all('SELECT * FROM event_consumers')), before);
    assert.equal((await state.read((sql) => sql.all('SELECT * FROM maintenance_probe'))).length, 0);
    assert.equal(await state.eventHead(), 2);
    run(false);
    assert.equal((await state.read((sql) => sql.all('SELECT * FROM maintenance_probe'))).length, 2);
    run(false);
    assert.equal((await state.read((sql) => sql.all('SELECT * FROM maintenance_probe'))).length, 2);
  } finally {
    await state.close();
  }
});

test('assembled Main remains fenced through boot and shutdown', () => {
  const env = { ...process.env, MERV_BOOT_MAINTENANCE: '1' } as NodeJS.ProcessEnv;
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', 'tests/fixtures/maintenance-boot.ts'],
    { env, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /# tests 1/);
});
