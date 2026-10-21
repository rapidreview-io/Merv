import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { OAuthAdmission } from '@merv/scope/oauth-admission';
const request = (remoteAddress: string, forwarded?: string) =>
  ({
    socket: { remoteAddress },
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  }) as IncomingMessage;

test('untrusted forwarding cannot bypass limits; only a named proxy supplies the rightmost address', () => {
  const limits = new OAuthAdmission(['127.0.0.1']);
  for (let i = 0; i < 10; i++)
    assert.equal(limits.admit(request('192.0.2.1', `203.0.113.${i}`), 'register'), null);
  assert.ok(limits.admit(request('192.0.2.1', '203.0.113.111'), 'register'));
  for (let i = 0; i < 10; i++)
    assert.equal(
      limits.admit(request('127.0.0.1', `198.51.100.${i}, 203.0.113.5`), 'register'),
      null,
    );
  assert.ok(limits.admit(request('::ffff:127.0.0.1', 'other,203.0.113.5'), 'register'));
  assert.equal(limits.admit(request('127.0.0.1', '203.0.113.6'), 'register'), null);
});

test('IPv6 /64 shares limits, windows expire, and the limiter has bounded memory', () => {
  let now = 0;
  const limits = new OAuthAdmission([], () => now, 2);
  for (let i = 0; i < 10; i++)
    assert.equal(limits.admit(request(`2001:db8:1:2::${i}`), 'register'), null);
  assert.equal(limits.admit(request('2001:db8:1:2::ffff'), 'register'), 60);
  assert.equal(limits.admit(request('2001:db8:1:3::1'), 'register'), null);
  assert.equal(limits.admit(request('198.51.100.1'), 'register'), 60);
  now = 60000;
  assert.equal(limits.admit(request('198.51.100.1'), 'register'), null);
});
