import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, digest } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { initializeManagedCompute, ManagedCompute } from '@merv/sandboxes/managed-compute';
import type { SandboxCompute, SandboxComputeSpec } from '@merv/sandboxes/types';
import { openState } from './fixtures/state.js';

test('legacy compute backfills missing jobs, preserves current states and resumes without resubmission', async (t) => {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const identity = await scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'compute-migration',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await scope.createProject(identity, { name: 'Migration', requestId: 'project' });
  const caller = await scope.caller(identity, project.id);
  await state.transaction((tx) =>
    tx.run(`CREATE TABLE experiment_compute_runs (
    project_id TEXT, experiment_id TEXT, attempt_index BIGINT, key TEXT, input_hash TEXT,
    input_json TEXT, run_id TEXT, state TEXT, cost TEXT, result TEXT, created_by TEXT,
    created_at TEXT, updated_at TEXT, PRIMARY KEY(experiment_id,attempt_index,key))`),
  );
  const input = {
    experimentId: 'exp_existing',
    attemptIndex: 1,
    key: 'pending',
    provider: 'test',
    offerId: 'gpu',
    command: 'echo migration',
    minutes: 5,
    maxUsd: 1,
  };
  for (const [key, status, runId] of [
    ['pending', 'submitting', null],
    ['known', 'running', 'provider_known'],
  ] as const) {
    const legacyInput = { ...input, key };
    await state.transaction((tx) =>
      tx.run(
        'INSERT INTO experiment_compute_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        project.id,
        input.experimentId,
        1,
        key,
        digest(legacyInput),
        JSON.stringify(legacyInput),
        runId,
        status,
        JSON.stringify({ amount: '0.10', currency: 'USD' }),
        null,
        caller.actorId,
        new Date().toISOString(),
        new Date().toISOString(),
      ),
    );
  }
  await initializeManagedCompute(state, true);
  const submissions: SandboxComputeSpec[] = [];
  const reads: string[] = [];
  const logReads: string[] = [];
  const adapter: SandboxCompute = {
    since: '2000-01-01T00:00:00Z',
    async offers() {
      return { offers: [] };
    },
    async allowance() {
      return {};
    },
    async submit(_projectId, spec) {
      submissions.push(spec);
      return 'provider_pending';
    },
    async get(_projectId, runId) {
      reads.push(runId);
      return {
        id: runId,
        state: 'completed',
        reason: null,
        cost: { amount: '0.20', currency: 'USD' },
        result: { exit: 0, bytes: 2, head: 'ok', tail: 'ok' },
      };
    },
    async cancel() {
      throw new Error('No migrated job should be cancelled');
    },
    async logs(projectId, runId) {
      assert.equal(projectId, project.id);
      logReads.push(runId);
      return { state: 'running', mode: 'legacy' };
    },
  };
  const policy = {
    async authorize() {},
    async active() {
      return true;
    },
  };
  let managed = new ManagedCompute(state, scope, adapter, 'experiment', policy);
  t.after(async () => {
    managed.close();
    await state.close();
  });
  const { experimentId, attemptIndex, ...options } = input;
  const replay = await managed.run(caller, {
    ownerId: experimentId,
    generation: attemptIndex,
    ...options,
  });
  assert.equal(replay.state, 'submitting');
  assert.equal(replay.runId, 'pending');
  assert.deepEqual(await managed.logs(caller, experimentId, 'pending'), {
    state: 'submitting',
    mode: 'pending',
  });
  assert.equal(logReads.length, 0, 'unsubmitted keys must not reach the provider');
  await managed.logs(caller, experimentId, 'known', 1);
  assert.deepEqual(logReads, ['provider_known']);
  await assert.rejects(managed.logs(caller, 'another_owner', 'known'), {
    code: 'compute_not_found',
  });
  await assert.rejects(managed.logs(caller, experimentId, 'known', 2), {
    code: 'compute_not_found',
  });
  const otherProject = await scope.createProject(identity, { name: 'Other', requestId: 'other' });
  const otherCaller = await scope.caller(identity, otherProject.id);
  await assert.rejects(managed.logs(otherCaller, experimentId, 'known'), {
    code: 'compute_not_found',
  });
  const tasks = new ManagedCompute(state, scope, adapter, 'task', policy);
  t.after(() => tasks.close());
  await assert.rejects(tasks.logs(caller, experimentId, 'known'), { code: 'compute_not_found' });
  assert.equal(
    logReads.length,
    1,
    'foreign owners, projects, kinds and generations never reach provider logs',
  );
  await managed.tick();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]!.idempotencyKey, digest([project.id, experimentId, 1, 'pending']));
  assert.ok(reads.includes('provider_known'));
  managed.close();
  // An older release can write a new legacy row during a quiescent rollback.
  const rollbackInput = { ...input, key: 'after-rollback' };
  await state.transaction((tx) =>
    tx.run(
      `INSERT INTO experiment_compute_runs SELECT project_id,experiment_id,attempt_index,
      'after-rollback',?,?,'provider_rollback','running',cost,result,
      created_by,created_at,updated_at FROM experiment_compute_runs WHERE key='known'`,
      digest(rollbackInput),
      JSON.stringify(rollbackInput),
    ),
  );
  // Restart must not copy stale states back over the live ledger or rent the known jobs again.
  await initializeManagedCompute(state, true);
  managed = new ManagedCompute(state, scope, adapter, 'experiment', policy);
  await managed.tick();
  const history = await state.transaction((tx) => managed.history(project.id, experimentId, tx));
  assert.equal(submissions.length, 1);
  assert.equal(history.length, 3);
  assert.ok(reads.includes('provider_rollback'));
  assert.ok(history.every((row) => row.state === 'completed'));
  assert.ok(history.every((row) => row.cost.amount === '0.20'));
  assert.ok(history.every((row) => row.cost.basis === 'unclassified_estimate'));
});
