import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import { createService, type Principal } from '@merv/contracts';
import type { CheckoutInput, Paid } from '@merv/contracts/payments';
import { ProjectScope } from '@merv/scope';
import { SandboxesPeople } from '@merv/sandboxes/people';
import { CREDITS_PRODUCT, sandboxesCreditsPlugin } from '../packages/sandboxes/src/credits.js';
import { PaymentsService } from '../packages/payments/src/index.js';
import { mountCaller, person, refused, startHost } from './fixtures/admin.js';
import { openState } from './fixtures/state.js';

const issuer = 'https://identity.example';
const alice = { issuer, subject: 'alice' };
type Compute = { topUps: number[]; providers: Record<string, unknown>[] };

/** The credits plugin beside the in-process host, whose operator funds `fake` through the
 *  `cloud` connection; Payments over a fake Stripe. */
async function fixture(t: TestContext) {
  const state = await openState();
  t.after(async () => await state.close());
  const ctx = new Context();
  ctx.provide('state', state);
  ctx.provide('scope', await createService(new ProjectScope(state)));
  process.env.MERV_TEST_SANDBOXES_VAULT_KEY = Buffer.alloc(32, 7).toString('base64url');
  const funded = { name: 'cloud', plugin: 'fake', connection_id: 'cloud', cloud_account: 'cloud' };
  await startHost(t, ctx, 'MERV_TEST_SANDBOXES_VAULT_KEY', {
    settings: { providers: [funded] },
  });
  await ctx.sbxProviders.connections.registerIn(ctx.sbxDb, {
    id: 'cloud',
    plugin: 'fake',
    cloudAccount: 'cloud',
  });
  const { sbxAuth: auth, sbxAccounts: accounts, sbxBilling: billing, sbxProviders } = ctx;
  const { sbxDb: db, sbxClock: clock } = ctx;
  const people = new SandboxesPeople(
    { auth, accounts, billing, providers: sbxProviders, db, clock },
    {},
  );
  ctx.provide('sandboxesPeople', people);
  const call = mountCaller(ctx, person(alice));
  const checkouts: CheckoutInput[] = [];
  const payments = new PaymentsService(state, {
    live: false,
    async checkout(input) {
      checkouts.push(input);
      return { url: 'https://checkout.stripe.com/c/top-up', id: 'cs_1', expiresAt: 0 };
    },
    async verify(raw) {
      return JSON.parse(raw.toString()) as Paid;
    },
  });
  await payments.initialize();
  const unprovide = ctx.provide('payments', payments);
  const fiber = ctx.plugin(sandboxesCreditsPlugin);
  t.after(async () => await fiber.dispose());
  await fiber.await();
  const paid = (paymentId: string, eventId: string, amountUsd = 25): Paid => ({
    product: CREDITS_PRODUCT,
    reference: 'top-up',
    metadata: { issuer, subject: 'alice', provider: 'fake' },
    paymentId,
    amountUsd,
    eventId,
    createdAt: '2026-10-18T10:00:00.000Z',
  });
  const webhook = (event: Paid) => payments.receive(Buffer.from(JSON.stringify(event)), 'sig');
  /** A key of `plugin` saved in Alice's home namespace. */
  const key = async (plugin: string) =>
    await ctx.sbxVault.save({
      namespace: (await people.accountOf(alice))!.namespace,
      name: `mine-${plugin}`,
      plugin,
      fields: { bridge_url: 'https://user-bridge.example.test', bridge_token: 'own-token' },
      settings: {},
      access: 'tunnel',
      verified: true,
    });
  const compute = () => call<Compute>('GET', '/compute');
  return { ctx, people, call, compute, key, checkouts, paid, webhook, unprovide };
}

