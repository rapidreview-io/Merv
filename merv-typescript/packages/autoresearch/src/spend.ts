import type { Context } from 'cordis';
import type {} from '@sandboxes/merv-host/types';
import type {} from '@sandboxes/billing';
import { Instant } from '@sandboxes/kernel';

/**
 * What a project's compute has cost since an instant, in US dollars: Sandboxes' accrued money
 * and what its live machines hold reserved, in the namespace linked to the project. `null` means
 * no compute is connected, so nothing can be spent; a rejection means the spend is not known now.
 */
export interface SpendSource {
  since(projectId: string, sinceIso: string): Promise<{ usd: number } | null>;
}

const usd = (rows: readonly { amount: string; currency: string }[]) =>
  rows
    .filter((money) => money.currency.toUpperCase() === 'USD')
    .reduce((sum, money) => sum + Number(money.amount), 0);

/** Sandboxes' own accounting: the same report a person's spend page reads. */
export function sandboxesSpend(ctx: Context): SpendSource {
  return {
    async since(projectId, sinceIso) {
      // Looked up at each read: Sandboxes may load after Autoresearch, or not at all.
      const merv = ctx.get('sbxMerv');
      const billing = ctx.get('sbxBilling');
      if (!merv || !billing) return null;
      const link = await merv.linked(projectId);
      if (!link) return null;
      const report = await billing.report(link.namespace, { start: Instant.parseIso(sinceIso) });
      return { usd: usd(report.accrued) + usd(report.reserved) };
    },
  };
}
