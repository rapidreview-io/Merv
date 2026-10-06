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

test('JWKS ignores unusable entries and verifies ES256, RS256 and EdDSA from a mixed set', async () => {
  const pairs = {
    es: await generateKeyPair('ES256', { extractable: true }),
    rs: await generateKeyPair('RS256', { extractable: true }),
    ed: await generateKeyPair('Ed25519', { extractable: true }),
    leaked: await generateKeyPair('ES256', { extractable: true }),
    p384: await generateKeyPair('ES384', { extractable: true }),
  };
  const keys = [
    { ...(await exportJWK(pairs.es.publicKey)), kid: 'es' },
    { ...(await exportJWK(pairs.rs.publicKey)), kid: 'rs' },
    { ...(await exportJWK(pairs.ed.publicKey)), kid: 'ed' },
    { ...(await exportJWK(pairs.leaked.privateKey)), kid: 'leaked' },
    { ...(await exportJWK(pairs.p384.publicKey)), kid: 'p384' },
    { kty: 'oct', k: 'c2hhcmVkLXNlY3JldC1zaGFyZWQtc2VjcmV0', kid: 'oct' },
    { kty: 'AKP', alg: 'ML-DSA-44', pub: 'cG9zdC1xdWFudHVtLXB1YmxpYy1rZXk', kid: 'pq' },
    { kty: 'EC', kid: 'broken' },
    'not-a-key',
  ];
  let calls = 0;
  const provider = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => start,
      fetch: fetching(async () => {
        calls++;
        return Response.json({ keys });
      }),
    },
  );
  const sign = (alg: string, kid: string, key: CryptoKey) =>
    new SignJWT(claims()).setProtectedHeader({ alg, kid }).sign(key);
  for (const signed of [
    await sign('ES256', 'es', pairs.es.privateKey),
    await sign('RS256', 'rs', pairs.rs.privateKey),
    await sign('EdDSA', 'ed', pairs.ed.privateKey),
    await sign('Ed25519', 'ed', pairs.ed.privateKey),
  ])
    assert.equal((await provider.verify(signed)).subject, 'shared-user');
  for (const refused of [
    await sign('ES256', 'leaked', pairs.leaked.privateKey),
    await sign('ES384', 'p384', pairs.p384.privateKey),
  ])
    await assert.rejects(provider.verify(refused), denied);
  assert.equal(calls, 1);
});

test('JWKS keeps the last good set when a refresh returns nothing usable', async () => {
  let time = start;
  const pair = await generateKeyPair('ES256', { extractable: true });
  const good = { ...(await exportJWK(pair.publicKey)), kid: 'good' };
  const privateKey = { ...(await exportJWK(pair.privateKey)), kid: 'good' };
  const signed = await new SignJWT(claims({ exp: start / 1000 + 86_400 }))
    .setProtectedHeader({ alg: 'ES256', kid: 'good' })
    .sign(pair.privateKey);
  const other = await generateKeyPair('ES256', { extractable: true });
  const next = { ...(await exportJWK(other.publicKey)), kid: 'next' };
  const nextToken = await new SignJWT(claims({ exp: start / 1000 + 86_400 }))
    .setProtectedHeader({ alg: 'ES256', kid: 'next' })
    .sign(other.privateKey);
  const responses = [
    () => Response.json({ keys: [] }),
    () => Response.json({ keys: [privateKey] }),
    () => Response.json({ keys: [{ kty: 'oct', k: 'shared-secret' }] }),
    () => new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response(JSON.stringify({ keys: [next], pad: 'x'.repeat(65_536) })),
    () => new Response('unavailable', { status: 503 }),
  ];
  let respond = () => Response.json({ keys: [good] });
  let calls = 0;
  const provider = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => time,
      fetch: fetching(async () => {
        calls++;
        return respond();
      }),
    },
  );
  await provider.verify(signed);
  for (const [i, response] of responses.entries()) {
    respond = response;
    time += 300_001;
    assert.equal((await provider.verify(signed)).subject, 'shared-user');
    await settled();
    assert.equal(calls, i + 2);
    // The refused response was discarded: the old key still verifies and its key does not.
    assert.equal((await provider.verify(signed)).subject, 'shared-user');
    await assert.rejects(provider.verify(nextToken), denied);
    assert.equal(calls, i + 2);
  }
  await provider.verify(signed);
  assert.equal(calls, responses.length + 1);
});

test('JWKS shares one fetch between cold starts and between a refresh and an unknown kid', async (t) => {
  let time = start;
  const first = await generateKeyPair('ES256', { extractable: true });
  const second = await generateKeyPair('ES256', { extractable: true });
  const firstKey = { ...(await exportJWK(first.publicKey)), kid: 'first' };
  const secondKey = { ...(await exportJWK(second.publicKey)), kid: 'second' };
  const firstToken = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: 'first' })
    .sign(first.privateKey);
  const nextToken = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: 'second' })
    .sign(second.privateKey);
  let calls = 0;
  let release!: (keys: unknown[]) => void;
  const provider = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => time,
      fetch: fetching(async () => {
        calls++;
        return Response.json({
          keys: await new Promise<unknown[]>((resolve) => {
            release = resolve;
          }),
        });
      }),
    },
  );
  const cold = Array.from({ length: 10 }, () => provider.verify(firstToken));
  await settled();
  release([firstKey]);
  assert.ok((await Promise.all(cold)).every((identity) => identity.subject === 'shared-user'));
  assert.equal(calls, 1, 'Ten parallel cold requests make one fetch');
  time += 300_001;
  await provider.verify(firstToken);
  assert.equal(calls, 2, 'The due refresh has started in the background');
  const rotated = provider.verify(nextToken);
  await settled();
  release([firstKey, secondKey]);
  assert.equal((await rotated).subject, 'shared-user');
  assert.equal(calls, 2, 'An unknown kid joins the refresh already in flight');
});

