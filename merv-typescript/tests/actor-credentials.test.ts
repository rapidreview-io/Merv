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
import type { Caller, IssuedActorCredential } from '@merv/contracts';
import { postgresMigrations as scopeMigrations } from '../packages/scope/src/index.postgres.js';
import { openState, postgresUrl, schemaFor } from './fixtures/state.js';

const start = Date.parse('2026-09-16T10:00:00.000Z');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const asCaller = (issued: IssuedActorCredential): Caller => ({
  actorId: issued.actor.id,
  projectId: issued.actor.projectId,
  credentialId: issued.credential.id,
});

async function fixture(path = ':memory:') {
  const state = await openState(path);
  let time = start;
  const scope = await createService(new ProjectScope(state, () => time));
  const admin = await scope.bootstrap({ projectName: 'Actor credentials', actorName: 'Operator' });
  return {
    state,
    scope,
    admin,
    operator: asCaller(admin),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('v1 migration separates digests without changing actor identities, project authority or old bearer tokens', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-actor-credentials-v1-'));
  const path = directory;
  const state = await openState(path);
  t.after(async () => {
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // Frozen schema actually shipped by Scope v1, including its migration fingerprint.
  await state.migrate('scope', [{ version: 1, sql: scopeMigrations[1]! }]);
  const old = [
    {
      id: 'actor_operator',
      projectId: 'project_a',
      name: 'Operator',
      role: 'operator',
      active: 1,
      token: 'a'.repeat(43),
    },
    {
      id: 'actor_producer',
      projectId: 'project_a',
      name: 'Producer',
      role: 'producer',
      active: 1,
      token: 'b'.repeat(43),
    },
    {
      id: 'actor_revoked',
      projectId: 'project_a',
      name: 'Revoked reviewer',
      role: 'reviewer',
      active: 0,
      token: 'c'.repeat(43),
    },
    {
      id: 'actor_elsewhere',
      projectId: 'project_b',
      name: 'Elsewhere',
      role: 'operator',
      active: 1,
      token: 'd'.repeat(43),
    },
  ];
  const event = await state.transaction(async (tx) => {
    for (const id of ['project_a', 'project_b'])
      await tx.run('INSERT INTO projects VALUES(?,?,?)', id, id, '2026-01-01T00:00:00.000Z');
    for (const value of old)
      await tx.run(
        'INSERT INTO actors VALUES(?,?,?,?,?,?)',
        value.id,
        value.projectId,
        value.name,
        value.role,
        hash(value.token),
        value.active,
      );
    return await state.appendEvent(tx, {
      projectId: 'project_a',
      actorId: 'actor_operator',
      type: 'actor.created',
      subjectId: 'actor_producer',
      data: { name: 'Producer', role: 'producer' },
    });
  });
  const scope = await createService(new ProjectScope(state));
  assert.equal(
    await state.eventHead(),
    event.id,
    'Schema migration creates no fabricated domain event',
  );
  for (const value of old.filter((value) => value.active)) {
    const authenticated = await scope.authenticate(value.token);
    assert.equal(authenticated.id, value.id);
    assert.equal(authenticated.projectId, value.projectId);
    assert.equal(authenticated.role, value.role);
    assert.equal(authenticated.credential.actorId, value.id);
    assert.equal(authenticated.credential.projectId, value.projectId);
    assert.equal(authenticated.credential.expiresAt, null);
  }
  await assert.rejects(async () => await scope.authenticate(old[2].token), {
    code: 'unauthorized',
  });
  const operator = { actorId: old[0].id, projectId: old[0].projectId };
  assert.equal((await scope.actorCredentials(operator, old[1].id))[0].createdAt, event.createdAt);
  assert.equal(
    (await scope.actors(operator)).find((value) => value.id === old[2].id)?.active,
    false,
  );
  await assert.rejects(
    async () => await scope.require({ ...operator, projectId: 'project_b' }, 'admin'),
    {
      code: 'forbidden',
    },
  );
  const columns = await state.read(
    async (sql) =>
      await sql.all<{ name: string }>(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='actors'",
      ),
  );
  assert.ok(columns.length > 0);
  assert.equal(
    columns.some((column) => column.name === 'token_hash'),
    false,
  );
  const migrated = await state.read(
    async (sql) =>
      await sql.all<{ token_hash: string }>('SELECT token_hash FROM actor_credentials'),
  );
  assert.equal(migrated.length, old.length);
  assert.deepEqual(
    new Set(migrated.map((row) => row.token_hash)),
    new Set(old.map((value) => hash(value.token))),
  );
  const ids = await scope.actorCredentials(operator, old[1].id);
  await createService(new ProjectScope(state));
  assert.deepEqual(
    await scope.actorCredentials(operator, old[1].id),
    ids,
    'Reload does not reissue migrated credentials',
  );
});

test('issuance returns secret once while storage, metadata and events retain only its digest', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-actor-credential-secrets-'));
  const path = directory;
  const f = await fixture(path);
  t.after(async () => {
    await f.state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const issued = await f.scope.issueActor(f.operator, { name: 'Researcher', role: 'producer' });
  assert.equal(issued.token.length, 43);
  assert.equal(issued.credential.kind, 'actor');
  assert.equal(issued.credential.createdAt, new Date(start).toISOString());
  assert.equal(issued.credential.previousId, null);
  assert.equal(issued.credential.revokedAt, null);
  assert.deepEqual(await f.scope.authenticate(issued.token), {
    ...issued.actor,
    credential: issued.credential,
  });
  const stored = await f.state.read(
    async (sql) =>
      await sql.get<{ token_hash: string }>(
        'SELECT token_hash FROM actor_credentials WHERE id=?',
        issued.credential.id,
      ),
  );
  assert.equal(stored?.token_hash, hash(issued.token));
  const metadata = await f.scope.actorCredentials(asCaller(issued));
  assert.equal(JSON.stringify(metadata).includes('token_hash'), false);
  assert.equal(JSON.stringify(metadata).includes(issued.token), false);
  const events = JSON.stringify(await f.state.events(f.operator.projectId));
  assert.equal(events.includes(issued.token), false);
  assert.equal(events.includes(hash(issued.token)), false);
  // Every stored row of every table in this database, not just the credential table.
  const everything = await f.state.read(async (sql) => {
    const tables = await sql.all<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name",
    );
    let text = '';
    for (const { name } of tables) text += JSON.stringify(await sql.all(`SELECT * FROM "${name}"`));
    return text;
  });
  assert.ok(everything.includes(hash(issued.token)));
  assert.equal(everything.includes(issued.token), false);
  metadata[0].actorId = 'changed';
  issued.credential.expiresAt = 'changed';
  assert.notEqual((await f.scope.actorCredentials(asCaller(issued)))[0].actorId, 'changed');
  assert.equal((await f.scope.authenticate(issued.token)).credential.expiresAt, null);
});

test('expiry is canonical, rejects invalid issuance atomically and fences previously authenticated callers at the deadline', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const deadline = new Date(start + 1000).toISOString();
  const issued = await f.scope.issueActor(f.operator, {
    name: 'Expiring',
    role: 'reviewer',
    expiresAt: deadline,
  });
  const caller = asCaller(issued);
  await f.scope.require(caller, 'review');
  const count = (await f.scope.actors(f.operator)).length;
  const head = await f.state.eventHead();
  for (const expiresAt of [
    new Date(start).toISOString(),
    new Date(start - 1).toISOString(),
    '2026-09-16T10:00:01Z',
    '2026-09-16T10:00:01.000+00:00',
    '2026-02-31T10:00:01.000Z',
    'invalid',
    1,
    {},
  ])
    await assert.rejects(
      async () =>
        await f.scope.issueActor(f.operator, {
          name: 'Invalid deadline',
          role: 'producer',
          expiresAt: expiresAt as string,
        }),
      { code: 'invalid_expiry' },
    );
  assert.equal((await f.scope.actors(f.operator)).length, count);
  assert.equal(await f.state.eventHead(), head);
  f.advance(999);
  assert.equal((await f.scope.authenticate(issued.token)).id, issued.actor.id);
  f.advance(1);
  await assert.rejects(async () => await f.scope.authenticate(issued.token), {
    code: 'unauthorized',
  });
  await assert.rejects(async () => await f.scope.require(caller, 'review'), { code: 'forbidden' });
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => await f.scope.require(caller, 'review', tx)),
    {
      code: 'forbidden',
    },
  );
  assert.equal(
    await f.scope.eligible(caller.projectId, caller.actorId, 'review'),
    true,
    'Actor eligibility is distinct from this expired credential',
  );
  assert.equal(
    (await f.scope.require({ actorId: caller.actorId, projectId: caller.projectId }, 'review')).id,
    caller.actorId,
    'Trusted internal actor calls do not imply a credential lease',
  );
});

