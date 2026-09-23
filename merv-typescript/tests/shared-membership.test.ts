import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { ProjectScope } from '@merv/scope';
import { Memberships } from '@merv/scope/memberships';
import type { Caller, HumanPrincipal, Principal, Role } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';
import { openState, schemaFor } from './fixtures/state.js';
import { raceWriters, scopeWriter } from './fixtures/writer-race.js';

const issuer = 'https://identity.example/auth/v1';
const initialTime = Date.parse('2026-09-16T12:00:00.000Z');
async function fixture(path = ':memory:') {
  const state = await openState(path);
  let time = initialTime;
  const scope = await createService(new ProjectScope(state, () => time));
  const login = async (subject: string, realm = issuer) =>
    await scope.acceptVerifiedIdentity({
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

test('verified identities onboard independently of projects; creation receipts remain scoped and permission checked', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  assert.deepEqual(await f.scope.projects(alice), []);
  await assert.rejects(async () => await f.scope.caller(alice), { code: 'project_required' });
  const creation = { name: 'Research', requestId: 'create' };
  const creating = f.scope.createProject(alice, creation);
  creation.requestId = ' ';
  const project = await creating;
  const caller = await f.scope.caller(alice, project.id);
  assert.equal((await f.scope.require(caller, 'admin')).role, 'operator');
  assert.deepEqual((await f.scope.require(caller, 'read')).user, { issuer, subject: 'alice' });
  assert.equal(caller.credentialId, undefined);
  assert.deepEqual(await f.scope.actorCredentials(caller), []);
  const head = await f.state.eventHead();
  assert.deepEqual(
    await f.scope.createProject(alice, { name: 'Research', requestId: 'create' }),
    project,
  );
  assert.equal(await f.state.eventHead(), head);
  await assert.rejects(
    async () => await f.scope.createProject(alice, { name: 'Changed', requestId: 'create' }),
    {
      code: 'request_conflict',
    },
  );
  const bob = await f.login('bob');
  const b = await f.scope.createProject(bob, { name: 'Bob project', requestId: 'create' });
  assert.notEqual(b.id, project.id, 'Project receipts are scoped to verified identity');
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'operator' });
  await f.scope.removeMember(bob, project.id, 'alice');
  await assert.rejects(
    async () => await f.scope.createProject(alice, { name: 'Research', requestId: 'create' }),
    {
      code: 'membership_required',
    },
  );
  assert.deepEqual(await f.scope.projects(alice), []);
  await assert.rejects(async () => await f.scope.require(caller, 'read'), {
    code: 'membership_required',
  });
  const stored = JSON.stringify(
    await f.state.read(async (sql) => ({
      users: await sql.all('SELECT * FROM shared_users'),
      requests: await sql.all('SELECT * FROM user_project_requests'),
    })),
  );
  assert.equal(
    stored.includes('expiresAt'),
    false,
    'No bearer/session authority is persisted with shared users',
  );
});

