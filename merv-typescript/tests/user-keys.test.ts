import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';

import { ProjectScope } from '@merv/scope';
import { Memberships } from '@merv/scope/memberships';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { ReviewService } from '@merv/reviews';
import type { Caller, Principal, Role, UserKey } from '@merv/contracts';
import { openState, postgresUrl, schemaFor } from './fixtures/state.js';

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
      expiresAt: new Date(time + 3_600_000).toISOString(),
    });
  const owner = await login('owner');
  const project = await scope.createProject(owner, { name: 'Home', requestId: 'home' });
  const operator = await scope.caller(owner, project.id);
  const principal = async (token: string): Promise<Principal> => ({
    kind: 'key',
    key: await scope.authenticateKey(token),
  });
  return {
    state,
    scope,
    login,
    owner,
    project,
    operator,
    principal,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('project keys reuse owner membership attribution, default to their fixed project, and store only digests', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const reader = await f.login('reader');
  await f.scope.addMember(f.owner, f.project.id, { subject: 'reader', role: 'reader' });
  const beforeActors = await f.scope.actors(f.operator);
  const input = { projectId: f.project.id, label: ' Laptop ' };
  const creating = f.scope.createKey(reader, input);
  input.label = ' ';
  const issued = await creating;
  assert.match(issued.token, /^mk_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.key.label, 'Laptop');
  assert.equal(issued.key.grantScope, 'project');
  assert.equal(issued.key.previousId, null);
  assert.deepEqual(issued.key.owner, { issuer, subject: 'reader' });
  const principal = await f.principal(issued.token);
  const caller = await f.scope.caller(principal);
  assert.equal(caller.actorId, (await f.scope.caller(reader, f.project.id)).actorId);
  assert.equal(caller.credentialId, undefined);
  assert.equal(caller.human, undefined);
  assert.equal(caller.key?.id, issued.key.id);
  assert.equal((await f.scope.require(caller, 'read')).role, 'reader');
  await assert.rejects(async () => await f.scope.require(caller, 'write'), { code: 'forbidden' });
  await assert.rejects(async () => await f.scope.require(caller, 'review'), { code: 'forbidden' });
  assert.deepEqual(await f.scope.projects(principal), [f.project]);
  assert.deepEqual(await f.scope.actors(f.operator), beforeActors);
  const stored = await f.state.read(
    async (sql) =>
      (await sql.get<{ token_hash: string }>('SELECT * FROM user_keys WHERE id=?', issued.key.id))!,
  );
  assert.equal(stored.token_hash, createHash('sha256').update(issued.token).digest('hex'));
  assert.equal(
    JSON.stringify({
      stored,
      events: await f.state.events(f.project.id),
      metadata: await f.scope.keys(reader),
    }).includes(issued.token),
    false,
  );
  assert.equal(
    (await f.state.read(async (sql) => await sql.all('SELECT * FROM actor_credentials'))).length,
    0,
  );
  await assert.rejects(async () => await f.scope.authenticate(issued.token), {
    code: 'unauthorized',
  });
});