test('credential identity cannot be paired with another actor/project and metadata visibility stays scoped', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const actorInput = { name: 'Reader', role: 'reader' as 'reader' | 'operator' };
  const issuing = f.scope.issueActor(f.operator, actorInput);
  actorInput.role = 'operator';
  const reader = await issuing;
  assert.equal(reader.actor.role, 'reader');
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const readerCaller = asCaller(reader);
  assert.deepEqual(await f.scope.actorCredentials(readerCaller), [reader.credential]);
  await assert.rejects(
    async () => await f.scope.actorCredentials(readerCaller, f.operator.actorId),
    {
      code: 'forbidden',
    },
  );
  await assert.rejects(async () => await f.scope.actorCredentials(f.operator, other.actor.id), {
    code: 'not_found',
  });
  for (const caller of [
    { ...f.operator, credentialId: reader.credential.id },
    { ...readerCaller, credentialId: f.admin.credential.id },
    { ...f.operator, credentialId: other.credential.id },
    { ...asCaller(other), credentialId: f.admin.credential.id },
    { ...f.operator, credentialId: '' },
    { ...f.operator, credentialId: null as any },
    { ...f.operator, credentialId: 'missing' },
  ])
    await assert.rejects(async () => await f.scope.require(caller, 'read'), { code: 'forbidden' });
  await f.state.transaction(async (tx) => {
    const caller = { ...f.operator, credentialId: reader.credential.id };
    const get = tx.get.bind(tx);
    let substitutions = 0;
    const intercept = t.mock.method(tx, 'get', async (...args: Parameters<typeof get>) => {
      const row = await get(...args);
      if (args[0].includes('LEFT JOIN member_actors')) {
        caller.actorId = reader.actor.id;
        substitutions++;
      }
      return row;
    });
    try {
      await assert.rejects(() => f.scope.require(caller, 'admin', tx), { code: 'forbidden' });
      assert.equal(substitutions, 1);
    } finally {
      intercept.mock.restore();
    }
  });
  const pendingCaller = { ...f.operator };
  const source = f.scope.delegationSource(pendingCaller);
  Object.assign(pendingCaller, readerCaller);
  const capturedSource = await source;
  assert.equal(capturedSource.actorId, f.operator.actorId);
  assert.ok(capturedSource.kind === 'actor');
  const authorized = f.scope.requireDelegation(capturedSource, 'admin');
  capturedSource.expiresAt = 'changed';
  assert.equal((await authorized).id, f.operator.actorId);
  for (const action of [
    async () =>
      await f.scope.rotateCredential(readerCaller, { credentialId: reader.credential.id }),
    async () => await f.scope.revokeCredential(readerCaller, f.admin.credential.id),
  ])
    await assert.rejects(action, { code: 'forbidden' });
  const changingCaller = { ...f.operator };
  const authorize = f.scope.require.bind(f.scope);
  const intercepted = t.mock.method(
    f.scope,
    'require',
    async (...args: Parameters<typeof authorize>) => {
      const actor = await authorize(...args);
      changingCaller.projectId = other.project.id;
      return actor;
    },
  );
  try {
    for (const action of [
      () => f.scope.issueActorCredential(changingCaller, { actorId: other.actor.id }),
      () => f.scope.actorCredentials(changingCaller, other.actor.id),
      () => f.scope.rotateCredential(changingCaller, { credentialId: other.credential.id }),
      () => f.scope.revokeCredential(changingCaller, other.credential.id),
      () => f.scope.revokeActor(changingCaller, other.actor.id),
    ]) {
      changingCaller.projectId = f.operator.projectId;
      await assert.rejects(action, { code: 'not_found' });
    }
    changingCaller.projectId = f.operator.projectId;
    assert.equal((await f.scope.project(changingCaller)).id, f.operator.projectId);
    changingCaller.projectId = f.operator.projectId;
    assert.ok(
      (await f.scope.actors(changingCaller)).every(
        (actor) => actor.projectId === f.operator.projectId,
      ),
    );
  } finally {
    intercepted.mock.restore();
  }
});

