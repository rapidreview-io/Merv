import { z } from 'zod';
import { check, envName, MervError, type ConfiguredEnv } from '@merv/contracts';
import type {} from '@merv/fleet/types';
import { CredentialStore } from '@merv/identity/credentials';
import type {} from '@merv/secrets/types';
import { mervRefusals } from '@sandboxes/merv-host';
import { PLUGIN_COPY } from '@sandboxes/providers/console-labels';
import type {} from '@sandboxes/providers';
import type { AdminCredentials, PlatformSecret, ProviderKey } from './models.js';
import type { AdminEnv, AdminRoutes } from './index.js';

/** Published migrations: production pins each text by its digest, never edit one. Nothing reads
 *  admin@2's table any more: it kept each value's fingerprint, which the page no longer shows. */
export const credentialMigrations = {
  2: `CREATE TABLE admin_credential_observations (
    env TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    changed_at TEXT
  );`,
};

type Purpose = AdminCredentials['groups'][number]['purpose'];
/** The purpose each plugin entry's secrets serve; every other entry's are platform services. */
const purposes: Record<string, Purpose> = {
  pi: 'Agent',
  'fleet-workflow': 'Fleet agents',
  fleet: 'Fleet machines',
  sessions: 'Fleet machines',
};
const groups: Purpose[] = ['Agent', 'Fleet agents', 'Fleet machines', 'Platform services'];
const refusals = mervRefusals(MervError);

/** Which secret serves which purpose, never a value: the composition root's names and their
 *  owners' words, Secrets' changes, Fleet's relay outcomes, Identity's ledger and Sandboxes'
 *  providers, composed here and nowhere else. */
async function credentials(env: AdminEnv): Promise<AdminCredentials> {
  const secrets = env.ctx.get('secrets');
  const named = env.ctx.get('composition')?.environment() ?? [];
  // A read that fails leaves its facts out.
  const stored = (await secrets?.platformSecrets().catch(() => [])) ?? [];
  const changed = new Map(stored.map((row) => [row.env, row.updatedAt]));
  const outcomes =
    (await env.ctx
      .get('fleet')
      ?.relayOutcomes()
      .catch(() => [])) ?? [];
  const inventory =
    (await env.ctx
      .get('sbxProviders')
      ?.inventory()
      .catch(() => [])) ?? [];
  const minted = await new CredentialStore(env.state).summary().catch(() => []);

  const secret = (ref: ConfiguredEnv): PlatformSecret => {
    const value = process.env[ref.env];
    const lastChanged = changed.get(ref.env) ?? null;
    const latest = (key: 'lastOkAt' | 'lastFailureAt') =>
      outcomes
        .filter((row) => row.keyEnv === ref.env && row[key])
        .sort((a, b) => (a[key]! < b[key]! ? 1 : -1))[0];
    const ok = latest('lastOkAt');
    const failed = latest('lastFailureAt');
    return {
      plugin: ref.plugin,
      field: ref.field,
      env: ref.env,
      purpose: ref.purpose,
      set: !!value,
      // Values are compared here, in the process that holds them, and never kept or sent.
      sharedWith: [
        ...new Set(
          named
            .filter((other) => other.env !== ref.env && value && process.env[other.env] === value)
            .map((other) => other.env),
        ),
      ],
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
      editable: ref.overridable && !!secrets?.platformAvailable,
    };
  };
  return {
    groups: groups
      .map((purpose) => ({
        purpose,
        secrets: named
          .filter((ref) => (purposes[ref.plugin] ?? 'Platform services') === purpose)
          .map(secret),
      }))
      .filter((group) => group.secrets.length),
    // The platform's own keys: a key a person saved is theirs, not the admin's to read.
    providers: inventory
      .filter((p) => p.source === 'host')
      .flatMap((p) =>
        p.fields.map((field): ProviderKey => ({
          provider: p.name,
          label: PLUGIN_COPY[p.plugin]?.title ?? p.name,
          field: field.name,
          description: field.description,
          present: field.present,
          health: p.health?.status ?? null,
          healthReason: p.health_reason,
          editable: !!p.credential_env && !!secrets?.platformAvailable,
        })),
      ),
    minted,
  };
}

