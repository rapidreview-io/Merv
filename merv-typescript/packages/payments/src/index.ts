import type { Context } from 'cordis';
import { z } from 'zod';
import { check, envName, MervError, requiredEnv, type State } from '@merv/contracts';
import type { Paid, Payments } from '@merv/contracts/payments';
import type {} from '@merv/api/types';
import { StripeGateway } from './stripe.js';

/** Published migrations: production pins each text by its digest, never edit one. */
export const paymentMigrations = {
  1: `CREATE TABLE payments_stripe_events (
    event_id TEXT PRIMARY KEY,
    product TEXT NOT NULL,
    reference TEXT NOT NULL,
    received_at TEXT NOT NULL
  );`,
};

type Gateway = Pick<StripeGateway, 'live' | 'checkout' | 'verify'>;
/** Each product's fulfiller, and the events already fulfilled. */
export class PaymentsService implements Payments {
  #fulfillers = new Map<string, (paid: Paid) => Promise<void>>();
  constructor(
    private state: State,
    private gateway: Gateway,
  ) {}
  get live() {
    return this.gateway.live;
  }
  async initialize() {
    await this.state.migrate('payments', paymentMigrations);
  }
  checkout: Payments['checkout'] = (input) => this.gateway.checkout(input);
  fulfil(product: string, handler: (paid: Paid) => Promise<void>) {
    check(!this.#fulfillers.has(product), 'payments_conflict', `${product} is fulfilled`, 409);
    this.#fulfillers.set(product, handler);
    return () => {
      if (this.#fulfillers.get(product) === handler) this.#fulfillers.delete(product);
    };
  }
  async receive(raw: Buffer, signature: unknown) {
    check(typeof signature === 'string', 'invalid_webhook', 'Stripe signature is required', 400);
    const paid = await this.gateway.verify(raw, signature);
    if (!paid) return { received: true as const };
    const fulfil = this.#fulfillers.get(paid.product);
    // Unanswered, Stripe sends it again until its seller is loaded.
    check(fulfil, 'payments_unfulfilled', `Nothing fulfils ${paid.product}`, 503);
    const seen = await this.state.snapshotTransaction((tx) =>
      tx.get('SELECT event_id FROM payments_stripe_events WHERE event_id=?', paid.eventId),
    );
    if (seen) return { received: true as const };
    // A fulfiller is idempotent on the payment, so an event delivered twice at once is safe.
    await fulfil(paid);
    await this.state.transaction((tx) =>
      tx.run(
        'INSERT INTO payments_stripe_events(event_id,product,reference,received_at) VALUES(?,?,?,?) ON CONFLICT (event_id) DO NOTHING',
        paid.eventId,
        paid.product,
        paid.reference,
        new Date().toISOString(),
      ),
    );
    return { received: true as const };
  }
}

const Config = z
  .object({
    secretKeyEnv: envName
      .describe('Payments · Stripe secret key')
      .default('MERV_STRIPE_SECRET_KEY'),
    webhookSecretEnv: envName
      .describe('Payments · Stripe webhook signing secret')
      .default('MERV_STRIPE_WEBHOOK_SECRET'),
    live: z.boolean().default(false),
    /** Where a checkout's relative return paths lead. */
    publicOrigin: z
      .string()
      .url()
      .refine((value) => new URL(value).origin === value, 'Use an origin'),
  })
  .strict();
const secret = (name: string) => requiredEnv(name, 'payments_configuration');

/** Stripe for every plugin that sells, and its one public webhook. */
export const paymentsPlugin = {
  name: 'merv-payments',
  Config,
  inject: ['state', 'api'],
  async apply(ctx: Context, config: z.infer<typeof Config>) {
    await ctx.effect(async function* () {
      const payments = new PaymentsService(
        ctx.state,
        new StripeGateway({
          secretKey: secret(config.secretKeyEnv),
          webhookSecret: secret(config.webhookSecretEnv),
          publicOrigin: config.publicOrigin,
          live: config.live,
        }),
      );
      await payments.initialize();
      yield ctx.provide('payments', payments);
      yield ctx.api.mount(
        '/payments',
        async (req, _res, r) => {
          if (r.url.pathname !== '/payments/stripe-webhook' || req.method !== 'POST')
            throw new MervError('not_found', 'Unknown endpoint', 404);
          return payments.receive(
            await r.bytes(256 * 1024, 'application/json'),
            req.headers['stripe-signature'],
          );
        },
        { public: true },
      );
    });
  },
};
export default paymentsPlugin;