test('account grants cover only current and future owner memberships and always require project selection', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const account = await f.scope.createKey(f.owner, {
    projectId: f.project.id,
    grantScope: 'account',
  });
  const fixed = await f.scope.createKey(f.owner, { projectId: f.project.id });
  await assert.rejects(async () => await f.scope.caller(await f.principal(account.token)), {
    code: 'project_required',
  });
  const other = await f.login('other');
  const future = await f.scope.createProject(other, { name: 'Future', requestId: 'future' });
  await assert.rejects(
    async () => await f.scope.caller(await f.principal(account.token), future.id),
    {
      code: 'membership_required',
    },
  );
  await f.scope.addMember(other, future.id, { subject: 'owner', role: 'producer' });
  const inFuture = await f.scope.caller(await f.principal(account.token), future.id);
  assert.equal(inFuture.actorId, (await f.scope.caller(f.owner, future.id)).actorId);
  assert.notEqual(inFuture.actorId, f.operator.actorId);
  assert.equal((await f.scope.require(inFuture, 'write')).role, 'producer');
  await assert.rejects(async () => await f.scope.require(inFuture, 'admin'), { code: 'forbidden' });
  assert.deepEqual(
    new Set((await f.scope.projects(await f.principal(account.token))).map((p) => p.id)),
    new Set([f.project.id, future.id]),
  );
  await assert.rejects(
    async () => await f.scope.caller(await f.principal(fixed.token), future.id),
    { code: 'forbidden' },
  );
  assert.deepEqual(await f.scope.projects(await f.principal(fixed.token)), [f.project]);
  const metadataForgery: Principal = {
    kind: 'key',
    key: { ...fixed.key, grantScope: 'account', projectId: future.id, owner: other.user },
  };
  await assert.rejects(async () => await f.scope.caller(metadataForgery, future.id), {
    code: 'forbidden',
  });
  assert.equal((await f.scope.caller(metadataForgery)).actorId, f.operator.actorId);
});

test('key authority rejects mixed tags, another owner or actor, stale epochs, revoked credentials and forged metadata', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const other = await f.login('other');
  await f.scope.addMember(f.owner, f.project.id, { subject: 'other', role: 'operator' });
  const issued = await f.scope.createKey(f.owner, { projectId: f.project.id });
  const otherKey = await f.scope.createKey(other, { projectId: f.project.id });
  const caller = await f.scope.caller(await f.principal(issued.token));
  const otherCaller = await f.scope.caller(other, f.project.id);
  const machine = await f.scope.issueActor(f.operator, { name: 'Legacy', role: 'operator' });
  for (const invalid of [
    { ...caller, human: f.operator.human },
    { ...caller, credentialId: machine.credential.id },
    { ...caller, actorId: machine.actor.id },
    { ...caller, actorId: otherCaller.actorId },
    { ...caller, key: { ...caller.key!, id: otherKey.key.id } },
    { ...caller, key: { ...caller.key!, membershipId: otherCaller.human!.membershipId } },
    { ...caller, key: { ...caller.key!, id: 'missing' } },
  ])
    await assert.rejects(
      async () => await f.scope.require(invalid, 'read'),
      (error) => ['forbidden', 'membership_required'].includes((error as { code: string }).code),
    );
  await assert.rejects(
    async () =>
      await f.scope.require({ actorId: caller.actorId, projectId: caller.projectId }, 'read'),
    { code: 'membership_required' },
  );
  await f.scope.changeMemberRole(other, f.project.id, { subject: 'owner', role: 'reader' });
  await assert.rejects(async () => await f.scope.require(caller, 'read'), {
    code: 'membership_required',
  });
  const restricted = await f.scope.caller(await f.principal(issued.token));
  assert.equal((await f.scope.require(restricted, 'read')).role, 'reader');
  await assert.rejects(async () => await f.scope.require(restricted, 'write'), {
    code: 'forbidden',
  });
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await tx.run(
          'UPDATE user_keys SET revoked_at=? WHERE id=?',
          new Date(initialTime).toISOString(),
          issued.key.id,
        );
        await assert.rejects(async () => await f.scope.require(restricted, 'read', tx), {
          code: 'forbidden',
        });
        throw new Error('Rollback');
      }),
    /Rollback/,
  );
  assert.equal((await f.scope.require(restricted, 'read')).role, 'reader');
  await f.scope.revokeKey(f.owner, issued.key.id);
  await assert.rejects(async () => await f.scope.require(restricted, 'read'), {
    code: 'forbidden',
  });
  await assert.rejects(async () => await f.scope.caller({ kind: 'key', key: issued.key }), {
    code: 'forbidden',
  });
  await assert.rejects(async () => await f.scope.projects({ kind: 'key', key: issued.key }), {
    code: 'forbidden',
  });
});

