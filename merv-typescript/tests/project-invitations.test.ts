import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';

const issuer = 'https://auth.example/auth/v1';
async function fixture(t: import('node:test').TestContext) {
  const state = await openState();
  t.after(() => state.close());
  let now = Date.parse('2026-10-14T12:00:00.000Z');
  const scope = await createService(new ProjectScope(state, () => now));
  const login = (subject: string, realm = issuer) =>
    scope.members.acceptVerifiedIdentity({
      issuer: realm,
      subject,
      expiresAt: new Date(now + 3600_000).toISOString(),
    });
  const owner = await login('owner');
  const project = await scope.members.createProject(owner, { name: 'Shared', requestId: 'shared' });
  const invite = (subject = 'recipient') =>
    scope.members.inviteMember(owner, project.id, {
      issuer,
      subject,
      email: `${subject}@example.com`,
      role: 'producer',
    });
  return {
    state,
    scope,
    owner,
    project,
    login,
    invite,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('invitation creates no actor; acceptance is atomic under duplicate requests and preserves creator billing', async (t) => {
  const f = await fixture(t);
  const before = await f.state.read((sql) => sql.all('SELECT id FROM actors'));
  const invitations = await Promise.all([f.invite(), f.invite()]);
  assert.equal(invitations[0]!.id, invitations[1]!.id);
  assert.deepEqual(await f.state.read((sql) => sql.all('SELECT id FROM actors')), before);
  const person = await f.login('recipient');
  const foreign = await f.login('recipient', 'https://other.example/auth/v1');
  await assert.rejects(
    () => f.scope.members.respondToInvitation(foreign, invitations[0]!.id, 'accept'),
    { code: 'not_found' },
  );
  const accepted = await Promise.all([
    f.scope.members.respondToInvitation(person, invitations[0]!.id, 'accept'),
    f.scope.members.respondToInvitation(person, invitations[0]!.id, 'accept'),
  ]);
  assert.equal(accepted[0]!.id, accepted[1]!.id);
});

test('expired invitations and invitations withdrawn when an operator loses authority cannot be accepted', async (t) => {
  const f = await fixture(t);
  const expired = await f.invite();
  f.advance(7 * 86400_000);
  await assert.rejects(() => f.scope.members.respondToInvitation(f.owner, expired.id, 'accept'), {
    code: 'unauthorized',
  });
  const person = await f.login('recipient');
  await assert.rejects(() => f.scope.members.respondToInvitation(person, expired.id, 'accept'), {
    code: 'invitation_closed',
  });
  const owner = await f.login('owner');
  const next = await f.scope.members.inviteMember(owner, f.project.id, {
    issuer,
    subject: 'recipient',
    email: 'recipient@example.com',
    role: 'operator',
  });
  const other = await f.login('other');
  await f.scope.members.addMember(owner, f.project.id, { subject: 'other', role: 'operator' });
  await f.scope.members.changeMemberRole(other, f.project.id, { subject: 'owner', role: 'reader' });
  assert.equal(
    (await f.scope.members.invitations(other, f.project.id)).find((i) => i.id === next.id)!.status,
    'revoked',
  );
  await assert.rejects(() => f.scope.members.respondToInvitation(person, next.id, 'accept'), {
    code: 'invitation_closed',
  });
  assert.deepEqual(await f.scope.projects(person), []);
});

test('failed acceptance audit rolls back both membership and invitation consumption', async (t) => {
  const f = await fixture(t);
  const offered = await f.invite();
  const person = await f.login('recipient');
  const append = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async () => {
    throw new Error('injected audit failure');
  };
  await assert.rejects(
    () => f.scope.members.respondToInvitation(person, offered.id, 'accept'),
    /audit failure/,
  );
  f.state.appendEvent = append;
  assert.deepEqual(await f.scope.projects(person), []);
  assert.equal((await f.scope.members.invitations(person))[0]!.status, 'pending');
  await f.scope.members.respondToInvitation(person, offered.id, 'accept');
  assert.equal((await f.scope.projects(person)).length, 1);
});
