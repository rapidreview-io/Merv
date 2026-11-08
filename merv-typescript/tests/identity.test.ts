import { MervError } from '@merv/contracts';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { inspect } from 'node:util';
import { SupabaseIdentity } from '../packages/identity/src/index.js';

const start = Date.parse('2026-09-16T10:00:00.000Z');
const url = 'https://identity.example';
const issuer = `${url}/auth/v1`;
const secret = 'synthetic-shared-identity-secret-at-least-thirty-two-bytes';
const bytes = new TextEncoder().encode(secret);
const claims = (overrides: JWTPayload = {}): JWTPayload => ({
  iss: issuer,
  aud: 'authenticated',
  sub: 'shared-user',
  exp: start / 1000 + 3600,
  role: 'authenticated',
  ...overrides,
});
const token = (overrides: JWTPayload = {}, alg = 'HS256') =>
  new SignJWT(claims(overrides)).setProtectedHeader({ alg }).sign(bytes);
const denied = (error: unknown) =>
  error instanceof MervError && error.code === 'unauthorized' && error.status === 401;
/** No usable key set: 503, so a signed-in person is asked to retry, not signed out. */
const unavailable = (error: unknown) =>
  error instanceof MervError && error.code === 'identity_unavailable' && error.status === 503;
function environment(t: TestContext, value: string) {
  const name = `MERV_IDENTITY_TEST_${randomUUID().replaceAll('-', '_')}`;
  process.env[name] = value;
  t.after(() => delete process.env[name]);
  return name;
}
function hs(t: TestContext, options: { clock?: () => number } = {}) {
  return new SupabaseIdentity(
    { supabaseUrl: url, mode: 'hs256', secretEnv: environment(t, secret) },
    { clock: () => start, ...options },
  );
}
const fetching = (fn: (url: string, options?: RequestInit) => Promise<Response>) =>
  fn as typeof globalThis.fetch;
/** Let background key refreshes run to their next await. */
const settled = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

test('signature, algorithm, issuer, audience, subject, expiry and user-role requirements fail closed', async (t) => {
  const provider = hs(t);
  const badClaims: JWTPayload[] = [
    { iss: 'https://another.example/auth/v1' },
    { iss: undefined },
    { aud: 'another-audience' },
    { aud: undefined },
    { sub: undefined },
    { sub: '' },
    { sub: ' padded-user ' },
    { sub: 'x'.repeat(201) },
    { exp: undefined },
    { exp: start / 1000 },
    { exp: start / 1000 - 1 },
    { nbf: start / 1000 + 1 },
    { is_anonymous: true },
    { is_anonymous: 'true' },
    { role: 'anon' },
    { role: 'service_role' },
    { role: undefined },
  ];
  for (const invalid of badClaims)
    await assert.rejects(provider.verify(await token(invalid)), denied);
  const wrongSignature = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode('another-synthetic-key-at-least-thirty-two-bytes'));
  for (const invalid of [
    wrongSignature,
    await token({}, 'HS384'),
    'not-a-jwt',
    'e30.e30.',
    'a'.repeat(16_385),
  ])
    await assert.rejects(provider.verify(invalid), (error: unknown) => {
      assert.ok(denied(error));
      assert.equal((error as Error).cause, undefined);
      assert.ok(!inspect(error).includes(invalid));
      return true;
    });
  assert.equal((await provider.verify(await token({ nbf: start / 1000 }))).subject, 'shared-user');
});

test('JWKS serves the last good set through refresh failures and fails closed only after 24 hours', async (t) => {
  let time = start;
  t.mock.method(Date, 'now', () => time);
  const first = await generateKeyPair('ES256', { extractable: true });
  const second = await generateKeyPair('ES256', { extractable: true });
  const firstKey = { ...(await exportJWK(first.publicKey)), kid: 'first', alg: 'ES256' };
  const secondKey = { ...(await exportJWK(second.publicKey)), kid: 'second', alg: 'ES256' };
  let keys = [firstKey];
  let calls = 0;
  let failure = false;
  const provider = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => time,
      fetch: fetching(async () => {
        calls++;
        if (failure) throw new Error('synthetic-key-provider-outage');
        return Response.json({ keys });
      }),
    },
  );
  const firstToken = await new SignJWT(claims({ exp: start / 1000 + 3 * 86_400 }))
    .setProtectedHeader({ alg: 'ES256', kid: 'first' })
    .sign(first.privateKey);
  const nextToken = await new SignJWT(claims({ exp: start / 1000 + 3 * 86_400 }))
    .setProtectedHeader({ alg: 'ES256', kid: 'second' })
    .sign(second.privateKey);
  await provider.verify(firstToken);
  keys = [secondKey];
  await assert.rejects(provider.verify(nextToken), denied);
  assert.equal(calls, 1, 'An unknown kid refetches at most every 30 s');
  time += 30_001;
  await provider.verify(nextToken);
  assert.equal(calls, 2);
  const loadedAt = time;
  failure = true;
  time += 300_001;
  await provider.verify(nextToken);
  await settled();
  assert.equal(calls, 3, 'A due refresh runs in the background and the stale set is served');
  await provider.verify(nextToken);
  assert.equal(calls, 3, 'A failed refresh is retried at most every 30 s');
  // During the outage a kid the stale set lacks may be a new key: retry, never sign out.
  await assert.rejects(provider.verify(firstToken), unavailable);
  assert.equal(calls, 3);
  time += 30_001;
  await provider.verify(nextToken);
  await settled();
  assert.equal(calls, 4);
  time = loadedAt + 24 * 3_600_000;
  await assert.rejects(provider.verify(nextToken), (error: unknown) => {
    assert.ok(unavailable(error));
    assert.equal((error as Error).cause, undefined);
    assert.ok(!inspect(error).includes('synthetic-key-provider-outage'));
    return true;
  });
  assert.equal(calls, 5, 'A set 24 h old is no longer trusted; the request waits for a fetch');
  await assert.rejects(provider.verify(nextToken), unavailable);
  assert.equal(calls, 5);
  failure = false;
  time += 30_001;
  await provider.verify(nextToken);
  assert.equal(calls, 6, 'The verifier recovers by itself');
  time += 24 * 3_600_000 + 1;
  failure = false;
  await provider.verify(nextToken);
  assert.equal(calls, 7, 'A forward clock jump past 24 h makes one blocking refetch');
  await provider.verify(nextToken);
  assert.equal(calls, 7);
});

test('JWKS timeout bounds a stalled response body and cancels its reader', async (t) => {
  const pair = await generateKeyPair('ES256');
  const signed = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256' })
    .sign(pair.privateKey);
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 5000);
    return controller.signal;
  });
  let cancelCount = 0;
  let fetched!: () => void;
  const responseStarted = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  const provider = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => start,
      fetch: fetching(async () => {
        const response = new Response(
          new ReadableStream({
            start() {
              fetched();
            },
            cancel() {
              cancelCount++;
            },
          }),
        );
        return response;
      }),
    },
  );
  const pending = provider.verify(signed);
  await responseStarted;
  controller.abort();
  await assert.rejects(pending, unavailable);
  assert.equal(cancelCount, 1);
});
