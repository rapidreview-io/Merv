/**
 * Scope's credential rows and the Identity ledger that co-decides their liveness, when the two
 * disagree: rows an older image wrote after this instance's boot pass (no ledger row yet), a
 * revocation made only in the ledger, and ledger rows that are not Scope's own. Cases that fail
 * today are marked with the plan step that turns them on.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createService,
  MervError,
  newId,
  sha256Hex,
  type Caller,
  type Principal,
} from '@merv/contracts';
import { CredentialStore } from '@merv/identity/credentials';
import { ProjectScope } from '@merv/scope';
import type { LedgerKind } from '@merv/scope/ledger';
import { openState } from './fixtures/state.js';

const issuer = 'https://identity.example/auth/v1';
const hour = 3_600_000;

async function fixture() {
  const state = await openState();
  let now = Date.parse('2026-09-27T12:00:00.000Z');
  const clock = () => now;
  const time = (offset = 0) => new Date(now + offset).toISOString();
  /** A Scope instance booting on this database, as a restart or a second server would. */
  const boot = async () => await createService(new ProjectScope(state, clock));
  const scope = await boot();
  const origin = await scope.bootstrap({ projectName: 'Ledger drift', actorName: 'Owner' });
  const owner: Caller = {
    actorId: origin.actor.id,
    projectId: origin.project.id,
    credentialId: origin.credential.id,
  };
  const machine = await scope.issueActor(owner, { name: 'Machine', role: 'producer' });
  const login = async () =>
    await scope.acceptVerifiedIdentity({ issuer, subject: 'alice', expiresAt: time(hour) });
  const alice = await login();
  const project = await scope.createProject(alice, { name: 'Keys', requestId: 'keys' });
  return {
    state,
    scope,
    boot,
    owner,
    machine,
    login,
    alice,
    project,
    time,
    ledger: new CredentialStore(state, clock),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An actor credential of the machine actor written straight to Scope's table, as an older image would. */
async function legacyCredential(
  f: Fixture,
  {
    token = randomBytes(32).toString('base64url'),
    id = newId('credential'),
    expiresAt = null as string | null,
    revokedAt = null as string | null,
  } = {},
) {
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at,expires_at,revoked_at,previous_id) VALUES(?,?,?,?,?,?,?,?,NULL)',
      id,
      f.machine.actor.id,
      f.owner.projectId,
      'actor',
      sha256Hex(token),
      f.time(),
      expiresAt,
      revokedAt,
    ),
  );
  return { id, token, tokenHash: sha256Hex(token) };
}

/** A project key of alice's written straight to Scope's table, as an older image would. */
async function legacyKey(
  f: Fixture,
  {
    token = `mk_${randomBytes(32).toString('base64url')}`,
    id = newId('key'),
    revokedAt = null as string | null,
  } = {},
) {
  const key = {
    id,
    owner: { issuer, subject: 'alice' },
    projectId: f.project.id,
    grantScope: 'project' as const,
    label: null,
    createdAt: f.time(),
    expiresAt: null,
    revokedAt,
    previousId: null,
  };
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO user_keys(id,issuer,subject,project_id,grant_scope,label,token_hash,created_at,expires_at,revoked_at,previous_id) VALUES(?,?,?,?,?,NULL,?,?,NULL,?,NULL)',
      id,
      issuer,
      'alice',
      f.project.id,
      'project',
      sha256Hex(token),
      key.createdAt,
      revokedAt,
    ),
  );
  const principal: Principal = { kind: 'key', key };
  return { id, token, tokenHash: sha256Hex(token), principal };
}

const ledgerRow = async (f: Fixture, tokenHash: string) =>
  await f.state.read((sql) =>
    sql.get<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM identity_credentials WHERE token_hash=?',
      tokenHash,
    ),
  );
const scopeRevokedAt = async (f: Fixture, table: 'actor_credentials' | 'user_keys', id: string) =>
  (await f.state.read((sql) =>
    sql.get<{ revoked_at: string | null }>(`SELECT revoked_at FROM ${table} WHERE id=?`, id),
  ))!.revoked_at;
const unauthorized = { code: 'unauthorized', status: 401 };

const unadopted: [
  string,
  LedgerKind,
  (f: Fixture) => Promise<{ token: string; tokenHash: string }>,
  (scope: ProjectScope, token: string) => Promise<unknown>,
][] = [
  [
    'revokeCredential',
    'actor',
    async (f) => {
      const legacy = await legacyCredential(f);
      await f.scope.revokeCredential(f.owner, legacy.id);
      return legacy;
    },
    async (scope, token) => await scope.authenticate(token),
  ],
  [
    'rotateCredential',
    'actor',
    async (f) => {
      const legacy = await legacyCredential(f);
      const next = await f.scope.rotateCredential(f.owner, { credentialId: legacy.id });
      assert.equal((await f.scope.authenticate(next.token)).id, f.machine.actor.id);
      return legacy;
    },
    async (scope, token) => await scope.authenticate(token),
  ],
  [
    'revokeKey',
    'user-key',
    async (f) => {
      const legacy = await legacyKey(f);
      await f.scope.revokeKey(f.alice, legacy.id);
      return legacy;
    },
    async (scope, token) => await scope.authenticateKey(token),
  ],
  [
    'rotateKey',
    'user-key',
    async (f) => {
      const legacy = await legacyKey(f);
      const next = await f.scope.rotateKey(f.alice, { keyId: legacy.id });
      assert.equal((await f.scope.authenticateKey(next.token)).id, next.key.id);
      return legacy;
    },
    async (scope, token) => await scope.authenticateKey(token),
  ],
];

