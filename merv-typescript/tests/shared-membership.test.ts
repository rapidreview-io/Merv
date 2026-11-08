import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';

import { test } from 'node:test';

import type { Principal, Role } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { Memberships } from '@merv/scope/memberships';

import { openState } from './fixtures/state.js';

const issuer = 'https://identity.example/auth/v1';
const initialTime = Date.parse('2026-09-16T12:00:00.000Z');
async function fixture(path = ':memory:') {
  const state = await openState(path);
  let time = initialTime;
  const scope = await createService(new ProjectScope(state, () => time));
  const login = async (subject: string, realm = issuer) =>
    await scope.members.acceptVerifiedIdentity({
      issuer: realm,
      subject,
      expiresAt: new Date(time + 60_000).toISOString(),
    });
  return {
    state,
    scope,
    login,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('one human has independent project roles and attribution actors; issuer and machine boundaries remain exact', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice'),
    bob = await f.login('bob');
  const a = await f.scope.members.createProject(alice, { name: 'A', requestId: 'A' });
  const b = await f.scope.members.createProject(bob, { name: 'B', requestId: 'B' });
  await f.scope.members.addMember(bob, b.id, { subject: 'alice', role: 'reader' });
  const inA = await f.scope.caller(alice, a.id),
    inB = await f.scope.caller(alice, b.id);
  assert.notEqual(inA.actorId, inB.actorId);
  const pendingCaller = structuredClone(inA);
  const authorized = f.scope.require(pendingCaller, 'admin');
  pendingCaller.human!.subject = 'changed';
  assert.equal((await authorized).role, 'operator');
  assert.equal((await f.scope.require(inB, 'read')).role, 'reader');
  await assert.rejects(async () => await f.scope.require(inB, 'write'), { code: 'forbidden' });
  assert.deepEqual(
    new Set((await f.scope.projects(alice)).map((value) => value.id)),
    new Set([a.id, b.id]),
  );
  await assert.rejects(async () => await f.scope.caller(bob, a.id), {
    code: 'membership_required',
  });
  const otherRealm = await f.login('alice', 'https://elsewhere.example/auth/v1');
  assert.deepEqual(await f.scope.projects(otherRealm), []);
  await assert.rejects(async () => await f.scope.caller(otherRealm, a.id), {
    code: 'membership_required',
  });
  const machine = await f.scope.credentials.issueActor(inA, {
    name: 'Worker operator',
    role: 'operator',
  });
  const principal: Principal = { kind: 'actor', actor: await f.scope.authenticate(machine.token) };
  assert.deepEqual(await f.scope.projects(principal), [a]);
  assert.equal((await f.scope.caller(principal)).projectId, a.id);
  await assert.rejects(async () => await f.scope.caller(principal, b.id), { code: 'forbidden' });
  for (const action of [
    async () =>
      await f.scope.members.createProject(principal, {
        name: 'Machine-owned',
        requestId: 'machine',
      }),
    async () =>
      await f.scope.members.addMember(principal, a.id, { subject: 'mallory', role: 'operator' }),
    async () =>
      await f.scope.members.changeMemberRole(principal, a.id, { subject: 'alice', role: 'reader' }),
    async () => await f.scope.members.removeMember(principal, a.id, 'alice'),
    async () => await f.scope.members.memberships(principal, a.id),
  ])
    await assert.rejects(action, { code: 'forbidden' });
  assert.equal(
    (await f.scope.members.memberships(alice, b.id)).memberships.filter((value) => value.active)
      .length,
    2,
    'Every human member may read membership history',
  );
  const changing = structuredClone(alice);
  const head = await f.state.eventHead();
  let swapTo = 'bob';
  const human = Memberships.prototype.human;
  const swapped = t.mock.method(
    Memberships.prototype,
    'human',
    async function (this: Memberships, ...args: Parameters<typeof human>) {
      const checked = await human.apply(this, args);
      changing.user.subject = swapTo;
      return checked;
    },
  );
  try {
    for (const operation of [
      () => f.scope.members.addMember(changing, b.id, { subject: 'mallory', role: 'operator' }),
      () =>
        f.scope.members.changeMemberRole(changing, b.id, { subject: 'alice', role: 'operator' }),
      () => f.scope.members.removeMember(changing, b.id, 'alice'),
    ]) {
      changing.user.subject = 'alice';
      await assert.rejects(operation, { code: 'forbidden' });
    }
    swapTo = 'alice';
    changing.user.subject = 'bob';
    await assert.rejects(() => f.scope.members.memberships(changing, a.id), {
      code: 'membership_required',
    });
  } finally {
    swapped.mock.restore();
  }
  assert.equal(await f.state.eventHead(), head);
});

test('role changes and remove/rejoin preserve actor attribution but fence every old membership epoch', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice'),
    bob = await f.login('bob');
  const project = await f.scope.members.createProject(alice, {
    name: 'Epochs',
    requestId: 'create',
  });
  const invitation = { subject: 'bob', role: 'reviewer' as Role };
  const inviting = f.scope.members.addMember(alice, project.id, invitation);
  invitation.subject = 'mallory';
  invitation.role = 'operator';
  const initial = await inviting;
  assert.deepEqual([initial.subject, initial.role], ['bob', 'reviewer']);
  const old = await f.scope.caller(bob, project.id);
  const change = { subject: 'bob', role: 'reader' as Role };
  const changing = f.scope.members.changeMemberRole(alice, project.id, change);
  change.role = 'operator';
  const changed = await changing;
  assert.equal(changed.actorId, initial.actorId);
  assert.notEqual(changed.id, initial.id);
  await assert.rejects(async () => await f.scope.require(old, 'read'), {
    code: 'membership_required',
  });
  const reader = await f.scope.caller(bob, project.id);
  assert.equal((await f.scope.require(reader, 'read')).role, 'reader');
  assert.equal(await f.scope.eligible(project.id, initial.actorId, 'review'), false);
  const roleEvent = (await f.state.events(project.id)).findLast(
    (event) => event.type === 'actor.permissions_changed',
  )!;
  assert.deepEqual(roleEvent.data, {
    beforeRole: 'reviewer',
    role: 'reader',
    previousMembershipId: initial.id,
    membershipId: changed.id,
  });
  assert.equal(
    (await f.scope.actors(await f.scope.caller(alice, project.id))).find(
      (value) => value.id === initial.actorId,
    )?.active,
    true,
  );
  await f.scope.members.removeMember(alice, project.id, 'bob');
  const head = await f.state.eventHead();
  await f.scope.members.removeMember(alice, project.id, 'bob');
  await f.scope.members.removeMember(alice, project.id, 'never-invited');
  assert.equal(await f.state.eventHead(), head, 'Repeated removal creates no second revoke event');
  await assert.rejects(async () => await f.scope.require(reader, 'read'), {
    code: 'membership_required',
  });
  assert.equal(await f.scope.eligible(project.id, initial.actorId, 'read'), false);
  const rejoined = await f.scope.members.addMember(alice, project.id, {
    subject: 'bob',
    role: 'reviewer',
  });
  const fresh = await f.scope.caller(bob, project.id);
  assert.equal(rejoined.actorId, initial.actorId);
  assert.notEqual(rejoined.id, initial.id);
  assert.notEqual(rejoined.id, changed.id);
  assert.equal((await f.scope.require(fresh, 'review')).id, initial.actorId);
  for (const previous of [old, reader])
    await assert.rejects(
      async () =>
        await f.state.transaction(async (tx) => await f.scope.require(previous, 'read', tx)),
      {
        code: 'membership_required',
      },
    );
  const history = (await f.scope.members.memberships(alice, project.id)).memberships.filter(
    (value) => value.subject === 'bob',
  );
  assert.deepEqual(
    history.map((value) => [value.id, value.active]),
    [
      [initial.id, false],
      [changed.id, false],
      [rejoined.id, true],
    ],
  );
  for (const forged of [
    { actorId: fresh.actorId, projectId: fresh.projectId },
    { ...fresh, human: { ...fresh.human!, subject: 'alice' } },
    { ...fresh, human: { ...fresh.human!, issuer: 'https://foreign.example' } },
    { ...fresh, human: { ...fresh.human!, membershipId: initial.id } },
  ])
    await assert.rejects(async () => await f.scope.require(forged, 'read'), {
      code: 'membership_required',
    });
  await assert.rejects(
    async () => await f.scope.require({ ...fresh, credentialId: 'forged' }, 'read'),
    {
      code: 'forbidden',
    },
  );
});

