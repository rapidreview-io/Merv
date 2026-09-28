/**
 * The credential ledger decides liveness on its own: since Identity R2 no boot pass adopts hashes
 * that an owner's tables hold but the ledger does not, so such a hash never authenticates, not
 * even after a restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createService, newId, sha256Hex, MervError } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { CredentialStore } from '@merv/identity/credentials';
import { openState } from './fixtures/state.js';

const time = Date.parse('2026-09-26T10:00:00.000Z');
const denied = (error: unknown) => error instanceof MervError && error.status === 401;

test('a Scope token hash that is not in the ledger never authenticates, even after a restart', async () => {
  const state = await openState();
  let scope = await createService(new ProjectScope(state, () => time));
  const operator = await scope.bootstrap({ projectName: 'Migration', actorName: 'Operator' });
  const token = randomBytes(32).toString('base64url');
  const id = newId('credential');
  await state.transaction((tx) =>
    tx.run(
      'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at,expires_at,previous_id) VALUES(?,?,?,?,?,?,?,NULL)',
      id,
      operator.actor.id,
      operator.actor.projectId,
      'actor',
      sha256Hex(token),
      new Date(time).toISOString(),
      new Date(time + 60_000).toISOString(),
    ),
  );
  const caller = {
    actorId: operator.actor.id,
    projectId: operator.actor.projectId,
    credentialId: id,
  };
  await assert.rejects(scope.authenticate(token), denied);
  await assert.rejects(scope.require(caller, 'read'), denied);
  scope = await createService(new ProjectScope(state, () => time));
  await assert.rejects(scope.authenticate(token), denied);
  await assert.rejects(scope.require(caller, 'read'), denied);
  await assert.rejects(new CredentialStore(state, () => time).authenticate(token, 'actor'), denied);
  assert.equal(
    await state.read((sql) =>
      sql.get('SELECT 1 FROM identity_credentials WHERE token_hash=?', sha256Hex(token)),
    ),
    undefined,
  );
  // The operator's own credential, issued through the ledger, still works.
  assert.equal((await scope.authenticate(operator.token)).id, operator.actor.id);
  await state.close();
});
