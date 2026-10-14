import Stripe from 'stripe';
import { check } from '@merv/contracts';
import type { ExperimentContract } from './types.js';

export interface PaidCheckout {
  eventId: string;
  requestId: string;
  contractHash: string;
  checkoutId: string;
  paymentId: string;
  amountCents: number;
  currency: string;
}
export interface Payments {
  checkout(input: {
    requestId: string;
    contract: ExperimentContract;
    email: string;
    generation: number;
    previousId?: string;
  }): Promise<{ id: string; url: string; expiresAt: number }>;
  verify(bytes: Buffer, signature: string): PaidCheckout | null;
}
/** No browser callback can fulfill an order; only a signed paid Checkout event can. */
export class StripePayments implements Payments {
  private stripe: Stripe;
  constructor(
    private config: {
      secretKey: string;
      webhookSecret: string;
      publicOrigin: string;
      live: boolean;
    },
  ) {
    check(
      config.secretKey.startsWith(config.live ? 'sk_live_' : 'sk_test_') ||
        config.secretKey.startsWith(config.live ? 'rk_live_' : 'rk_test_'),
      'customer_configuration',
      'Stripe key does not match configured payment mode',
      503,
    );
    check(
      config.webhookSecret.startsWith('whsec_'),
      'customer_configuration',
      'Stripe webhook secret is required',
      503,
    );
    this.stripe = new Stripe(config.secretKey, { maxNetworkRetries: 2, timeout: 20000 });
  }
  async checkout(input: {
    requestId: string;
    contract: ExperimentContract;
    email: string;
    generation: number;
    previousId?: string;
  }) {
    const { requestId, contract, email, generation } = input;
    if (input.previousId) {
      const previous = await this.stripe.checkout.sessions.retrieve(input.previousId);
      check(
        previous.payment_status !== 'paid',
        'payment_processing',
        'Payment is already received; waiting for its confirmation',
        409,
      );
      if (previous.status === 'open' && previous.url)
        return { id: previous.id, url: previous.url, expiresAt: previous.expires_at };
      check(
        previous.status === 'expired',
        'payment_processing',
        'This checkout is still settling; wait for its confirmation',
        409,
      );
    }
    const back = `${this.config.publicOrigin}/customer-experiments/r/${encodeURIComponent(requestId)}`;
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        managed_payments: { enabled: false },
        allowed_payment_method_types: ['card'],
        customer_email: email,
        client_reference_id: requestId,
        metadata: {
          product: 'merv-customer-experiment-v1',
          requestId,
          contractHash: contract.hash,
          contractId: contract.id,
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: contract.price.currency,
              unit_amount: contract.price.amountCents,
              product_data: {
                name: contract.plan.title.slice(0, 250),
                description: 'One bounded experiment under the accepted Merv plan',
              },
            },
          },
        ],
        success_url: `${back}?checkout=returned`,
        cancel_url: `${back}?checkout=cancelled`,
      },
      { idempotencyKey: `merv-experiment-v2-${requestId}-${contract.hash}-${generation}` },
    );
    check(
      session.url && session.livemode === this.config.live,
      'checkout_unavailable',
      'Checkout is not available',
      503,
    );
    return { id: session.id, url: session.url, expiresAt: session.expires_at };
  }
  verify(bytes: Buffer, signature: string): PaidCheckout | null {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(bytes, signature, this.config.webhookSecret, 300);
    } catch {
      check(false, 'invalid_webhook', 'Invalid Stripe webhook signature', 400);
    }
    check(
      event.livemode === this.config.live,
      'invalid_webhook',
      'Stripe event has the wrong payment mode',
      400,
    );
    if (
      !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(
        event.type,
      )
    )
      return null;
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.product !== 'merv-customer-experiment-v1') return null;
    if (session.payment_status !== 'paid') return null;
    check(
      session.mode === 'payment' &&
        session.metadata.requestId &&
        session.metadata.contractHash &&
        session.client_reference_id === session.metadata.requestId &&
        session.amount_total !== null &&
        session.currency &&
        typeof session.payment_intent === 'string',
      'invalid_webhook',
      'Paid checkout is missing experiment references',
      400,
    );
    return {
      eventId: event.id,
      requestId: session.metadata.requestId,
      contractHash: session.metadata.contractHash,
      checkoutId: session.id,
      paymentId: session.payment_intent,
      amountCents: session.amount_total,
      currency: session.currency,
    };
  }
}

export interface ResultMailer {
  send(input: { to: string; title: string; url: string; idempotencyKey: string }): Promise<void>;
}
/** Resend's transactional API. Only an approved request's email receives its private result link. */
export class ResendResultMailer implements ResultMailer {
  constructor(
    private key: string,
    private from: string,
  ) {}
  async send(input: { to: string; title: string; url: string; idempotencyKey: string }) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: `Your Merv experiment: ${input.title}`,
        text: `Your experiment has finished. Open your private page to see the result, evidence, and review:\n\n${input.url}`,
      }),
    });
    check(response.ok, 'email_unavailable', 'Result email could not be delivered yet', 503);
  }
}