test('the last verified human operator is protected until another invited operator first logs in', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  const project = await f.scope.members.createProject(alice, {
    name: 'Handoff',
    requestId: 'create',
  });
  await f.scope.members.addMember(alice, project.id, { subject: 'bob', role: 'operator' });
  for (const action of [
    async () => await f.scope.members.removeMember(alice, project.id, 'alice'),
    async () =>
      await f.scope.members.changeMemberRole(alice, project.id, {
        subject: 'alice',
        role: 'reader',
      }),
  ])
    await assert.rejects(action, { code: 'last_operator', status: 409 });
  await f.scope.members.removeMember(alice, project.id, 'bob');
  await f.scope.members.addMember(alice, project.id, { subject: 'bob', role: 'operator' });
  const bob = await f.login('bob');
  await f.scope.members.removeMember(alice, project.id, 'alice');
  assert.equal(
    (await f.scope.require(await f.scope.caller(bob, project.id), 'admin')).role,
    'operator',
  );
  await assert.rejects(async () => await f.scope.members.removeMember(bob, project.id, 'bob'), {
    code: 'last_operator',
  });
});

test('membership mutations, actor state and project receipts roll back with failed audit events', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice'),
    bob = await f.login('bob');
  const project = await f.scope.members.createProject(alice, {
    name: 'Atomic',
    requestId: 'create',
  });
  await f.scope.members.addMember(alice, project.id, { subject: 'bob', role: 'reviewer' });
  const snapshot = async () =>
    await f.state.read(async (sql) => ({
      projects: await sql.all('SELECT * FROM projects'),
      actors: await sql.all('SELECT * FROM actors'),
      links: await sql.all('SELECT * FROM member_actors'),
      memberships: await sql.all('SELECT * FROM project_memberships'),
      receipts: await sql.all('SELECT * FROM user_project_requests'),
      events: await sql.all('SELECT * FROM events'),
    }));
  const before = await snapshot();
  const append = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    await append(tx, event);
    throw Error('Injected membership event failure');
  };
  for (const action of [
    async () => await f.scope.members.createProject(alice, { name: 'Failed', requestId: 'failed' }),
    async () =>
      await f.scope.members.addMember(alice, project.id, { subject: 'charlie', role: 'reader' }),
    async () =>
      await f.scope.members.changeMemberRole(alice, project.id, {
        subject: 'bob',
        role: 'producer',
      }),
    async () => await f.scope.members.removeMember(alice, project.id, 'bob'),
    async () =>
      await f.scope.members.adoptProject(bob, project.id, {
        repairReason: 'Host administrator recovery.',
      }),
  ]) {
    await assert.rejects(action, /Injected membership event failure/);
    assert.deepEqual(await snapshot(), before);
  }
  f.state.appendEvent = append;
  assert.equal(
    (await f.scope.require(await f.scope.caller(bob, project.id), 'review')).role,
    'reviewer',
  );
  assert.notEqual(
    (await f.scope.members.createProject(alice, { name: 'Failed', requestId: 'failed' })).id,
    project.id,
  );
});
