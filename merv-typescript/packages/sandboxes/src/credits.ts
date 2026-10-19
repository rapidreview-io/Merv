import type { Context } from 'cordis';
import { z } from 'zod';
import { check, digest, MervError } from '@merv/contracts';
import type { Paid, Payments } from '@merv/contracts/payments';
import type { MountHandler } from '@merv/api/types';
import type { SbxBilling } from '@sandboxes/billing';
import { Decimal, Instant } from '@sandboxes/kernel';
import { mervRefusals } from '@sandboxes/merv-host/errors';
import type { SbxProviders, SbxVault } from '@sandboxes/providers';
import { PLUGIN_COPY } from '@sandboxes/providers/console-labels';
import type { SandboxesPeople } from './types.js';

/** What a top-up's Checkout sells: credit on one provider of the buyer's own account. */
export const CREDITS_PRODUCT = 'merv-sandbox-credits-v1';
/** The founder's fixed top-ups, in USD. */
export const TOP_UPS = [25, 50, 100, 250] as const;
const back = '/ui/settings/compute';
const refusals = mervRefusals(MervError);

type Mode = 'hosted' | 'own';
/** TODO(merv-sandboxes): delete this cast once @sandboxes/providers declares
 *  `SbxProviders.modes` (each account's hosted or own-key mode per provider plugin). */
const modesOf = (providers: SbxProviders) =>
  (
    providers as SbxProviders & {
      modes: {
        of(accountId: string): Promise<{ plugin: string; mode: Mode; stored: boolean }[]>;
        set(accountId: string, plugin: string, mode: Mode): Promise<void>;
      };
    }
  ).modes;

interface Sbx {
  people: SandboxesPeople;
  providers: SbxProviders;
  billing: SbxBilling;
  vault: SbxVault;
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

const connected = async (sbx: Sbx) =>
  new Set((await sbx.providers.connections.list()).map((c) => c.plugin));

/** Per provider plugin the person's own account can use: its mode, the hosted credit where an
 *  operator connection can spend one, and whether the person saved a key of their own. */
async function compute(sbx: Sbx, person: Person) {
  const own = await sbx.people.accountOf(person);
  if (!own) return { topUps: [], providers: [] };
  const [modes, report, hosted, keys] = await Promise.all([
    modesOf(sbx.providers).of(own.accountId),
    sbx.billing.credits.report(own.accountId),
    connected(sbx),
    sbx.vault.list(own.namespace),
  ]);
  return {
    topUps: sbx.payments() ? TOP_UPS : [],
    providers: modes.map(({ plugin, mode }) => {
      const pool = report.pools.find((p) => p.provider === plugin);
      return {
        plugin,
        label: PLUGIN_COPY[plugin]?.title ?? plugin,
        mode,
        hosted: hosted.has(plugin)
          ? { granted: pool?.granted ?? '0', used: pool?.used ?? '0', left: pool?.available ?? '0' }
          : null,
        ownKey: keys.some((key) => key.plugin === plugin),
      };
    }),
  };
}

async function checkout(sbx: Sbx, person: Person, input: z.infer<typeof checkoutInput>) {
  const payments = sbx.payments();
  check(payments, 'checkout_unavailable', 'Payments are not configured', 503);
  // Money is never taken for credit no operator connection could spend.
  check(
    (await connected(sbx)).has(input.provider),
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
    metadata: { issuer, subject, provider: input.provider, amountUsd: String(input.amountUsd) },
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
export function computeRoutes(sbx: Sbx): MountHandler {
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
        await modesOf(sbx.providers).set(own.accountId, provider, input.mode);
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
  inject: ['api', 'sandboxesPeople', 'sbxProviders', 'sbxBilling', 'sbxVault'],
  apply(ctx: Context) {
    let payments: Payments | undefined;
    ctx.inject(['payments'], (ctx) => {
      ctx.effect(() => {
        const people = ctx.sandboxesPeople;
        const fulfilment = ctx.payments.fulfil(CREDITS_PRODUCT, (paid) => topUp(people, paid));
        payments = ctx.payments;
        return () => {
          fulfilment();
          payments = undefined;
        };
      });
    });
    const sbx: Sbx = {
      people: ctx.sandboxesPeople,
      providers: ctx.sbxProviders,
      billing: ctx.sbxBilling,
      vault: ctx.sbxVault,
      payments: () => payments,
    };
    ctx.effect(() => ctx.api.mount('/compute', computeRoutes(sbx)));
  },
};
