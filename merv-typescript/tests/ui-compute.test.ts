import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, serve, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { Integrations } = await import('../packages/ui/web/views/settings.js');
const props = { shell: { rows: [], plugins: [] } } as never;

test('Integrations shows an entitled project’s month of ML compute', async (t) => {
  t.after(unmount);
  serve('/tools/compute.offers', {
    body: {
      result: {
        entitled: true,
        allowance: {
          month_to_date: [{ currency: 'USD', amount: '12.4' }],
          cap: { currency: 'USD', amount: '50' },
        },
        offers: [],
      },
    },
  });
  await mount(createElement(Integrations, props));
  assert.match(text(), /ML compute/);
  assert.match(text(), /\$12\.40 of \$50/);
  assert.doesNotMatch(text(), /No integrations/);
});

test('Integrations stays empty without an entitled allowance', async (t) => {
  t.after(unmount);
  serve('/tools/compute.offers', {
    body: { result: { entitled: false, allowance: null, offers: [] } },
  });
  await mount(createElement(Integrations, props));
  assert.match(text(), /No integrations/);
});
