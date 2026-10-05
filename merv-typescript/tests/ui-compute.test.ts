import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement, StrictMode } = await import('react');
const { Integrations } = await import('../packages/ui/web/views/settings.js');
const { SandboxesConnection } = await import('../packages/ui/web/views/sandboxes.js');
const props = { shell: { rows: [], plugins: [] } } as never;

test('Integrations stays empty without Code or native compute', async (t) => {
  t.after(unmount);
  await mount(createElement(Integrations, props));
  assert.match(text(), /No integrations/);
});

const unavailable = { available: false, connected: false, url: null };
const disconnected = { available: true, connected: false, url: 'https://compute.example/ui' };
const connected = {
  ...disconnected,
  connected: true,
  accountId: 'account-a',
  memberId: 'member-a',
  connectionId: 'connection-a',
};

test('compute card hides unavailable deployments without broken controls', async (t) => {
  t.after(unmount);
  serve('/sandboxes/connection', { body: unavailable });
  await mount(createElement(SandboxesConnection));
  assert.equal(text(), '');
});

test('compute uses the same account without a second enrollment flow', async (t) => {
  t.after(unmount);
  serve('/sandboxes/connection', { body: disconnected });
  await mount(createElement(SandboxesConnection));
  assert.match(text(), /same compute and spending/);
  assert.match(text(), /Enable compute/);
  assert.doesNotMatch(text(), /token|namespace|sign up|link account/i);
});

test('connected project opens native compute and disconnect updates permission', async (t) => {
  t.after(unmount);
  serve('/sandboxes/connection', (call) => ({ body: call === 1 ? connected : disconnected }));
  await mount(createElement(SandboxesConnection));
  assert.match(text(), /bills the account you approved/);
  assert.match(text(), /Existing rentals and admitted jobs continue/);
  assert.equal(document.querySelector('a')?.getAttribute('href'), connected.url);
  await click('Disconnect');
  assert.ok(requests.includes('DELETE /sandboxes/connection'));
  assert.match(text(), /Enable compute/);
});

test('consent return finishes once and removes its marker only after success', async (t) => {
  t.after(async () => {
    await unmount();
    window.history.replaceState(null, '', '/');
  });
  window.history.replaceState(null, '', '/settings/integrations?sandboxes=complete');
  serve('/sandboxes/connection/finish', { body: connected });
  await mount(createElement(StrictMode, null, createElement(SandboxesConnection)));
  assert.equal(requests.filter((r) => r === 'POST /sandboxes/connection/finish').length, 1);
  assert.equal(window.location.search, '');
  assert.match(text(), /View compute/);
});

test('failed consent completion preserves the callback for an exact retry', async (t) => {
  t.after(async () => {
    await unmount();
    window.history.replaceState(null, '', '/');
  });
  window.history.replaceState(null, '', '/settings/integrations?sandboxes=complete');
  serve('/sandboxes/connection/finish', { network: true });
  await mount(createElement(SandboxesConnection));
  assert.match(text(), /did not answer/);
  assert.equal(window.location.search, '?sandboxes=complete');
  assert.doesNotMatch(text(), /View compute/);
});

test('Integrations shows native Personal compute billing the approved account', async (t) => {
  t.after(unmount);
  serve('/sandboxes/connection', { body: connected });
  await mount(createElement(Integrations, props));
  assert.match(text(), /bills the account you approved/);
});

test('managed compute displays the enforced account usage and enables without Personal consent', async (t) => {
  t.after(unmount);
  serve('/sandboxes/connection', { body: { ...disconnected, managedAvailable: true } });
  serve('/sandboxes/connection/managed', {
    body: {
      ...connected,
      funding: 'managed',
      managedAvailable: true,
      allowance: {
        budgets: [
          {
            scope: 'member',
            target: 'member-a',
            window: 'month',
            metric: 'money',
            currency: 'USD',
            cap: '500',
            accrued: '12.4',
            reserved: '8',
            available: '479.6',
            provider: null,
            source: null,
            accounting_complete: true,
          },
        ],
      },
    },
  });
  await mount(createElement(SandboxesConnection));
  await click('Enable Merv-managed ML');
  assert.ok(requests.includes('POST /sandboxes/connection/managed'));
  assert.match(text(), /\$12\.40 used/);
  assert.match(text(), /\$8\.00 reserved/);
  assert.match(text(), /\$500 per account this month/);
  assert.match(text(), /shared across that account’s projects/);
  assert.doesNotMatch(text(), /bills the account you approved/);
});
