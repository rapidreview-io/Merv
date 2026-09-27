import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createService, newId, sha256Hex, MervError } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { CredentialStore } from '@merv/identity/credentials';
import { openState } from './fixtures/state.js';

const time = Date.parse('2026-09-26T10:00:00.000Z');
const denied = (error: unknown) => error instanceof MervError && error.status === 401;

test('Scope adopts a legacy hash on restart but cannot revive central revocation', async () => {
  const state = await openState();
  let scope = await createService(new ProjectScope(state, () => time));
  const operator = await scope.bootstrap({ projectName: 'Migration', actorName: 'Operator' });
  const token = randomBytes(32).toString('base64url');
  const id = newId('credential');
  const expiresAt = new Date(time + 60_000).toISOString();
  await state.transaction((tx) =>
    tx.run(
      'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at,expires_at,previous_id) VALUES(?,?,?,?,?,?,?,NULL)',
      id,
      operator.actor.id,
      operator.actor.projectId,
      'actor',
      sha256Hex(token),
      new Date(time).toISOString(),
      expiresAt,
    ),
  );
  await assert.rejects(scope.authenticate(token), denied);
  scope = await createService(new ProjectScope(state, () => time));
  assert.equal((await scope.authenticate(token)).credential.id, id);
  const credentials = new CredentialStore(state, () => time);
  await credentials.revoke(sha256Hex(token), 'scope');
  await assert.rejects(scope.authenticate(token), denied);
  scope = await createService(new ProjectScope(state, () => time));
  await assert.rejects(scope.authenticate(token), denied);
  await state.close();
});