test('session actor creation and role updates retain the authorized delegation and role', async (t) => {
  const f = await fixture();
  t.after(() => f.state.close());
  const reader = await f.scope.issueActor(f.operator, { name: 'Reader', role: 'reader' });
  const readerSource = await f.scope.delegationSource(asCaller(reader));
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other owner' });
  await assert.rejects(() => f.scope.requireDelegation(readerSource, 'write'), {
    code: 'forbidden',
  });
  for (const change of ['role', 'project'])
    await t.test(change, async () => {
      const source = structuredClone(readerSource);
      const input = {
        sessionId: `session-${change}`,
        name: 'Reader session',
        role: 'reader' as 'reader' | 'producer',
      };
      const created = await f.state.transaction(async (tx) => {
        const pending = f.scope.createSessionActor(source, input, tx);
        if (change === 'role') input.role = 'producer';
        else source.projectId = other.project.id;
        return await pending;
      });
      assert.equal(created.role, 'reader');
      assert.equal(created.projectId, f.operator.projectId);
      const stored = await f.state.read((sql) =>
        sql.get('SELECT role,project_id FROM actors WHERE id=?', created.id),
      );
      assert.equal(stored!.role, 'reader');
      assert.equal(stored!.project_id, f.operator.projectId);
    });
  const otherSource = await f.scope.delegationSource(asCaller(other));
  const foreign = await f.state.transaction((tx) =>
    f.scope.createSessionActor(
      otherSource,
      {
        sessionId: 'foreign-session',
        agentId: 'foreign-agent',
        name: 'Foreign reader',
        role: 'reader',
      },
      tx,
    ),
  );
  const source = await f.scope.delegationSource(f.operator);
  await f.state.transaction(async (tx) => {
    const pending = f.scope.setAgentRole(source, foreign.id, 'producer', tx);
    source.projectId = other.project.id;
    await assert.rejects(pending, { code: 'agent_unavailable' });
  });
  assert.equal(
    (await f.state.read((sql) => sql.get('SELECT role FROM actors WHERE id=?', foreign.id)))!.role,
    'reader',
  );
});

