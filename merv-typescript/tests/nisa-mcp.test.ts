import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNisaMcpScenario } from '../scripts/nisa-mcp-scenario.js';

const checkout = process.env.MERV_NISA_CHECKOUT;
test(
  'Nisa-owned MCP composes retrieval, durable Q&A, quota and independent mount removal',
  {
    skip: checkout
      ? false
      : 'Set MERV_NISA_CHECKOUT to the prepared Nisa repository to run the cross-repository integration',
    timeout: 60_000,
  },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-nisa-mcp-'));
    try {
      const report = await runNisaMcpScenario(directory, checkout!);
      assert.equal(report.status, 'passed');
      assert.deepEqual(report.toolCounts, [56, 50, 56]);
      assert.equal(report.runnerDispatches, 2);
      assert.equal(report.nativeTaskState, 'done');
      assert.equal(report.retainedFeedPosts, 2);
      assert.equal(report.checks.nativeTaskReviewFeedCompletedWhileNisaAbsent, true);
      assert.equal(report.checks.runnerDispatchCountProvesNoReplay, true);
      assert.ok(Object.values(report.checks).every(Boolean));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