test('one human has independent project roles and attribution actors; issuer and machine boundaries remain exact', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice'),
    bob = await f.login('bob');
  const a = await f.scope.createProject(alice, { name: 'A', requestId: 'A' });
  const b = await f.scope.createProject(bob, { name: 'B', requestId: 'B' });
  await f.scope.addMember(bob, b.id, { subject: 'alice', role: 'reader' });
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
  const machine = await f.scope.issueActor(inA, { name: 'Worker operator', role: 'operator' });
  const principal: Principal = { kind: 'actor', actor: await f.scope.authenticate(machine.token) };
  assert.deepEqual(await f.scope.projects(principal), [a]);
  assert.equal((await f.scope.caller(principal)).projectId, a.id);
  await assert.rejects(async () => await f.scope.caller(principal, b.id), { code: 'forbidden' });
  for (const action of [
    async () =>
      await f.scope.createProject(principal, { name: 'Machine-owned', requestId: 'machine' }),
    async () => await f.scope.addMember(principal, a.id, { subject: 'mallory', role: 'operator' }),
    async () =>
      await f.scope.changeMemberRole(principal, a.id, { subject: 'alice', role: 'reader' }),
    async () => await f.scope.removeMember(principal, a.id, 'alice'),
    async () => await f.scope.memberships(principal, a.id),
  ])
    await assert.rejects(action, { code: 'forbidden' });
  assert.equal(
    (await f.scope.memberships(alice, b.id)).filter((value) => value.active).length,
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
      () => f.scope.addMember(changing, b.id, { subject: 'mallory', role: 'operator' }),
      () => f.scope.changeMemberRole(changing, b.id, { subject: 'alice', role: 'operator' }),
      () => f.scope.removeMember(changing, b.id, 'alice'),
    ]) {
      changing.user.subject = 'alice';
      await assert.rejects(operation, { code: 'forbidden' });
    }
    swapTo = 'alice';
    changing.user.subject = 'bob';
    await assert.rejects(() => f.scope.memberships(changing, a.id), {
      code: 'membership_required',
    });
  } finally {
    swapped.mock.restore();
  }
  assert.equal(await f.state.eventHead(), head);
});

test('invitations do not verify users, login preserves user identity, and expiration is rechecked inside transactions', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  const project = await f.scope.createProject(alice, { name: 'Invitations', requestId: 'create' });
  const invitation = await f.scope.addMember(alice, project.id, {
    subject: 'bob',
    role: 'reviewer',
  });
  assert.equal(
    await f.state.read(
      async (sql) =>
        await sql.get('SELECT * FROM shared_users WHERE issuer=? AND subject=?', issuer, 'bob'),
    ),
    undefined,
  );
  const fake: HumanPrincipal = {
    kind: 'user',
    user: { issuer, subject: 'bob', createdAt: 'invented' },
    expiresAt: new Date(initialTime + 60_000).toISOString(),
  };
  await assert.rejects(async () => await f.scope.caller(fake, project.id), {
    code: 'unauthorized',
  });
  const bob = await f.login('bob');
  assert.equal((await f.scope.caller(bob, project.id)).actorId, invitation.actorId);
  const first = await f.scope.caller(bob, project.id);
  assert.equal(first.human?.membershipId, invitation.id);
  f.advance(1000);
  const refreshed = await f.login('bob');
  assert.deepEqual(refreshed.user, bob.user);
  assert.notEqual(refreshed.expiresAt, bob.expiresAt);
  assert.deepEqual(
    await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'reviewer' }),
    invitation,
  );
  await assert.rejects(
    async () => await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'reader' }),
    {
      code: 'membership_exists',
    },
  );
  f.advance(59_000);
  await assert.rejects(async () => await f.scope.projects(bob), { code: 'unauthorized' });
  await assert.rejects(
    async () => await f.state.transaction(async (tx) => await f.scope.require(first, 'review', tx)),
    {
      code: 'forbidden',
    },
  );
  assert.equal(
    (await f.scope.require(await f.scope.caller(refreshed, project.id), 'review')).id,
    invitation.actorId,
  );
  assert.equal(
    await f.scope.eligible(project.id, invitation.actorId, 'review'),
    true,
    'Membership eligibility is not tied to one expired login',
  );
});

