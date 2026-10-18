import type { Context } from 'cordis';
import { z } from 'zod';
import type {} from '@sandboxes/accounts';
import type {} from '@sandboxes/auth';
import type { CreditBalance, PolicyRow } from '@sandboxes/billing';
import type {} from '@sandboxes/providers';
import { Decimal, Instant } from '@sandboxes/kernel';
import { mervRefusals } from '@sandboxes/merv-host';
import { check, MervError, pathSegment, type ScopePerson } from '@merv/contracts';
import { personKey } from '@merv/fleet/model-ledger';
import type { FleetPersonDay, ModelTokens } from '@merv/fleet/types';
import type {} from '@merv/pi/types';
import type { AdminEnv, AdminRoutes } from './index.js';

/** `GET /admin/credits`. Credit money is Sandboxes' USD decimal text; Fleet's is an estimate. */
export interface AdminCredits {
  at: string;
  /** Provider plugins with an operator connection: the only providers credits may name. */
  providers: string[];
  people: CreditPerson[];
  /** Every account a person belongs to, a project pays from, or credits are held in, once. */
  accounts: CreditAccount[];
  /** Owners not loaded here, whose figures are left out: `fleet`, `pi`. */
  unavailable: string[];
}
export interface CreditPerson {
  label: string;
  issuer: string;
  subject: string;
  /** The Sandboxes accounts they are a member of. */
  accounts: { accountId: string; role: 'admin' | 'member' }[];
  projects: ScopePerson['projects'];
  /** Today (UTC): their Fleet machines' spend against the daily cap, and Fleet model tokens. */
  fleet: FleetPersonDay | null;
  /** Today (UTC): their Agent chat model tokens. */
  pi: (ModelTokens & { person: string }) | null;
}
/** One account's credits per provider, as Sandboxes computes them, and its budget caps beside. */
export interface CreditAccount extends Omit<CreditBalance, 'account_id' | 'currency'> {
  accountId: string;
  name: string;
  /** The Merv projects whose agents spend from it, each as its payer member. */
  projects: { projectId: string; name: string; namespace: string; payerMemberId: string }[];
  /** Budget caps (`infra_policies`): a limit of their own, never part of the credits. */
  budgets: (Omit<PolicyRow, 'account_id' | 'cap' | 'source' | 'updated_at'> & {
    cap: string | null;
  })[];
}

const refusals = mervRefusals(MervError);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const usd = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,6})?$/)
  .refine((value) => /[1-9]/.test(value), 'Amount must be positive');
const time = z.string().datetime({ offset: true });
const target = { accountId: z.string().min(1).max(48), provider: z.string().min(1).max(64) };
/** `id` is the grant's own, and its idempotency key: reused, it must repeat the same terms. */
const grantInput = z
  .object({
    id,
    ...target,
    amount: usd,
    validFrom: time.optional(),
    expiresAt: time.optional(),
    reason: z.string().trim().min(1).max(2000),
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
    validityPeriods: z.number().int().min(1).max(1200).nullable(),
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
  const fleet = env.ctx.get('fleet');
  const pi = env.ctx.get('pi');
  const people = await env.ctx.scope.members.people();
  const persons = await Promise.all(
    people.map((p) => sbx.auth.persons.byIdentity(p.issuer, p.subject)),
  );
  const memberships = await Promise.all(
    persons.map(async (p) => (p ? await sbx.accounts.accountsOf(p.id) : [])),
  );
  const links = new Map<string, CreditAccount['projects']>();
  for (const { projectId, name } of new Map(
    people.flatMap((p) => p.projects).map((p) => [p.projectId, p]),
  ).values()) {
    const link = await sbx.accounts.linked(projectId);
    if (link)
      links.set(link.account_id, [
        ...(links.get(link.account_id) ?? []),
        { projectId, name, namespace: link.name, payerMemberId: link.default_member_id },
      ]);
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
  const days = await fleet?.peopleToday(keys);
  const tokens = await pi?.tokensToday(keys);
  return {
    at: new Date().toISOString(),
    providers: await plugins(sbx),
    people: people.map(({ issuer, subject, projects }, i) => ({
      label: persons[i]?.display_name || persons[i]?.email || subject,
      issuer,
      subject,
      accounts: memberships[i]!.map((a) => ({ accountId: a.id, role: a.role })),
      projects,
      fleet: days?.[i] ?? null,
      pi: tokens?.[i] ?? null,
    })),
    accounts,
    unavailable: [...(fleet ? [] : ['fleet']), ...(pi ? [] : ['pi'])],
  };
}

/** Writes go through CreditService alone, and each is kept in the admin audit log. */
export function creditRoutes(env: AdminEnv): AdminRoutes {
  const provider = async (sbx: Sandboxes, name: string) =>
    check(
      (await plugins(sbx)).includes(name),
      'invalid_provider',
      'Credits name a provider with an operator connection',
    );
  return {
    'GET /admin/credits': async () => await refusals.call(() => credits(env)),
    'POST /admin/credits/grants': async (r, who) => {
      const sbx = sandboxes(env.ctx);
      const input = await r.json(grantInput);
      await provider(sbx, input.provider);
      const validFrom = input.validFrom ?? new Date().toISOString();
      await refusals.call(() =>
        sbx.billing.credits.grant({
          ...input,
          amount: Decimal.parse(input.amount),
          validFrom: Instant.parseIso(validFrom),
          expiresAt: input.expiresAt ? Instant.parseIso(input.expiresAt) : null,
        }),
      );
      const detail = { ...input, validFrom };
      await env.audit.record({ ...who, action: 'credits.grant', target: input.accountId, detail });
      return { id: input.id, validFrom };
    },
    'POST /admin/credits/schedules': async (r, who) => {
      const sbx = sandboxes(env.ctx);
      const input = await r.json(scheduleInput);
      await provider(sbx, input.provider);
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
