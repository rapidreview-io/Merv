import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Context } from 'cordis';
import { MervError } from '@merv/contracts';
import { identityPlugin } from '@merv/identity';
import { CredentialStore, tokenDigest } from '@merv/identity/credentials';
import { openState } from './fixtures/state.js';

const iso = (time: number) => new Date(time).toISOString();
const denied = (error: unknown) => error instanceof MervError && error.status === 401;

test('Identity plugin loads without State and publishes no credential store', async () => {
  const ctx = new Context();
  const plugin = ctx.plugin(identityPlugin);
  await plugin.await();
  assert.equal('credentials' in ctx.identity, false);
  assert.deepEqual(ctx.identity.configuration(), { enabled: false });
  await ctx.fiber.dispose();
});

test('issued secrets remain valid across restart and only their digests are stored', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'merv-identity-credentials-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  let state = await openState(path);
  const first = new CredentialStore(state, () => now);
  await first.initialize();
  const { token, credential } = await first.issue({
    owner: 'sessions',
    subject: 'execution-1',
    kind: 'session',
    prefix: 'ms_',
    expiresAt: iso(now + 60_000),
    hardDeadline: iso(now + 120_000),
  });
  assert.match(token, /^ms_[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.tokenHash, tokenDigest(token));
  assert.equal((await first.authenticate(token, 'session')).subject, 'execution-1');
  const stored = await state.read((sql) =>
    sql.get<{ token_hash: string }>(
      'SELECT token_hash FROM identity_credentials WHERE id=?',
      credential.id,
    ),
  );
  assert.deepEqual(stored, { token_hash: tokenDigest(token) });
  await state.close();
  state = await openState(path);
  const second = new CredentialStore(state, () => now);
  await second.initialize();
  assert.equal((await second.authenticate(token, ['agent', 'session'])).id, credential.id);
  await assert.rejects(second.authenticate(token, 'agent'), denied);
  await second.renew(credential.tokenHash, 'sessions', iso(now + 90_000));
  now += 70_000;
  assert.equal((await second.authenticate(token, 'session')).id, credential.id);
  await assert.rejects(second.renew(credential.tokenHash, 'pi', iso(now + 10_000)));
  await assert.rejects(second.renew(credential.tokenHash, 'sessions', iso(now + 60_000)));
  await second.revoke(credential.tokenHash, 'sessions');
  await second.revoke(credential.tokenHash, 'sessions');
  await assert.rejects(second.authenticate(token, 'session'), denied);
  await assert.rejects(second.renew(credential.tokenHash, 'sessions', iso(now + 20_000)), denied);
  await state.close();
});

test('adoption is insert-only and lifecycle mutations roll back with their owner', async () => {
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  const state = await openState();
  const store = new CredentialStore(state, () => now);
  await store.initialize();
  const token = `piw_flt_a.${randomBytes(32).toString('base64url')}`;
  const tokenHash = tokenDigest(token);
  const input = {
    owner: 'pi',
    subject: 'slot-1',
    kind: 'pi-worker',
    tokenHash,
    expiresAt: iso(now + 60_000),
    hardDeadline: iso(now + 120_000),
  };
  await assert.rejects(
    state.transaction(async (tx) => {
      await store.adopt(input, tx);
      throw new Error('owner failed');
    }),
  );
  await assert.rejects(store.authenticate(token, 'pi-worker'), denied);
  const original = await store.adopt(input);
  assert.equal((await store.adopt({ ...input, expiresAt: iso(now + 119_000) })).id, original.id);
  assert.equal((await store.authenticate(token, 'pi-worker')).expiresAt, input.expiresAt);
  await assert.rejects(
    state.transaction(async (tx) => {
      await store.renew(tokenHash, 'pi', iso(now + 90_000), tx);
      throw new Error('owner failed');
    }),
  );
  assert.equal((await store.authenticate(token, 'pi-worker')).expiresAt, input.expiresAt);
  await assert.rejects(
    state.transaction(async (tx) => {
      await store.revoke(tokenHash, 'pi', tx);
      throw new Error('owner failed');
    }),
  );
  assert.equal((await store.authenticate(token, 'pi-worker')).id, original.id);
  now += 60_000;
  await assert.rejects(store.authenticate(token, 'pi-worker'), denied);
  await assert.rejects(store.renew(tokenHash, 'pi', iso(now + 10_000)), denied);
  assert.equal((await store.adopt(input)).id, original.id);
  await assert.rejects(store.authenticate(token, 'pi-worker'), denied);
  await state.close();
});

