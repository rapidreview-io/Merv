import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
for (const active of ['1', '0'])
  test(`native Git recovery and people startup with maintenance=${active}`, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, MERV_BOOT_MAINTENANCE: active };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', 'tests/fixtures/maintenance-startup-worker.ts'],
      { env, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /# tests 2/);
  });