test('key management is human-owner-only; membership loss preserves metadata and revocation, while rejoin uses a fresh epoch', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const other = await f.login('other');
  const otherRealm = await f.login('owner', 'https://another.example/auth/v1');
  await f.scope.addMember(f.owner, f.project.id, { subject: 'other', role: 'operator' });
  const issued = await f.scope.createKey(f.owner, { projectId: f.project.id });
  const old = await f.scope.caller(await f.principal(issued.token));
  for (const notOwner of [other, otherRealm]) {
    assert.deepEqual(await f.scope.keys(notOwner), []);
    await assert.rejects(async () => await f.scope.rotateKey(notOwner, { keyId: issued.key.id }), {
      code: 'not_found',
    });
    await assert.rejects(async () => await f.scope.revokeKey(notOwner, issued.key.id), {
      code: 'not_found',
    });
  }
  await f.scope.removeMember(other, f.project.id, 'owner');
  assert.equal((await f.scope.authenticateKey(issued.token)).id, issued.key.id);
  assert.deepEqual(await f.scope.projects(await f.principal(issued.token)), []);
  await assert.rejects(async () => await f.scope.caller(await f.principal(issued.token)), {
    code: 'membership_required',
  });
  await assert.rejects(async () => await f.scope.rotateKey(f.owner, { keyId: issued.key.id }), {
    code: 'membership_required',
  });
  assert.deepEqual(await f.scope.keys(f.owner, f.project.id), [issued.key]);
  await f.scope.addMember(other, f.project.id, { subject: 'owner', role: 'reviewer' });
  const rejoined = await f.scope.caller(await f.principal(issued.token));
  assert.equal(rejoined.actorId, old.actorId);
  assert.notEqual(rejoined.key?.membershipId, old.key?.membershipId);
  await assert.rejects(async () => await f.scope.require(old, 'read'), {
    code: 'membership_required',
  });
  assert.equal((await f.scope.require(rejoined, 'review')).role, 'reviewer');
  await f.scope.removeMember(other, f.project.id, 'owner');
  await f.scope.revokeKey(f.owner, issued.key.id);
  assert.ok((await f.scope.keys(f.owner))[0].revokedAt);
  const audit = (await f.state.events(f.project.id)).at(-1)!;
  assert.equal(audit.type, 'actor.key_revoked');
  assert.equal(
    audit.actorId,
    old.actorId,
    'Audit retains the original project attribution after departure',
  );
});

test('operator keys cannot escape into human administration or independent actor credentials', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const machine = await f.scope.issueActor(f.operator, { name: 'Legacy', role: 'operator' });
  const issued = await f.scope.createKey(f.owner, {
    projectId: f.project.id,
    grantScope: 'account',
  });
  const principal = await f.principal(issued.token),
    caller = await f.scope.caller(principal, f.project.id);
  const before = await f.state.eventHead();
  for (const operation of [
    async () => await f.scope.keys(principal),
    async () => await f.scope.createKey(principal, { projectId: f.project.id }),
    async () => await f.scope.rotateKey(principal, { keyId: issued.key.id }),
    async () => await f.scope.revokeKey(principal, issued.key.id),
    async () => await f.scope.createProject(principal, { name: 'Escape', requestId: 'escape' }),
    async () => await f.scope.memberships(principal, f.project.id),
    async () =>
      await f.scope.addMember(principal, f.project.id, { subject: 'escape', role: 'operator' }),
    async () =>
      await f.scope.changeMemberRole(principal, f.project.id, { subject: 'owner', role: 'reader' }),
    async () => await f.scope.removeMember(principal, f.project.id, 'owner'),
    async () => await f.scope.issueActor(caller, { name: 'Escape', role: 'operator' }),
    async () => await f.scope.actorCredentials(caller, machine.actor.id),
    async () => await f.scope.issueActorCredential(caller, { actorId: machine.actor.id }),
    async () => await f.scope.rotateCredential(caller, { credentialId: machine.credential.id }),
    async () => await f.scope.revokeCredential(caller, machine.credential.id),
    async () => await f.scope.revokeActor(caller, machine.actor.id),
  ])
    await assert.rejects(operation, { code: 'forbidden' });
  assert.equal(await f.state.eventHead(), before);
  assert.equal((await f.scope.authenticate(machine.token)).active, true);
});

