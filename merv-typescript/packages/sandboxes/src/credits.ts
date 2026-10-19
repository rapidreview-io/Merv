import type { Context } from 'cordis';
import { z } from 'zod';
import { check, digest, MervError } from '@merv/contracts';
import type { Paid, Payments } from '@merv/contracts/payments';
import type { MountHandler } from '@merv/api/types';
import type { SbxBilling } from '@sandboxes/billing';
import { Decimal, Instant } from '@sandboxes/kernel';
import { mervRefusals } from '@sandboxes/merv-host/errors';
import type { SbxProviders } from '@sandboxes/providers';
import { PLUGIN_COPY } from '@sandboxes/providers/console-labels';
import type { SandboxesPeople } from './types.js';

/** What a top-up's Checkout sells: credit on one provider of the buyer's own account. */
export const CREDITS_PRODUCT = 'merv-sandbox-credits-v1';
/** The founder's fixed top-ups, in USD. */
const TOP_UPS = [25, 50, 100, 250] as const;
const back = '/ui/settings/compute';
const refusals = mervRefusals(MervError);

interface Sbx {
  people: SandboxesPeople;
  providers: SbxProviders;
  billing: SbxBilling;
  /** Payments while it is loaded: without it nothing is sold. */
  payments(): Payments | undefined;
}
type Person = { issuer: string; subject: string };

const checkoutInput = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    amountUsd: z.number().refine((usd) => TOP_UPS.some((top) => top === usd)),
    requestId: z.string().uuid(),
  })
  .strict();
const modeInput = z.object({ mode: z.enum(['hosted', 'own']) }).strict();

/** Per provider plugin the person's own account can use: its mode, the hosted credit where a
 *  funded instance is the account's to rent, and whether the account saved a key of its own. */
async function compute(sbx: Sbx, person: Person) {
  const own = await sbx.people.accountOf(person);
  if (!own) return { topUps: [], providers: [] };
  const [modes, report] = await Promise.all([
    sbx.providers.modes.of(own.accountId),
    sbx.billing.credits.report(own.accountId),
  ]);
  return {
    topUps: sbx.payments() ? TOP_UPS : [],
    providers: modes.map(({ plugin, mode, funded, keyed }) => {
      const pool = report.pools.find((p) => p.provider === plugin);
      return {
        plugin,
        label: PLUGIN_COPY[plugin]?.title ?? plugin,
        mode,
        hosted: funded ? { granted: pool?.granted ?? '0', left: pool?.available ?? '0' } : null,
        ownKey: keyed,
      };
    }),
  };
}

async function checkout(sbx: Sbx, person: Person, input: z.infer<typeof checkoutInput>) {
  const payments = sbx.payments();
  check(payments, 'checkout_unavailable', 'Payments are not configured', 503);
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

/** `/compute`: the signed-in person's own account, per provider. */
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
    const path = r.url.pathname;
    if (path === '/compute' && req.method === 'GET')
      return refusals.call(() => compute(sbx, person));
    if (path === '/compute/checkout' && req.method === 'POST') {
      const input = await r.json(checkoutInput);
      return refusals.call(() => checkout(sbx, person, input));
    }
    const mode = /^\/compute\/([a-z][a-z0-9_-]{0,63})\/mode$/.exec(path);
    if (mode && req.method === 'PUT') {
      const provider = mode[1]!;
      const input = await r.json(modeInput);
      return refusals.call(async () => {
        const own = await sbx.people.accountOf(person);
        check(own, 'not_found', 'No Sandboxes account yet', 404);
        await sbx.providers.modes.set(own.accountId, provider, input.mode);
        return { plugin: provider, mode: input.mode };
      });
    }
    throw new MervError('not_found', 'Unknown endpoint', 404);
  };
}

/** A person's compute: top-ups paid through Stripe, credited at once, and each provider's mode.
 *  Loaded by the integration beside its people. */
export const sandboxesCreditsPlugin = {
  name: 'merv-sandboxes-credits',
  inject: ['api', 'sandboxesPeople', 'sbxProviders', 'sbxBilling'],
  apply(ctx: Context) {
    const people = ctx.sandboxesPeople;
    ctx.inject(['payments'], (ctx) => {
      ctx.effect(() => ctx.payments.fulfil(CREDITS_PRODUCT, (paid) => topUp(people, paid)));
    });
    const sbx: Sbx = {
      people,
      providers: ctx.sbxProviders,
      billing: ctx.sbxBilling,
      payments: () => ctx.get('payments'),
    };
    ctx.effect(() => ctx.api.mount('/compute', computeRoutes(sbx)));
  },
};