test('a top-up sells only credit a funded instance can spend, and its payment credits it at once, once', async (t) => {
  const f = await fixture(t);
  await f.people.ensure(alice);
  const requestId = crypto.randomUUID();
  await assert.rejects(
    f.call('POST', '/compute/checkout', { provider: 'cloudflare', amountUsd: 25, requestId }),
    refused('provider_unavailable', 409),
  );
  await assert.rejects(
    f.call('POST', '/compute/checkout', { provider: 'fake', amountUsd: 30, requestId }),
    refused('invalid_input', 400),
  );
  assert.equal(f.checkouts.length, 0);
  const opened = await f.call('POST', '/compute/checkout', {
    provider: 'fake',
    amountUsd: 25,
    requestId,
  });
  assert.deepEqual(opened, { url: 'https://checkout.stripe.com/c/top-up' });
  await f.call('POST', '/compute/checkout', { provider: 'fake', amountUsd: 25, requestId });
  const [first, again] = f.checkouts;
  assert.deepEqual(
    { ...first, idempotencyKey: undefined },
    {
      product: CREDITS_PRODUCT,
      reference: requestId,
      amountUsd: 25,
      description: 'Fake credits',
      metadata: { issuer, subject: 'alice', provider: 'fake' },
      successUrl: '/ui/settings/compute?checkout=paid',
      cancelUrl: '/ui/settings/compute',
      idempotencyKey: undefined,
    },
  );
  // A retry of the same request is the same Checkout.
  assert.equal(again!.idempotencyKey, first!.idempotencyKey);

  for (const event of ['evt_1', 'evt_1', 'evt_2'])
    assert.deepEqual(await f.webhook(f.paid('pi_1', event)), { received: true });
  await f.webhook(f.paid('pi_2', 'evt_3', 50));
  const { accountId } = (await f.people.accountOf(alice))!;
  const report = await f.ctx.sbxBilling.credits.report(accountId);
  assert.deepEqual(report.grants.map((g) => [g.id, g.provider, g.amount, g.reason]).sort(), [
    ['stripe:pi_1', 'fake', '25', 'Top-up'],
    ['stripe:pi_2', 'fake', '50', 'Top-up'],
  ]);
  const [fake, ...rest] = (await f.compute()).providers;
  assert.deepEqual(fake, {
    plugin: 'fake',
    label: 'Fake',
    funded: true,
    mode: 'hosted',
    hosted: { granted: '75', left: '75' },
    ownKey: false,
  });
  // Every other plugin Sandboxes offers follows, unfunded and unusable until a key is saved;
  // the local plugin only where the deployment funds it.
  assert.ok(rest.length > 10);
  assert.ok(rest.every((p) => !p.funded && p.hosted === null && p.mode === null && !p.ownKey));
  assert.ok(rest.some((p) => p.plugin === 'modal'));
  assert.ok(!rest.some((p) => p.plugin === 'local' || p.plugin === 'fake'));
});

test('compute shows each provider’s mode, hosted credit and own key, and sets the mode', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.compute(), { topUps: [], providers: [] });
  await f.people.ensure(alice);
  await f.key('cloudflare');
  const { topUps, providers } = await f.compute();
  assert.deepEqual(topUps, [25, 50, 100, 250]);
  const of = (plugin: string) => providers.find((p) => p.plugin === plugin);
  // The funded provider leads, with no credit granted yet.
  assert.deepEqual(providers[0], {
    plugin: 'fake',
    label: 'Fake',
    funded: true,
    mode: 'hosted',
    hosted: { granted: '0', left: '0' },
    ownKey: false,
  });
  assert.deepEqual(of('cloudflare'), {
    plugin: 'cloudflare',
    label: 'Cloudflare Containers',
    funded: false,
    mode: 'own',
    hosted: null,
    ownKey: true,
  });
  assert.equal(of('modal')!.mode, null);
  // Sandboxes keeps the rule: no key of its own, no own mode.
  await assert.rejects(
    f.call('PUT', '/compute/fake/mode', { mode: 'own' }),
    refused('sandbox_validation', 400),
  );
  await f.key('fake');
  assert.deepEqual(await f.call('PUT', '/compute/fake/mode', { mode: 'own' }), {
    plugin: 'fake',
    mode: 'own',
  });
  assert.equal((await f.compute()).providers[0]!.mode, 'own');
  await assert.rejects(
    f.call('PUT', '/compute/fake/mode', { mode: 'free' }),
    refused('invalid_input', 400),
  );
  // Without Payments nothing is sold.
  f.unprovide();
  assert.deepEqual((await f.compute()).topUps, []);
  await assert.rejects(
    f.call('POST', '/compute/checkout', {
      provider: 'fake',
      amountUsd: 25,
      requestId: crypto.randomUUID(),
    }),
    refused('checkout_unavailable', 503),
  );
  // Only a person signed in has an account here.
  await assert.rejects(
    f.call('GET', '/compute', undefined, {
      kind: 'actor',
      actor: { id: 'a', projectId: 'p' },
    } as unknown as Principal),
    refused('forbidden', 403),
  );
});