for (const [name, kind, retire, authenticate] of unadopted)
  test(`${name} of a row the ledger has not adopted succeeds and stays revoked`, async (t) => {
    const f = await fixture();
    const legacy = await retire(f);
    await t.test('the ledger records the revocation at once', async () => {
      assert.notEqual((await ledgerRow(f, legacy.tokenHash))?.revoked_at ?? null, null);
    });
    await t.test('a restarted Scope still refuses the token', async () => {
      await assert.rejects(authenticate(await f.boot(), legacy.token), unauthorized);
      // Scope refuses on its own revoked_at too; the ledger must refuse on its own.
      await assert.rejects(f.ledger.authenticate(legacy.token, kind), unauthorized);
    });
  });

test('a restart adopts a revoked row the ledger never held as revoked', async () => {
  const f = await fixture();
  const revokedAt = f.time(-hour);
  const credential = await legacyCredential(f, { revokedAt });
  const key = await legacyKey(f, { revokedAt });
  await f.boot();
  for (const [legacy, kind] of [
    [credential, 'actor'],
    [key, 'user-key'],
  ] as const) {
    assert.equal((await ledgerRow(f, legacy.tokenHash))?.revoked_at, revokedAt);
    await assert.rejects(f.ledger.authenticate(legacy.token, kind), unauthorized);
  }
});

test('a credential revoked only in the ledger cannot be rotated', async () => {
  const f = await fixture();
  await f.ledger.revoke(
    (await f.state.read((sql) =>
      sql.get<{ token_hash: string }>(
        'SELECT token_hash FROM actor_credentials WHERE id=?',
        f.machine.credential.id,
      ),
    ))!.token_hash,
    'scope',
  );
  await assert.rejects(
    f.scope.rotateCredential(f.owner, { credentialId: f.machine.credential.id }),
    { code: 'credential_revoked', status: 409 },
  );
  assert.equal(await scopeRevokedAt(f, 'actor_credentials', f.machine.credential.id), null);
});

test('a rotation that would outlive its caller is refused before the ledger is consulted', async () => {
  const f = await fixture();
  const limited = await f.scope.issueActor(f.owner, {
    name: 'Limited operator',
    role: 'operator',
    expiresAt: f.time(hour),
  });
  const caller: Caller = {
    actorId: limited.actor.id,
    projectId: limited.actor.projectId,
    credentialId: limited.credential.id,
  };
  await f.ledger.revoke(sha256Hex(f.machine.token), 'scope');
  // The machine credential never expires, so keeping its deadline outlives the caller's.
  await assert.rejects(
    f.scope.rotateCredential(caller, { credentialId: f.machine.credential.id }),
    { code: 'self_expiry_extension', status: 403 },
  );
  assert.equal(await scopeRevokedAt(f, 'actor_credentials', f.machine.credential.id), null);
});

test('a key revoked only in the ledger cannot be rotated', async () => {
  const f = await fixture();
  const { key, token } = await f.scope.createKey(f.alice, { projectId: f.project.id });
  await f.ledger.revoke(sha256Hex(token), 'scope');
  await assert.rejects(f.scope.rotateKey(f.alice, { keyId: key.id }), {
    code: 'key_revoked',
    status: 409,
  });
  assert.equal(await scopeRevokedAt(f, 'user_keys', key.id), null);
});

test('an expired credential or key is still renewed with an explicit expiry', async () => {
  const f = await fixture();
  const issued = await f.scope.issueActorCredential(f.owner, {
    actorId: f.machine.actor.id,
    expiresAt: f.time(hour),
  });
  const key = await f.scope.createKey(f.alice, {
    projectId: f.project.id,
    expiresAt: f.time(hour),
  });
  f.advance(2 * hour);
  const renewed = await f.scope.rotateCredential(f.owner, {
    credentialId: issued.credential.id,
    expiresAt: f.time(hour),
  });
  assert.equal((await f.scope.authenticate(renewed.token)).id, f.machine.actor.id);
  const rotated = await f.scope.rotateKey(await f.login(), {
    keyId: key.key.id,
    expiresAt: f.time(hour),
  });
  assert.equal((await f.scope.authenticateKey(rotated.token)).id, rotated.key.id);
});

