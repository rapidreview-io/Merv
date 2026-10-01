import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  NativeCredentials,
  NativeSandboxClient,
  nativeOrigin,
} from '../packages/sandboxes/src/native-client.js';
const secret = `sbxt_${'s'.repeat(43)}`;
test('native credentials bind encrypted payloads to their row and reject ciphertext tampering', () => {
  const key = randomBytes(32).toString('base64url');
  const cipher = new NativeCredentials(key);
  const sealed = cipher.seal({ bearer: secret }, 'assignment:lease');
  assert.ok(!sealed.includes(secret));
  assert.deepEqual(cipher.open(sealed, 'assignment:lease'), { bearer: secret });
  for (const [value, binding] of [
    [sealed, 'connection:lease'],
    [sealed + '!', 'assignment:lease'],
    [sealed.slice(2), 'assignment:lease'],
  ])
    assert.throws(() => cipher.open(value!, binding!), { code: 'sandbox_credentials_unavailable' });
  assert.throws(
    () =>
      new NativeCredentials(randomBytes(32).toString('base64url')).open(sealed, 'assignment:lease'),
    { code: 'sandbox_credentials_unavailable' },
  );
  assert.equal(JSON.stringify(cipher), '{}');
});
test('native client restricts destination and refuses redirects without reading upstream error details', async () => {
  for (const origin of [
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?token=secret',
    'https://example.com\n',
  ])
    assert.throws(() => nativeOrigin(origin), { code: 'invalid_sandboxes_config' });
  let calls = 0;
  const client = new NativeSandboxClient('https://sandbox.example', (async (url, options) => {
    calls++;
    assert.equal(options?.redirect, 'manual');
    assert.equal(new URL(String(url)).origin, 'https://sandbox.example');
    return new Response(secret, { status: 302, headers: { location: 'https://attacker.example' } });
  }) as typeof fetch);
  await assert.rejects(client.request('/v1/delegations/connection', secret), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  for (const route of [
    'https://attacker.example',
    '/v1/delegations/../secrets',
    '/v1/delegations/%2fsecret',
    '/mcp',
  ])
    await assert.rejects(client.request(route, secret), { code: 'invalid_sandbox_route' });
  assert.equal(calls, 1);
});
test('native JSON streams are bounded and transport/parser errors are sanitized', async () => {
  const cases: [() => Response, string][] = [
    [() => Response.json({ value: 'x'.repeat(8 * 1024 * 1024) }), 'sandbox_unavailable'],
    [
      () => new Response(secret, { headers: { 'content-type': 'application/json' } }),
      'sandbox_unavailable',
    ],
    [
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(secret));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      'sandbox_unavailable',
    ],
    [() => new Response(secret, { status: 403 }), 'sandbox_access_revoked'],
  ];
  for (const [response, code] of cases) {
    const client = new NativeSandboxClient('https://sandbox.example', (async () =>
      response()) as typeof fetch);
    await assert.rejects(client.request('/v1/delegations/connection', secret), (error) => {
      assert.equal((error as any).code, code);
      assert.ok(!String(error).includes(secret));
      return true;
    });
  }
  const client = new NativeSandboxClient('https://sandbox.example', (async () => {
    throw Error(secret);
  }) as typeof fetch);
  await assert.rejects(client.request('/v1/delegations/connection', secret), (error) => {
    assert.ok(!String(error).includes(secret));
    return true;
  });
});