test('key expiry and rotation preserve grants and support explicit human reauthorization without reviving revoked lineages', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  for (const expiresAt of [
    '',
    '2026-09-16',
    new Date(initialTime).toISOString(),
    '2026-09-17T00:00:00Z',
    0,
  ])
    await assert.rejects(
      async () =>
        await f.scope.createKey(f.owner, {
          projectId: f.project.id,
          expiresAt: expiresAt as string,
        }),
      { code: 'invalid_expiry' },
    );
  for (const grantScope of ['', 'all', null])
    await assert.rejects(
      async () =>
        await f.scope.createKey(f.owner, {
          projectId: f.project.id,
          grantScope: grantScope as 'project',
        }),
      { code: 'invalid_grant' },
    );
  for (const label of ['', ' ', 'x'.repeat(121), 1])
    await assert.rejects(
      async () =>
        await f.scope.createKey(f.owner, { projectId: f.project.id, label: label as string }),
      { code: 'invalid_label' },
    );
  const expiresAt = new Date(initialTime + 1000).toISOString();
  const issued = await f.scope.createKey(f.owner, {
    projectId: f.project.id,
    label: 'Device',
    expiresAt,
  });
  const caller = await f.scope.caller(await f.principal(issued.token));
  const rotation: { keyId: string; expiresAt?: string | null } = { keyId: issued.key.id };
  const rotating = f.scope.rotateKey(f.owner, rotation);
  rotation.expiresAt = null;
  const rotated = await rotating;
  assert.equal(rotated.key.expiresAt, expiresAt);
  assert.equal(rotated.key.previousId, issued.key.id);
  assert.equal(rotated.key.projectId, issued.key.projectId);
  assert.equal(rotated.key.label, issued.key.label);
  assert.deepEqual(rotated.key.owner, issued.key.owner);
  assert.equal(rotated.key.grantScope, 'project');
  await assert.rejects(async () => await f.scope.authenticateKey(issued.token), {
    code: 'unauthorized',
  });
  await assert.rejects(async () => await f.scope.require(caller, 'read'), { code: 'forbidden' });
  await assert.rejects(
    async () => await f.scope.rotateKey(f.owner, { keyId: issued.key.id, expiresAt: null }),
    {
      code: 'key_revoked',
    },
  );
  const expiringCaller = await f.scope.caller(await f.principal(rotated.token));
  f.advance(1000);
  await assert.rejects(async () => await f.scope.authenticateKey(rotated.token), {
    code: 'unauthorized',
  });
  await assert.rejects(async () => await f.scope.require(expiringCaller, 'read'), {
    code: 'forbidden',
  });
  await assert.rejects(async () => await f.scope.rotateKey(f.owner, { keyId: rotated.key.id }), {
    code: 'invalid_expiry',
  });
  const renewed = await f.scope.rotateKey(f.owner, { keyId: rotated.key.id, expiresAt: null });
  assert.equal(renewed.key.expiresAt, null);
  assert.equal((await f.scope.authenticateKey(renewed.token)).id, renewed.key.id);
  await f.scope.revokeKey(f.owner, issued.key.id);
  await assert.rejects(async () => await f.scope.authenticateKey(renewed.token), {
    code: 'unauthorized',
  });
  assert.ok((await f.scope.keys(f.owner)).every((key) => key.revokedAt !== null));
  for (const token of [issued.token, rotated.token, renewed.token])
    assert.equal(await f.scope.recognizesCredential(token), true);
  for (const invalid of [
    '',
    'mk_',
    'mk_' + 'x'.repeat(43),
    'mk_' + 'x'.repeat(300),
    null,
    {},
    issued.token + '.',
  ]) {
    assert.equal(await f.scope.recognizesCredential(invalid as string), false);
    await assert.rejects(async () => await f.scope.authenticateKey(invalid as string), {
      code: 'unauthorized',
    });
  }
  const head = await f.state.eventHead();
  await f.scope.revokeKey(f.owner, issued.key.id);
  assert.equal(await f.state.eventHead(), head);
  assert.equal((await f.scope.require(f.operator, 'admin')).active, true);
  const durable = await f.scope.createKey(f.owner, { projectId: f.project.id });
  const keys = await f.scope.keys(f.owner);
  const rotationHead = await f.state.eventHead();
  const resolve = Memberships.prototype.resolve;
  const delayed = t.mock.method(
    Memberships.prototype,
    'resolve',
    async function (this: Memberships, ...args: Parameters<typeof resolve>) {
      const caller = await resolve.apply(this, args);
      f.advance(1000);
      return caller;
    },
  );
  try {
    await assert.rejects(
      f.scope.rotateKey(f.owner, {
        keyId: durable.key.id,
        expiresAt: new Date(initialTime + 2000).toISOString(),
      }),
      { code: 'invalid_expiry' },
    );
  } finally {
    delayed.mock.restore();
  }
  assert.equal((await f.scope.authenticateKey(durable.token)).id, durable.key.id);
  assert.deepEqual(await f.scope.keys(f.owner), keys);
  assert.equal(await f.state.eventHead(), rotationHead);
});

