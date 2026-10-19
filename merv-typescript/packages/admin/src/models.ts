/**
 * What the /admin routes answer: types alone, written out rather than borrowed from the owners
 * they are composed from, so the browser reads the same ones (`@merv/admin/models`).
 */
import type { RunningPhrase } from '@merv/contracts/running';
import type { UsageTotals } from '@merv/sessions/models';

/** Why a unit may need someone: an owner's blocker, an admin's allowance, a customer, an agent. */
export interface AdminAttention {
  reason: 'blocker' | 'allowance' | 'customer' | 'agent';
  code: string;
  /** The owner's words, where it has any: an agent's need is a phrase Sessions writes. */
  message?: string | RunningPhrase;
}
export interface AdminWorkRow {
  id: string;
  /** The owner's workflow name (`task`, `service_experiment`), `pi` for an Agent conversation. */
  kind: string;
  /** The owner's type name, where it has one (`task.work`). */
  type?: string;
  title: string;
  /** The unit it is part of, which the table draws it under: a lens's reflection. */
  parent?: string;
  project: { id: string; name: string };
  person: string;
  state: string;
  terminal: boolean;
  attention: AdminAttention[];
  /** The live work visit at the unit's revision. */
  agent?: { role: string; status: string } | null;
  machine: {
    phase: string;
    profile: string | null;
    provider: string | null;
    usdPerHour: number | null;
  } | null;
  lastActivity: string;
  createdAt: string;
  /** Its closed work visits; runners report tokens unverified, and no visit reports a price. */
  cost?: Omit<UsageTotals, 'toolCalls' | 'toolPayloadTokensEstimate'> | null;
  /** A standalone experiment's request, which its customer's page is opened by. */
  requestId?: string;
}
export interface AdminWork {
  rows: AdminWorkRow[];
  at: string;
}

/** The loader entry and the config field that names `env`. */
interface EnvName {
  plugin: string;
  field: string;
  env: string;
}
type Outcome = Record<'at' | 'relay' | 'model', string>;

/** One platform secret named by a plugin's config, by what it is for. Never its value. */
export interface PlatformSecret extends EnvName {
  /** The owner's own description of the field (its config schema's `.describe()`). */
  purpose: string;
  set: boolean;
  /** Every other variable a loaded entry names that holds the same value. */
  sharedWith: string[];
  lastChanged: string | null;
  lastOk: Outcome | null;
  lastFailure: (Outcome & { status: number | null; code: string | null }) | null;
  dead: boolean;
  /** The admin may reveal and change it here (a stored override replaces the env value). */
  editable: boolean;
}
/** One credential field of one of the platform's sandbox provider instances. Never its value. */
export interface ProviderKey {
  provider: string;
  field: string;
  /** The provider plugin's own description of the field. */
  description: string;
  present: boolean | null;
  health: 'ok' | 'degraded' | 'unavailable' | null;
  healthReason: string | null;
  editable: boolean;
}
export interface AdminCredentials {
  groups: {
    purpose: 'Agent' | 'Fleet agents' | 'Fleet machines' | 'Platform services';
    secrets: PlatformSecret[];
  }[];
  providers: ProviderKey[];
  /** Machine and agent credentials Merv minted, by owner and kind (Postgres counts as text). */
  minted: (Record<'owner' | 'kind' | 'newestIssued', string> &
    Record<'live' | 'revokedLastDay', number | string> & { soonestExpiry: string | null })[];
}
/** `POST /admin/credentials/reveal` (→ `{ value }`) names one; `/change` (→ `{ ok, reloaded }`,
 *  the plugin entries reloaded and provider instances rebound) gives an env its `value`, or a
 *  provider some of its key's `fields`. */
export type CredentialTarget = { env: string } | { provider: string; field: string };

/** A credit type a person spends: the platform's own, or one sandbox provider's. */
export type CreditKind = 'agent-tokens' | 'fleet-tokens' | 'fleet-usd' | `provider:${string}`;
export interface CreditUse {
  kind: CreditKind;
  label: string;
  unit: 'tokens' | 'usd';
  /** Per day for the platform's own kinds; what is granted (all time) for a provider. */
  limit: number | null;
  /** The person's own limit, where it overrides the platform default. */
  own: boolean;
  used: Record<'day' | 'week' | 'month' | 'total', number>;
  /** What is left now: of today's limit, or of a provider's granted credit. */
  left: number | null;
}
/** `GET /admin/credits/people/:person` (`:person` is `encodeURIComponent(key)`). */
export interface PersonCredits {
  /** `key` is `issuer|subject`, which every credit write names the person by. */
  person: { key: string; label: string };
  kinds: CreditUse[];
  /** The provider grants and schedules on their own Sandboxes account: money as decimal text,
   *  times as ISO text. */
  grants: (Record<'id' | 'provider' | 'amount' | 'used' | 'reserved' | 'available', string> &
    Record<'valid_from' | 'created_at' | 'reason', string> &
    Record<'expires_at' | 'revoked_at' | 'schedule_id', string | null>)[];
  schedules: (Record<'id' | 'provider' | 'amount' | 'starts_at', string> & {
    cadence: 'daily' | 'weekly' | 'monthly';
    validity_periods: number | null;
    ends_at: string | null;
    enabled: boolean;
  })[];
}
/** `GET /admin/credits`: one row per person, with what they used today (UTC) of each credit type. */
export interface AdminCredits {
  people: (PersonCredits['person'] & { kinds: (Omit<CreditUse, 'used'> & { used: number })[] })[];
}