test('revoking a hash another authority owns is refused as a conflict', async () => {
  const f = await fixture();
  const foreign = await f.ledger.issue({
    owner: 'other',
    subject: 'other_subject',
    kind: 'other',
    prefix: '',
    expiresAt: null,
  });
  const legacy = await legacyCredential(f, { token: foreign.token });
  await assert.rejects(f.scope.revokeCredential(f.owner, legacy.id), {
    code: 'credential_conflict',
    status: 409,
  });
  assert.equal(await scopeRevokedAt(f, 'actor_credentials', legacy.id), null);
});

test('an actor credential whose ledger row another owner holds is refused', async () => {
  const f = await fixture();
  const id = newId('credential');
  const { token } = await f.ledger.issue({
    owner: 'other',
    subject: id,
    kind: 'actor',
    prefix: '',
    expiresAt: null,
  });
  await legacyCredential(f, { token, id });
  await assert.rejects(f.scope.authenticate(token), unauthorized);
  await assert.rejects(
    f.scope.require(
      { actorId: f.machine.actor.id, projectId: f.owner.projectId, credentialId: id },
      'read',
    ),
    unauthorized,
  );
});

test('an actor credential whose ledger row names another subject is refused', async () => {
  const f = await fixture();
  const { token } = await f.ledger.issue({
    owner: 'scope',
    subject: newId('credential'),
    kind: 'actor',
    prefix: '',
    expiresAt: null,
  });
  const legacy = await legacyCredential(f, { token });
  await assert.rejects(f.scope.authenticate(token), unauthorized);
  await assert.rejects(
    f.scope.require(
      { actorId: f.machine.actor.id, projectId: f.owner.projectId, credentialId: legacy.id },
      'read',
    ),
    unauthorized,
  );
});

test('a user key whose ledger row another owner holds is refused', async () => {
  const f = await fixture();
  const id = newId('key');
  const { token } = await f.ledger.issue({
    owner: 'other',
    subject: id,
    kind: 'user-key',
    prefix: 'mk_',
    expiresAt: null,
  });
  const legacy = await legacyKey(f, { token, id });
  await assert.rejects(f.scope.authenticateKey(token), unauthorized);
  await assert.rejects(f.scope.caller(legacy.principal), unauthorized);
});

test('a user key whose ledger row names another subject is refused', async () => {
  const f = await fixture();
  const { token } = await f.ledger.issue({
    owner: 'scope',
    subject: newId('key'),
    kind: 'user-key',
    prefix: 'mk_',
    expiresAt: null,
  });
  const legacy = await legacyKey(f, { token });
  await assert.rejects(f.scope.authenticateKey(token), unauthorized);
  await assert.rejects(f.scope.caller(legacy.principal), unauthorized);
});

test('a restart with nothing to adopt adopts nothing and takes no writer lock', async (t) => {
  const f = await fixture();
  const adopt = t.mock.method(CredentialStore.prototype, 'adopt');
  // Counts every transaction of the boot, not only the adoption pass. That is exact today because
  // State.migrate runs its steps through the internal transact(), not transaction(); a new
  // boot-time transaction elsewhere must be excluded here rather than tolerated.
  const transaction = t.mock.method(f.state, 'transaction');
  await f.boot();
  assert.equal(adopt.mock.callCount(), 0);
  assert.equal(transaction.mock.callCount(), 0);
});

test('a restart adopts exactly the rows written since the last boot pass', async (t) => {
  const f = await fixture();
  const legacy = await legacyCredential(f);
  const adopt = t.mock.method(CredentialStore.prototype, 'adopt');
  const scope = await f.boot();
  assert.equal((await scope.authenticate(legacy.token)).credential.id, legacy.id);
  await t.test('and only those', () => {
    assert.equal(adopt.mock.callCount(), 1);
  });
});

test('a hash another authority owns does not stop a restart and stays refused', async () => {
  const f = await fixture();
  const id = newId('credential');
  const { token } = await f.ledger.issue({
    owner: 'other',
    subject: id,
    kind: 'actor',
    prefix: '',
    expiresAt: null,
  });
  await legacyCredential(f, { token, id });
  const scope = await f.boot();
  await assert.rejects(scope.authenticate(token), unauthorized);
});

test('a malformed row never adopted still stops a restart', async (t) => {
  const f = await fixture();
  // Scope writes canonical timestamps; this one lacks milliseconds.
  const legacy = await legacyCredential(f, { expiresAt: '2030-01-01T00:00:00Z' });
  await assert.rejects(f.boot(), MervError);
  await t.test('naming the row', async () => {
    await assert.rejects(
      f.boot(),
      (error: { code?: string; status?: number; message?: string }) => {
        assert.equal(error.code, 'scope_ledger_adoption');
        assert.equal(error.status, 500);
        assert.match(error.message ?? '', new RegExp(legacy.id));
        return true;
      },
    );
  });
});
