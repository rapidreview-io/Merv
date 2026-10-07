import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresMigrations } from '../packages/workflows/src/index.postgres.js';
import {
  checkReceipt,
  insertLease,
  latestReleases,
  leaseReceipt,
  leaseRows,
} from '@merv/workflows/lease-rows';
import { digest } from '@merv/contracts';
import { openState } from './fixtures/state.js';

// A lease's receipt and details can carry a frozen paper context (160,000 characters for an
// experiment), so a read of who holds what loads neither unless it asks for them, and a read of
// when each instance's leases ended is one aggregate, not every lease ever taken.
test('lease reads are narrow by default and ask for receipts and details', async () => {
  const state = await openState();
  await state.migrate('workflows', postgresMigrations);
  const projectId = 'project_lease_reads';
  const paper = 'x'.repeat(10_000);
  await state.transaction(async (tx) => {
    for (const [index, revision, released] of [
      [0, 1, '2026-01-01T00:00:00.000Z'],
      [1, 1, '2026-01-02T00:00:00.000Z'],
      [2, 2, '2026-01-03T00:00:00.000Z'],
      [3, 2, null],
    ] as const) {
      const id = `session_${index}`;
      await insertLease(tx, {
        id,
        projectId,
        snapshot: { id: 'experiment_a', revision, workflow: 'experiment', state: 'running' },
        actorId: `actor_${index}`,
        sourceActorId: 'actor_owner',
        reviewId: null,
        claimId: null,
        receipt: { leaseId: id, paper },
        details: { purpose: 'work', inputs: { paper } },
      });
      if (released) await tx.run('UPDATE wf_leases SET released_at=? WHERE id=?', released, id);
    }
  });
  await state.transaction(async (tx) => {
    const where = { projectId, instanceIds: ['experiment_a'] };
    const narrow = await leaseRows(tx, where);
    assert.equal(narrow.length, 4);
    for (const row of narrow) {
      assert.equal('receipt' in row, false);
      assert.equal('details' in row, false);
    }
    assert.deepEqual(
      narrow.map((row) => [row.id, Number(row.revision), row.released_at]),
      [
        ['session_0', 1, '2026-01-01T00:00:00.000Z'],
        ['session_1', 1, '2026-01-02T00:00:00.000Z'],
        ['session_2', 2, '2026-01-03T00:00:00.000Z'],
        ['session_3', 2, null],
      ],
    );
    const live = await leaseRows(tx, { ...where, active: true });
    assert.deepEqual(
      live.map((row) => [row.id, row.state, 'details' in row]),
      [['session_3', 'running', false]],
    );
    const [full] = await leaseRows<{ inputs: { paper: string } }>(
      tx,
      { ...where, id: 'session_3' },
      'full',
    );
    assert.equal(full.details.inputs.paper, paper);
    // The full row carries the receipt's digest, not the receipt: a check compares digests.
    assert.equal('receipt' in full, false);
    assert.equal(full.receipt_digest, digest({ paper, leaseId: 'session_3' }));
    checkReceipt(full, { paper, leaseId: 'session_3' }, 'stale');
    assert.throws(() => checkReceipt(full, { leaseId: 'session_3' }, 'stale'), {
      code: 'stale_lease',
    });
    assert.deepEqual(await leaseReceipt(tx, full), { leaseId: 'session_3', paper });
    assert.deepEqual(
      (await latestReleases(tx, { projectId, instanceIds: ['experiment_a', 'missing'] })).map(
        (row) => [row.instance_id, Number(row.revision), row.released_at],
      ),
      [
        ['experiment_a', 1, '2026-01-02T00:00:00.000Z'],
        ['experiment_a', 2, '2026-01-03T00:00:00.000Z'],
      ],
    );
    assert.deepEqual(await latestReleases(tx, { projectId, instanceIds: [] }), []);
  });
});