test('rotation preserves identity and expiry, retains history and immediately fences old caller credentials', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const deadline = new Date(start + 2000).toISOString();
  const first = await f.scope.issueActor(f.operator, {
    name: 'Producer',
    role: 'producer',
    expiresAt: deadline,
  });
  const before = await f.state.eventHead();
  f.advance(100);
  const next = await f.scope.rotateCredential(f.operator, { credentialId: first.credential.id });
  assert.deepEqual(next.actor, first.actor);
  assert.equal(next.credential.expiresAt, deadline);
  assert.equal(next.credential.previousId, first.credential.id);
  assert.notEqual(next.token, first.token);
  await assert.rejects(async () => await f.scope.authenticate(first.token), {
    code: 'unauthorized',
  });
  await assert.rejects(async () => await f.scope.require(asCaller(first), 'write'), {
    code: 'forbidden',
  });
  assert.deepEqual((await f.scope.authenticate(next.token)).credential, next.credential);
  await assert.rejects(
    async () => await f.scope.rotateCredential(f.operator, { credentialId: first.credential.id }),
    {
      code: 'credential_revoked',
      status: 409,
    },
  );
  const history = await f.scope.actorCredentials(f.operator, first.actor.id);
  assert.equal(history.length, 2);
  assert.equal(
    history.find((value) => value.id === first.credential.id)?.revokedAt,
    new Date(start + 100).toISOString(),
  );
  assert.deepEqual(
    (await f.state.events(f.operator.projectId, before)).map((value) => value.type),
    ['actor.credential_rotated'],
  );
  assert.equal(
    (await f.scope.actors(f.operator)).find((value) => value.id === first.actor.id)?.active,
    true,
  );
  f.advance(1900);
  await assert.rejects(
    async () => await f.scope.rotateCredential(f.operator, { credentialId: next.credential.id }),
    {
      code: 'invalid_expiry',
    },
  );
  const renewed = await f.scope.rotateCredential(f.operator, {
    credentialId: next.credential.id,
    expiresAt: null,
  });
  assert.equal(renewed.credential.expiresAt, null);
  assert.equal((await f.scope.authenticate(renewed.token)).id, first.actor.id);
  await assert.rejects(
    async () => await f.scope.rotateCredential(f.operator, { credentialId: f.admin.credential.id }),
    { code: 'self_rotation', status: 409 },
  );
  assert.equal((await f.scope.require(f.operator, 'admin')).id, f.admin.actor.id);
});

