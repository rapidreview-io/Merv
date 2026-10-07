import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@merv/contracts';
import { leaseRows } from '@merv/workflows/lease-rows';
import { postgresMigrations } from '../packages/workflows/src/index.postgres.js';
import { openState } from './fixtures/state.js';

// workflows@13 backfills each stored receipt's digest() in SQL. It must be the digest the checks
// compute from the receipt the worker presents, for every receipt JSON.stringify could have
// written, and a receipt it cannot read keeps no digest and is digested where it is read.
test('workflows@13 backfills the digest() of every stored receipt', async () => {
  const state = await openState();
  const before = Object.fromEntries(
    Object.entries(postgresMigrations).filter(([version]) => +version < 13),
  );
  await state.migrate('workflows', before);
  const receipts: Record<string, unknown> = {
    plain: { leaseId: 'l', taskId: 't', revision: 3, purpose: 'work', reviewId: null },
    order: { z: 1, a: { y: [3, { d: true, c: false }], b: [] }, A: {}, '': 'empty key' },
    numbers: { tiny: 1.5e-7, big: 1e21, negative: -12.25, whole: 4, zero: 0 },
    escapes: {
      quote: '"q"',
      slash: 'a/b\\c',
      controls: '\b\f\n\r\t\u0001\u001f',
      unicode: 'é ü 中文 😀',
    },
    keys: { é: 1, 'z/y': 2, 'quote"key': 3, 'back\\slash': 4 },
    paper: { items: [{ id: 'p1', body: { text: 'p'.repeat(20_000) } }] },
    // PostgreSQL reads none of these as text; the last only looks like one.
    nul: { log: 'tail: a\u0000b', 'key\u0000': 1 },
    lone: { note: 'half \ud800 pair and \udfff' },
    literal: { note: 'not an escape: \\u0000 \\ud800' },
  };
  const unreadable = new Set(['nul', 'lone', 'literal']);
  await state.transaction(async (tx) => {
    for (const [id, receipt] of Object.entries(receipts))
      await tx.run(
        "INSERT INTO wf_leases(id,project_id,instance_id,revision,workflow,state,actor_id,receipt,details) VALUES(?,'p',?,1,'task','running','a',?,'{}')",
        id,
        `i_${id}`,
        JSON.stringify(receipt),
      );
  });
  await state.migrate('workflows', postgresMigrations);
  const stored = new Map(
    (
      await state.read((sql) =>
        sql.all<{ id: string; receipt_digest: string | null }>(
          'SELECT id,receipt_digest FROM wf_leases',
        ),
      )
    ).map((row) => [row.id, row.receipt_digest]),
  );
  for (const [id, receipt] of Object.entries(receipts))
    assert.equal(stored.get(id), unreadable.has(id) ? null : digest(receipt), id);
  await state.transaction(async (tx) => {
    for (const [id, receipt] of Object.entries(receipts)) {
      const [row] = await leaseRows(tx, { projectId: 'p', id }, 'full');
      assert.equal(row!.receipt_digest, digest(receipt), id);
      assert.equal('receipt' in row!, false);
    }
  });
  // The digest is as immutable as the receipt it stands for.
  await assert.rejects(
    state.transaction((tx) => tx.run("UPDATE wf_leases SET receipt_digest='x' WHERE id='plain'")),
    { message: 'Database constraint rejected the operation' },
  );
});
