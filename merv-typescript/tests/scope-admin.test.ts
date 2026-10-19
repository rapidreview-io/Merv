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

test('the creator is the admin; setAdmin needs admin permission, a signed-in operator and consent', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  const project = await f.scope.members.createProject(alice, { name: 'Billed', requestId: 'r' });
  const members = async () => await f.scope.members.memberships(alice, project.id);
  assert.deepEqual((await members()).admin, person('alice'));
  // Agents read the project: it never names the person billed for it.
  assert.deepEqual(Object.keys(project).sort(), ['createdAt', 'id', 'name']);
  assert.deepEqual(f.heard, [[project.id, 'alice']]);
  // The request replayed creates nothing and changes no admin.
  await f.scope.members.createProject(alice, { name: 'Billed', requestId: 'r' });
  assert.equal(f.heard.length, 1);
  for (const [subject, role] of [
    ['bob', 'operator'],
    ['carol', 'operator'],
    ['reader', 'reader'],
    ['absent', 'operator'],
  ] as const)
    await f.scope.members.addMember(alice, project.id, { subject, role });
  const bob = await f.login('bob');
  await f.login('carol');
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
  // The members read says whom its caller may bill: the admin, the other signed-in operators;
  // another operator, themselves; a reader, nobody.
  const { memberships } = await members();
  const payers = async (who: typeof alice) =>
    (await f.scope.members.memberships(who, project.id)).payers.map(
      (id) => memberships.find((m) => m.id === id)!.subject,
    );
  assert.deepEqual(await payers(alice), ['bob', 'carol']);
  assert.deepEqual(await payers(bob), ['bob']);
  assert.deepEqual(await payers(reader), []);
  // Only the admin names another operator to bill; any operator takes billing on themselves.
  await assert.rejects(f.scope.members.setAdmin(bob, project.id, person('carol')), {
    code: 'admin_consent',
    status: 403,
  });
  assert.deepEqual(await f.scope.members.setAdmin(bob, project.id, person('bob')), person('bob'));
  assert.deepEqual((await members()).admin, person('bob'));
  await assert.rejects(f.scope.members.setAdmin(alice, project.id, person('carol')), {
    code: 'admin_consent',
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
});

test('an admin who stops being an operator hands it to the operator who ended it, else the longest-standing', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  const project = await f.scope.members.createProject(alice, { name: 'Handover', requestId: 'r' });
  for (const subject of ['bob', 'carol', 'dave'])
    await f.scope.members.addMember(alice, project.id, { subject, role: 'operator' });
  const [bob, carol, dave] = [await f.login('bob'), await f.login('carol'), await f.login('dave')];
  // Whoever removes or demotes the admin takes billing on, never pushing it onto bob.
  await f.scope.members.removeMember(carol, project.id, 'alice');
  assert.deepEqual(await f.owners(), [[project.id, 'carol']]);
  await f.scope.members.changeMemberRole(dave, project.id, { subject: 'carol', role: 'reader' });
  assert.deepEqual(await f.owners(), [[project.id, 'dave']]);
  // Demoting themselves, dave gives way to bob, the longest-standing operator.
  await f.scope.members.changeMemberRole(dave, project.id, { subject: 'dave', role: 'reader' });
  assert.deepEqual(await f.owners(), [[project.id, 'bob']]);
  // Another member's removal keeps the admin.
  await f.scope.members.removeMember(bob, project.id, 'carol');
  assert.deepEqual(await f.owners(), [[project.id, 'bob']]);
  assert.deepEqual(
    f.heard.map(([, subject]) => subject),
    ['alice', 'carol', 'dave', 'bob'],
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
  await createService(new ProjectScope(f.state));
  const admins = await f.state.read((sql) =>
    sql.all<{ id: string; admin_subject: string | null }>('SELECT id,admin_subject FROM projects'),
  );
  // bob never signed in, so carol, the next operator, is the one billed.
  assert.deepEqual(Object.fromEntries(admins.map((p) => [p.id, p.admin_subject])), {
    [kept.id]: 'alice',
    [moved.id]: 'carol',
    [boot.project.id]: null,
  });
});