test('credential revocation preserves actor authority and provenance; actor revocation invalidates every credential', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  await assert.rejects(
    async () => await f.scope.revokeCredential(f.operator, f.admin.credential.id),
    {
      code: 'self_revoke',
    },
  );
  const issued = await f.scope.issueActor(f.operator, { name: 'Reviewer', role: 'reviewer' });
  const head = await f.state.eventHead();
  await f.scope.revokeCredential(f.operator, issued.credential.id);
  await f.scope.revokeCredential(f.operator, issued.credential.id);
  await assert.rejects(async () => await f.scope.authenticate(issued.token), {
    code: 'unauthorized',
  });
  await assert.rejects(async () => await f.scope.require(asCaller(issued), 'review'), {
    code: 'forbidden',
  });
  assert.equal(await f.scope.eligible(issued.actor.projectId, issued.actor.id, 'review'), true);
  assert.deepEqual(
    (await f.state.events(f.operator.projectId, head)).map((value) => value.type),
    ['actor.credential_revoked'],
  );
  assert.equal(
    (await f.scope.actors(f.operator)).find((value) => value.id === issued.actor.id)?.active,
    true,
  );
  const active = await f.scope.issueActor(f.operator, {
    name: 'Another reviewer',
    role: 'reviewer',
  });
  const extraToken = (await f.scope.issueActorCredential(f.operator, { actorId: active.actor.id }))
    .token;
  assert.equal((await f.scope.authenticate(extraToken)).id, active.actor.id);
  await f.scope.revokeActor(f.operator, active.actor.id);
  for (const token of [active.token, extraToken])
    await assert.rejects(async () => await f.scope.authenticate(token), { code: 'unauthorized' });
  assert.equal(await f.scope.eligible(active.actor.projectId, active.actor.id, 'review'), false);
  const history = await f.scope.actorCredentials(f.operator, active.actor.id);
  assert.equal(history.length, 2);
  assert.ok(
    history.every((value) => value.revokedAt === null),
    'Identity revocation is separate from credential revocation',
  );
  await assert.rejects(
    async () => await f.scope.rotateCredential(f.operator, { credentialId: active.credential.id }),
    { code: 'actor_revoked' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('DELETE FROM actor_credentials WHERE id=?', active.credential.id),
      ),
    { code: 'state_constraint' },
  );
  for (const column of [
    'actor_id',
    'project_id',
    'token_hash',
    'created_at',
    'expires_at',
    'previous_id',
  ])
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) =>
            await tx.run(
              `UPDATE actor_credentials SET ${column}=? WHERE id=?`,
              'changed',
              active.credential.id,
            ),
        ),
      { code: 'state_constraint' },
    );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE actor_credentials SET revoked_at=NULL WHERE id=?',
            issued.credential.id,
          ),
      ),
    { code: 'state_constraint' },
  );
});

test('failed credential event writes roll back issuance, replacement and revocation with their metadata', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const issued = await f.scope.issueActor(f.operator, { name: 'Producer', role: 'producer' });
  const head = await f.state.eventHead();
  const identities = await f.scope.actors(f.operator);
  const original = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    await original(tx, event);
    throw new Error('Injected event failure');
  };
  for (const action of [
    async () => await f.scope.issueActor(f.operator, { name: 'Rolled back', role: 'reader' }),
    async () => await f.scope.issueActorCredential(f.operator, { actorId: issued.actor.id }),
    async () => await f.scope.rotateCredential(f.operator, { credentialId: issued.credential.id }),
    async () => await f.scope.revokeCredential(f.operator, issued.credential.id),
  ]) {
    await assert.rejects(action, /Injected event failure/);
    assert.equal(await f.state.eventHead(), head);
    assert.deepEqual(await f.scope.actors(f.operator), identities);
    assert.deepEqual(await f.scope.actorCredentials(f.operator, issued.actor.id), [
      issued.credential,
    ]);
    assert.equal((await f.scope.authenticate(issued.token)).id, issued.actor.id);
  }
  f.state.appendEvent = original;
  assert.equal(
    (await f.scope.rotateCredential(f.operator, { credentialId: issued.credential.id })).actor.id,
    issued.actor.id,
  );
});

test('recognition retains local credential provenance after rotation, expiry, revocation and actor deactivation', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const expired = await f.scope.issueActor(f.operator, {
    name: 'Expiring',
    role: 'producer',
    expiresAt: new Date(start + 1).toISOString(),
  });
  const revoked = await f.scope.issueActor(f.operator, { name: 'Revoked', role: 'producer' });
  const deactivated = await f.scope.issueActor(f.operator, {
    name: 'Deactivated',
    role: 'reviewer',
  });
  const initial = await f.scope.issueActor(f.operator, { name: 'Rotated', role: 'producer' });
  const rotated = await f.scope.rotateCredential(f.operator, {
    credentialId: initial.credential.id,
  });
  await f.scope.revokeCredential(f.operator, revoked.credential.id);
  await f.scope.revokeActor(f.operator, deactivated.actor.id);
  f.advance(1);
  const head = await f.state.eventHead();
  for (const token of [expired.token, revoked.token, deactivated.token, initial.token]) {
    await assert.rejects(async () => await f.scope.authenticate(token), { code: 'unauthorized' });
    assert.equal(await f.scope.recognizesCredential(token), true);
  }
  assert.equal(await f.scope.recognizesCredential(rotated.token), true);
  for (const token of ['', 'short', 'x'.repeat(201), 'unknown'.repeat(8), null, {}])
    assert.equal(await f.scope.recognizesCredential(token as string), false);
  assert.equal(await f.state.eventHead(), head);
});

