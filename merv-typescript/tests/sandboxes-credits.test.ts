import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Context } from 'cordis';
import type { ZodType } from 'zod';
import { createService, MervError, type Principal } from '@merv/contracts';
import type { CheckoutInput, Paid } from '@merv/contracts/payments';
import type { ApiRequest, MountHandler } from '@merv/api/types';
import { ProjectScope } from '@merv/scope';
import { SandboxesPeople } from '@merv/sandboxes/people';
import { CREDITS_PRODUCT, sandboxesCreditsPlugin } from '../packages/sandboxes/src/credits.js';
import { PaymentsService } from '../packages/payments/src/index.js';
import { person, refused, startHost } from './fixtures/admin.js';
import { openState } from './fixtures/state.js';

const issuer = 'https://identity.example';
const alice = person({ issuer, subject: 'alice' });
type Mode = 'hosted' | 'own';

/** The credits plugin beside the in-process host, whose operator connected `fake`; Payments
 *  over a fake Stripe, and the provider modes the Sandboxes contract will hold. */
async function fixture(t: TestContext) {
  const state = await openState();
  t.after(async () => await state.close());
  const ctx = new Context();
  ctx.provide('state', state);
  ctx.provide('scope', await createService(new ProjectScope(state)));
  process.env.MERV_TEST_SANDBOXES_VAULT_KEY = Buffer.alloc(32, 7).toString('base64url');
  await startHost(t, ctx, 'MERV_TEST_SANDBOXES_VAULT_KEY');
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
  const modes = new Map<string, Mode>();
  Object.assign(ctx.sbxProviders, {
    modes: {
      of: async (accountId: string) =>
        ['fake', 'cloudflare'].map((plugin) => ({
          plugin,
          mode: modes.get(`${accountId}:${plugin}`) ?? (plugin === 'fake' ? 'hosted' : 'own'),
          stored: modes.has(`${accountId}:${plugin}`),
        })),
      set: async (accountId: string, plugin: string, mode: Mode) =>
        void modes.set(`${accountId}:${plugin}`, mode),
    },
  });
  let route: MountHandler | undefined;
  ctx.provide('api', {
    mount: (_: string, handler: MountHandler) => ((route = handler), () => {}),
  });
  const checkouts: CheckoutInput[] = [];
  const payments = new PaymentsService(state, {
    live: false,
    async checkout(input) {
      checkouts.push(input);
      return { url: 'https://checkout.stripe.com/c/top-up', sessionId: 'cs_1', expiresAt: 0 };
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
  const call = async <T = Record<string, any>>(
    method: string,
    path: string,
    body?: unknown,
    who: Principal = alice,
  ) =>
    (await route!(
      { method } as IncomingMessage,
      { setHeader() {} } as unknown as ServerResponse,
      {
        url: new URL(path, 'https://merv.example'),
        principal: who,
        json: async (schema: ZodType) => {
          const parsed = schema.safeParse(body);
          if (!parsed.success) throw new MervError('invalid_input', 'Invalid input', 400);
          return parsed.data;
        },
      } as ApiRequest,
    )) as T;
  const paid = (paymentId: string, eventId: string, amountUsd = 25): Paid => ({
    product: CREDITS_PRODUCT,
    reference: 'top-up',
    metadata: { issuer, subject: 'alice', provider: 'fake', amountUsd: String(amountUsd) },
    paymentId,
    amountUsd,
    eventId,
    sessionId: 'cs_1',
    createdAt: '2026-10-18T10:00:00.000Z',
  });
  const webhook = (event: Paid) => payments.receive(Buffer.from(JSON.stringify(event)), 'sig');
  return { ctx, people, call, checkouts, paid, webhook, unprovide };
}

test('a top-up sells only credit a connection can spend, and its payment credits it at once, once', async (t) => {
  const f = await fixture(t);
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
      metadata: { issuer, subject: 'alice', provider: 'fake', amountUsd: '25' },
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
  const { accountId } = (await f.people.accountOf({ issuer, subject: 'alice' }))!;
  const report = await f.ctx.sbxBilling.credits.report(accountId);
  assert.deepEqual(report.grants.map((g) => [g.id, g.provider, g.amount, g.reason]).sort(), [
    ['stripe:pi_1', 'fake', '25', 'Top-up'],
    ['stripe:pi_2', 'fake', '50', 'Top-up'],
  ]);
  const compute = await f.call('GET', '/compute');
  assert.deepEqual(compute.providers[0], {
    plugin: 'fake',
    label: 'Fake',
    mode: 'hosted',
    hosted: { granted: '75', used: '0', left: '75' },
    ownKey: false,
  });
});

test('compute shows each provider’s mode, hosted credit and own key, and sets the mode', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('GET', '/compute'), { topUps: [], providers: [] });
  await f.people.ensure({ issuer, subject: 'alice' });
  const { namespace } = (await f.people.accountOf({ issuer, subject: 'alice' }))!;
  await f.ctx.sbxVault.save({
    namespace,
    name: 'mine',
    plugin: 'cloudflare',
    fields: { bridge_url: 'https://user-bridge.example.test', bridge_token: 'own-token' },
    settings: {},
    access: 'tunnel',
    verified: true,
  });
  assert.deepEqual(await f.call('GET', '/compute'), {
    topUps: [25, 50, 100, 250],
    providers: [
      {
        plugin: 'fake',
        label: 'Fake',
        mode: 'hosted',
        hosted: { granted: '0', used: '0', left: '0' },
        ownKey: false,
      },
      {
        plugin: 'cloudflare',
        label: 'Cloudflare Containers',
        mode: 'own',
        hosted: null,
        ownKey: true,
      },
    ],
  });
  assert.deepEqual(await f.call('PUT', '/compute/fake/mode', { mode: 'own' }), {
    plugin: 'fake',
    mode: 'own',
  });
  assert.equal((await f.call('GET', '/compute')).providers[0].mode, 'own');
  await assert.rejects(
    f.call('PUT', '/compute/fake/mode', { mode: 'free' }),
    refused('invalid_input', 400),
  );
  // Without Payments nothing is sold.
  f.unprovide();
  assert.deepEqual((await f.call('GET', '/compute')).topUps, []);
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
