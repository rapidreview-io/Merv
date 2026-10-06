import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openState } from './fixtures/state.js';

async function fixture(t: any) {
  const state = await openState(':memory:');
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const { project } = await scope.bootstrap({ projectName: 'Lost', actorName: 'Operator' });
  const append = (type: string, subjectId: string, data: Record<string, string> = {}) =>
    state.transaction(
      async (tx) =>
        (
          await state.appendEvent(tx, {
            projectId: project.id,
            actorId: 'x',
            type,
            subjectId,
            data,
          })
        ).id,
    );
  const lost = (actorId: string, permission: 'read' | 'write' | 'review', after: number) =>
    state.transaction((tx) => scope.permissionLost(project.id, actorId, permission, after, tx));
  return { state, append, lost, projectId: project.id };
}

test('State.nextEvent finds the first event of the named types after a cursor', async (t) => {
  const { state, append } = await fixture(t);
  const start = await state.eventHead();
  const a = await append('sample.a', 's');
  const b = await append('sample.b', 's');
  assert.equal(await state.nextEvent(start, ['sample.b', 'sample.a']), a);
  assert.equal(await state.nextEvent(a, ['sample.a', 'sample.b']), b);
  assert.equal(await state.nextEvent(a, ['sample.a']), undefined);
  await assert.rejects(state.nextEvent(start, []), { code: 'invalid_cursor' });
});

test('permissionLost counts a revocation or a role change away from the permission after the cursor', async (t) => {
  const { state, append, lost } = await fixture(t);
  const revokedBefore = await append('actor.revoked', 'actor_a');
  assert.equal(await lost('actor_a', 'read', revokedBefore), false);
  assert.equal(await lost('actor_a', 'read', revokedBefore - 1), true);
  const start = await state.eventHead();
  await append('actor.permissions_changed', 'actor_b', { beforeRole: 'reviewer', role: 'reader' });
  assert.equal(await lost('actor_b', 'review', start), true);
  assert.equal(await lost('actor_b', 'read', start), false);
  assert.equal(await lost('actor_b', 'write', start), false, 'a reviewer never held write');
  await append('actor.permissions_changed', 'actor_c', { beforeRole: 'reader', role: 'producer' });
  assert.equal(await lost('actor_c', 'write', start), false, 'gaining a permission loses nothing');
  // As before: an unknown role holds nothing, and a missing one is no role.
  await append('actor.permissions_changed', 'actor_d', { beforeRole: 'reader', role: 'unknown' });
  assert.equal(await lost('actor_d', 'read', start), true);
  await append('actor.permissions_changed', 'actor_e', { beforeRole: 'unknown' });
  assert.equal(await lost('actor_e', 'read', start), false);
  await append('actor.permissions_changed', 'actor_f', { beforeRole: 'operator' });
  assert.equal(await lost('actor_f', 'read', start), true);
});

test('permissionLost reads past a full page of role changes that lost nothing', async (t) => {
  const { state, append, lost, projectId } = await fixture(t);
  const start = await state.eventHead();
  await state.transaction(async (tx) => {
    for (let index = 0; index < 1000; index++)
      await state.appendEvent(tx, {
        projectId,
        actorId: 'x',
        type: 'actor.permissions_changed',
        subjectId: 'actor_g',
        data: { beforeRole: 'reader', role: 'reviewer' },
      });
  });
  assert.equal(await lost('actor_g', 'review', start), false);
  await append('actor.permissions_changed', 'actor_g', { beforeRole: 'reviewer', role: 'reader' });
  assert.equal(await lost('actor_g', 'review', start), true);
});