test('staged self-rotation tolerates a lost issue response, verifies replacement and revokes only old credentials', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const head = await f.state.eventHead();
  await assert.rejects(
    async () => await f.scope.rotateCredential(f.operator, { credentialId: f.admin.credential.id }),
    { code: 'self_rotation', status: 409 },
  );
  assert.equal(await f.state.eventHead(), head);
  // The first issue response can be lost; the old authentication credential stays usable.
  await f.scope.issueActorCredential(f.operator, { actorId: f.operator.actorId });
  assert.equal((await f.scope.authenticate(f.admin.token)).id, f.operator.actorId);
  const lost = (await f.scope.actorCredentials(f.operator)).find(
    (value) => value.id !== f.admin.credential.id,
  )!;
  assert.equal(lost.previousId, null);
  const fresh = await f.scope.issueActorCredential(f.operator, { actorId: f.operator.actorId });
  assert.equal((await f.scope.authenticate(fresh.token)).id, f.operator.actorId);
  const next = asCaller(fresh);
  assert.equal((await f.scope.require(next, 'admin')).id, f.operator.actorId);
  await f.scope.revokeCredential(next, f.admin.credential.id);
  await f.scope.revokeCredential(next, lost.id);
  await assert.rejects(async () => await f.scope.authenticate(f.admin.token), {
    code: 'unauthorized',
  });
  assert.equal((await f.scope.authenticate(fresh.token)).id, f.operator.actorId);
  await assert.rejects(async () => await f.scope.revokeCredential(next, fresh.credential.id), {
    code: 'self_revoke',
  });
  await assert.rejects(
    async () =>
      await f.scope.revokeCredential(
        { actorId: next.actorId, projectId: next.projectId },
        fresh.credential.id,
      ),
    { code: 'self_revoke' },
  );
  assert.equal((await f.scope.actors(next)).length, 1);
  assert.equal(
    (await f.scope.actorCredentials(next)).filter((value) => value.revokedAt === null).length,
    1,
  );
  assert.deepEqual(
    (await f.state.events(f.operator.projectId, head)).map((value) => value.type),
    [
      'actor.credential_issued',
      'actor.credential_issued',
      'actor.credential_revoked',
      'actor.credential_revoked',
    ],
  );
});

test('self issuance inherits the authenticating expiry and self rotation cannot extend a finite predecessor', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const deadline = new Date(start + 2000).toISOString();
  const limited = await f.scope.issueActor(f.operator, {
    name: 'Limited operator',
    role: 'operator',
    expiresAt: deadline,
  });
  const caller = asCaller(limited);
  const issueInput = { actorId: caller.actorId };
  const pendingIssue = f.scope.issueActorCredential(caller, issueInput);
  issueInput.actorId = f.operator.actorId;
  const inherited = await pendingIssue;
  assert.equal(inherited.credential.expiresAt, deadline);
  const before = await f.scope.actorCredentials(caller);
  const head = await f.state.eventHead();
  for (const operation of ['issue', 'rotate']) {
    const pendingCaller = { ...caller };
    const authorize = f.scope.require.bind(f.scope);
    const intercepted = t.mock.method(
      f.scope,
      'require',
      async (...args: Parameters<typeof authorize>) => {
        const actor = await authorize(...args);
        pendingCaller.actorId = f.operator.actorId;
        delete pendingCaller.credentialId;
        return actor;
      },
    );
    try {
      await assert.rejects(
        () =>
          operation === 'issue'
            ? f.scope.issueActorCredential(pendingCaller, {
                actorId: caller.actorId,
                expiresAt: null,
              })
            : f.scope.rotateCredential(pendingCaller, {
                credentialId: inherited.credential.id,
                expiresAt: null,
              }),
        { code: 'self_expiry_extension', status: 403 },
      );
    } finally {
      intercepted.mock.restore();
    }
  }

  for (const expiresAt of [null, new Date(start + 2001).toISOString()])
    await assert.rejects(
      async () =>
        await f.scope.issueActorCredential(caller, { actorId: caller.actorId, expiresAt }),
      { code: 'self_expiry_extension', status: 403 },
    );
  assert.deepEqual(await f.scope.actorCredentials(caller), before);
  assert.equal(await f.state.eventHead(), head);
  const shortDeadline = new Date(start + 1000).toISOString();
  const short = await f.scope.issueActorCredential(caller, {
    actorId: caller.actorId,
    expiresAt: shortDeadline,
  });
  for (const expiresAt of [null, new Date(start + 1500).toISOString()])
    await assert.rejects(
      async () =>
        await f.scope.rotateCredential(caller, { credentialId: short.credential.id, expiresAt }),
      { code: 'self_expiry_extension', status: 403 },
    );
  const rotationInput = { credentialId: short.credential.id };
  const pendingRotation = f.scope.rotateCredential(caller, rotationInput);
  rotationInput.credentialId = caller.credentialId!;
  const rotated = await pendingRotation;
  assert.equal(rotated.credential.expiresAt, shortDeadline);
  // Nor can a short-lived caller rotate a longer credential of its own into a permanent one.
  const lasting = await f.scope.issueActorCredential(f.operator, {
    actorId: caller.actorId,
    expiresAt: null,
  });
  await assert.rejects(
    async () => await f.scope.rotateCredential(caller, { credentialId: lasting.credential.id }),
    { code: 'self_expiry_extension', status: 403 },
  );
  assert.equal(
    (await f.scope.authenticate(limited.token)).id,
    limited.actor.id,
    'Rotating another own credential does not revoke the caller',
  );
  const earlier = await f.scope.rotateCredential(caller, {
    credentialId: inherited.credential.id,
    expiresAt: new Date(start + 500).toISOString(),
  });
  assert.equal(earlier.credential.expiresAt, new Date(start + 500).toISOString());
  const authorized = await f.scope.rotateCredential(f.operator, {
    credentialId: limited.credential.id,
    expiresAt: null,
  });
  assert.equal(
    authorized.credential.expiresAt,
    null,
    'Another operator can explicitly authorize an extension',
  );
});

