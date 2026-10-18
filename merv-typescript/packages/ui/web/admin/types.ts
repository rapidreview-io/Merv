/**
 * What the /admin routes answer (packages/admin/src/{work,credits,credentials}.ts), as far as these
 * pages read it. The server's own types sit beside its composition, which the browser cannot load.
 */
import type { RunningPhrase } from '@merv/contracts/running';

export interface AdminWorkRow {
  id: string;
  kind: string;
  type: string | null;
  title: string;
  project: { id: string; name: string };
  person: { key: string; label: string };
  state: string;
  terminal: boolean;
  attention: { reason: string; provider?: string; code: string; message: string | RunningPhrase }[];
  agent: { role: string; status: string } | null;
  machine: {
    phase: string;
    profile: string | null;
    provider: string | null;
    sandboxId: string | null;
    usdPerHour: number | null;
  } | null;
  lastActivity: string;
  createdAt: string;
  updatedAt: string;
  cost: {
    sessions: number;
    reportedSessions: number;
    wallMs: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
  /** A standalone experiment's request, which its customer's page is opened by. */
  requestId?: string;
}
export interface AdminWork {
  rows: AdminWorkRow[];
  people: { key: string; label: string; active: number; total: number }[];
  at: string;
  unavailable: string[];
}

interface Tokens {
  used: number;
  limit: number;
}
export interface CreditAccount {
  accountId: string;
  name: string;
  projects: { projectId: string; name: string }[];
  pools: {
    provider: string;
    granted: string;
    used: string;
    reserved: string;
    available: string;
    expired: string;
    revoked: string;
  }[];
  grants: {
    id: string;
    provider: string;
    amount: string;
    used: string;
    reserved: string;
    available: string;
    valid_from: string;
    expires_at: string | null;
    revoked_at: string | null;
    schedule_id: string | null;
    created_at: string;
    reason: string;
  }[];
  schedules: {
    id: string;
    provider: string;
    amount: string;
    starts_at: string;
    cadence: 'daily' | 'weekly' | 'monthly';
    validity_periods: number | null;
    ends_at: string | null;
    enabled: boolean;
  }[];
  budgets: {
    id: string;
    scope: string;
    window: string;
    metric: string;
    currency: string | null;
    cap: string | null;
    provider: string | null;
  }[];
}
export interface AdminCredits {
  at: string;
  providers: string[];
  people: {
    label: string;
    issuer: string;
    subject: string;
    accounts: { accountId: string; role: 'admin' | 'member' }[];
    fleet: { usd: number; usdCap: number | null; tokens: Tokens | null } | null;
    pi: Tokens | null;
  }[];
  accounts: CreditAccount[];
  unavailable: string[];
}

export interface AdminCredential {
  env: string;
  plugin: string;
  field: string;
  set: boolean;
  fingerprint: string | null;
  sharedWith: { plugin: string; field: string; env: string }[];
  firstSeen: string | null;
  lastChanged: string | null;
  lastOk: { at: string; relay: string; model: string } | null;
  lastFailure: {
    at: string;
    relay: string;
    model: string;
    status: number | null;
    code: string | null;
  } | null;
  dead: boolean;
}
export interface AdminCredentials {
  at: string;
  groups: {
    purpose: string;
    provider?: {
      name: string;
      plugin: string;
      source: string;
      enabled: boolean;
      /** The env name a host instance's credential is read from. */
      credential_env?: string | null;
      fields: { name: string; present: boolean | null }[];
      verified_at: string | null;
      health: { status: string; message: string } | null;
      health_reason: string | null;
    };
    credentials: AdminCredential[];
  }[];
  minted: {
    owner: string;
    kind: string;
    live: number | string;
    soonestExpiry: string | null;
    revokedLastDay: number | string;
    newestIssued: string;
  }[];
  unavailable: string[];
}
