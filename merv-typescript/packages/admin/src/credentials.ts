import { sha256Hex, type ConfiguredEnv } from '@merv/contracts';
import type {} from '@merv/fleet/types';
import { CredentialStore } from '@merv/identity/credentials';
import type {} from '@sandboxes/providers';
import type { AdminCredential, AdminCredentialGroup, AdminCredentials } from './models.js';
import type { AdminEnv } from './index.js';

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

/** Which credential serves which purpose, never a value: the composition root's names, Fleet's
 *  relay outcomes, Identity's ledger and Sandboxes' providers, composed here and nowhere else. */
export async function adminCredentials(env: AdminEnv): Promise<AdminCredentials> {
  const at = new Date().toISOString();
  const composition = env.ctx.get('composition');
  const sandboxes = env.ctx.get('sbxProviders');
  const fleet = env.ctx.get('fleet');
  // A read that fails leaves its facts out.
  const providers = (await sandboxes?.inventory().catch(() => [])) ?? [];
  const outcomes = (await fleet?.relayOutcomes().catch(() => [])) ?? [];
  const minted = await new CredentialStore(env.state).summary().catch(() => []);

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
        name: provider.name,
        plugin: provider.plugin,
        source: provider.source,
        namespaces: provider.namespaces,
        enabled: provider.enabled,
        credential_env: provider.credential_env,
        fields: provider.fields,
        verified_at: provider.verified_at?.toJSON() ?? null,
        health: provider.health,
        health_reason: provider.health_reason,
      },
      credentials: [],
    };
    // In reading order: before the platform services, which come last.
    groups.splice(-1, 0, group);
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
  };
}
