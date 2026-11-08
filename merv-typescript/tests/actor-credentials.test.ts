import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Caller, IssuedActorCredential } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';

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
  const admin = await scope.credentials.bootstrap({
    projectName: 'Actor credentials',
    actorName: 'Operator',
  });
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

test('issuance returns secret once while storage, metadata and events retain only its digest', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-actor-credential-secrets-'));
  const path = directory;
  const f = await fixture(path);
  t.after(async () => {
    await f.state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const issued = await f.scope.credentials.issueActor(f.operator, {
    name: 'Researcher',
    role: 'producer',
  });
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
  const metadata = await f.scope.credentials.actorCredentials(asCaller(issued));
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
  assert.notEqual(
    (await f.scope.credentials.actorCredentials(asCaller(issued)))[0].actorId,
    'changed',
  );
  assert.equal((await f.scope.authenticate(issued.token)).credential.expiresAt, null);
});

test('expiry is canonical, rejects invalid issuance atomically and fences previously authenticated callers at the deadline', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const deadline = new Date(start + 1000).toISOString();
  const issued = await f.scope.credentials.issueActor(f.operator, {
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
        await f.scope.credentials.issueActor(f.operator, {
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

test('credential revocation preserves actor authority and provenance; actor revocation invalidates every credential', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  await assert.rejects(
    async () => await f.scope.credentials.revokeCredential(f.operator, f.admin.credential.id),
    {
      code: 'self_revoke',
    },
  );
  const issued = await f.scope.credentials.issueActor(f.operator, {
    name: 'Reviewer',
    role: 'reviewer',
  });
  const head = await f.state.eventHead();
  await f.scope.credentials.revokeCredential(f.operator, issued.credential.id);
  await f.scope.credentials.revokeCredential(f.operator, issued.credential.id);
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
  const active = await f.scope.credentials.issueActor(f.operator, {
    name: 'Another reviewer',
    role: 'reviewer',
  });
  const extraToken = (
    await f.scope.credentials.issueActorCredential(f.operator, { actorId: active.actor.id })
  ).token;
  assert.equal((await f.scope.authenticate(extraToken)).id, active.actor.id);
  await f.scope.credentials.revokeActor(f.operator, active.actor.id);
  for (const token of [active.token, extraToken])
    await assert.rejects(async () => await f.scope.authenticate(token), { code: 'unauthorized' });
  assert.equal(await f.scope.eligible(active.actor.projectId, active.actor.id, 'review'), false);
  const history = await f.scope.credentials.actorCredentials(f.operator, active.actor.id);
  assert.equal(history.length, 2);
  assert.ok(
    history.every((value) => value.revokedAt === null),
    'Identity revocation is separate from credential revocation',
  );
  await assert.rejects(
    async () =>
      await f.scope.credentials.rotateCredential(f.operator, {
        credentialId: active.credential.id,
      }),
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
  const issued = await f.scope.credentials.issueActor(f.operator, {
    name: 'Producer',
    role: 'producer',
  });
  const head = await f.state.eventHead();
  const identities = await f.scope.actors(f.operator);
  const original = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    await original(tx, event);
    throw new Error('Injected event failure');
  };
  for (const action of [
    async () =>
      await f.scope.credentials.issueActor(f.operator, { name: 'Rolled back', role: 'reader' }),
    async () =>
      await f.scope.credentials.issueActorCredential(f.operator, { actorId: issued.actor.id }),
    async () =>
      await f.scope.credentials.rotateCredential(f.operator, {
        credentialId: issued.credential.id,
      }),
    async () => await f.scope.credentials.revokeCredential(f.operator, issued.credential.id),
  ]) {
    await assert.rejects(action, /Injected event failure/);
    assert.equal(await f.state.eventHead(), head);
    assert.deepEqual(await f.scope.actors(f.operator), identities);
    assert.deepEqual(await f.scope.credentials.actorCredentials(f.operator, issued.actor.id), [
      issued.credential,
    ]);
    assert.equal((await f.scope.authenticate(issued.token)).id, issued.actor.id);
  }
  f.state.appendEvent = original;
  assert.equal(
    (await f.scope.credentials.rotateCredential(f.operator, { credentialId: issued.credential.id }))
      .actor.id,
    issued.actor.id,
  );
});

test('nothing minted through an expiring operator credential outlives it, and its conversation mints nothing', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const deadline = new Date(start + 2000).toISOString();
  const limited = await f.scope.credentials.issueActor(f.operator, {
    name: 'Limited operator',
    role: 'operator',
    expiresAt: deadline,
  });
  const lasting = await f.scope.credentials.issueActor(f.operator, {
    name: 'Lasting',
    role: 'producer',
  });
  const conversation: Caller = {
    actorId: limited.actor.id,
    projectId: limited.actor.projectId,
    conversation: {
      id: 'conversation_limited',
      epoch: 1,
      commandId: 'command_limited',
      runtimeId: 'runtime_limited',
    },
  };
  const source = await f.scope.delegationSource(asCaller(limited));
  t.after(f.scope.registerConversationAuthority({ require: async () => structuredClone(source) }));
  assert.equal((await f.scope.delegationSource(conversation)).kind, 'actor');
  // A conversation never administers actors or their credentials, whatever its source.
  for (const attempt of [
    () => f.scope.credentials.issueActor(conversation, { name: 'Via Pi', role: 'reader' }),
    () => f.scope.credentials.issueActorCredential(conversation, { actorId: lasting.actor.id }),
    () =>
      f.scope.credentials.rotateCredential(conversation, {
        credentialId: lasting.credential.id,
        expiresAt: deadline,
      }),
  ])
    await assert.rejects(attempt(), { code: 'forbidden', status: 403 });
  for (const [name, caller] of [['credential', asCaller(limited)]] as const) {
    const actors = await f.scope.actors(f.operator);
    const credentials = await f.scope.credentials.actorCredentials(f.operator, lasting.actor.id);
    const head = await f.state.eventHead();
    for (const expiresAt of [null, new Date(start + 2001).toISOString()]) {
      await assert.rejects(
        f.scope.credentials.issueActor(caller, { name: 'Unbounded', role: 'producer', expiresAt }),
        { code: 'self_expiry_extension', status: 403 },
        name,
      );
      await assert.rejects(
        f.scope.credentials.issueActorCredential(caller, { actorId: lasting.actor.id, expiresAt }),
        { code: 'self_expiry_extension', status: 403 },
        name,
      );
    }
    // The default keeps the old credential's null deadline, which the caller cannot grant.
    await assert.rejects(
      f.scope.credentials.rotateCredential(caller, { credentialId: lasting.credential.id }),
      { code: 'self_expiry_extension', status: 403 },
      name,
    );
    assert.deepEqual(await f.scope.actors(f.operator), actors, name);
    assert.deepEqual(
      await f.scope.credentials.actorCredentials(f.operator, lasting.actor.id),
      credentials,
      name,
    );
    assert.equal(await f.state.eventHead(), head, name);
    assert.equal((await f.scope.authenticate(lasting.token)).id, lasting.actor.id, name);
    // An omitted expiry inherits the caller's deadline; an explicit one may reach it.
    const created = await f.scope.credentials.issueActor(caller, {
      name: `${name} actor`,
      role: 'reader',
    });
    assert.equal(created.credential.expiresAt, deadline, name);
    const issued = await f.scope.credentials.issueActorCredential(caller, {
      actorId: lasting.actor.id,
    });
    assert.equal(issued.credential.expiresAt, deadline, name);
    const earlier = new Date(start + 1000).toISOString();
    assert.equal(
      (
        await f.scope.credentials.issueActor(caller, {
          name: `${name} earlier`,
          role: 'reader',
          expiresAt: earlier,
        })
      ).credential.expiresAt,
      earlier,
      name,
    );
    const rotated = await f.scope.credentials.rotateCredential(caller, {
      credentialId: issued.credential.id,
      expiresAt: deadline,
    });
    assert.equal(rotated.credential.expiresAt, deadline, name);
    // A lasting credential of another actor may be tightened to the caller's deadline.
    const unbounded = await f.scope.credentials.issueActorCredential(f.operator, {
      actorId: lasting.actor.id,
    });
    assert.equal(unbounded.credential.expiresAt, null, name);
    const tightened = await f.scope.credentials.rotateCredential(caller, {
      credentialId: unbounded.credential.id,
      expiresAt: deadline,
    });
    assert.equal(tightened.credential.expiresAt, deadline, name);
    assert.equal((await f.scope.authenticate(tightened.token)).id, lasting.actor.id, name);
  }
  // An operator on a lasting credential, and a bare in-process caller, set any deadline.
  for (const caller of [
    f.operator,
    { actorId: f.operator.actorId, projectId: f.operator.projectId },
  ])
    assert.equal(
      (await f.scope.credentials.issueActor(caller, { name: 'Unbounded', role: 'reader' }))
        .credential.expiresAt,
      null,
    );
  assert.equal(
    (
      await f.scope.credentials.rotateCredential(f.operator, {
        credentialId: lasting.credential.id,
        expiresAt: null,
      })
    ).credential.expiresAt,
    null,
  );
});