const conflict = (status: number) => (error: unknown) =>
  error instanceof MervError && error.status === status;

test('adoption is idempotent and never revives, extends or re-owns a row', async () => {
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  const state = await openState();
  const store = new CredentialStore(state, () => now);
  await store.initialize();
  const token = `ms_${randomBytes(32).toString('base64url')}`;
  const input = {
    owner: 'scope',
    subject: 'credential-1',
    kind: 'actor',
    tokenHash: tokenDigest(token),
    expiresAt: iso(now + 60_000),
    hardDeadline: iso(now + 60_000),
  };
  const original = await store.adopt(input);
  assert.equal(original.revokedAt, null);
  assert.equal((await store.authenticate(token, 'actor')).id, original.id);
  const later = { expiresAt: iso(now + 120_000), hardDeadline: iso(now + 120_000) };
  const again = await store.adopt({ ...input, ...later });
  assert.equal(again.id, original.id);
  assert.equal(again.expiresAt, input.expiresAt);
  const first = iso(now);
  assert.equal((await store.revoke(input.tokenHash, 'scope'))?.revokedAt, first);
  now += 1_000;
  for (const repeat of [input, { ...input, ...later }]) {
    const adopted = await store.adopt(repeat);
    assert.equal(adopted.id, original.id);
    assert.equal(adopted.revokedAt, first);
  }
  await assert.rejects(store.authenticate(token, 'actor'), denied);
  for (const mismatch of [{ owner: 'sessions' }, { subject: 'credential-2' }, { kind: 'user-key' }])
    await assert.rejects(store.adopt({ ...input, ...mismatch }), conflict(409));
  assert.equal((await store.revoke(input.tokenHash, 'scope'))?.revokedAt, first);
  await state.close();
});

test('revocation is owner-checked, idempotent and a no-op for an unknown hash', async () => {
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  const state = await openState();
  const store = new CredentialStore(state, () => now);
  await store.initialize();
  const { token, credential } = await store.issue({
    owner: 'sessions',
    subject: 'execution-1',
    kind: 'session-execution',
    prefix: 'ms_',
    expiresAt: iso(now + 60_000),
    hardDeadline: iso(now + 120_000),
  });
  await assert.rejects(store.revoke(credential.tokenHash, 'pi'), conflict(403));
  assert.equal((await store.authenticate(token, 'session-execution')).id, credential.id);
  const unknown = tokenDigest('never-issued-or-adopted-token');
  assert.equal(await store.revoke(unknown, 'sessions'), undefined);
  // An owner transaction that revokes a legacy hash missing from the ledger still commits.
  await state.transaction(async (tx) => {
    assert.equal(await store.revoke(unknown, 'sessions', tx), undefined);
    await tx.run(
      'UPDATE identity_credentials SET expires_at=? WHERE token_hash=?',
      iso(now + 90_000),
      credential.tokenHash,
    );
  });
  assert.equal((await store.authenticate(token, 'session-execution')).expiresAt, iso(now + 90_000));
  const revoked = await store.revoke(credential.tokenHash, 'sessions');
  assert.equal(revoked?.revokedAt, iso(now));
  now += 5_000;
  assert.equal((await store.revoke(credential.tokenHash, 'sessions'))?.revokedAt, iso(now - 5_000));
  await assert.rejects(store.authenticate(token, 'session-execution'), denied);
  // An expired row can still be revoked; the row keeps its expiry.
  const expiring = await store.issue({
    owner: 'pi',
    subject: 'slot-1',
    kind: 'pi-worker',
    prefix: 'piw_',
    expiresAt: iso(now + 1_000),
    hardDeadline: iso(now + 1_000),
  });
  now += 2_000;
  const late = await store.revoke(expiring.credential.tokenHash, 'pi');
  assert.deepEqual([late?.revokedAt, late?.expiresAt], [iso(now), expiring.credential.expiresAt]);
  await state.close();
});

