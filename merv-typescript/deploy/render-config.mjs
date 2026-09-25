import { readFileSync, writeFileSync } from 'node:fs';
import { deploymentSchema, fleetRuntimes, piModels, sandboxConnections } from './schema.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value?.trim() || value.trim() !== value) throw new Error(`Missing or invalid ${name}`);
  return value;
};
const httpsOrigin = (name) => {
  const value = required(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
  if (url.protocol !== 'https:' || url.origin !== value) throw new Error(`Invalid ${name}`);
  return value;
};
const envName = (name) => {
  const value = required(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
};
const integer = (name, fallback, min, max) => {
  if (process.env[name] === undefined) return fallback;
  const value = required(name);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${name}`);
  }
  const number = Number(value);
  if (number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
};
const optIn = (name) => {
  const value = process.env[name];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`Invalid ${name}`);
};
const json = (name) => {
  try {
    return JSON.parse(required(name));
  } catch {
    throw new Error(`Invalid ${name}`);
  }
};
const fleetEnabled = optIn('MERV_FLEET_ENABLED');
const workflowEnabled = optIn('MERV_FLEET_WORKFLOW_ENABLED');
const piEnabled = optIn('MERV_PI_ENABLED');
if (workflowEnabled && !fleetEnabled) throw new Error('Fleet workflow requires MERV_FLEET_ENABLED');
if (piEnabled && !fleetEnabled) throw new Error('Pi requires MERV_FLEET_ENABLED');
const mode = required('MERV_TS_AUTH_MODE');
if (!['hs256', 'jwks'].includes(mode)) throw new Error('Invalid MERV_TS_AUTH_MODE');
// Refuse to silently place new objects among the legacy Python objects.
if (!/^merv-ts(?:\/[A-Za-z0-9_-]+)*$/.test(required('MERV_BLOB_PREFIX'))) {
  throw new Error('MERV_BLOB_PREFIX must be merv-ts or a directory below it');
}
for (const name of [
  'MERV_DB_URL',
  'MERV_BLOB_BUCKET',
  'MERV_BLOB_ENDPOINT_URL',
  'MERV_BLOB_ACCESS_KEY_ID',
  'MERV_BLOB_SECRET_ACCESS_KEY',
  'SUPABASE_ANON_KEY',
  ...(mode === 'hs256' ? ['SUPABASE_JWT_SECRET'] : []),
])
  required(name);

const config = JSON.parse(
  readFileSync(new URL('../dist/config/default.json', import.meta.url), 'utf8'),
);
const set = (id, value) => {
  const plugin = config.plugins.find((entry) => entry.id === id);
  if (!plugin) throw new Error(`Missing required deployment plugin: ${id}`);
  plugin.config = value;
  plugin.required = true;
  plugin.disabled = false;
};
set('state', {
  backend: 'postgres',
  connectionStringEnv: 'MERV_DB_URL',
  schema: deploymentSchema(),
  // Writers queue on the schema lock and each read scope holds a connection while it
  // runs; ten connections filled with lock waiters starved every read under three runs.
  maxConnections: 40,
  connectionTimeoutMs: 30000,
  statementTimeoutMs: 60000,
  // Every transaction takes one advisory lock per schema; two scenario runs with their
  // runners overran 5 s of waiting.
  lockTimeoutMs: 45000,
});
set('blobs', {
  backend: 's3',
  bucketEnv: 'MERV_BLOB_BUCKET',
  endpointEnv: 'MERV_BLOB_ENDPOINT_URL',
  accessKeyIdEnv: 'MERV_BLOB_ACCESS_KEY_ID',
  secretAccessKeyEnv: 'MERV_BLOB_SECRET_ACCESS_KEY',
  regionEnv: 'MERV_BLOB_REGION',
  prefixEnv: 'MERV_BLOB_PREFIX',
});
set('identity', {
  supabaseUrl: httpsOrigin('SUPABASE_URL'),
  mode,
  publishableKeyEnv: 'SUPABASE_ANON_KEY',
  ...(mode === 'hs256' ? { secretEnv: 'SUPABASE_JWT_SECRET' } : {}),
});
set('api', {
  host: '0.0.0.0',
  port: 3081,
  allowedOrigins: [httpsOrigin('MERV_TS_PUBLIC_ORIGIN')],
});
set('ui', {});
// Code keeps one Git repository per project beside the state, on the data volume: /tmp is a
// small tmpfs, and the repositories must survive the container.
set('code', { repositories: { root: '/var/lib/merv-ts/code' } });
set('code-research', {});
// Rows and acts published by merv-sandboxes. Absent until the operator names the service, so
// a deployment that has not connected one composes exactly the plugins it composed before.
let connections = [];
// The machines Fleet rents, the default first. MERV_FLEET_RUNTIMES replaces the single-profile
// MERV_FLEET_RUNTIME_* variables, which then only let an image older than the catalog render.
let runtimes = [];
if (process.env.MERV_SANDBOXES_URL !== undefined) {
  httpsOrigin('MERV_SANDBOXES_URL');
  connections = sandboxConnections();
  if (fleetEnabled) {
    runtimes =
      process.env.MERV_FLEET_RUNTIMES === undefined
        ? fleetRuntimes(
            [
              {
                key: 'standard',
                label: 'Standard',
                slots: 3,
                provider: process.env.MERV_FLEET_RUNTIME_PROVIDER,
                offerId: process.env.MERV_FLEET_RUNTIME_OFFER_ID,
                releaseId: process.env.MERV_FLEET_RUNTIME_RELEASE_ID,
                leaseSeconds: integer('MERV_FLEET_RUNTIME_LEASE_SECONDS', undefined, 60, 86_400),
              },
            ],
            'MERV_FLEET_RUNTIME_*',
          )
        : fleetRuntimes(json('MERV_FLEET_RUNTIMES'), 'MERV_FLEET_RUNTIMES');
    // A workflow machine outlives a Main restart; should Main not return, its unrenewed lease is
    // the bound on how long it runs on. Fleet renews a lease before it ends.
    if (workflowEnabled)
      runtimes = runtimes.map((profile) => ({
        ...profile,
        leaseSeconds: Math.min(profile.leaseSeconds ?? 900, 900),
      }));
  }
  config.plugins.push(
    { id: 'sandboxes-tools', name: '@merv/sandboxes/tools' },
    { id: 'sandboxes-ui', name: '@merv/sandboxes/ui', required: false },
    {
      id: 'sandboxes',
      name: '@merv/sandboxes',
      // Only names: the origin and each project's consumer grant stay in the environment.
      config: {
        urlEnv: 'MERV_SANDBOXES_URL',
        connections,
        ...(runtimes.length
          ? { runtimes: runtimes.map(({ label, slots, agent, ...profile }) => profile) }
          : {}),
      },
    },
  );
}
if (fleetEnabled) {
  if (process.env.MERV_SANDBOXES_URL === undefined) {
    throw new Error('Fleet requires MERV_SANDBOXES_URL');
  }
  const managedSecretEnv = envName('MERV_FLEET_MANAGED_SECRET_ENV');
  if (Buffer.byteLength(process.env[managedSecretEnv] ?? '') < 32) {
    throw new Error('Fleet managed secret is unavailable');
  }
  // With Fleet serving every project, a project nobody has switched runs its work (the ruling).
  set('sessions', { managedSecretEnv, ...(workflowEnabled && { dispatchByDefault: true }) });
  // Caps that replace the project limit for the named projects, such as the Pi host's.
  const projectLimits =
    process.env.MERV_FLEET_PROJECT_LIMITS === undefined ? {} : json('MERV_FLEET_PROJECT_LIMITS');
  if (
    typeof projectLimits !== 'object' ||
    !projectLimits ||
    Array.isArray(projectLimits) ||
    Object.keys(projectLimits).length > 256 ||
    Object.entries(projectLimits).some(
      ([projectId, limit]) =>
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(projectId) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 64,
    )
  ) {
    throw new Error('Invalid MERV_FLEET_PROJECT_LIMITS');
  }
  // Owners that rent in the host rent through its connection: by default the Pi host's.
  const host = process.env.MERV_FLEET_HOST_PROJECT_ID ?? process.env.MERV_PI_HOST_PROJECT_ID;
  if (host !== undefined && !connections.some((entry) => entry.projectId === host)) {
    throw new Error('Fleet host project has no sandbox connection');
  }
  config.plugins.push(
    { id: 'fleet-tools', name: '@merv/fleet/tools' },
    { id: 'fleet-ui', name: '@merv/fleet/ui', required: false },
    {
      id: 'fleet',
      name: '@merv/fleet',
      config: {
        enabled: true,
        globalLimit: integer('MERV_FLEET_GLOBAL_LIMIT', 50, 1, 64),
        projectLimit: integer('MERV_FLEET_PROJECT_LIMIT', 5, 1, 64),
        projectLimits,
        allocationTimeoutSeconds: integer(
          'MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS',
          86_400,
          60,
          86_400,
        ),
        ...(host !== undefined && { hostProjectId: host }),
      },
    },
  );
  if (workflowEnabled) {
    // Only these sign-in identities' choice of Fleet is served; '*' once sign-up is closed.
    const people = json('MERV_FLEET_WORKFLOW_PEOPLE');
    if (
      !Array.isArray(people) ||
      !people.length ||
      people.some((person) => typeof person !== 'string' || !/^(\*|\S+ \S+)$/.test(person))
    ) {
      throw new Error('Invalid MERV_FLEET_WORKFLOW_PEOPLE');
    }
    const modelApiKeyEnv = envName('MERV_FLEET_WORKFLOW_MODEL_API_KEY_ENV');
    if (!process.env[modelApiKeyEnv]) throw new Error('Fleet workflow credential is unavailable');
    config.plugins.push({
      id: 'fleet-workflow',
      name: '@merv/fleet/workflow',
      config: {
        enabled: true,
        people,
        modelApiKeyEnv,
        baseUrl: httpsOrigin('MERV_FLEET_WORKFLOW_BASE_URL'),
        maxAgents: integer('MERV_FLEET_WORKFLOW_MAX_AGENTS', 10, 1, 64),
        dailyTokensPerPerson: integer(
          'MERV_FLEET_WORKFLOW_DAILY_TOKENS_PER_PERSON',
          20_000_000,
          1,
          1_000_000_000,
        ),
      },
    });
  }
}
if (piEnabled) {
  const secretEnv = envName('MERV_PI_SECRET_ENV');
  const modelApiKeyEnv = envName('MERV_PI_MODEL_API_KEY_ENV');
  if (
    Buffer.byteLength(process.env[secretEnv] ?? '') < 32 ||
    !process.env[modelApiKeyEnv]?.trim()
  ) {
    throw new Error('Pi credentials are unavailable');
  }
  // One operator-owned project rents every Pi machine with its own service key and Sandboxes
  // connection; each turn's reads still run as the person who sent it.
  const hostProjectId = required('MERV_PI_HOST_PROJECT_ID');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(hostProjectId)) {
    throw new Error('Invalid MERV_PI_HOST_PROJECT_ID');
  }
  if (!connections.some((entry) => entry.projectId === hostProjectId)) {
    throw new Error('Pi host project has no sandbox connection');
  }
  const hostKeyEnv = envName('MERV_PI_HOST_KEY_ENV');
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(process.env[hostKeyEnv] ?? '')) {
    throw new Error(`Missing or invalid ${hostKeyEnv}`);
  }
  const runtimeKey = process.env.MERV_PI_RUNTIME_KEY ?? 'project';
  if (!['project', 'person'].includes(runtimeKey)) throw new Error('Invalid MERV_PI_RUNTIME_KEY');
  config.plugins.push(
    { id: 'pi-tools', name: '@merv/pi/tools' },
    { id: 'pi-api', name: '@merv/pi/api' },
    { id: 'pi-ui', name: '@merv/pi/ui', required: false },
    {
      id: 'pi',
      name: '@merv/pi',
      config: {
        enabled: true,
        secretEnv,
        modelApiKeyEnv,
        // Checked as Main checks it, so a dry run catches what would stop Main; the older
        // MERV_PI_MODEL is ignored.
        ...(process.env.MERV_PI_MODELS !== undefined && {
          models: piModels(json('MERV_PI_MODELS'), 'MERV_PI_MODELS'),
        }),
        baseUrl: httpsOrigin('MERV_TS_PUBLIC_ORIGIN'),
        turnTimeoutSeconds: integer('MERV_PI_TURN_TIMEOUT_SECONDS', 300, 10, 900),
        idleTimeoutSeconds: integer('MERV_PI_IDLE_TIMEOUT_SECONDS', 600, 5, 3600),
        runtimeKey,
        host: { projectId: hostProjectId, credentialEnv: hostKeyEnv },
        machines: runtimes.map(({ key, label, slots, agent }) => ({ key, label, slots, agent })),
        agentMoves: optIn('MERV_PI_AGENT_MOVES'),
      },
    },
  );
}
const legacySourceId = process.env.MERV_TS_LEGACY_SOURCE_ID;
if (legacySourceId !== undefined) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(legacySourceId)) {
    throw new Error('Invalid MERV_TS_LEGACY_SOURCE_ID');
  }
  config.plugins.push({
    id: 'legacy-history-ui',
    name: new URL('../dist/src/legacy-history-ui.js', import.meta.url).href,
    config: { sourceId: legacySourceId },
  });
}
writeFileSync(process.argv[2] ?? '/tmp/merv-config.json', JSON.stringify(config), { mode: 0o600 });
