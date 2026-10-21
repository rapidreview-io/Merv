import type { ApiRequest, MountHandler } from '@merv/api/types';
import { MervError } from '@merv/contracts';
import type { Paid } from '@merv/contracts/payments';
import { Context } from 'cordis';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import Stripe from 'stripe';
import { paymentsPlugin } from '../packages/payments/src/index.js';
import { StripeGateway } from '../packages/payments/src/stripe.js';

const secret = 'whsec_test_payments';
const stripe = new Stripe('sk_test_payments_fixture');
const origin = 'https://merv.example';
/** A signed-for event of one Checkout, opened by `origin` unless told otherwise. */
const session = (
  product: string,
  {
    id = 'evt_1',
    paymentIntent = 'pi_1',
    opener = origin as string | undefined,
    event = {} as object,
    object = {} as object,
  } = {},
) =>
  JSON.stringify({
    id,
    object: 'event',
    livemode: false,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: paymentIntent,
        amount_total: 2500,
        currency: 'usd',
        client_reference_id: 'ref_1',
        created: 1760000000,
        metadata: { product, provider: 'fake', ...(opener ? { origin: opener } : {}) },
        ...object,
      },
    },
    ...event,
  });
const signed = (payload: string, timestamp = Math.floor(Date.now() / 1000)) =>
  stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
const gateway = (live = false, secretKey = 'sk_test_payments_fixture') =>
  new StripeGateway({ secretKey, webhookSecret: secret, publicOrigin: origin, live });

/** The plugin over real Stripe signatures, its webhook called as the API would call it. */
async function fixture(t: TestContext) {
  process.env.MERV_TEST_STRIPE_KEY = 'sk_test_payments_fixture';
  process.env.MERV_TEST_STRIPE_WEBHOOK = secret;
  const routes = new Map<string, MountHandler>();
  const ctx = new Context();
  ctx.provide('api', {
    mount: (prefix: string, handler: MountHandler) => (routes.set(prefix, handler), () => {}),
  });
  const fiber = ctx.plugin(paymentsPlugin, {
    secretKeyEnv: 'MERV_TEST_STRIPE_KEY',
    webhookSecretEnv: 'MERV_TEST_STRIPE_WEBHOOK',
    live: false,
    publicOrigin: origin,
  });
  t.after(async () => await fiber.dispose());
  await fiber.await();
  const webhook = (payload: string, signature?: string) =>
    routes.get('/payments')!(
      {
        method: 'POST',
        headers: {
          'stripe-signature': signature ?? signed(payload),
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      {
        url: new URL('/payments/stripe-webhook', 'https://merv.example'),
        bytes: async () => Buffer.from(payload),
      } as unknown as ApiRequest,
    );
  return { ctx, webhook };
}

test('the webhook hands each delivery of a paid Merv checkout to its product’s fulfiller', async (t) => {
  const f = await fixture(t);
  const fulfilled: Paid[] = [];
  const dispose = f.ctx.payments.fulfil('merv-test-v1', async (paid) => {
    fulfilled.push(paid);
  });
  assert.throws(() => f.ctx.payments.fulfil('merv-test-v1', async () => {}), /fulfilled/);
  // Another seller on the same Stripe account, or another deployment, is not this webhook's.
  assert.deepEqual(await f.webhook(session('another-shop')), { received: true });
  const elsewhere = session('merv-test-v1', { opener: 'https://staging.merv.example' });
  assert.deepEqual(await f.webhook(elsewhere), { received: true });
  // A Merv product nothing fulfils yet is refused, so Stripe sends it again.
  await assert.rejects(Promise.resolve(f.webhook(session('merv-other-v1'))), {
    code: 'payments_unfulfilled',
    status: 503,
  });
  await assert.rejects(Promise.resolve(f.webhook(session('merv-test-v1'), 'forged')), {
    code: 'invalid_webhook',
  });
  assert.equal(fulfilled.length, 0);
  // Each delivery reaches the fulfiller, which is idempotent on the payment.
  for (let delivery = 0; delivery < 2; delivery++)
    assert.deepEqual(await f.webhook(session('merv-test-v1')), { received: true });
  const paid = {
    product: 'merv-test-v1',
    reference: 'ref_1',
    metadata: { provider: 'fake' },
    paymentId: 'pi_1',
    amountUsd: 25,
    eventId: 'evt_1',
    createdAt: '2025-10-09T08:53:20.000Z',
  };
  assert.deepEqual(fulfilled, [paid, paid]);
  // A fulfiller that fails fails the webhook, for Stripe's retry to fulfil.
  dispose();
  f.ctx.payments.fulfil('merv-test-v1', async () => {
    throw new MervError('busy', 'Try again', 503);
  });
  await assert.rejects(
    Promise.resolve(f.webhook(session('merv-test-v1', { id: 'evt_2', paymentIntent: 'pi_2' }))),
    {
      code: 'busy',
    },
  );
});

test('only authentic paid same-mode Checkouts of a Merv product this deployment opened are paid', async () => {
  const stripeGateway = gateway();
  const verify = (payload: string, signature = signed(payload)) =>
    stripeGateway.verify(Buffer.from(payload), signature);
  const payload = session('merv-test-v1');
  const paid = {
    product: 'merv-test-v1',
    reference: 'ref_1',
    metadata: { provider: 'fake' },
    paymentId: 'pi_1',
    amountUsd: 25,
    eventId: 'evt_1',
    createdAt: '2025-10-09T08:53:20.000Z',
  };
  assert.deepEqual(await verify(payload), paid);
  // One opened before the marker carries none, and is still this deployment's.
  assert.deepEqual(await verify(session('merv-test-v1', { opener: undefined })), paid);
  for (const ignored of [
    session('merv-test-v1', { object: { payment_status: 'unpaid' } }),
    session('merv-test-v1', { event: { type: 'payment_intent.succeeded' } }),
    session('another-shop'),
    session('merv-test-v1', { opener: 'https://staging.merv.example' }),
  ])
    assert.equal(await verify(ignored), null);
  await assert.rejects(verify(session('merv-test-v1', { event: { livemode: true } })), /mode/);
  await assert.rejects(verify(`${payload} `, signed(payload)), /signature/);
  await assert.rejects(verify(payload, signed(payload, 1)), /signature/);
  for (const object of [{ client_reference_id: null }, { currency: 'eur' }])
    await assert.rejects(verify(session('merv-test-v1', { object })), /references/);
  assert.throws(() => gateway(false, 'sk_live_disallowed'), /payment mode/);
});

test('a Checkout carries the deployment that opened it', async () => {
  const stripeGateway = gateway();
  let created: Stripe.Checkout.SessionCreateParams | undefined;
  const { sessions } = (stripeGateway as unknown as { stripe: Stripe }).stripe.checkout;
  Object.assign(sessions, {
    create: async (params: Stripe.Checkout.SessionCreateParams) => (
      (created = params),
      { id: 'cs_1', url: 'https://checkout.stripe.com/c/1', livemode: false, expires_at: 1 }
    ),
  });
  const opened = await stripeGateway.checkout({
    product: 'merv-test-v1',
    reference: 'ref_1',
    amountUsd: 25,
    description: 'Credits',
    metadata: { provider: 'fake', origin: 'https://forged.example' },
    successUrl: '/done',
    cancelUrl: '/',
    idempotencyKey: 'key',
  });
  assert.deepEqual(opened, { id: 'cs_1', url: 'https://checkout.stripe.com/c/1', expiresAt: 1 });
  assert.deepEqual(created!.metadata, { provider: 'fake', product: 'merv-test-v1', origin });
});
