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

/** The credit Sandboxes holds on an account: each grant's money as decimal text, its times as
 *  ISO text. */
export interface CreditAccount {
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

/** The loader entry, or a provider instance's plugin, and the config field that names `env`. */
interface EnvName {
  plugin: string;
  field: string;
  env: string;
}
type Outcome = Record<'at' | 'relay' | 'model', string>;
export interface AdminCredential extends EnvName {
  set: boolean;
  /** The first 8 hex of the value's SHA-256; never the value. */
  fingerprint: string | null;
  /** Every other name and field that holds the same value. */
  sharedWith: EnvName[];
  /** When the value last changed, once this page has seen it change. */
  lastChanged: string | null;
  /** Fleet's relay's last call the provider answered, and its last that failed. */
  lastOk: Outcome | null;
  lastFailure: (Outcome & { status: number | null; code: string | null }) | null;
  /** Fleet's relay saw the provider refuse this key, and it has neither worked nor changed since. */
  dead: boolean;
}
export interface AdminCredentialGroup {
  purpose: string;
  /** A sandbox provider's instance; its credentials are its host key reference, if any. */
  provider?: {
    name: string;
    plugin: string;
    source: 'host' | 'user';
    namespaces: readonly string[] | null;
    enabled: boolean;
    /** The environment variable a host instance's key reference names, if it names one. */
    credential_env: string | null;
    fields: readonly { name: string; present: boolean | null }[];
    verified_at: string | null;
    health: { status: string; message: string } | null;
    health_reason: string | null;
  };
  credentials: AdminCredential[];
}
export interface AdminCredentials {
  at: string;
  groups: AdminCredentialGroup[];
  /** Machine and agent credentials Merv minted, by owner and kind (Postgres counts as text). */
  minted: (Record<'owner' | 'kind' | 'newestIssued', string> &
    Record<'live' | 'revokedLastDay', number | string> & { soonestExpiry: string | null })[];
}

// ── v2 (docs/ADMIN.md "v2"): operable credentials and credits. These replace the shapes above
// where they overlap; the builders delete what they supersede.

/** One platform secret named by a plugin's config, by what it is for. Never its value. */
export interface PlatformSecret extends EnvName {
  /** The owner's own description of the field (its config schema's `.describe()`). */
  purpose: string;
  set: boolean;
  /** Every other name and field that holds the same value. */
  sharedWith: EnvName[];
  lastChanged: string | null;
  lastOk: Outcome | null;
  lastFailure: (Outcome & { status: number | null; code: string | null }) | null;
  dead: boolean;
  /** The admin may reveal and change it here (a stored override replaces the env value). */
  editable: boolean;
}
/** One credential field of one sandbox provider instance. Never its value. */
export interface ProviderKey {
  provider: string;
  plugin: string;
  source: 'host' | 'user';
  /** The namespace a user-saved key belongs to; null for a host instance. */
  namespace: string | null;
  field: string;
  /** The provider plugin's own description of the field. */
  description: string;
  secret: boolean;
  present: boolean | null;
  health: 'ok' | 'degraded' | 'unavailable' | null;
  healthReason: string | null;
  verifiedAt: string | null;
  editable: boolean;
}
export interface AdminCredentialsV2 {
  at: string;
  groups: {
    purpose: 'Agent' | 'Fleet agents' | 'Fleet machines' | 'Platform services';
    secrets: PlatformSecret[];
  }[];
  providers: ProviderKey[];
  minted: AdminCredentials['minted'];
}
/** `POST /admin/credentials/reveal` and `/change`: one platform secret, or one provider's keys. */
export type CredentialTarget =
  { env: string } | { provider: string; namespace: string | null; field: string };
export type CredentialChange =
  | { env: string; value: string }
  | { provider: string; namespace: string | null; fields: Record<string, string> };

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
/** `GET /admin/credits/people/:person` (`:person` is `encodeURIComponent(issuer + '|' + subject)`). */
export interface PersonCredits {
  person: { key: string; label: string; issuer: string; subject: string };
  /** Their own Sandboxes account, which provider credit is granted to. */
  accountId: string | null;
  kinds: CreditUse[];
  /** The provider grants and schedules on their account. */
  grants: CreditAccount['grants'];
  schedules: CreditAccount['schedules'];
}
/** `GET /admin/credits`: one row per person, with what they used today (UTC) of each credit type. */
export interface AdminCredits {
  at: string;
  /** Provider plugins with an operator connection: the only providers credits may name. */
  providers: string[];
  people: (PersonCredits['person'] & { kinds: (Omit<CreditUse, 'used'> & { used: number })[] })[];
}
/** `POST /admin/credits/people/:person/limits`: null clears the person's own limit. */
export interface CreditLimitInput {
  kind: 'agent-tokens' | 'fleet-tokens' | 'fleet-usd';
  limit: number | null;
}
