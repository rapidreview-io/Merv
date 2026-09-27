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

test('Identity plugin publishes credentials after State migration', async () => {
  const state = await openState();
  const ctx = new Context();
  ctx.provide('state', state);
  const plugin = ctx.plugin(identityPlugin);
  await plugin.await();
  assert.ok(ctx.identity.credentials);
  assert.deepEqual(ctx.identity.configuration(), { enabled: false });
  await ctx.fiber.dispose();
  await state.close();
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

test('owner revokes all rotations of one subject atomically', async () => {
  const now = Date.parse('2026-09-26T10:00:00.000Z');
  const state = await openState();
  const store = new CredentialStore(state, () => now);
  await store.initialize();
  const input = {
    owner: 'sessions',
    subject: 'agent-1',
    kind: 'session-agent',
    expiresAt: iso(now + 60_000),
    hardDeadline: iso(now + 120_000),
  };
  const a = await store.issue(input);
  const b = await store.issue(input);
  const other = await store.issue({ ...input, subject: 'agent-2' });
  await assert.rejects(
    state.transaction(async (tx) => {
      await store.revokeSubject('sessions', 'agent-1', 'session-agent', tx);
      throw new Error('owner failed');
    }),
  );
  await store.authenticate(a.token, 'session-agent');
  await state.transaction((tx) => store.revokeSubject('sessions', 'agent-1', 'session-agent', tx));
  await assert.rejects(store.authenticate(a.token, 'session-agent'), denied);
  await assert.rejects(store.authenticate(b.token, 'session-agent'), denied);
  await store.authenticate(other.token, 'session-agent');
  await state.close();
});