const target = z.union([
  z.object({ env: envName }).strict(),
  z.object({ provider: z.string(), field: z.string() }).strict(),
]);
const change = z.union([
  z.object({ env: envName, value: z.string().min(1) }).strict(),
  z
    .object({ provider: z.string(), fields: z.record(z.string().min(1)) })
    .strict()
    .refine((input) => Object.keys(input.fields).length > 0),
]);

/** One secret at a time, each read or change kept in the admin audit log by what it names, never
 *  its value: a platform secret a loaded plugin's config names, or a provider instance's field
 *  Sandboxes lists. Nothing else is read. */
export function credentialRoutes(env: AdminEnv): AdminRoutes {
  const composition = () => {
    const composed = env.ctx.get('composition');
    check(
      composed && env.ctx.get('secrets'),
      'credentials_unavailable',
      'Stored secrets are unavailable',
      503,
    );
    return composed;
  };
  /** An env name a loaded plugin's config names, which a stored secret may replace. */
  const platform = (name: string) => {
    const refs = composition()
      .environment()
      .filter((ref) => ref.env === name);
    check(refs.length, 'not_found', 'No loaded plugin names this secret', 404);
    check(
      refs.every((ref) => ref.overridable),
      'credential_fixed',
      'This secret is read before stored secrets apply; change it in the deployment',
      409,
    );
    return name;
  };
  /** A host provider instance Sandboxes lists with these fields: its key env, and its key now. */
  const provider = async (name: string, fields: string[]) => {
    const hub = env.ctx.get('sbxProviders');
    check(hub, 'credentials_unavailable', 'Sandbox providers are not available', 503);
    const found = (await refusals.call(() => hub.inventory())).find(
      (p) => p.source === 'host' && p.name === name,
    );
    check(
      found && fields.every((field) => found.fields.some((known) => known.name === field)),
      'not_found',
      'No such sandbox provider key',
      404,
    );
    const key = found.credential_env;
    check(key, 'credential_fixed', 'This provider key is not read from the environment', 409);
    // Read when used: a change reads it inside the serialized override, as it stands then.
    const current = () =>
      refusals.call(async () =>
        hub.plugin(found.plugin).auth.resolve(`env:${key}`, { instanceName: found.name }),
      );
    return { hub, key, current };
  };
  return {
    'GET /admin/credentials': async () => await credentials(env),
    'POST /admin/credentials/reveal': async (r, who) => {
      const input = await r.json(target);
      const value =
        'env' in input
          ? process.env[platform(input.env)]
          : (await (await provider(input.provider, [input.field])).current())[input.field];
      check(value, 'not_found', 'This secret is not set', 404);
      // The target alone: its env name, or its provider and field.
      const { env: name, provider: instance, ...detail } = input as Record<string, string>;
      await env.audit.record(who, 'credentials.reveal', (name ?? instance)!, detail);
      return { value };
    },
    'POST /admin/credentials/change': async (r, who) => {
      const input = await r.json(change);
      if ('env' in input) {
        const reloaded = await composition().override(platform(input.env), input.value, who);
        await env.audit.record(who, 'credentials.change', input.env);
        return { ok: true, reloaded };
      }
      const names = Object.keys(input.fields);
      const { hub, key, current } = await provider(input.provider, names);
      // A host instance's key is its credential env, replaced as any platform secret is, and
      // Sandboxes rebinds the instances that read it.
      const reloaded = await composition().override(
        key,
        async () => JSON.stringify({ ...(await current()), ...input.fields }),
        who,
        () => refusals.call(() => hub.rebindHost(key)),
      );
      await env.audit.record(who, 'credentials.change', input.provider, { fields: names });
      return { ok: true, reloaded };
    },
  };
}
