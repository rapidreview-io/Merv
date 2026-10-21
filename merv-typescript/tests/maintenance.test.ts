import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readBootMaintenance, maintenancePublicRead } from '@merv/contracts/maintenance';

test('boot maintenance is opt-in, strict, immutable and has a separate operator capability', () => {
  assert.equal(readBootMaintenance({}).active, false);
  assert.equal(readBootMaintenance({ MERV_BOOT_MAINTENANCE: '0' }).active, false);
  for (const value of ['', 'true', 'false', 'yes', ' 1'])
    assert.throws(() => readBootMaintenance({ MERV_BOOT_MAINTENANCE: value }), /must be 0 or 1/);
  const env = { MERV_BOOT_MAINTENANCE: '1', MERV_MAINTENANCE_OPERATOR_TOKEN: 'a'.repeat(32) };
  const policy = readBootMaintenance(env);
  env.MERV_BOOT_MAINTENANCE = '0';
  env.MERV_MAINTENANCE_OPERATOR_TOKEN = 'b'.repeat(32);
  assert.equal(policy.active, true);
  assert.equal(policy.operator('a'.repeat(32)), true);
  for (const value of [undefined, '', 'b'.repeat(32), ['a'.repeat(32)]])
    assert.equal(policy.operator(value), false);
  assert.equal(readBootMaintenance({ MERV_BOOT_MAINTENANCE: '1' }).operator('anything'), false);
  assert.throws(() => readBootMaintenance({ MERV_MAINTENANCE_OPERATOR_TOKEN: 'short' }));
});

test('only exact health and release static GETs are public during maintenance', () => {
  for (const path of ['/health', '/ui/', '/ui/assets/app.js'])
    assert.equal(maintenancePublicRead('GET', path), true);
  for (const path of [
    '/health/extra',
    '/ui/settings',
    '/auth/config',
    '/customer-experiments',
    '/payments/stripe',
    '/ui/assets-other/a',
  ])
    assert.equal(maintenancePublicRead('GET', path), false);
  assert.equal(maintenancePublicRead('POST', '/health'), false);
});

test('fresh maintenance process fences real scheduler entry points and HTTP boundaries', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', 'tests/fixtures/maintenance-worker.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...env,
        MERV_BOOT_MAINTENANCE: '1',
        MERV_MAINTENANCE_OPERATOR_TOKEN: 'operator-test-capability-'.repeat(2),
      },
    },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /# tests 2/);
});
