import { z } from 'zod';
import { check, MervError, type Caller } from '@merv/contracts';
export interface ComputeFundingStatus {
  connected: boolean;
  funding?: string;
  memberId?: string | null;
  namespaceId?: string;
  allowance?: unknown;
  [key: string]: unknown;
}
export interface ComputeProvisioning {
  managedCompute?: {
    options(caller: Caller): Promise<unknown>;
    enable(caller: Caller): Promise<ComputeFundingStatus>;
  };
}

const name = z.string().min(1).max(255);
const quantity = z.number().finite().nonnegative().nullable();
const amount = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .max(100);
// Deliberately project only published machine facts. Neither arbitrary provider fields nor
// the funding receipt (which names a payer) belongs in a customer's intake conversation.
const offerSchema = z.object({
  provider: name,
  offer_id: name,
  instance_type: name,
  region: name,
  resources: z.object({
    cpu: quantity,
    memory_mb: quantity,
    gpu: name.nullable(),
    gpu_count: z.number().int().nonnegative(),
    gpu_memory_mb: quantity,
    disk_gb: quantity,
  }),
  hourly_price: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount }).nullable(),
  available: z.boolean(),
});
const optionsSchema = z.object({ offers: z.array(offerSchema).max(10_000) });
export interface ComputeOptions {
  checkedAt: string;
  source: 'sandboxes';
  offers: z.infer<typeof offerSchema>[];
  notice: string;
}
export interface CustomerCompute {
  /** Read provider inventory. Does not enroll the request or issue any rental authority. */
  options(caller: Caller): Promise<ComputeOptions>;
  /** Server-only funding preflight for checkout/release. Issues no assignment or rental. */
  prepareExecution(caller: Caller): Promise<void>;
}

const allowanceSchema = z.object({
  budgets: z
    .array(
      z.object({
        scope: z.string(),
        target: z.string(),
        window: z.string(),
        metric: z.string(),
        currency: z.string().nullable(),
        provider: z.string().nullable(),
        source: z.string().nullable(),
        cap: amount.nullable(),
        available: amount.nullable(),
        accounting_complete: z.boolean(),
      }),
    )
    .min(1),
});
const positive = (value: string | null) => value !== null && /[1-9]/.test(value);

/** The existing member allowance is a shared account ceiling, not a per-experiment quote. */
function funded(status: ComputeFundingStatus): void {
  const parsed = allowanceSchema.safeParse(status.allowance);
  check(
    status.connected && status.funding === 'managed' && status.memberId && parsed.success,
    'customer_compute_unavailable',
    'Managed compute funding could not be verified',
    503,
  );
  const budgets = parsed.data.budgets;
  const member = budgets.filter(
    (budget) =>
      ((budget.scope === 'member' &&
        budget.target === status.memberId &&
        budget.window === 'month') ||
        (budget.scope === 'namespace' &&
          budget.target === status.namespaceId &&
          budget.window === 'all_time')) &&
      budget.metric === 'money' &&
      budget.currency === 'USD' &&
      budget.provider === null &&
      budget.source === null,
  );
  check(
    member.length > 0 && member.every((budget) => budget.cap === null || positive(budget.cap)),
    'customer_compute_unavailable',
    'Managed compute needs a verified sponsor allowance',
    503,
  );
  // Provider-specific policies are checked once the executor chooses an offer. A depleted
  // provider must not hide a funded alternative. Unfiltered policies apply to every choice.
  check(
    budgets
      .filter((budget) => budget.provider === null && budget.source === null && budget.cap !== null)
      .every((budget) => budget.accounting_complete && positive(budget.available)),
    'customer_compute_unavailable',
    'Managed compute allowance is exhausted or awaiting accounting',
    503,
  );
}

/** Narrow product adapter over the already configured Sandboxes owner. No credentials,
 * independent connection client, rental API, or provider configuration are exposed here. */
export class ManagedCustomerCompute implements CustomerCompute {
  constructor(private readonly sandboxes: ComputeProvisioning) {}

  private capability() {
    const capability = this.sandboxes.managedCompute;
    check(capability, 'customer_compute_unavailable', 'Managed compute is not configured', 503);
    return capability;
  }

  async options(caller: Caller): Promise<ComputeOptions> {
    const capability = this.capability();
    try {
      const parsed = optionsSchema.parse(await capability.options(caller));
      return {
        checkedAt: new Date().toISOString(),
        source: 'sandboxes',
        offers: parsed.offers.filter((offer) => offer.available),
        notice:
          'Provider-reported inventory and hourly prices, not a reservation. Capacity and prices may change; some providers advertise shapes without a live capacity guarantee. The executor checks current options and rental admission before selecting hardware. GPU type is an internal execution choice, not part of customer approval. Account funding and provider policy still apply.',
      };
    } catch {
      // An unavailable read is not an empty catalog or evidence of no GPUs. Never pass
      // provider response bodies or account/credential details into intake.
      throw new MervError(
        'customer_compute_unavailable',
        'Current compute options could not be verified; retry the catalog read',
        503,
      );
    }
  }

  async prepareExecution(caller: Caller): Promise<void> {
    funded(await this.capability().enable(caller));
  }
}
