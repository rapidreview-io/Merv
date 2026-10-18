import { sha256Hex, type ConfiguredEnv } from '@merv/contracts';
import type {} from '@merv/fleet/types';
import { CredentialStore, type CredentialSummary } from '@merv/identity/credentials';
import type { ProviderInventoryEntry } from '@sandboxes/providers';
import { loaded, type AdminEnv } from './index.js';

/** Published migrations: production pins each text by its digest, never edit one. */
export const credentialMigrations = {
  2: `CREATE TABLE admin_credential_observations (
    env TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY(env, fingerprint)
  );`,
};

/** The purpose each plugin entry's credentials serve; every other entry's is a platform service. */
const services = 'Platform services';
const purposes: Record<string, string> = {
  pi: 'Pi agents',
  'fleet-workflow': 'Fleet agents',
  fleet: 'Fleet machines',
  sessions: 'Fleet machines',
};

export interface AdminCredential {
  env: string;
  /** The loader entry, or a provider instance's plugin, and the config field that names `env`. */
  plugin: string;
  field: string;
  set: boolean;
  /** The first 8 hex of the value's SHA-256; never the value. */
  fingerprint: string | null;
  /** Every other name and field that holds the same value. */
  sharedWith: ConfiguredEnv[];
  firstSeen: string | null;
  /** When the value last changed, once this page has seen it change. */
  lastChanged: string | null;
  lastOk: { at: string; relay: string; model: string } | null;
  lastFailure: {
    at: string;
    relay: string;
    model: string;
    status: number | null;
    code: string | null;
  } | null;
  /** Fleet's relay saw the provider refuse this key, and it has neither worked nor changed since. */
  dead: boolean;
}
export interface AdminCredentialGroup {
  purpose: string;
  /** A sandbox provider's instance; its credentials are its host key reference, if any. */
  provider?: Omit<ProviderInventoryEntry, 'verified_at' | 'updated_at'> & {
    verified_at: string | null;
    updated_at: string | null;
  };
  credentials: AdminCredential[];
}
export interface AdminCredentials {
  at: string;
  groups: AdminCredentialGroup[];
  /** Machine and agent credentials Merv minted, by owner and kind. */
  minted: CredentialSummary[];
  /** The owners not loaded here, or whose read failed. */
  unavailable: string[];
}

/** Which credential serves which purpose, never a value: the composition root's names, Fleet's
 *  relay outcomes, Identity's ledger and Sandboxes' providers, composed here and nowhere else. */
export async function adminCredentials(env: AdminEnv): Promise<AdminCredentials> {
  const at = new Date().toISOString();
  const { get, unavailable } = loaded(env.ctx);
  const read = async <T>(owner: string, fn: () => Promise<T> | undefined) => {
    try {
      return await fn();
    } catch {
      unavailable.push(owner);
    }
  };
  const composition = get('composition');
  const providers = (await read('sbxProviders', () => get('sbxProviders')?.inventory())) ?? [];
  const outcomes = (await read('fleet', () => get('fleet')?.relayOutcomes())) ?? [];
  const minted = (await read('identity', () => new CredentialStore(env.state).summary())) ?? [];

  const groups: AdminCredentialGroup[] = [...new Set(Object.values(purposes)), services].map(
    (purpose) => ({ purpose, credentials: [] }),
  );
  const named = (composition?.environment() ?? []).map((ref) => ({
    ref,
    group: groups.find((g) => g.purpose === (purposes[ref.plugin] ?? services))!,
  }));
  for (const provider of providers) {
    const group = {
      purpose: 'Sandbox provider',
      provider: {
        ...provider,
        verified_at: provider.verified_at?.toJSON() ?? null,
        updated_at: provider.updated_at?.toJSON() ?? null,
      },
      credentials: [],
    };
    groups.push(group);
    const { plugin, name, credential_env: key } = provider;
    if (key)
      named.push({ ref: { plugin, field: `providers.${name}.credential`, env: key }, group });
  }
  const digests = new Map<string, string>();
  for (const { ref } of named) {
    const value = process.env[ref.env];
    if (value) digests.set(ref.env, sha256Hex(value));
  }
  const seen = await env.state.transaction(async (tx) => {
    for (const [name, digest] of digests)
      await tx.run(
        'INSERT INTO admin_credential_observations(env,fingerprint,first_seen,last_seen) VALUES(?,?,?,?) ON CONFLICT(env,fingerprint) DO UPDATE SET last_seen=excluded.last_seen',
        name,
        digest.slice(0, 8),
        at,
        at,
      );
    return await tx.all<{ env: string; fingerprint: string; first_seen: string }>(
      'SELECT env,fingerprint,first_seen FROM admin_credential_observations ORDER BY first_seen',
    );
  });

  const credential = (ref: ConfiguredEnv): AdminCredential => {
    const digest = digests.get(ref.env);
    const fingerprint = digest?.slice(0, 8) ?? null;
    const history = seen.filter((row) => row.env === ref.env);
    const since = history.find((row) => row.fingerprint === fingerprint)?.first_seen ?? null;
    const lastChanged = history.length > 1 ? since : null;
    const latest = (key: 'lastOkAt' | 'lastFailureAt') =>
      outcomes
        .filter((row) => row.keyEnv === ref.env && row[key])
        .sort((a, b) => (a[key]! < b[key]! ? 1 : -1))[0];
    const ok = latest('lastOkAt');
    const failed = latest('lastFailureAt');
    return {
      ...ref,
      set: !!digest,
      fingerprint,
      sharedWith: digest
        ? named
            .map((n) => n.ref)
            .filter((other) => other !== ref && digests.get(other.env) === digest)
        : [],
      firstSeen: history[0]?.first_seen ?? null,
      lastChanged,
      lastOk: ok ? { at: ok.lastOkAt!, relay: ok.relay, model: ok.model } : null,
      lastFailure: failed
        ? {
            at: failed.lastFailureAt!,
            relay: failed.relay,
            model: failed.model,
            status: failed.lastFailureStatus,
            code: failed.lastFailureCode,
          }
        : null,
      dead:
        !!failed?.rejected &&
        !(ok && ok.lastOkAt! > failed.lastFailureAt!) &&
        !(lastChanged && lastChanged > failed.lastFailureAt!),
    };
  };
  for (const { ref, group } of named) group.credentials.push(credential(ref));
  return {
    at,
    groups: groups.filter((g) => g.provider || g.credentials.length),
    minted,
    unavailable,
  };
}