test('additional credential issuance restores access to an active identity without creating or reviving an actor', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const issued = await f.scope.issueActor(f.operator, { name: 'Reviewer', role: 'reviewer' });
  await f.scope.revokeCredential(f.operator, issued.credential.id);
  const actors = await f.scope.actors(f.operator);
  const head = await f.state.eventHead();
  const replacement = await f.scope.issueActorCredential(f.operator, { actorId: issued.actor.id });
  assert.deepEqual(replacement.actor, issued.actor);
  assert.equal(replacement.credential.previousId, null);
  assert.equal((await f.scope.authenticate(replacement.token)).id, issued.actor.id);
  assert.deepEqual(await f.scope.actors(f.operator), actors);
  const event = (await f.state.events(f.operator.projectId, head))[0];
  assert.equal(event.type, 'actor.credential_issued');
  assert.equal(event.subjectId, replacement.credential.id);
  assert.deepEqual(event.data, { actorId: issued.actor.id, expiresAt: null });
  assert.equal(JSON.stringify(event).includes(replacement.token), false);
  assert.equal(JSON.stringify(event).includes(hash(replacement.token)), false);
  await assert.rejects(
    async () =>
      await f.scope.issueActorCredential(asCaller(replacement), { actorId: issued.actor.id }),
    { code: 'forbidden' },
  );
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  await assert.rejects(
    async () => await f.scope.issueActorCredential(f.operator, { actorId: other.actor.id }),
    {
      code: 'not_found',
    },
  );
  await f.scope.revokeActor(f.operator, issued.actor.id);
  await assert.rejects(
    async () => await f.scope.issueActorCredential(f.operator, { actorId: issued.actor.id }),
    {
      code: 'actor_revoked',
    },
  );
  assert.equal((await f.scope.actorCredentials(f.operator, issued.actor.id)).length, 2);
});

test('a lost other-actor rotation response is discoverable through predecessor metadata and recoverable', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const issued = await f.scope.issueActor(f.operator, { name: 'Researcher', role: 'producer' });
  await f.scope.rotateCredential(f.operator, { credentialId: issued.credential.id });
  await assert.rejects(
    async () => await f.scope.rotateCredential(f.operator, { credentialId: issued.credential.id }),
    { code: 'credential_revoked', status: 409 },
  );
  const successor = (await f.scope.actorCredentials(f.operator, issued.actor.id)).find(
    (value) => value.previousId === issued.credential.id,
  )!;
  assert.ok(successor);
  assert.equal(successor.revokedAt, null);
  const recovered = await f.scope.rotateCredential(f.operator, { credentialId: successor.id });
  assert.equal((await f.scope.authenticate(recovered.token)).id, issued.actor.id);
  assert.equal(recovered.credential.previousId, successor.id);
  assert.equal((await f.scope.actorCredentials(f.operator, issued.actor.id)).length, 3);
  assert.deepEqual(recovered.actor, issued.actor);
});

