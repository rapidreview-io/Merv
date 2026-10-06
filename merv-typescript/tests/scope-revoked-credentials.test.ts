import { createService, type Principal } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openState } from './fixtures/state.js';

// Identity's ledger alone decides whether a Scope credential or key is live; these pin that a
// revoked or expired one is refused on every path, whatever Scope's own row says.
const issuer = 'https://identity.example/auth/v1';
async function fixture(t: any) {
  const state = await openState(':memory:');
  t.after(() => state.close());
  let time = Date.parse('2026-10-06T12:00:00.000Z');
  const scope = await createService(new ProjectScope(state, () => time));
  const owner = await scope.members.acceptVerifiedIdentity({
    issuer,
    subject: 'owner',
    expiresAt: new Date(time + 86_400_000).toISOString(),
  });
  const project = await scope.members.createProject(owner, { name: 'Home', requestId: 'home' });
  const operator = await scope.caller(owner, project.id);
  const advance = (ms: number) => (time += ms);
  const later = (ms: number) => new Date(time + ms).toISOString();
  return { scope, owner, project, operator, advance, later };
}
const unauthorized = { code: 'unauthorized', status: 401 };
const forbidden = { code: 'forbidden', status: 403 };

test('a revoked actor credential is refused at sign-in and in every decision', async (t) => {
  const { scope, operator } = await fixture(t);
  const issued = await scope.credentials.issueActor(operator, { name: 'Bot', role: 'producer' });
  const caller = {
    actorId: issued.actor.id,
    projectId: issued.actor.projectId,
    credentialId: issued.credential.id,
  };
  await scope.require(caller, 'write');
  await scope.credentials.revokeCredential(operator, issued.credential.id);
  await assert.rejects(scope.authenticate(issued.token), unauthorized);
  await assert.rejects(scope.require(caller, 'read'), forbidden);
  assert.equal(await scope.recognizesCredential(issued.token), true, 'still one Scope issued');
});

test('an expired actor credential is refused at sign-in and in every decision', async (t) => {
  const { scope, operator, advance, later } = await fixture(t);
  const issued = await scope.credentials.issueActor(operator, {
    name: 'Bot',
    role: 'producer',
    expiresAt: later(60_000),
  });
  const caller = {
    actorId: issued.actor.id,
    projectId: issued.actor.projectId,
    credentialId: issued.credential.id,
  };
  await scope.require(caller, 'write');
  advance(60_000);
  await assert.rejects(scope.authenticate(issued.token), unauthorized);
  await assert.rejects(scope.require(caller, 'read'), forbidden);
});

test('a revoked or expired user key is refused at sign-in and in every decision', async (t) => {
  const { scope, owner, project, advance, later } = await fixture(t);
  for (const end of ['revoke', 'expire'] as const) {
    const issued = await scope.userKeys.create(owner, {
      projectId: project.id,
      expiresAt: later(60_000),
    });
    const principal: Principal = {
      kind: 'key',
      key: await scope.userKeys.authenticate(issued.token),
    };
    const caller = await scope.caller(principal);
    await scope.require(caller, 'write');
    if (end === 'revoke') await scope.userKeys.revoke(owner, issued.key.id);
    else advance(60_000);
    await assert.rejects(scope.userKeys.authenticate(issued.token), unauthorized);
    await assert.rejects(scope.caller(principal), forbidden);
    await assert.rejects(scope.require(caller, 'read'), forbidden);
    assert.equal(await scope.recognizesCredential(issued.token), true);
  }
});

test('a token Scope never issued is not recognized', async (t) => {
  const { scope } = await fixture(t);
  assert.equal(await scope.recognizesCredential(`mk_${'a'.repeat(43)}`), false);
  assert.equal(await scope.recognizesCredential('x'.repeat(40)), false);
});
