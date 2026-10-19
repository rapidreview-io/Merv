/**
 * Settings → Compute against the /compute routes' fixtures: a gallery with a card per provider,
 * the balance where Merv funds it with the top-ups and the mode on demand, greyed where it does not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
const { ComputeSettings } = await import('../packages/ui/web/views/compute.js');

const funded = { funded: true, mode: 'hosted', ownKey: false };
const unfunded = { funded: false, mode: null, hosted: null, ownKey: false };
const providers = [
  { plugin: 'lambda', label: 'Lambda', ...funded, hosted: { granted: '100', left: '75' } },
  { plugin: 'thunder', label: 'Thunder', ...funded, hosted: { granted: '0', left: '0' } },
  {
    plugin: 'runpod',
    label: 'RunPod',
    ...funded,
    mode: 'own',
    hosted: { granted: '0', left: '0' },
    ownKey: true,
  },
  { plugin: 'aws', label: 'AWS', ...unfunded },
  { plugin: 'vast', label: 'Vast', ...unfunded, mode: 'own', ownKey: true },
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

test('every provider is a card: its balance where Merv funds it, else greyed with its key', async (t) => {
  t.after(unmount);
  await open();
  const cards = [...document.querySelectorAll('.compute-card')];
  assert.deepEqual(
    cards.map((card) => card.textContent),
    [
      'Lambda$75of $100Add creditsYour key',
      // Nothing granted is $0 alone.
      'Thunder$0Add creditsYour key',
      // A key to switch to is a switch; without one, a link to bring it.
      'RunPod$0Add creditsHostedYour key',
      'AWSYour key',
      'VastYour key',
    ],
  );
  // Only what the account cannot use yet steps back.
  assert.deepEqual(
    cards
      .filter((card) => card.hasAttribute('data-off'))
      .map((card) => card.firstChild?.textContent),
    ['AWS'],
  );
  assert.equal(document.querySelectorAll('a[href="/sandboxes/providers"]').length, 4);
  // No table, and the amounts are drawn once asked for.
  assert.equal(document.querySelector('[role="columnheader"], table'), null);
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
    [...document.querySelectorAll('.compute-card button.btn--sm')].map((b) => b.textContent),
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

test('the mode is changed from its switch, and without payments nothing is sold', async (t) => {
  t.after(unmount);
  const modes: Record<string, unknown>[] = [];
  serve('/compute/runpod/mode', (_call, body) => {
    modes.push(body);
    return { body: { plugin: 'runpod', mode: 'hosted' } };
  });
  await open([]);
  assert.doesNotMatch(text(), /Add credits/);
  const hosted = document.querySelector<HTMLButtonElement>(
    '[aria-label="RunPod mode"] button:first-child',
  )!;
  await act(async () => hosted.click());
  await settle(0);
  assert.deepEqual(modes, [{ mode: 'hosted' }]);
  assert.ok(requests.includes('PUT /compute/runpod/mode'));
});
