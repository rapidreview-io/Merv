import type { Context } from 'cordis';
import { z } from 'zod';
import { check, digest, MervError } from '@merv/contracts';
import type { Paid, Payments } from '@merv/contracts/payments';
import type { MountHandler } from '@merv/api/types';
import { Decimal, Instant } from '@sandboxes/kernel';
import { mervRefusals } from '@sandboxes/merv-host/errors';
import type { SbxProviders } from '@sandboxes/providers';
import { PLUGIN_COPY } from '@sandboxes/providers/console-labels';
import type { SandboxesPeople } from './types.js';

/** What a top-up's Checkout sells: credit on one provider of the buyer's own account. */
export const CREDITS_PRODUCT = 'merv-sandbox-credits-v1';
/** Where Checkout returns: the console's Providers page inside Merv's Sandboxes view. */
const back = '/ui/sandboxes/providers';
const refusals = mervRefusals(MervError);

interface Sbx {
  people: SandboxesPeople;
  providers: SbxProviders;
  /** The top-ups the console offers, in USD: the host's `console.top_ups`. */
  topUps: readonly number[];
  /** Payments while it is loaded: without it nothing is sold. */
  payments(): Payments | undefined;
}
type Person = { issuer: string; subject: string };

const checkoutInput = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    amountUsd: z.number(),
    requestId: z.string().uuid(),
  })
  .strict();
async function checkout(sbx: Sbx, person: Person, input: z.infer<typeof checkoutInput>) {
  const payments = sbx.payments();
  check(payments, 'checkout_unavailable', 'Payments are not configured', 503);
  check(sbx.topUps.includes(input.amountUsd), 'invalid_input', 'Not a top-up on offer', 400);
  // Money is never taken for credit the account has no funded instance to spend on.
  const own = await sbx.people.accountOf(person);
  const modes = own ? await sbx.providers.modes.of(own.accountId) : [];
  check(
    modes.some((row) => row.plugin === input.provider && row.funded),
    'provider_unavailable',
    'This provider has no hosted machines',
    409,
  );
  const { issuer, subject } = person;
  const { url } = await payments.checkout({
    product: CREDITS_PRODUCT,
    reference: input.requestId,
    amountUsd: input.amountUsd,
    description: `${PLUGIN_COPY[input.provider]?.title ?? input.provider} credits`,
    metadata: { issuer, subject, provider: input.provider },
    successUrl: `${back}?checkout=paid`,
    cancelUrl: back,
    idempotencyKey: `merv-credits-v1-${digest([issuer, subject, input.provider, input.amountUsd, input.requestId])}`,
  });
  return { url };
}

/** A paid top-up, granted once: the grant's id is the payment's and its terms the session's. */
async function topUp(people: SandboxesPeople, paid: Paid) {
  const { issuer, subject, provider } = paid.metadata;
  check(issuer && subject && provider, 'invalid_webhook', 'Paid credit names no account', 400);
  await people.grant(
    { issuer, subject },
    {
      id: `stripe:${paid.paymentId}`,
      provider,
      amount: Decimal.parse(paid.amountUsd.toFixed(2)),
      validFrom: Instant.parseIso(paid.createdAt),
      expiresAt: null,
      reason: 'Top-up',
    },
  );
}

/** `/compute/checkout`: a top-up of the signed-in person's own account, which the console asks for. */
function computeRoutes(sbx: Sbx): MountHandler {
  return async (req, res, r) => {
    res.setHeader('Cache-Control', 'no-store');
    const principal = r.principal;
    check(
      principal && !('caller' in principal) && principal.kind === 'user',
      'forbidden',
      'Sign in with an account to manage compute',
      403,
    );
    const person = { issuer: principal.user.issuer, subject: principal.user.subject };
    if (r.url.pathname === '/compute/checkout' && req.method === 'POST') {
      const input = await r.json(checkoutInput);
      return refusals.call(() => checkout(sbx, person, input));
    }
    throw new MervError('not_found', 'Unknown endpoint', 404);
  };
}

/** A person's top-ups, paid through Stripe and credited at once; the console shows modes and
 *  balances from Sandboxes itself. Loaded by the integration beside its people. */
export const sandboxesCreditsPlugin = {
  name: 'merv-sandboxes-credits',
  inject: ['api', 'sandboxesPeople', 'sbxProviders', 'sbxSettings'],
  apply(ctx: Context) {
    const people = ctx.sandboxesPeople;
    ctx.inject(['payments'], (ctx) => {
      ctx.effect(() => ctx.payments.fulfil(CREDITS_PRODUCT, (paid) => topUp(people, paid)));
    });
    const sbx: Sbx = {
      people,
      providers: ctx.sbxProviders,
      topUps: ctx.sbxSettings.console.top_ups,
      payments: () => ctx.get('payments'),
    };
    ctx.effect(() => ctx.api.mount('/compute', computeRoutes(sbx)));
  },
};
