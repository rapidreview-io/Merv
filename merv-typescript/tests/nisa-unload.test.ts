import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runNisaUnloadScenario } from '../scripts/nisa-unload-scenario.js';

test(
  'Nisa removal drains search while the same sandbox clients and native task/review/feed continue',
  { timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-nisa-unload-'));
    try {
      const report = await runNisaUnloadScenario(directory);
      assert.equal(report.status, 'passed');
      assert.deepEqual(report.toolCounts, [29, 27, 29]);
      assert.equal(report.nisaRequests, 3);
      assert.equal(report.sandboxCalls, 4);
      assert.equal(report.sandboxConnections, 2);
      assert.equal(report.realNisaServiceVerified, false);
      assert.equal(report.realSandboxServiceVerified, false);
      assert.ok(Object.values(report.checks).every(Boolean));
      assert.equal(report.checks.resourcesClosed, true);
      const evidence = JSON.stringify(report);
      assert.ok(!evidence.includes('synthetic-nisa-scenario-token'));
      assert.ok(!evidence.includes('synthetic-nisa-scenario-sandbox-token'));
      assert.ok(!evidence.includes('Bearer'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