test('existing verified identities use a read path while first insertion rechecks expiry after acquiring its transaction', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const initial = await f.login('alice');
  const transaction = f.state.transaction.bind(f.state);
  f.state.transaction = async () => {
    throw new Error('Unexpected identity write transaction');
  };
  assert.deepEqual(await f.login('alice'), initial);
  const identity = { ...initial.user, expiresAt: initial.expiresAt };
  const accepting = f.scope.acceptVerifiedIdentity(identity);
  identity.subject = 'unverified';
  identity.expiresAt = new Date(initialTime + 120_000).toISOString();
  assert.deepEqual(await accepting, initial);
  const expiring = f.scope.acceptVerifiedIdentity({
    ...initial.user,
    expiresAt: initial.expiresAt,
  });
  f.advance(60_000);
  await assert.rejects(expiring, { code: 'unauthorized' });
  await assert.rejects(
    async () =>
      await f.scope.acceptVerifiedIdentity({
        issuer,
        subject: 'alice',
        expiresAt: initial.expiresAt,
      }),
    { code: 'unauthorized' },
  );
  f.state.transaction = transaction;
  let first = true;
  const scope = await createService(
    new ProjectScope(f.state, () => {
      const time = first ? initialTime : initialTime + 2000;
      first = false;
      return time;
    }),
  );
  await assert.rejects(
    async () =>
      await scope.acceptVerifiedIdentity({
        issuer,
        subject: 'expired-before-insert',
        expiresAt: new Date(initialTime + 1000).toISOString(),
      }),
    { code: 'unauthorized' },
  );
  assert.equal(
    await f.state.read(
      async (sql) =>
        await sql.get('SELECT * FROM shared_users WHERE subject=?', 'expired-before-insert'),
    ),
    undefined,
  );
});

test('human validation retains the original expiry and rejects expiry during the user lookup', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const principal = await f.login('alice');
  const expiresAt = principal.expiresAt;
  let time = initialTime;
  const members = new Memberships(
    f.state,
    () => new Date(time).toISOString(),
    f.scope.require.bind(f.scope),
  );
  await f.state.transaction(async (tx) => {
    const pending = members.human(principal, tx);
    principal.expiresAt = new Date(initialTime + 120_000).toISOString();
    assert.equal((await pending).expiresAt, expiresAt);
  });
  await f.state.transaction(async (tx) => {
    const pending = members.human({ ...principal, expiresAt }, tx);
    time += 60_000;
    await assert.rejects(pending, { code: 'unauthorized' });
  });
});

test('role changes and remove/rejoin preserve actor attribution but fence every old membership epoch', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice'),
    bob = await f.login('bob');
  const project = await f.scope.createProject(alice, { name: 'Epochs', requestId: 'create' });
  const invitation = { subject: 'bob', role: 'reviewer' as Role };
  const inviting = f.scope.addMember(alice, project.id, invitation);
  invitation.subject = 'mallory';
  invitation.role = 'operator';
  const initial = await inviting;
  assert.deepEqual([initial.subject, initial.role], ['bob', 'reviewer']);
  const old = await f.scope.caller(bob, project.id);
  const change = { subject: 'bob', role: 'reader' as Role };
  const changing = f.scope.changeMemberRole(alice, project.id, change);
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
  await f.scope.removeMember(alice, project.id, 'bob');
  const head = await f.state.eventHead();
  await f.scope.removeMember(alice, project.id, 'bob');
  await f.scope.removeMember(alice, project.id, 'never-invited');
  assert.equal(await f.state.eventHead(), head, 'Repeated removal creates no second revoke event');
  await assert.rejects(async () => await f.scope.require(reader, 'read'), {
    code: 'membership_required',
  });
  assert.equal(await f.scope.eligible(project.id, initial.actorId, 'read'), false);
  const rejoined = await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'reviewer' });
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
  const history = (await f.scope.memberships(alice, project.id)).filter(
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

test('member actors cannot receive machine tokens or generic revocation; independent machine actors survive member loss', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice'),
    bob = await f.login('bob');
  const project = await f.scope.createProject(alice, {
    name: 'Actor boundaries',
    requestId: 'create',
  });
  const caller = await f.scope.caller(alice, project.id);
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'operator' });
  const machine = await f.scope.issueActor(caller, { name: 'Runner', role: 'producer' });
  for (const action of [
    async () => await f.scope.issueActorCredential(caller, { actorId: caller.actorId }),
    async () => await f.scope.revokeActor(caller, caller.actorId),
  ])
    await assert.rejects(action, { code: 'member_actor' });
  // Even a malformed imported credential must never make a member actor a machine principal.
  const token = 'test-imported-member-credential-'.repeat(2);
  await f.state.transaction(
    async (tx) =>
      await tx.run(
        'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at) VALUES(?,?,?,?,?,?)',
        'credential_imported',
        caller.actorId,
        caller.projectId,
        'actor',
        createHash('sha256').update(token).digest('hex'),
        new Date(initialTime).toISOString(),
      ),
  );
  await assert.rejects(async () => await f.scope.authenticate(token), { code: 'unauthorized' });
  for (const action of [
    async () => await f.scope.rotateCredential(caller, { credentialId: 'credential_imported' }),
    async () => await f.scope.revokeCredential(caller, 'credential_imported'),
  ])
    await assert.rejects(action, { code: 'member_actor' });
  await f.scope.removeMember(bob, project.id, 'alice');
  assert.equal((await f.scope.authenticate(machine.token)).id, machine.actor.id);
  assert.equal(
    (
      await f.scope.require(
        { actorId: machine.actor.id, projectId: project.id, credentialId: machine.credential.id },
        'write',
      )
    ).id,
    machine.actor.id,
  );
  await assert.rejects(
    async () =>
      await f.scope.require(
        { actorId: machine.actor.id, projectId: project.id, human: caller.human },
        'read',
      ),
    { code: 'forbidden' },
  );
});