test('account rotation survives losing its issuance project but requires another current membership', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const other = await f.login('other');
  await f.scope.addMember(f.owner, f.project.id, { subject: 'other', role: 'operator' });
  const second = await f.scope.createProject(other, { name: 'Second', requestId: 'second' });
  await f.scope.addMember(other, second.id, { subject: 'owner', role: 'reader' });
  const account = await f.scope.createKey(f.owner, {
    projectId: f.project.id,
    grantScope: 'account',
  });
  const fixed = await f.scope.createKey(f.owner, { projectId: f.project.id });
  await f.scope.removeMember(other, f.project.id, 'owner');
  const rotated = await f.scope.rotateKey(f.owner, { keyId: account.key.id });
  assert.equal(rotated.key.projectId, f.project.id);
  assert.equal(rotated.key.grantScope, 'account');
  assert.equal(
    (
      await f.scope.require(
        await f.scope.caller(await f.principal(rotated.token), second.id),
        'read',
      )
    ).role,
    'reader',
  );
  assert.equal((await f.state.events(f.project.id)).at(-1)?.actorId, f.operator.actorId);
  await assert.rejects(async () => await f.scope.rotateKey(f.owner, { keyId: fixed.key.id }), {
    code: 'membership_required',
  });
  await f.scope.removeMember(other, second.id, 'owner');
  await assert.rejects(async () => await f.scope.rotateKey(f.owner, { keyId: rotated.key.id }), {
    code: 'membership_required',
  });
  await assert.rejects(
    async () => await f.scope.createKey(f.owner, { projectId: second.id, grantScope: 'account' }),
    {
      code: 'membership_required',
    },
  );
  assert.equal((await f.scope.keys(f.owner)).length, 3);
  await f.scope.revokeKey(f.owner, account.key.id);
  await assert.rejects(async () => await f.scope.authenticateKey(rotated.token), {
    code: 'unauthorized',
  });
});