test(
  'concurrent credential rotations serialize and issue exactly one successor',
  { timeout: 15_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-actor-credential-race-'));
    const path = directory;
    const f = await fixture(path);
    const operator2 = await f.scope.issueActor(f.operator, {
      name: 'Other operator',
      role: 'operator',
    });
    const target = await f.scope.issueActor(f.operator, { name: 'Worker', role: 'producer' });
    const barrier = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
    const control = new Int32Array(barrier);
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { register } = await import(workerData.loader);
        register();
        const [{ PostgresState }, { ProjectScope }] = await Promise.all([
          import(workerData.stateModule), import(workerData.scopeModule),
        ]);
        const state = await PostgresState.open({
          connectionString: workerData.url,
          schema: workerData.schema,
          maxConnections: 2,
          readConnections: 1,
          lockTimeoutMs: 30000,
        });
        const scope = new ProjectScope(state, () => workerData.time);
        await scope.initialize();
        const control = new Int32Array(workerData.barrier);
        const append = state.appendEvent.bind(state);
        state.appendEvent = async (tx, event) => {
          const written = await append(tx, event);
          if (workerData.first && event.type === 'actor.credential_rotated') {
            Atomics.store(control, 0, 1);
            parentPort.postMessage({ type: 'held' });
            if (Atomics.wait(control, 1, 0, 5000) === 'timed-out')
              throw new Error('Parent did not release rotation transaction');
            Atomics.store(control, 0, 0);
          }
          return written;
        };
        const transaction = state.transaction.bind(state);
        state.transaction = (fn) => transaction((tx) => {
          if (!workerData.first) Atomics.store(control, 2, 1);
          return fn(tx);
        });
        parentPort.on('message', async () => {
          parentPort.postMessage({ type: 'attempt' });
          try {
            const issued = await scope.rotateCredential(workerData.caller, {
              credentialId: workerData.credentialId,
            });
            parentPort.postMessage({ type: 'result', ok: true, credential: issued.credential });
          } catch (error) {
            parentPort.postMessage({ type: 'result', ok: false, code: error.code, status: error.status });
          } finally {
            await state.close();
            parentPort.close();
          }
        });
        parentPort.postMessage({ type: 'ready' });
      })().catch((error) => { throw error; });
    `;
    const spawn = (caller: Caller, first: boolean) =>
      new Worker(source, {
        eval: true,
        execArgv: [],
        workerData: {
          url: postgresUrl,
          schema: schemaFor(path),
          caller,
          first,
          barrier,
          time: start,
          credentialId: target.credential.id,
          loader: import.meta.resolve('tsx/esm/api'),
          stateModule: new URL('../packages/state/src/index.ts', import.meta.url).href,
          scopeModule: new URL('../packages/scope/src/index.ts', import.meta.url).href,
        },
      });
    const first = spawn(f.operator, true);
    const second = spawn(asCaller(operator2), false);
    const errors: Error[] = [];
    for (const worker of [first, second]) worker.on('error', (error) => errors.push(error));
    t.after(async () => {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      await Promise.all([first.terminate(), second.terminate()]);
      await f.state.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const message = (worker: Worker, type: string) =>
      new Promise<{
        type: string;
        ok?: boolean;
        credential?: IssuedActorCredential['credential'];
        code?: string;
        status?: number;
      }>((resolve, reject) => {
        const cleanup = () => {
          worker.off('message', receive);
          worker.off('error', fail);
          worker.off('exit', exited);
        };
        const receive = (value: any) => {
          if (value.type !== type) return;
          cleanup();
          resolve(value);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const exited = (code: number) => fail(new Error(`Worker exited ${code} before ${type}`));
        worker.on('message', receive);
        worker.once('error', fail);
        worker.once('exit', exited);
      });
    await Promise.all([message(first, 'ready'), message(second, 'ready')]);
    const held = message(first, 'held');
    first.postMessage('rotate');
    await held;
    const attempted = message(second, 'attempt');
    second.postMessage('rotate');
    await attempted;
    await delay(100);
    assert.equal(
      Atomics.load(control, 0),
      1,
      'First rotation still holds the database write transaction',
    );
    assert.equal(
      Atomics.load(control, 2),
      0,
      'Second rotation must wait before its transaction callback',
    );
    const results = Promise.all([message(first, 'result'), message(second, 'result')]);
    Atomics.store(control, 1, 1);
    Atomics.notify(control, 1);
    const [one, two] = await results;
    assert.deepEqual(errors, []);
    assert.equal(one.ok, true);
    assert.equal(one.credential?.previousId, target.credential.id);
    assert.deepEqual(two, { type: 'result', ok: false, code: 'credential_revoked', status: 409 });
    const history = await f.scope.actorCredentials(f.operator, target.actor.id);
    assert.equal(history.length, 2);
    assert.equal(history.filter((value) => value.previousId === target.credential.id).length, 1);
    assert.equal(
      (await f.state.events(f.operator.projectId)).filter(
        (value) => value.type === 'actor.credential_rotated',
      ).length,
      1,
    );
    await assert.rejects(async () => await f.scope.authenticate(target.token), {
      code: 'unauthorized',
    });
  },
);