test('renewal needs a hard deadline, only moves expiry forward and stops at the boundaries', async () => {
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  const state = await openState();
  const store = new CredentialStore(state, () => now);
  await store.initialize();
  const unbounded = await store.issue({
    owner: 'sessions',
    subject: 'agent-1',
    kind: 'session-agent',
    prefix: 'ms_',
    expiresAt: iso(now + 60_000),
  });
  await assert.rejects(
    store.renew(unbounded.credential.tokenHash, 'sessions', iso(now + 90_000)),
    (error: unknown) =>
      error instanceof MervError && error.status === 400 && error.code === 'invalid_credential',
  );
  const { token, credential } = await store.issue({
    owner: 'sessions',
    subject: 'execution-1',
    kind: 'session-execution',
    prefix: 'ms_',
    expiresAt: iso(now + 60_000),
    hardDeadline: iso(now + 120_000),
  });
  const earlier = await store.renew(credential.tokenHash, 'sessions', iso(now + 30_000));
  assert.equal(earlier.expiresAt, iso(now + 60_000));
  assert.equal(
    (await store.renew(credential.tokenHash, 'sessions', iso(now + 60_000))).expiresAt,
    iso(now + 60_000),
  );
  await assert.rejects(
    store.renew(credential.tokenHash, 'sessions', iso(now + 120_001)),
    conflict(400),
  );
  assert.equal(
    (await store.renew(credential.tokenHash, 'sessions', iso(now + 120_000))).expiresAt,
    iso(now + 120_000),
  );
  // expires_at == now and hard_deadline == now are not live.
  now += 120_000;
  await assert.rejects(store.authenticate(token, 'session-execution'), denied);
  const expiry = await store.issue({
    owner: 'scope',
    subject: 'credential-1',
    kind: 'actor',
    prefix: 'ms_',
    expiresAt: iso(now + 1_000),
  });
  now += 1_000;
  await assert.rejects(store.authenticate(expiry.token, 'actor'), denied);
  now -= 1;
  assert.equal((await store.authenticate(expiry.token, 'actor')).id, expiry.credential.id);
  await state.close();
});

test('the ledger trigger refuses raw un-revoke, shortened expiry, deadline changes and deletion', async () => {
  const now = Date.parse('2026-09-26T10:00:00.000Z');
  const state = await openState();
  const store = new CredentialStore(state, () => now);
  await store.initialize();
  const input = {
    owner: 'pi',
    subject: 'slot-1',
    kind: 'pi-worker',
    prefix: 'piw_',
    expiresAt: iso(now + 60_000),
    hardDeadline: iso(now + 120_000),
  };
  const live = await store.issue(input);
  const revoked = await store.issue({ ...input, subject: 'slot-2' });
  await store.revoke(revoked.credential.tokenHash, 'pi');
  // Without a hard deadline the CHECK constraint allows a NULL expiry, so only the
  // trigger can refuse lifting it.
  const unbounded = await store.issue({ ...input, subject: 'slot-3', hardDeadline: undefined });
  const refusals: [string, ...string[]][] = [
    [
      'UPDATE identity_credentials SET revoked_at=NULL WHERE token_hash=?',
      revoked.credential.tokenHash,
    ],
    [
      'UPDATE identity_credentials SET expires_at=? WHERE token_hash=?',
      iso(now + 30_000),
      live.credential.tokenHash,
    ],
    [
      'UPDATE identity_credentials SET expires_at=NULL WHERE token_hash=?',
      unbounded.credential.tokenHash,
    ],
    [
      'UPDATE identity_credentials SET hard_deadline=? WHERE token_hash=?',
      iso(now + 110_000),
      live.credential.tokenHash,
    ],
    ['DELETE FROM identity_credentials WHERE token_hash=?', revoked.credential.tokenHash],
  ];
  for (const [statement, ...values] of refusals)
    await assert.rejects(
      state.transaction((tx) => tx.run(statement, ...values)),
      (error: unknown) => error instanceof MervError && error.code === 'state_constraint',
    );
  assert.equal((await store.authenticate(live.token, 'pi-worker')).expiresAt, input.expiresAt);
  assert.equal((await store.authenticate(unbounded.token, 'pi-worker')).expiresAt, input.expiresAt);
  await assert.rejects(store.authenticate(revoked.token, 'pi-worker'), denied);
  await state.close();
});
