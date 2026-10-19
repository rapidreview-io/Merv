import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService, type ProjectAdmin } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';

const issuer = 'https://identity.example/auth/v1';
const person = (subject: string): ProjectAdmin => ({ issuer, subject });

async function fixture() {
  const state = await openState();
  let time = Date.parse('2026-10-18T12:00:00.000Z');
  const scope = await createService(new ProjectScope(state, () => (time += 1)));
  const heard: [string, string][] = [];
  scope.members.onAdminChanged((projectId, admin) => heard.push([projectId, admin.subject]));
  // A listener's failure is its own.
  scope.members.onAdminChanged(() => {
    throw new Error('listener failed');
  });
  const login = async (subject: string) =>
    await scope.members.acceptVerifiedIdentity({
      issuer,
      subject,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  const owners = async () =>
    (await scope.projectOwners()).map(({ projectId, source }) => [
      projectId,
      source.kind === 'human' && source.subject,
    ]);
  return { state, scope, heard, login, owners };
}

test('the creator is the admin; setAdmin needs admin permission and a signed-in operator', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  const project = await f.scope.members.createProject(alice, { name: 'Billed', requestId: 'r' });
  assert.deepEqual(project.admin, person('alice'));
  assert.deepEqual(f.heard, [[project.id, 'alice']]);
  // The request replayed creates nothing and changes no admin.
  await f.scope.members.createProject(alice, { name: 'Billed', requestId: 'r' });
  assert.equal(f.heard.length, 1);
  for (const [subject, role] of [
    ['bob', 'operator'],
    ['reader', 'reader'],
    ['absent', 'operator'],
  ] as const)
    await f.scope.members.addMember(alice, project.id, { subject, role });
  const bob = await f.login('bob');
  const reader = await f.login('reader');
  await assert.rejects(f.scope.members.setAdmin(reader, project.id, person('bob')), {
    code: 'forbidden',
  });
  // A reader, an operator who never signed in, and nobody of the project cannot be its admin.
  for (const subject of ['reader', 'absent', 'stranger'])
    await assert.rejects(f.scope.members.setAdmin(alice, project.id, person(subject)), {
      code: 'admin_not_operator',
      status: 409,
    });
  assert.equal(f.heard.length, 1);
  const changed = await f.scope.members.setAdmin(bob, project.id, person('bob'));
  assert.deepEqual(changed.admin, person('bob'));
  assert.deepEqual((await f.scope.project(await f.scope.caller(alice, project.id))).admin, {
    issuer,
    subject: 'bob',
  });
  // Setting the admin it has is no change.
  await f.scope.members.setAdmin(alice, project.id, person('bob'));
  assert.deepEqual(f.heard, [
    [project.id, 'alice'],
    [project.id, 'bob'],
  ]);
  const events = (await f.state.events(project.id)).filter(
    (e) => e.type === 'project.admin_changed',
  );
  assert.deepEqual(
    events.map((e) => e.data),
    [{ issuer, subject: 'bob', before: person('alice') }],
  );
  // The owner is the stored admin, not the longest-standing operator.
  assert.deepEqual(await f.owners(), [[project.id, 'bob']]);
  assert.deepEqual((await f.scope.directory()).projects[0]!.admin, person('bob'));
});

test('an admin who stops being an operator hands it to the longest-standing live operator', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  const project = await f.scope.members.createProject(alice, { name: 'Handover', requestId: 'r' });
  for (const subject of ['bob', 'carol'])
    await f.scope.members.addMember(alice, project.id, { subject, role: 'operator' });
  const carol = await f.login('carol');
  const bob = await f.login('bob');
  await f.scope.members.setAdmin(alice, project.id, person('carol'));
  // Demoted, carol gives way to alice, the longest-standing operator; removed, alice to bob.
  await f.scope.members.changeMemberRole(carol, project.id, { subject: 'carol', role: 'reader' });
  assert.deepEqual(await f.owners(), [[project.id, 'alice']]);
  await f.scope.members.removeMember(alice, project.id, 'alice');
  assert.deepEqual(await f.owners(), [[project.id, 'bob']]);
  // Another member's removal keeps the admin.
  await f.scope.members.removeMember(bob, project.id, 'carol');
  assert.deepEqual(await f.owners(), [[project.id, 'bob']]);
  assert.deepEqual(
    f.heard.map(([, subject]) => subject),
    ['alice', 'carol', 'alice', 'bob'],
  );
});

test('scope@12 backfills each admin from the longest-standing signed-in operator', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  const kept = await f.scope.members.createProject(alice, { name: 'Kept', requestId: 'a' });
  const moved = await f.scope.members.createProject(alice, { name: 'Moved', requestId: 'b' });
  await f.scope.members.addMember(alice, moved.id, { subject: 'bob', role: 'operator' });
  await f.scope.members.addMember(alice, moved.id, { subject: 'carol', role: 'operator' });
  await f.login('carol');
  await f.scope.members.removeMember(alice, moved.id, 'alice');
  const boot = await f.scope.credentials.bootstrap({ projectName: 'Unowned', actorName: 'Op' });
  // The database as it stood before scope@12, which the next start applies.
  await f.state.transaction(async (tx) => {
    await tx.run('ALTER TABLE projects DROP COLUMN admin_issuer, DROP COLUMN admin_subject');
    await tx.run("DELETE FROM component_migrations WHERE component='scope' AND version=12");
  });
  const scope = await createService(new ProjectScope(f.state));
  const admins = new Map(
    (await scope.directory()).projects.map((p) => [p.id, p.admin?.subject ?? null]),
  );
  // bob never signed in, so carol, the next operator, is the one billed.
  assert.deepEqual(Object.fromEntries(admins), {
    [kept.id]: 'alice',
    [moved.id]: 'carol',
    [boot.project.id]: null,
  });
});