test('key lifecycle writes roll back with their audit events, and key ownership, grants and lineage are immutable', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const issued = await f.scope.createKey(f.owner, { projectId: f.project.id });
  const head = await f.state.eventHead();
  const append = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    await append(tx, event);
    throw new Error('Audit failure');
  };
  for (const operation of [
    async () => await f.scope.createKey(f.owner, { projectId: f.project.id }),
    async () => await f.scope.rotateKey(f.owner, { keyId: issued.key.id }),
    async () => await f.scope.revokeKey(f.owner, issued.key.id),
  ]) {
    await assert.rejects(operation, /Audit failure/);
    assert.equal(await f.state.eventHead(), head);
    assert.deepEqual(await f.scope.keys(f.owner), [issued.key]);
    assert.equal((await f.scope.authenticateKey(issued.token)).id, issued.key.id);
  }
  f.state.appendEvent = append;
  for (const column of [
    'issuer',
    'subject',
    'project_id',
    'grant_scope',
    'label',
    'token_hash',
    'created_at',
    'expires_at',
    'previous_id',
  ])
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) =>
            await tx.run(`UPDATE user_keys SET ${column}=? WHERE id=?`, 'changed', issued.key.id),
        ),
      { code: 'state_constraint' },
    );
  await assert.rejects(
    async () => await f.state.transaction(async (tx) => await tx.run('DELETE FROM user_keys')),
    { code: 'state_constraint' },
  );
  const child = await f.scope.rotateKey(f.owner, { keyId: issued.key.id });
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('UPDATE user_keys SET revoked_at=NULL WHERE id=?', issued.key.id),
      ),
    { code: 'state_constraint' },
  );
  // Direct invalid inserts also cannot create a wider grant in a rotation lineage.
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            `INSERT INTO user_keys(id,issuer,subject,project_id,grant_scope,label,token_hash,created_at,previous_id)
     SELECT 'forged',issuer,subject,project_id,'account',label,'forged-hash',created_at,id FROM user_keys WHERE id=?`,
            child.key.id,
          ),
      ),
    { code: 'state_constraint' },
  );
  const beforeRevoke = await f.scope.keys(f.owner);
  f.state.appendEvent = async (tx, event) => {
    await append(tx, event);
    throw new Error('Recursive audit failure');
  };
  await assert.rejects(
    async () => await f.scope.revokeKey(f.owner, issued.key.id),
    /Recursive audit failure/,
  );
  assert.deepEqual(await f.scope.keys(f.owner), beforeRevoke);
  assert.equal((await f.scope.authenticateKey(child.token)).id, child.key.id);
  f.state.appendEvent = append;
});

