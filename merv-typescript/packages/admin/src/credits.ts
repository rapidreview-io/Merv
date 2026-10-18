import type { Context } from 'cordis';
import { z } from 'zod';
import type {} from '@sandboxes/accounts';
import type {} from '@sandboxes/auth';
import type {} from '@sandboxes/billing';
import type {} from '@sandboxes/providers';
import { Decimal, Instant } from '@sandboxes/kernel';
import { mervRefusals } from '@sandboxes/merv-host';
import { check, MervError, pathSegment } from '@merv/contracts';
import { personKey } from '@merv/fleet/model-ledger';
import type {} from '@merv/fleet/types';
import type {} from '@merv/pi/types';
import type { AdminCredits, CreditAccount } from './models.js';
import { personLabel, type AdminEnv, type AdminRoutes } from './index.js';

const refusals = mervRefusals(MervError);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
/** Syntax alone: CreditService refuses the values, but an amount it cannot parse would be a 500. */
const usd = z.string().regex(/^\d+(\.\d+)?$/);
const time = z.string().datetime({ offset: true });
const target = { accountId: z.string().min(1).max(48), provider: z.string() };
/** `id` is the grant's own, and its idempotency key: reused, it must repeat the same terms. */
const grantInput = z
  .object({
    id,
    ...target,
    amount: usd,
    validFrom: time,
    expiresAt: time.optional(),
    reason: z.string(),
  })
  .strict();
/** Terms are immutable: the same `id` only enables or disables the schedule. */
const scheduleInput = z
  .object({
    id,
    ...target,
    amount: usd,
    cadence: z.enum(['daily', 'weekly', 'monthly']),
    startsAt: time,
    validityPeriods: z.number().int().nullable(),
    endsAt: time.nullable().optional(),
    enabled: z.boolean(),
  })
  .strict();

/** The Sandboxes services credits live in, found per request: without them, 503. */
function sandboxes(ctx: Context) {
  const billing = ctx.get('sbxBilling');
  const accounts = ctx.get('sbxAccounts');
  const auth = ctx.get('sbxAuth');
  const providers = ctx.get('sbxProviders');
  check(
    billing && accounts && auth && providers,
    'credits_unavailable',
    'Sandbox credits are not available on this server',
    503,
  );
  return { billing, accounts, auth, providers };
}
type Sandboxes = ReturnType<typeof sandboxes>;

const plugins = async (sbx: Sandboxes) =>
  [...new Set((await sbx.providers.connections.list()).map((c) => c.plugin))].sort();

async function credits(env: AdminEnv): Promise<AdminCredits> {
  const sbx = sandboxes(env.ctx);
  const { people, projects } = await env.ctx.scope.directory();
  const persons = await Promise.all(
    people.map((p) => sbx.auth.persons.byIdentity(p.issuer, p.subject)),
  );
  const memberships = await Promise.all(
    persons.map(async (p) => (p ? await sbx.accounts.accountsOf(p.id) : [])),
  );
  const links = new Map<string, CreditAccount['projects']>();
  for (const { id: projectId, name } of projects) {
    const link = await sbx.accounts.linked(projectId);
    if (link)
      links.set(link.account_id, [...(links.get(link.account_id) ?? []), { projectId, name }]);
  }
  const balances = new Map(
    (await sbx.billing.credits.overview()).map((balance) => [balance.account_id, balance]),
  );
  const ids = new Set([
    ...memberships.flat().map((account) => account.id),
    ...links.keys(),
    ...balances.keys(),
  ]);
  const accounts: CreditAccount[] = [];
  for (const accountId of [...ids].sort()) {
    const { pools, grants, schedules } = balances.get(accountId) ?? {
      pools: [],
      grants: [],
      schedules: [],
    };
    accounts.push({
      accountId,
      name: (await sbx.accounts.get(accountId)).name,
      projects: links.get(accountId) ?? [],
      pools,
      grants,
      schedules,
      budgets: (await sbx.billing.policies(accountId)).map(
        ({ account_id, cap, source, updated_at, ...policy }) => ({
          ...policy,
          cap: cap?.toJSON() ?? null,
        }),
      ),
    });
  }
  // Fleet and Pi key a person by their sign-in; the actor names only callers without one.
  const keys = people.map((p) => personKey(p, { projectId: '', actorId: '' }));
  const days = await env.ctx.get('fleet')?.peopleToday(keys);
  const tokens = await env.ctx.get('pi')?.tokensToday(keys);
  return {
    at: new Date().toISOString(),
    providers: await plugins(sbx),
    people: people.map((person, i) => ({
      label:
        personLabel(env.admins, person) ??
        (persons[i]?.display_name || persons[i]?.email || 'Unnamed'),
      issuer: person.issuer,
      subject: person.subject,
      accounts: memberships[i]!.map((a) => ({ accountId: a.id, role: a.role })),
      fleet: days?.[i] ?? null,
      pi: tokens?.[i] ?? null,
    })),
    accounts,
  };
}

/** Writes go through CreditService alone, and each is kept in the admin audit log. */
export function creditRoutes(env: AdminEnv): AdminRoutes {
  return {
    'GET /admin/credits': async () => await refusals.call(() => credits(env)),
    'POST /admin/credits/grants': async (r, who) => {
      const sbx = sandboxes(env.ctx);
      const input = await r.json(grantInput);
      await refusals.call(() =>
        sbx.billing.credits.grant({
          ...input,
          amount: Decimal.parse(input.amount),
          validFrom: Instant.parseIso(input.validFrom),
          expiresAt: input.expiresAt ? Instant.parseIso(input.expiresAt) : null,
        }),
      );
      await env.audit.record({
        ...who,
        action: 'credits.grant',
        target: input.accountId,
        detail: input,
      });
      return { id: input.id };
    },
    'POST /admin/credits/schedules': async (r, who) => {
      const sbx = sandboxes(env.ctx);
      const input = await r.json(scheduleInput);
      await refusals.call(() =>
        sbx.billing.credits.setSchedule({
          ...input,
          amount: Decimal.parse(input.amount),
          startsAt: Instant.parseIso(input.startsAt),
          endsAt: input.endsAt ? Instant.parseIso(input.endsAt) : null,
        }),
      );
      await env.audit.record({
        ...who,
        action: 'credits.schedule',
        target: input.accountId,
        detail: input,
      });
      return { id: input.id, enabled: input.enabled };
    },
    'POST /admin/credits/grants/:id/revoke': async (r, who) => {
      const sbx = sandboxes(env.ctx);
      const grant = pathSegment(r.url.pathname.split('/')[4]!);
      await refusals.call(() => sbx.billing.credits.revokeGrant(grant));
      await env.audit.record({ ...who, action: 'credits.revoke', target: grant });
      return { id: grant, revoked: true };
    },
  };
}
