import { mapAsync } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { Context } from 'cordis';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { MervError } from '@merv/contracts';
import { SupabaseIdentity, identityPlugin } from '../packages/identity/src/index.js';

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

test('disabled identity is independent and Cordis provides it without State or Scope', async (t) => {
  const provider = new SupabaseIdentity();
  assert.deepEqual(provider.configuration(), { enabled: false });
  await assert.rejects(provider.verify(await token()), denied);
  const ctx = new Context();
  const entry = ctx.plugin(identityPlugin);
  await entry.await();
  assert.deepEqual(ctx.identity.configuration(), { enabled: false });
  assert.deepEqual(identityPlugin.inject, []);
  t.after(async () => {
    await ctx.fiber.dispose();
  });
});

test('HS256 verifies only signed account identity and rechecks expiry after asynchronous verification', async (t) => {
  let time = start;
  const provider = hs(t, { clock: () => time });
  const signed = await token({ user_metadata: { role: 'operator', actorId: 'forged' } });
  assert.deepEqual(await provider.verify(signed), {
    issuer,
    subject: 'shared-user',
    expiresAt: new Date(start + 3_600_000).toISOString(),
  });
  const pending = provider.verify(signed);
  time += 3_600_000;
  await assert.rejects(pending, denied);
  assert.deepEqual(provider.configuration(), { enabled: true });
  for (const value of [JSON.stringify(provider), inspect(provider)]) {
    assert.ok(!value.includes(secret));
    assert.ok(!value.includes(signed));
  }
});

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

test('configuration rejects unsafe origins, implicit HMAC and secret-bearing metadata without echoes', (t) => {
  const reference = environment(t, secret);
  const configurations = [
    { mode: 'hs256' },
    { supabaseUrl: url, secretEnv: reference },
    { supabaseUrl: url, mode: 'hs256' },
    { supabaseUrl: url, mode: 'hs256', secretEnv: environment(t, 'too-short') },
    { supabaseUrl: url, mode: 'hs256', secretEnv: 'not-an-env-ref!' },
    { supabaseUrl: `https://user:${secret}@identity.example`, mode: 'jwks' },
    { supabaseUrl: `${url}?secret=${secret}` },
    { supabaseUrl: `${url}/other-path` },
    { supabaseUrl: `${url}#fragment` },
    { supabaseUrl: 'http://identity.example', allowLocalHttp: true },
    { supabaseUrl: 'http://127.0.0.1:1234' },
    { supabaseUrl: 'http://localhost.evil.example', allowLocalHttp: true },
    { supabaseUrl: 'file:///tmp/keys' },
    { supabaseUrl: url, mode: 'none' },
    { supabaseUrl: url, jwtSecret: secret },
    { supabaseUrl: url, audience: '' },
    { supabaseUrl: url, allowLocalHttp: 'true' },
    null,
    [],
  ];
  for (const config of configurations)
    assert.throws(
      () => new SupabaseIdentity(config as any),
      (error: unknown) => {
        assert.ok(error instanceof MervError);
        assert.equal(error.code, 'invalid_identity_config');
        assert.equal(error.cause, undefined);
        assert.ok(!inspect(error).includes(secret));
        assert.ok(!inspect(error).includes(reference));
        return true;
      },
    );
  for (const address of ['http://127.0.0.1:1234', 'http://localhost:1234', 'http://[::1]:1234'])
    assert.deepEqual(
      new SupabaseIdentity({ supabaseUrl: address, allowLocalHttp: true }).configuration(),
      { enabled: true },
    );
});

test('login configuration exposes only a detached public publishable or legacy anon key', async (t) => {
  const anonymous = await token({ role: 'anon', sub: undefined });
  for (const key of ['sb_publishable_abcdefghijklmnopqrstuv', anonymous]) {
    const provider = new SupabaseIdentity({
      supabaseUrl: `${url}/`,
      publishableKeyEnv: environment(t, key),
    });
    const config = provider.configuration();
    assert.deepEqual(config, { enabled: true, login: { url, publishableKey: key } });
    config.login!.publishableKey = 'mutated';
    assert.equal(provider.configuration().login?.publishableKey, key);
  }
  for (const key of [
    await token({ role: 'service_role' }),
    secret,
    'sb_secret_abcdefghijklmnopqrstuv',
  ])
    assert.throws(
      () => new SupabaseIdentity({ supabaseUrl: url, publishableKeyEnv: environment(t, key) }),
      (error: unknown) => {
        assert.ok(error instanceof MervError && error.code === 'invalid_identity_config');
        assert.ok(!inspect(error).includes(key));
        return true;
      },
    );
});

