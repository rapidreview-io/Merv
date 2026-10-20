import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from 'cordis';
import { MervError } from '@merv/contracts';
import host from '@merv/sandboxes/host';
import { retired } from '@merv/sandboxes/integration';
import { migrate, openDatabase } from '@sandboxes/db';
import { ConfigurationError } from '@sandboxes/kernel';
import { postgresUrl, schemaFor } from './fixtures/state.js';

test('Sandboxes host requires migrations, boots with Merv errors, and releases its services and pool', async (t) => {
  const schema = schemaFor();
  const dataDir = mkdtempSync(join(tmpdir(), 'merv-sandboxes-host-'));
  const db = await openDatabase({ url: postgresUrl, schema });
  t.after(async () => {
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const previousKey = process.env.MERV_TEST_SANDBOXES_VAULT_KEY;
  process.env.MERV_TEST_SANDBOXES_VAULT_KEY = Buffer.alloc(32, 7).toString('base64url');
  t.after(() => {
    if (previousKey === undefined) delete process.env.MERV_TEST_SANDBOXES_VAULT_KEY;
    else process.env.MERV_TEST_SANDBOXES_VAULT_KEY = previousKey;
  });
  const config = host.Config.parse({
    databaseUrlEnv: 'MERV_TEST_POSTGRES_URL',
    schema,
    vaultKeyEnv: 'MERV_TEST_SANDBOXES_VAULT_KEY',
    publicOrigin: 'https://sandboxes.example',
    dataDir,
    relayEvents: false,
  });
  const boot = () => {
    const ctx = new Context();
    const fiber = ctx.plugin(host, config);
    return { ctx, fiber };
  };
  await assert.rejects(
    boot().fiber.await(),
    (error) => error instanceof ConfigurationError && /Merv never migrates/.test(error.message),
  );

  await migrate(db, { schemaExplicit: true });
  const { ctx, fiber } = boot();
  await fiber.await();
  await assert.rejects(
    ctx.sbxMerv.principal({ projectId: 'unlinked-project', actorId: 'actor' }, 'read'),
    (error) => error instanceof MervError && error.code === 'sandbox_unavailable',
  );
  const pool = ctx.sbxDb;
  await fiber.dispose();
  for (const name of ['sbxMerv', 'sbxDb', 'sbxProviders', 'sbxJobs', 'sbxRegistry'])
    assert.equal(ctx.get(name), undefined, name);
  await assert.rejects(pool.get('SELECT 1'), /database is closed/);
});

test('the Sandboxes tools retired on 2026-10-20 say where they went', () => {
  assert.deepEqual(
    [
      'sandboxes.job_status',
      'sandboxes.providers_list',
      'sandboxes.usage_report',
      'sandbox.extend',
      'sandbox.release',
      'sandboxes.snapshot_list',
      'sandboxes.job',
      'job_status',
    ].map(retired),
    [
      'sandboxes.job with action=status',
      'sandboxes.sandbox with action=providers',
      'sandboxes.spend with action=report',
      'sandboxes.sandbox with action=renew',
      'sandboxes.sandbox with action=delete',
      false,
      false,
      false,
    ],
  );
});
