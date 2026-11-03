import type { Context } from 'cordis';
import { z } from 'zod';
import { digest } from '@merv/contracts';
import { ResourceLimitSchema } from '@sandboxes/accounts';
import { linkProject } from '@sandboxes/auth';
import { PolicySchema } from '@sandboxes/billing';

/** Limits on the computers people's agents rent through the Sandboxes tools. */
export const computeConfig = z.strictObject({
  /** No machine, renewed or not, runs past this: nothing can configure it over half an hour. */
  maxLeaseSeconds: z.number().int().min(60).max(1800).default(1800),
  dailyUsdPerPerson: z.number().positive().default(1),
  dailyUsdTotal: z.number().positive().default(20),
  /** Below every GPU Modal sells, and it offers only what sandboxes-env.py's shapes name. */
  maxHourlyUsd: z.number().positive().max(0.5).default(0.2),
});

/**
 * Sandboxes enforces every limit in its admission transaction, per account, so one account holds
 * everyone: that is what lets it check a deployment-wide cap. This only writes those limits and
 * connects each project to it, with one member per person so more projects share one allowance.
 */
export const computePlugin = {
  name: 'merv-board-compute',
  Config: computeConfig,
  inject: [
    'scope',
    'sbxAccounts',
    'sbxAuth',
    'sbxBilling',
    'sbxResourceLimits',
    'sbxDb',
    'sbxClock',
  ],
  async apply(ctx: Context, input: z.input<typeof computeConfig>) {
    const config = computeConfig.parse(input);
    const { sbxAccounts: accounts, sbxAuth: auth, sbxResourceLimits: limits, sbxDb: db } = ctx;
    const home = await accounts.ensureNativeNamespace('merv-board-compute');
    const account = home.account_id;
    const admin = (await accounts.members(account)).find((m) => m.id === home.default_member_id)!;
    const target = { scope: 'account', target: account };
    await limits.set(
      account,
      'board-machines',
      ResourceLimitSchema.parse({
        ...target,
        max_lifetime_seconds: config.maxLeaseSeconds,
        max_hourly_price: { currency: 'USD', amount: String(config.maxHourlyUsd) },
      }),
    );
    const daily = (scope: object, cap: number) =>
      PolicySchema.parse({
        ...scope,
        window: 'day',
        currency: 'USD',
        metric: 'money',
        cap: `${cap}`,
      });
    await ctx.sbxBilling.setPolicy(account, 'board-total', daily(target, config.dailyUsdTotal));
    await ctx.sbxBilling.setPolicy(
      account,
      'board-person',
      daily({ ...target, scope: 'member_default' }, config.dailyUsdPerPerson),
    );

    const connect = async (projectId: string, who: { issuer: string; subject: string }) => {
      if (await accounts.linked(projectId)) return;
      const identity = { issuer: who.issuer, subject: who.subject };
      const person =
        (await auth.persons.byIdentity(identity.issuer, identity.subject)) ??
        (await auth.persons.ensureIdentity({
          ...identity,
          displayName: `person-${digest(identity).slice(0, 12)}`,
        }));
      const member =
        (await accounts.memberOf(account, person.id)) ??
        (await accounts.addMember(account, { personId: person.id }));
      await limits.set(
        account,
        `board-one-${member.id}`,
        ResourceLimitSchema.parse({ scope: 'member', target: member.id, max_concurrent: 1 }),
      );
      await linkProject(
        { db, accounts, clock: ctx.sbxClock },
        admin.person_id!,
        projectId,
        { account_id: account, member_id: member.id, only_unlinked: true },
        { internal: true },
      );
    };
    // One at a time: the same person's two new projects must not race to make one member.
    let queue = Promise.resolve();
    const connecting = (projectId: string, who: { issuer: string; subject: string }) => {
      queue = queue
        .then(() => connect(projectId, who))
        .catch((error) =>
          console.error(
            JSON.stringify({ event: 'compute.link_failed', projectId, error: String(error) }),
          ),
        );
      return queue;
    };
    ctx.effect(() => ctx.scope.members.onAdminChanged((id, who) => void connecting(id, who)));
    for (const { projectId, source } of await ctx.scope.projectOwners())
      if (source.kind === 'human') await connecting(projectId, source);
  },
};