test('EC and RSA JWKS verification uses only the configured endpoint and deduplicates cached fetches', async (t) => {
  const pairs = await Promise.all([
    generateKeyPair('ES256', { extractable: true }),
    generateKeyPair('RS256', { extractable: true }),
  ]);
  const algorithms = ['ES256', 'RS256'];
  const keys = await Promise.all(
    pairs.map(async (pair, i) => ({
      ...(await exportJWK(pair.publicKey)),
      alg: algorithms[i],
      kid: String(i),
    })),
  );
  let calls = 0;
  const provider = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => start,
      fetch: fetching(async (target, init) => {
        calls++;
        assert.equal(target, `${issuer}/.well-known/jwks.json`);
        assert.equal(init?.redirect, 'error');
        assert.equal(init?.credentials, 'omit');
        assert.equal(new Headers(init?.headers).has('authorization'), false);
        return Response.json({ keys });
      }),
    },
  );
  const signed = await Promise.all(
    pairs.map((pair, i) =>
      new SignJWT(claims())
        .setProtectedHeader({
          alg: algorithms[i],
          kid: String(i),
          jku: 'https://token-controlled.invalid/keys',
          x5u: 'https://token-controlled.invalid/cert',
        })
        .sign(pair.privateKey),
    ),
  );
  const identities = await Promise.all(
    signed.flatMap((value) => [provider.verify(value), provider.verify(value)]),
  );
  assert.ok(identities.every((value) => value.subject === 'shared-user'));
  assert.equal(calls, 1);
  const attacker = await generateKeyPair('ES256', { extractable: true });
  const embedded = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: '0', jwk: await exportJWK(attacker.publicKey) })
    .sign(attacker.privateKey);
  await assert.rejects(provider.verify(embedded), denied);
  assert.equal(calls, 1, 'A token-provided JWK cannot replace the trusted cached key');
  await assert.rejects(provider.verify(await token()), denied);
  assert.equal(calls, 1, 'An HMAC token cannot select a remote asymmetric key');
});

test('JWKS unknown-key cooldown and refresh admit rotated keys without trusting expired cache', async (t) => {
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
  const firstToken = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: 'first' })
    .sign(first.privateKey);
  const nextToken = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: 'second' })
    .sign(second.privateKey);
  await provider.verify(firstToken);
  keys = [secondKey];
  await assert.rejects(provider.verify(nextToken), denied);
  assert.equal(calls, 1);
  time += 30_001;
  await provider.verify(nextToken);
  assert.equal(calls, 2);
  failure = true;
  time += 300_001;
  await assert.rejects(provider.verify(nextToken), (error: unknown) => {
    assert.ok(denied(error));
    assert.ok(!inspect(error).includes('synthetic-key-provider-outage'));
    return true;
  });
  assert.equal(calls, 3);
  await assert.rejects(provider.verify(nextToken), denied);
  assert.equal(calls, 3, 'Failed refresh is cooled down instead of retried on every request');
  failure = false;
  time += 30_001;
  await provider.verify(nextToken);
  assert.equal(calls, 4);
});

test('JWKS status, redirect, oversized body, malformed keys and private keys fail closed', async (t) => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const signed = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256' })
    .sign(pair.privateKey);
  const privateKey = await exportJWK(pair.privateKey);
  const failures = [
    () => new Response('upstream-error-secret', { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid' } }),
    () => new Response('{invalid-json'),
    () => new Response('x'.repeat(65_537)),
    () => new Response('{}', { headers: { 'content-length': '65537' } }),
    () => Response.json({ keys: [] }),
    () => Response.json({ keys: Array(33).fill({ kty: 'EC' }) }),
    () => Response.json({ keys: [privateKey] }),
    () => Response.json({ keys: [{ kty: 'oct', k: 'shared-secret' }] }),
  ];
  for (const response of failures) {
    const provider = new SupabaseIdentity(
      { supabaseUrl: url },
      { clock: () => start, fetch: fetching(async () => response()) },
    );
    await assert.rejects(provider.verify(signed), (error: unknown) => {
      assert.ok(denied(error));
      assert.equal((error as Error).cause, undefined);
      assert.ok(!inspect(error).includes('upstream-error-secret'));
      assert.ok(!inspect(error).includes(privateKey.d!));
      return true;
    });
  }
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
  await assert.rejects(pending, denied);
  assert.equal(cancelCount, 1);
});