test('the last verified human operator is protected until another invited operator first logs in', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice');
  const project = await f.scope.createProject(alice, { name: 'Handoff', requestId: 'create' });
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'operator' });
  for (const action of [
    async () => await f.scope.removeMember(alice, project.id, 'alice'),
    async () =>
      await f.scope.changeMemberRole(alice, project.id, { subject: 'alice', role: 'reader' }),
  ])
    await assert.rejects(action, { code: 'last_operator', status: 409 });
  await f.scope.removeMember(alice, project.id, 'bob');
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'operator' });
  const bob = await f.login('bob');
  await f.scope.removeMember(alice, project.id, 'alice');
  assert.equal(
    (await f.scope.require(await f.scope.caller(bob, project.id), 'admin')).role,
    'operator',
  );
  await assert.rejects(async () => await f.scope.removeMember(bob, project.id, 'bob'), {
    code: 'last_operator',
  });
});

test('simultaneous self-demotions leave one verified human operator after serialized checks', async (t) => {
  const f = await fixture('member-operator-race');
  t.after(async () => await f.state.close());
  const alice = await f.login('alice'),
    bob = await f.login('bob');
  const project = await f.scope.createProject(alice, {
    name: 'Operator race',
    requestId: 'create',
  });
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'operator' });
  const demote = (principal: HumanPrincipal) => async (scope: ProjectScope) =>
    (
      await scope.changeMemberRole(principal, project.id, {
        subject: principal.user.subject,
        role: 'reader',
      })
    ).role;
  const race = await raceWriters({
    schema: schemaFor('member-operator-race'),
    service: scopeWriter(() => initialTime, 'actor.permissions_changed'),
    first: demote(alice),
    second: demote(bob),
  });
  assert.equal(
    race.secondEnteredWhileHeld,
    false,
    'Second operator check waits for the first transaction',
  );
  assert.deepEqual(race.first, { ok: true, value: 'reader' });
  assert.deepEqual(race.second, { ok: false, code: 'last_operator', status: 409 });
  assert.equal(
    (await f.scope.require(await f.scope.caller(alice, project.id), 'read')).role,
    'reader',
  );
  assert.equal(
    (await f.scope.require(await f.scope.caller(bob, project.id), 'admin')).role,
    'operator',
  );
  assert.equal(
    (await f.scope.memberships(bob, project.id)).filter(
      (value) => value.active && value.role === 'operator',
    ).length,
    1,
  );
});

