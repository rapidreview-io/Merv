import assert from 'node:assert/strict';
import test from 'node:test';
import { click, mount, serve, settle, text, unmount, requests } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
await import('../packages/ui/web/components.js');
const { App } = await import('../packages/ui/web/app.js');
const account = { kind: 'user', user: { issuer: 'test', subject: 'new-user' }, projects: [] };
const render = (path: string) => {
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: account });
  return createElement(MemoryRouter, { initialEntries: [path] }, createElement(App));
};

test('a signed-in account with no projects reaches consent without a project shell or selection', async () => {
  const id = 'a'.repeat(43);
  let submitted: Record<string, unknown> | undefined;
  serve(`/oauth/requests/${id}`, (_n, body) => {
    if ('allow' in body) {
      submitted = body;
      // Keep the rendered page for assertions instead of navigating jsdom.
      return { status: 400, body: { error: { message: 'Consent recorded by fixture' } } };
    }
    return {
      body: {
        clientName: 'Native client',
        redirectUri: 'http://127.0.0.1/callback',
        resource: 'https://merv.example/mcp',
      },
    };
  });
  const start = requests.length;
  try {
    await mount(render(`/connect/${id}`));
    await settle();
    assert.match(text(), /Native client/);
    assert.doesNotMatch(text(), /Selected project|Create a project/);
    assert.ok(document.querySelector('a[href="/ui/account/keys"]'));
    await click('Authorize');
    assert.deepEqual(submitted, { allow: true });
    assert.ok(!requests.slice(start).some((r) => r.includes('/tools/') || r.includes('/projects')));
  } finally {
    await unmount();
  }
});

test('zero-project account can open account keys and revoke an OAuth connection', async () => {
  let revoked = false;
  const key = {
    id: 'key_oauth',
    owner: account.user,
    projectId: null,
    grantScope: 'account',
    label: 'OAuth: Native client',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    revokedAt: null,
    previousId: null,
  };
  serve('/account/keys', () => ({
    body: { keys: [{ ...key, revokedAt: revoked ? new Date().toISOString() : null }] },
  }));
  serve('/account/keys/key_oauth', () => {
    revoked = true;
    return { body: { revoked: true } };
  });
  const start = requests.length;
  try {
    await mount(render('/account/keys'));
    await settle();
    assert.match(text(), /OAuth: Native client/);
    await click('Revoke key and descendants');
    await settle();
    assert.ok(revoked, JSON.stringify({ requests: requests.slice(start), page: text() }));
    assert.ok(requests.includes('DELETE /account/keys/key_oauth'));
    assert.deepEqual(
      requests.slice(start).filter((r) => r.includes('/tools/')),
      [],
    );
  } finally {
    await unmount();
  }
});