test('JWKS keeps serving keys and admits rotation after the clock steps back during an outage', async () => {
  let time = start;
  const first = await generateKeyPair('ES256', { extractable: true });
  const second = await generateKeyPair('ES256', { extractable: true });
  const firstKey = { ...(await exportJWK(first.publicKey)), kid: 'first' };
  const secondKey = { ...(await exportJWK(second.publicKey)), kid: 'second' };
  const firstToken = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: 'first' })
    .sign(first.privateKey);
  const nextToken = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: 'second' })
    .sign(second.privateKey);
  let keys = [firstKey];
  let failure = false;
  let calls = 0;
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
  await provider.verify(firstToken);
  failure = true;
  time = start - 3_600_000;
  assert.equal((await provider.verify(firstToken)).subject, 'shared-user');
  await settled();
  assert.equal(calls, 2, 'A backward step makes the set due for refresh, not expired');
  failure = false;
  keys = [firstKey, secondKey];
  time += 30_001;
  assert.equal((await provider.verify(nextToken)).subject, 'shared-user');
  assert.equal(calls, 3, 'Rotation is admitted 30 s after the failed refresh');
});

test('JWKS single flight clears after the timeout even when a fetcher ignores its signal', async (t) => {
  let time = start;
  let controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 5000);
    controller = new AbortController();
    return controller.signal;
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.publicKey)), kid: 'key' };
  const signed = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: 'key' })
    .sign(pair.privateKey);
  let hang = true;
  let calls = 0;
  const provider = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => time,
      fetch: fetching(async () => {
        calls++;
        if (hang) return await new Promise<Response>(() => undefined);
        return Response.json({ keys: [key] });
      }),
    },
  );
  const pending = provider.verify(signed);
  await settled();
  controller.abort();
  await assert.rejects(pending, unavailable);
  hang = false;
  time += 30_001;
  assert.equal((await provider.verify(signed)).subject, 'shared-user');
  assert.equal(calls, 2);
  hang = true;
  time += 300_001;
  // The fetcher hangs until the abort below, so a request that waited on it would lose
  // this race; the 2 s bound only keeps a regression from hanging the test.
  let bound!: NodeJS.Timeout;
  const outcome = await Promise.race([
    Promise.all([provider.verify(signed), provider.verify(signed)]).then(() => 'verified'),
    new Promise((resolve) => {
      bound = setTimeout(() => resolve('waited'), 2_000);
    }),
  ]);
  clearTimeout(bound);
  assert.equal(outcome, 'verified', 'No request waits on a hung background refresh');
  assert.equal(calls, 3);
  controller.abort();
  await settled();
  time += 30_001;
  hang = false;
  await provider.verify(signed);
  await settled();
  assert.equal(calls, 4, 'The hung background refresh no longer holds the single flight');
});

test('JWKS refuses a token that expires while a cold key fetch is slow', async () => {
  let time = start;
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.publicKey)), kid: 'key' };
  const signed = await new SignJWT(claims({ exp: start / 1000 + 1 }))
    .setProtectedHeader({ alg: 'ES256', kid: 'key' })
    .sign(pair.privateKey);
  let release!: () => void;
  const provider = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => time,
      fetch: fetching(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json({ keys: [key] });
      }),
    },
  );
  const pending = provider.verify(signed);
  await settled();
  time += 2_000;
  release();
  await assert.rejects(pending, denied);
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
      assert.ok(unavailable(error));
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
  await assert.rejects(pending, unavailable);
  assert.equal(cancelCount, 1);
});

test('JWKS refreshes leave no unhandled rejections', async (t) => {
  // Earlier tests' real 5 s timeouts fire after this file finishes, so fire the timeout
  // here: once after the fetch won the race and once while a fetcher rejects on abort.
  const controllers: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', () => {
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.publicKey)), kid: 'key' };
  const signed = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'ES256', kid: 'key' })
    .sign(pair.privateKey);
  const answered = new SupabaseIdentity(
    { supabaseUrl: url },
    { clock: () => start, fetch: fetching(async () => Response.json({ keys: [key] })) },
  );
  assert.equal((await answered.verify(signed)).subject, 'shared-user');
  const aborted = new SupabaseIdentity(
    { supabaseUrl: url },
    {
      clock: () => start,
      fetch: fetching(
        (_url, options) =>
          new Promise<Response>((_resolve, reject) =>
            options!.signal!.addEventListener('abort', () =>
              setImmediate(() => reject(new Error('synthetic-abort'))),
            ),
          ),
      ),
    },
  );
  const pending = aborted.verify(signed);
  await settled();
  for (const controller of controllers) controller.abort();
  await assert.rejects(pending, unavailable);
  await settled();
  assert.deepEqual(unhandled, []);
});
