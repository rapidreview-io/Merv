import type { Context } from 'cordis';
import type {} from '@sandboxes/merv-host/types';
import type {} from '@sandboxes/accounts';
import type {} from '@sandboxes/billing';
import type {} from '@sandboxes/db';
import type {} from '@sandboxes/providers';
import { Decimal } from '@sandboxes/kernel';
import type {} from '@merv/api/types';
import { check, digest, type Caller } from '@merv/contracts';
import { ManagedCustomerCompute } from './compute.js';

/** Use the configured sponsor's existing compute account, with a private namespace per request.
 * The intake gets inventory only; linking and allowance checks happen before checkout. */
export function hostedCustomerCompute(
  ctx: Context,
  config: {
    sponsor: { issuer: string; subject: string };
    computeProjectId: string;
    computeProviders: string[];
    computeBudgetUsd: number | null;
  },
) {
  const namespaceOf = (caller: Caller) => `customer-${digest(caller.projectId).slice(0, 32)}`;
  const source = async () => {
    const caller = await ctx.scope.caller(
      {
        kind: 'user',
        user: { ...config.sponsor, createdAt: new Date(0).toISOString() },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      config.computeProjectId,
    );
    await ctx.scope.require(caller, 'admin');
    const link = await ctx.sbxMerv.linked(config.computeProjectId);
    check(link, 'customer_compute_unavailable', 'Sponsor compute project is not connected', 503);
    // This rechecks the linked account and payer using Sandboxes' normal access policy.
    await ctx.sbxMerv.principal(caller, 'read');
    return { caller, link };
  };
  return new ManagedCustomerCompute({
    managedCompute: {
      async options(caller: Caller) {
        await ctx.scope.require(caller, 'admin');
        const sponsor = await source();
        const catalogs = await Promise.all(
          config.computeProviders.map((provider) =>
            ctx.tools.call('sandboxes.sandbox_options', sponsor.caller, {
              all_options: true,
              provider,
            }),
          ),
        );
        return { offers: catalogs.flatMap((catalog) => (catalog as { offers: unknown[] }).offers) };
      },
      async spend(caller: Caller) {
        await ctx.scope.require(caller, 'read');
        const report = await ctx.sbxBilling.report(namespaceOf(caller));
        const usd = report.accrued
          .filter((money) => money.currency.toUpperCase() === 'USD')
          .reduce((sum, money) => sum + Number(money.amount), 0);
        return { usd, limitUsd: config.computeBudgetUsd };
      },
      async enable(caller: Caller) {
        await ctx.scope.require(caller, 'admin');
        const { link } = await source();
        const namespace = namespaceOf(caller);
        await ctx.sbxDb.transaction(async (q) => {
          await ctx.sbxAccounts.lock(q, link.account_id);
          await ctx.sbxAccounts.validateTargetsIn(
            q,
            link.account_id,
            [link.namespace],
            [link.member_id],
          );
          const row = await ctx.sbxAccounts.addNamespace(
            link.account_id,
            namespace,
            link.member_id,
            { q },
          );
          check(
            !row.merv_project_id || row.merv_project_id === caller.projectId,
            'customer_compute_unavailable',
            'Experiment compute namespace has a different owner',
            503,
          );
          await ctx.sbxAccounts.setLink(q, namespace, {
            projectId: caller.projectId,
            memberId: link.member_id,
          });
        });
        await ctx.sbxBilling.setPolicy(link.account_id, namespace, {
          scope: 'namespace',
          target: namespace,
          window: 'all_time',
          metric: 'money',
          currency: 'USD',
          cap: config.computeBudgetUsd === null ? null : Decimal.fromInt(config.computeBudgetUsd),
          provider: null,
          source: null,
        });
        await ctx.sbxResourceLimits.set(link.account_id, namespace, {
          scope: 'namespace',
          target: namespace,
          provider: null,
          source: null,
          // Two, so a machine still being torn down never blocks its replacement.
          max_concurrent: 2,
          max_lifetime_seconds: 86_400,
          max_hourly_price: null,
        });
        // Only explicitly configured sponsor providers may be copied into the private namespace.
        // Prepaid host connections must retain their entitlement/wallet path and cannot be copied.
        const installed = new Set((await ctx.sbxVault.list(namespace)).map((entry) => entry.name));
        for (const name of config.computeProviders) {
          const bound = await ctx.sbxProviders.resolve(link.namespace, name);
          check(
            !bound.connectionId,
            'customer_compute_unavailable',
            'Prepaid providers require a dedicated customer entitlement',
            503,
          );
          if (installed.has(name)) continue;
          const host = ctx.sbxSettings.providers.find((entry) => entry.name === name);
          const saved =
            bound.source === 'user' ? await ctx.sbxVault.fields(link.namespace, name) : null;
          check(
            saved || (host?.enabled && ctx.sbxProviders.hostVisible(link.namespace, name)),
            'customer_compute_unavailable',
            'Sponsor provider is unavailable',
            503,
          );
          const fields =
            saved?.fields ??
            bound.plugin.auth.resolve(host!.credential, {
              environ: process.env,
              instanceName: name,
            });
          await ctx.sbxProviders.connect(namespace, {
            name,
            plugin: bound.plugin.name,
            fields,
            settings: saved?.record.settings ?? host!.settings,
            access: bound.access,
          });
        }
        await ctx.sbxMerv.principal(caller, 'write');
        const usage = await ctx.sbxBilling.usage(link.account_id);
        const budgets = usage.budgets.filter(
          (budget) =>
            budget.scope === 'account' ||
            (budget.scope === 'namespace' && budget.target === namespace) ||
            (budget.scope === 'member' && budget.target === link.member_id),
        );
        return {
          connected: true,
          funding: 'managed',
          memberId: link.member_id,
          namespaceId: namespace,
          allowance: JSON.parse(JSON.stringify({ budgets })),
        };
      },
    },
  });
}
