import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Stripe from 'stripe';
import { Context } from 'cordis';
import { MervError } from '@merv/contracts';
import type { Paid } from '@merv/contracts/payments';
import type { ApiRequest, MountHandler } from '@merv/api/types';
import { paymentsPlugin } from '../packages/payments/src/index.js';
import { openState } from './fixtures/state.js';

const secret = 'whsec_test_payments';
const stripe = new Stripe('sk_test_payments_fixture');
const session = (product: string, id = 'evt_1', paymentIntent = 'pi_1') =>
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
        metadata: { product, provider: 'fake' },
      },
    },
  });

/** The plugin over real Stripe signatures, its webhook called as the API would call it. */
async function fixture(t: TestContext) {
  const state = await openState();
  t.after(async () => await state.close());
  process.env.MERV_TEST_STRIPE_KEY = 'sk_test_payments_fixture';
  process.env.MERV_TEST_STRIPE_WEBHOOK = secret;
  const routes = new Map<string, MountHandler>();
  const ctx = new Context();
  ctx.provide('state', state);
  ctx.provide('api', {
    mount: (prefix: string, handler: MountHandler) => (routes.set(prefix, handler), () => {}),
  });
  const fiber = ctx.plugin(paymentsPlugin, {
    secretKeyEnv: 'MERV_TEST_STRIPE_KEY',
    webhookSecretEnv: 'MERV_TEST_STRIPE_WEBHOOK',
    live: false,
    publicOrigin: 'https://merv.example',
  });
  t.after(async () => await fiber.dispose());
  await fiber.await();
  const webhook = (payload: string, signature?: string) =>
    routes.get('/payments')!(
      {
        method: 'POST',
        headers: {
          'stripe-signature':
            signature ?? stripe.webhooks.generateTestHeaderString({ payload, secret }),
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      {
        url: new URL('/payments/stripe-webhook', 'https://merv.example'),
        bytes: async () => Buffer.from(payload),
      } as unknown as ApiRequest,
    );
  return { ctx, state, webhook };
}

test('the webhook fulfils each paid Merv checkout once, by its product', async (t) => {
  const f = await fixture(t);
  const fulfilled: Paid[] = [];
  const dispose = f.ctx.payments.fulfil('merv-test-v1', async (paid) => {
    fulfilled.push(paid);
  });
  assert.throws(() => f.ctx.payments.fulfil('merv-test-v1', async () => {}), /fulfilled/);
  // Another seller on the same Stripe account is not this webhook's.
  assert.deepEqual(await f.webhook(session('another-shop')), { received: true });
  // A Merv product nothing fulfils yet is refused, so Stripe sends it again.
  await assert.rejects(Promise.resolve(f.webhook(session('merv-other-v1'))), {
    code: 'payments_unfulfilled',
    status: 503,
  });
  await assert.rejects(Promise.resolve(f.webhook(session('merv-test-v1'), 'forged')), {
    code: 'invalid_webhook',
  });
  assert.equal(fulfilled.length, 0);
  for (let delivery = 0; delivery < 3; delivery++)
    assert.deepEqual(await f.webhook(session('merv-test-v1')), { received: true });
  assert.deepEqual(fulfilled, [
    {
      product: 'merv-test-v1',
      reference: 'ref_1',
      metadata: { provider: 'fake' },
      paymentId: 'pi_1',
      amountUsd: 25,
      eventId: 'evt_1',
      sessionId: 'cs_test_1',
      createdAt: '2025-10-09T08:53:20.000Z',
    },
  ]);
  // A fulfiller that fails leaves the event unrecorded, for Stripe's retry to fulfil.
  dispose();
  f.ctx.payments.fulfil('merv-test-v1', async () => {
    throw new MervError('busy', 'Try again', 503);
  });
  await assert.rejects(Promise.resolve(f.webhook(session('merv-test-v1', 'evt_2', 'pi_2'))), {
    code: 'busy',
  });
  const events = await f.state.read((sql) =>
    sql.all('SELECT event_id,product,reference FROM payments_stripe_events'),
  );
  assert.deepEqual(events, [{ event_id: 'evt_1', product: 'merv-test-v1', reference: 'ref_1' }]);
});