test('key rotation and revocation are not actor death; owner permission-loss events still fence unfinished claims', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-key-review-'));
  const f = await fixture();
  t.after(async () => {
    await f.state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reviewerUser = await f.login('reviewer');
  await f.scope.addMember(f.owner, f.project.id, { subject: 'reviewer', role: 'reviewer' });
  const artifacts = await createService(
    new ArtifactStore(f.state, f.scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(f.state, f.scope, artifacts));
  const producerKey = await f.scope.createKey(f.owner, { projectId: f.project.id });
  const producer = await f.scope.caller(await f.principal(producerKey.token));
  const proof = await artifacts.create(producer, { title: 'Proof', content: 'Passed.' });
  const request = await reviews.request(producer, {
    subjectId: 'task',
    subjectRevision: 1,
    producerId: producer.actorId,
    artifactIds: [proof.id],
    criteria: ['Passed.'],
    requestId: 'request',
  });
  await assert.rejects(async () => await reviews.start(f.operator, request.id), {
    code: 'review_independence',
  });
  let issued = await f.scope.createKey(reviewerUser, { projectId: f.project.id });
  let reviewer = await f.scope.caller(await f.principal(issued.token));
  let claim = await reviews.start(reviewer, request.id);
  issued = await f.scope.rotateKey(reviewerUser, { keyId: issued.key.id });
  await assert.rejects(async () => await reviews.checkSubmit(reviewer, claim.id), {
    code: 'forbidden',
  });
  reviewer = await f.scope.caller(await f.principal(issued.token));
  assert.equal((await reviews.checkSubmit(reviewer, claim.id)).claimId, claim.claimId);
  await f.scope.revokeKey(reviewerUser, issued.key.id);
  assert.equal(await f.scope.eligible(f.project.id, reviewer.actorId, 'review'), true);
  assert.equal(
    (await reviews.checkSubmit(await f.scope.caller(reviewerUser, f.project.id), claim.id)).claimId,
    claim.claimId,
  );
  issued = await f.scope.createKey(reviewerUser, { projectId: f.project.id });
  reviewer = await f.scope.caller(await f.principal(issued.token));
  assert.equal((await reviews.checkSubmit(reviewer, claim.id)).claimId, claim.claimId);
  for (const mode of ['role', 'remove']) {
    if (mode === 'role') {
      await f.scope.changeMemberRole(f.owner, f.project.id, {
        subject: 'reviewer',
        role: 'reader',
      });
      await f.scope.changeMemberRole(f.owner, f.project.id, {
        subject: 'reviewer',
        role: 'reviewer',
      });
    } else {
      await f.scope.removeMember(f.owner, f.project.id, 'reviewer');
      await f.scope.addMember(f.owner, f.project.id, { subject: 'reviewer', role: 'reviewer' });
    }
    const restored = await f.scope.caller(await f.principal(issued.token));
    await assert.rejects(async () => await reviews.checkSubmit(reviewer, claim.id), {
      code: 'membership_required',
    });
    await assert.rejects(async () => await reviews.checkSubmit(restored, claim.id), {
      code: 'stale_claim',
    });
    assert.equal(
      (await reviews.get(f.operator, claim.id)).status,
      'started',
      'No asynchronous recovery consumer is present',
    );
    const event = (await f.state.events(f.project.id)).findLast((e) =>
      mode === 'role'
        ? e.type === 'actor.permissions_changed' && e.data.role === 'reader'
        : e.type === 'actor.revoked',
    )!;
    await f.state.transaction(async (tx) =>
      mode === 'role'
        ? await reviews.actorPermissionsChanged(event, tx)
        : await reviews.actorRevoked(event, tx),
    );
    claim = await reviews.start(restored, request.id);
    reviewer = restored;
  }
  assert.equal(
    (
      await reviews.submit(reviewer, {
        reviewId: claim.id,
        claimId: claim.claimId!,
        verdict: 'pass',
        notes: 'Verified.',
        requestId: 'verdict',
      })
    ).status,
    'submitted',
  );
});

for (const [firstAction, secondAction] of [
  ['rotate', 'rotate'],
  ['rotate', 'revoke'],
  ['revoke', 'rotate'],
] as const) {
  test(
    `concurrent key ${firstAction}/${secondAction} operations serialize without a live revoked descendant`,
    { timeout: 15_000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'merv-key-race-'));
      const path = directory;
      const f = await fixture(path);
      const issued = await f.scope.createKey(f.owner, { projectId: f.project.id });
      const barrier = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
      const control = new Int32Array(barrier);
      const code = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { register } = await import(workerData.loader); register();
        const [{ PostgresState }, { ProjectScope }] = await Promise.all([import(workerData.stateModule), import(workerData.scopeModule)]);
        const state = await PostgresState.open({ connectionString: workerData.url, schema: workerData.schema, maxConnections: 2, readConnections: 1, lockTimeoutMs: 30000 });
        const scope = new ProjectScope(state, () => workerData.time);
        await scope.initialize();
        const control = new Int32Array(workerData.barrier), append = state.appendEvent.bind(state);
        state.appendEvent = async (tx,event) => {
          const result = await append(tx,event);
          if (workerData.first) {
            Atomics.store(control,0,1); parentPort.postMessage({type:'held'});
            if (Atomics.wait(control,1,0,5000) === 'timed-out') throw new Error('Unreleased transaction');
            Atomics.store(control,0,0);
          }
          return result;
        };
        const transaction = state.transaction.bind(state);
        state.transaction = fn => transaction(tx => { if (!workerData.first) Atomics.store(control,2,1); return fn(tx); });
        parentPort.on('message', async () => {
          parentPort.postMessage({type:'attempt'});
          try {
            const result = workerData.action === 'rotate'
              ? (await scope.rotateKey(workerData.owner,{keyId:workerData.keyId})).key
              : await scope.revokeKey(workerData.owner,workerData.keyId);
            parentPort.postMessage({type:'result',ok:true,key:result});
          } catch(error) { parentPort.postMessage({type:'result',ok:false,code:error.code,status:error.status}); }
          finally { await state.close(); parentPort.close(); }
        });
        parentPort.postMessage({type:'ready'});
      })().catch(error => { throw error; });`;
      const spawn = (action: string, first: boolean) =>
        new Worker(code, {
          eval: true,
          execArgv: [],
          workerData: {
            action,
            first,
            owner: f.owner,
            url: postgresUrl,
            schema: schemaFor(path),
            barrier,
            time: initialTime,
            keyId: issued.key.id,
            loader: import.meta.resolve('tsx/esm/api'),
            stateModule: new URL('../packages/state/src/index.ts', import.meta.url).href,
            scopeModule: new URL('../packages/scope/src/index.ts', import.meta.url).href,
          },
        });
      const first = spawn(firstAction, true),
        second = spawn(secondAction, false);
      t.after(async () => {
        Atomics.store(control, 1, 1);
        Atomics.notify(control, 1);
        await Promise.all([first.terminate(), second.terminate()]);
        await f.state.close();
        rmSync(directory, { recursive: true, force: true });
      });
      const message = (worker: Worker, type: string) =>
        new Promise<{ type: string; ok?: boolean; key?: UserKey; code?: string; status?: number }>(
          (resolve, reject) => {
            const cleanup = () => {
              worker.off('message', receive);
              worker.off('error', fail);
              worker.off('exit', exited);
            };
            const receive = (value: { type: string }) => {
              if (value.type === type) {
                cleanup();
                resolve(value);
              }
            };
            const fail = (error: Error) => {
              cleanup();
              reject(error);
            };
            const exited = (code: number) =>
              fail(new Error('Worker exited ' + code + ' before ' + type));
            worker.on('message', receive);
            worker.once('error', fail);
            worker.once('exit', exited);
          },
        );
      await Promise.all([message(first, 'ready'), message(second, 'ready')]);
      const held = message(first, 'held');
      first.postMessage('go');
      await held;
      const attempted = message(second, 'attempt');
      second.postMessage('go');
      await attempted;
      await delay(75);
      assert.equal(
        Atomics.load(control, 0),
        1,
        'First operation holds the database writer transaction',
      );
      assert.equal(Atomics.load(control, 2), 0, 'Second operation cannot enter its callback yet');
      const results = Promise.all([message(first, 'result'), message(second, 'result')]);
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      const [one, two] = await results;
      assert.equal(one.ok, true);
      const history = await f.scope.keys(f.owner);
      if (secondAction === 'rotate')
        assert.deepEqual(two, { type: 'result', ok: false, code: 'key_revoked', status: 409 });
      else assert.equal(two.ok, true);
      assert.equal(history.length, firstAction === 'rotate' ? 2 : 1);
      assert.equal(
        history.filter((key) => key.revokedAt === null).length,
        firstAction === 'rotate' && secondAction === 'rotate' ? 1 : 0,
      );
      assert.equal(
        history.filter((key) => key.previousId === issued.key.id).length,
        firstAction === 'rotate' ? 1 : 0,
      );
      await assert.rejects(async () => await f.scope.authenticateKey(issued.token), {
        code: 'unauthorized',
      });
    },
  );
}
