import Stripe from 'stripe';
import { check } from '@merv/contracts';
import type { CheckoutInput, Paid, Payments } from '@merv/contracts/payments';

/** Stripe Checkout in one mode. No browser callback can fulfil an order; only a signed paid
 *  Checkout event can. */
export class StripeGateway implements Pick<Payments, 'live' | 'checkout'> {
  private stripe: Stripe;
  readonly live: boolean;
  constructor(
    private config: {
      secretKey: string;
      webhookSecret: string;
      publicOrigin: string;
      live: boolean;
    },
  ) {
    this.live = config.live;
    check(
      config.secretKey.startsWith(config.live ? 'sk_live_' : 'sk_test_') ||
        config.secretKey.startsWith(config.live ? 'rk_live_' : 'rk_test_'),
      'payments_configuration',
      'Stripe key does not match configured payment mode',
      503,
    );
    check(
      config.webhookSecret.startsWith('whsec_'),
      'payments_configuration',
      'Stripe webhook secret is required',
      503,
    );
    this.stripe = new Stripe(config.secretKey, { maxNetworkRetries: 2, timeout: 20000 });
  }
  async checkout(input: CheckoutInput) {
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
    const url = (path: string) => new URL(path, this.config.publicOrigin).href;
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        managed_payments: { enabled: false },
        allowed_payment_method_types: ['card'],
        ...(input.email ? { customer_email: input.email } : {}),
        client_reference_id: input.reference,
        // The deployment that opened it, so two sharing one Stripe account never take each other's.
        metadata: { ...input.metadata, product: input.product, origin: this.config.publicOrigin },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(input.amountUsd * 100),
              product_data: { name: input.description.slice(0, 250) },
            },
          },
        ],
        success_url: url(input.successUrl),
        cancel_url: url(input.cancelUrl),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    check(
      session.url && session.livemode === this.live,
      'checkout_unavailable',
      'Checkout is not available',
      503,
    );
    return { id: session.id, url: session.url, expiresAt: session.expires_at };
  }
  /** Null for anything but a paid Checkout of a Merv product this deployment opened. */
  async verify(raw: Buffer, signature: string): Promise<Paid | null> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(raw, signature, this.config.webhookSecret, 300);
    } catch {
      check(false, 'invalid_webhook', 'Invalid Stripe webhook signature', 400);
    }
    check(
      event.livemode === this.live,
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
    // The account may sell other things, and other deployments Merv's; one opened before the
    // marker carries none.
    const { product, origin = this.config.publicOrigin, ...metadata } = session.metadata ?? {};
    if (!product?.startsWith('merv-') || origin !== this.config.publicOrigin) return null;
    if (session.payment_status !== 'paid') return null;
    const reference = session.client_reference_id;
    check(
      session.mode === 'payment' &&
        reference &&
        session.amount_total !== null &&
        session.currency === 'usd' &&
        typeof session.payment_intent === 'string',
      'invalid_webhook',
      'Paid checkout is missing its references',
      400,
    );
    return {
      product,
      reference,
      metadata,
      paymentId: session.payment_intent,
      amountUsd: session.amount_total / 100,
      eventId: event.id,
      createdAt: new Date(session.created * 1000).toISOString(),
      ...(session.customer_details?.email ? { email: session.customer_details.email } : {}),
    };
  }
}
