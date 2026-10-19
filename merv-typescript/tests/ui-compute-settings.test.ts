/**
 * Settings → Compute against the /compute routes' fixtures: per provider its mode, its hosted
 * credit with the top-ups on demand, or the person's own key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
const { ComputeSettings } = await import('../packages/ui/web/views/compute.js');

const providers = [
  {
    plugin: 'lambda',
    label: 'Lambda',
    mode: 'hosted',
    hosted: { granted: '100', left: '75' },
    ownKey: false,
  },
  { plugin: 'aws', label: 'AWS', mode: 'own', hosted: null, ownKey: false },
  {
    plugin: 'runpod',
    label: 'RunPod',
    mode: 'own',
    hosted: { granted: '0', left: '0' },
    ownKey: true,
  },
];
const open = async (
  topUps = [25, 50, 100, 250],
  reply: object = { body: { topUps, providers } },
) => {
  serve('/compute', reply);
  await mount(createElement(MemoryRouter, null, createElement(ComputeSettings)));
  await settle(0);
};

// First, before any read of /compute is cached.
test('a failed read says so, never that there are no providers', async (t) => {
  t.after(unmount);
  await open([], { status: 503, body: { error: { code: 'unavailable', message: 'Busy' } } });
  assert.doesNotMatch(text(), /No providers/);
  assert.match(text(), /Busy|unavailable/i);
});

test('each provider reads its mode, its hosted credit or its key, and nothing else', async (t) => {
  t.after(unmount);
  await open();
  const rows = [...document.querySelectorAll('.ruled-row')].map((row) => row.textContent);
  assert.deepEqual(rows, [
    'LambdaHostedYour key$75 of $100Add credits',
    'AWSConnect a key',
    // Own mode says so once, in its control.
    'RunPodHostedYour key',
  ]);
  assert.equal(
    document.querySelector('a[href="/sandboxes/providers"]')?.textContent,
    'Connect a key',
  );
  // The amounts are drawn once asked for.
  assert.doesNotMatch(text(), /\$250/);
});

test('Add credits opens the four top-ups, and one goes to its Checkout', async (t) => {
  t.after(unmount);
  await open();
  const sent: Record<string, unknown>[] = [];
  serve('/compute/checkout', (_call, body) => {
    sent.push(body);
    return { body: { url: 'https://checkout.stripe.com/c/top-up' } };
  });
  await click('Add credits');
  assert.deepEqual(
    [...document.querySelectorAll('.ruled-row button.btn--sm')].map((b) => b.textContent),
    ['$25', '$50', '$100', '$250'],
  );
  await click('$50');
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { ...sent[0], requestId: typeof sent[0]!.requestId },
    {
      provider: 'lambda',
      amountUsd: 50,
      requestId: 'string',
    },
  );
});

test('the mode is changed from its control, and without payments nothing is sold', async (t) => {
  t.after(unmount);
  const modes: Record<string, unknown>[] = [];
  serve('/compute/lambda/mode', (_call, body) => {
    modes.push(body);
    return { body: { plugin: 'lambda', mode: 'own' } };
  });
  await open([]);
  assert.doesNotMatch(text(), /Add credits/);
  const own = document.querySelector<HTMLButtonElement>(
    '[aria-label="Lambda mode"] button:last-child',
  )!;
  await act(async () => own.click());
  await settle(0);
  assert.deepEqual(modes, [{ mode: 'own' }]);
  assert.ok(requests.includes('PUT /compute/lambda/mode'));
});
