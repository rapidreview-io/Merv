import type { Context } from 'cordis';
import { z } from 'zod';
import { check, envName, MervError, requiredEnv } from '@merv/contracts';
import type { Paid, Payments } from '@merv/contracts/payments';
import type {} from '@merv/api/types';
import { StripeGateway } from './stripe.js';

type Gateway = Pick<StripeGateway, 'live' | 'checkout' | 'verify'>;
/** Each product's fulfiller. */
export class PaymentsService implements Payments {
  #fulfillers = new Map<string, (paid: Paid) => Promise<void>>();
  constructor(private gateway: Gateway) {}
  get live() {
    return this.gateway.live;
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
    // A fulfiller is idempotent on the payment, so every delivery of an event is safe.
    await fulfil(paid);
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
  inject: ['api'],
  async apply(ctx: Context, config: z.infer<typeof Config>) {
    await ctx.effect(async function* () {
      const payments = new PaymentsService(
        new StripeGateway({
          secretKey: secret(config.secretKeyEnv),
          webhookSecret: secret(config.webhookSecretEnv),
          publicOrigin: config.publicOrigin,
          live: config.live,
        }),
      );
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
