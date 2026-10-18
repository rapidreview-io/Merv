import { sha256Hex, type ConfiguredEnv } from '@merv/contracts';
import type {} from '@merv/fleet/types';
import { CredentialStore } from '@merv/identity/credentials';
import type {} from '@sandboxes/providers';
import type { AdminCredential, AdminCredentialGroup, AdminCredentials } from './models.js';
import type { AdminEnv } from './index.js';

/** Published migrations: production pins each text by its digest, never edit one. */
export const credentialMigrations = {
  2: `CREATE TABLE admin_credential_observations (
    env TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    changed_at TEXT
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
  // Each name's value as last seen, and when it last became a different one: a value restored
  // after a rotation changed then too.
  const seen = await env.state.transaction(async (tx) => {
    for (const [name, digest] of digests)
      await tx.run(
        `INSERT INTO admin_credential_observations(env,fingerprint) VALUES(?,?) ON CONFLICT(env) DO UPDATE
         SET fingerprint=excluded.fingerprint,changed_at=?
         WHERE admin_credential_observations.fingerprint<>excluded.fingerprint`,
        name,
        digest.slice(0, 8),
        at,
      );
    return await tx.all<{ env: string; changed_at: string | null }>(
      'SELECT env,changed_at FROM admin_credential_observations',
    );
  });

  const credential = (ref: ConfiguredEnv): AdminCredential => {
    const digest = digests.get(ref.env);
    const fingerprint = digest?.slice(0, 8) ?? null;
    const lastChanged = (digest && seen.find((row) => row.env === ref.env)?.changed_at) || null;
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
