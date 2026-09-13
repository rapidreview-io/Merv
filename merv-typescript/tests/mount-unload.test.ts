import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMountUnloadScenario } from '../scripts/mount-unload-scenario.js';

test(
  'configured mount removal drains upstream calls while native task/review/feed work completes',
  { timeout: 20000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-mount-unload-'));
    try {
      const report = await runMountUnloadScenario(directory);
      assert.equal(report.status, 'passed');
      assert.ok(Object.values(report.checks).every(Boolean));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