test('membership mutations, actor state and project receipts roll back with failed audit events', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const alice = await f.login('alice'),
    bob = await f.login('bob');
  const project = await f.scope.createProject(alice, { name: 'Atomic', requestId: 'create' });
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'reviewer' });
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
    async () => await f.scope.createProject(alice, { name: 'Failed', requestId: 'failed' }),
    async () => await f.scope.addMember(alice, project.id, { subject: 'charlie', role: 'reader' }),
    async () =>
      await f.scope.changeMemberRole(alice, project.id, { subject: 'bob', role: 'producer' }),
    async () => await f.scope.removeMember(alice, project.id, 'bob'),
    async () =>
      await f.scope.adoptProject(bob, project.id, { repairReason: 'Host administrator recovery.' }),
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
    (await f.scope.createProject(alice, { name: 'Failed', requestId: 'failed' })).id,
    project.id,
  );
});

test('v2 migration preserves local projects and credentials; adoption is explicit and ownership repair is audited', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-shared-membership-v2-'));
  const path = directory;
  let state = await openState(path);
  t.after(async () => {
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const migrate = state.migrate.bind(state);
  state.migrate = async (component, migrations) =>
    await migrate(
      component,
      component === 'scope' ? migrations.filter((migration) => migration.version <= 2) : migrations,
    );
  const oldScope = await createService(new ProjectScope(state));
  const legacy = await oldScope.bootstrap({ projectName: 'Legacy', actorName: 'Local operator' });
  state.migrate = migrate;
  let scope = await createService(new ProjectScope(state));
  assert.deepEqual(await scope.authenticate(legacy.token), {
    ...legacy.actor,
    credential: legacy.credential,
  });
  const login = async (subject: string) =>
    await scope.acceptVerifiedIdentity({
      issuer,
      subject,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  const alice = await login('alice');
  assert.deepEqual(await scope.projects(alice), [], 'First login never silently adopts local data');
  const adopted = await scope.adoptProject(alice, legacy.project.id);
  assert.equal(adopted.role, 'operator');
  assert.notEqual(adopted.actorId, legacy.actor.id);
  assert.equal((await scope.authenticate(legacy.token)).id, legacy.actor.id);
  const rescuer = await login('rescuer');
  await assert.rejects(async () => await scope.adoptProject(rescuer, legacy.project.id), {
    code: 'project_already_adopted',
  });
  for (const repairReason of ['', ' ', 'x'.repeat(2001)])
    await assert.rejects(
      async () => await scope.adoptProject(rescuer, legacy.project.id, { repairReason }),
      {
        code: 'invalid_repair_reason',
      },
    );
  const repair = {
    repairReason: 'The previous owner lost their identity-provider account.',
  };
  const repairing = scope.adoptProject(rescuer, legacy.project.id, repair);
  repair.repairReason = ' ';
  const repaired = await repairing;
  assert.equal(
    (await scope.require(await scope.caller(rescuer, legacy.project.id), 'admin')).id,
    repaired.actorId,
  );
  assert.equal(
    (await scope.memberships(rescuer, legacy.project.id)).filter((value) => value.active).length,
    2,
  );
  const audit = (await state.events(legacy.project.id)).findLast(
    (event) => event.type === 'membership.repaired',
  )!;
  assert.equal(audit.data.reason, 'The previous owner lost their identity-provider account.');
  assert.equal(audit.data.previousMembershipId, null);
  await scope.removeMember(rescuer, legacy.project.id, 'alice');
  const returned = await scope.adoptProject(alice, legacy.project.id, {
    repairReason: 'Restore recovered account.',
  });
  assert.equal(returned.actorId, adopted.actorId);
  assert.notEqual(returned.id, adopted.id);
  assert.equal(
    (await state.events(legacy.project.id)).at(-1)?.data.previousMembershipId,
    adopted.id,
  );
  await state.close();
  state = await openState(path);
  scope = await createService(new ProjectScope(state));
  assert.equal((await scope.authenticate(legacy.token)).id, legacy.actor.id);
  assert.equal((await scope.caller(alice, legacy.project.id)).human?.membershipId, returned.id);
  await assert.rejects(
    async () =>
      await state.transaction(async (tx) => await tx.run('DELETE FROM project_memberships')),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await state.transaction(
        async (tx) => await tx.run('UPDATE member_actors SET subject=?', 'changed'),
      ),
    { code: 'state_constraint' },
  );
});

test('human task context and review claims integrate with role-loss and remove/rejoin recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-shared-member-review-'));
  const app = await createApp({ directory, api: false });
  try {
    const login = async (subject: string) =>
      await app.ctx.scope.acceptVerifiedIdentity({
        issuer,
        subject,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const owner = await login('owner'),
      producerUser = await login('producer'),
      reviewerUser = await login('reviewer');
    const project = await app.ctx.scope.createProject(owner, {
      name: 'Member work',
      requestId: 'create',
    });
    await app.ctx.scope.addMember(owner, project.id, { subject: 'producer', role: 'producer' });
    await app.ctx.scope.addMember(owner, project.id, { subject: 'reviewer', role: 'reviewer' });
    const operator = await app.ctx.scope.caller(owner, project.id);
    const producer = await app.ctx.scope.caller(producerUser, project.id);
    let reviewer = await app.ctx.scope.caller(reviewerUser, project.id);
    const task = await app.ctx.tasks.create(producer, {
      title: 'Member task',
      goal: 'Verify the result.',
      checks: ['The result is reproducible.'],
      requestId: 'create-task',
    });
    const packet = await app.ctx.workflows.begin(producer, {
      instanceId: task.id,
      expectedRevision: 0,
    });
    assert.equal(packet.context?.actorId, producer.actorId);
    assert.equal(packet.context?.projectId, project.id);
    const proof = await app.ctx.artifacts.create(producer, {
      title: 'Proof',
      content: 'The result is reproducible.',
    });
    const pending = await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [proof.id],
        expectedRevision: 0,
        requestId: 'delivery',
      }),
    );
    const claimed = await app.ctx.reviews.start(reviewer, pending.reviewId!);
    const context = await app.ctx.tasks.context(reviewer, {
      taskId: task.id,
      purpose: 'review',
      expectedRevision: 1,
      claimId: claimed.claimId!,
      requestId: 'review-context',
    });
    assert.equal(context.actorId, reviewer.actorId);
    await app.ctx.scope.changeMemberRole(owner, project.id, {
      subject: 'reviewer',
      role: 'reader',
    });
    await app.ctx.domainEvents.drain();
    const released = await app.ctx.reviews.get(operator, claimed.id);
    assert.equal(released.status, 'requested');
    assert.equal(released.recovery?.reason, 'review_permission_lost');
    assert.equal(released.snapshotHash, claimed.snapshotHash);
    await assert.rejects(async () => await app.ctx.reviews.start(reviewer, claimed.id), {
      code: 'membership_required',
    });
    await app.ctx.scope.changeMemberRole(owner, project.id, {
      subject: 'reviewer',
      role: 'reviewer',
    });
    reviewer = await app.ctx.scope.caller(reviewerUser, project.id);
    const reclaimed = await app.ctx.reviews.start(reviewer, claimed.id);
    assert.notEqual(reclaimed.claimId, claimed.claimId);
    await app.ctx.scope.removeMember(owner, project.id, 'reviewer');
    await app.ctx.scope.addMember(owner, project.id, { subject: 'reviewer', role: 'reviewer' });
    const rejoined = await app.ctx.scope.caller(reviewerUser, project.id);
    assert.equal(rejoined.actorId, reviewer.actorId);
    await app.ctx.domainEvents.drain();
    assert.equal(
      (await app.ctx.reviews.get(operator, claimed.id)).status,
      'requested',
      'Rejoining does not erase a previous claim-loss event',
    );
    await assert.rejects(async () => await app.ctx.reviews.start(reviewer, claimed.id), {
      code: 'membership_required',
    });
    const latest = await app.ctx.reviews.start(rejoined, claimed.id);
    assert.notEqual(latest.claimId, reclaimed.claimId);
    await app.ctx.domainEvents.drain();
    assert.equal((await app.ctx.reviews.get(operator, claimed.id)).claimId, latest.claimId);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
