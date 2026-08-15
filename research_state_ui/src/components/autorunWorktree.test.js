import assert from 'node:assert/strict';
import test from 'node:test';

import { worktreeLineage } from './autorunWorktree.js';

const at = (iso, extra = {}) => ({ id: iso, created_at: iso, ...extra });

test('a job without a worktree has no lineage', () => {
  assert.deepEqual(worktreeLineage(at('2026-08-15T10:00:00Z'), [at('2026-08-15T09:00:00Z', { workspace_ref: 'x' })]),
    { branch: '', before: [], after: [] });
});

test('jobs on the same branch split into earlier and later, oldest first', () => {
  const branch = 'merv/experiments/p/e';
  const a = at('2026-08-14T10:00:00Z', { workspace_ref: branch });
  const b = at('2026-08-15T10:00:00Z', { workspace_ref: branch });
  const c = at('2026-08-16T10:00:00Z', { workspace_ref: branch });
  const other = at('2026-08-15T11:00:00Z', { workspace_ref: 'merv/experiments/p/z' });
  const lineage = worktreeLineage(b, [c, other, a, b]);
  assert.equal(lineage.branch, branch);
  assert.deepEqual(lineage.before.map((s) => s.id), [a.id]);
  assert.deepEqual(lineage.after.map((s) => s.id), [c.id]);
});

test('activation time wins over creation time for ordering', () => {
  const branch = 'b';
  const late = at('2026-08-15T09:00:00Z', { workspace_ref: branch, activated_at: '2026-08-15T12:00:00Z' });
  const mine = at('2026-08-15T10:00:00Z', { workspace_ref: branch });
  const lineage = worktreeLineage(mine, [late, mine]);
  assert.deepEqual(lineage.before, []);
  assert.deepEqual(lineage.after.map((s) => s.id), [late.id]);
});
