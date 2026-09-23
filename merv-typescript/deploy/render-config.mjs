import { readFileSync, writeFileSync } from 'node:fs';
import { deploymentSchema, sandboxConnections } from './schema.mjs';

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
const fleetEnabled = optIn('MERV_FLEET_ENABLED');
const workflowEnabled = optIn('MERV_FLEET_WORKFLOW_ENABLED');
if (workflowEnabled && !fleetEnabled) throw new Error('Fleet workflow requires MERV_FLEET_ENABLED');
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
if (process.env.MERV_SANDBOXES_URL !== undefined) {
  httpsOrigin('MERV_SANDBOXES_URL');
  const connections = sandboxConnections();
  let runtime;
  if (fleetEnabled) {
    const provider = required('MERV_FLEET_RUNTIME_PROVIDER');
    const offerId = required('MERV_FLEET_RUNTIME_OFFER_ID');
    const releaseId = required('MERV_FLEET_RUNTIME_RELEASE_ID');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) {
      throw new Error('Invalid MERV_FLEET_RUNTIME_PROVIDER');
    }
    if (offerId.length > 256) throw new Error('Invalid MERV_FLEET_RUNTIME_OFFER_ID');
    if (!/^rt1_[0-9a-f]{64}$/.test(releaseId)) {
      throw new Error('Invalid MERV_FLEET_RUNTIME_RELEASE_ID');
    }
    runtime = {
      provider,
      offerId,
      releaseId,
      leaseSeconds: integer('MERV_FLEET_RUNTIME_LEASE_SECONDS', undefined, 60, 86_400),
    };
    if (runtime.leaseSeconds === undefined) {
      throw new Error('Missing MERV_FLEET_RUNTIME_LEASE_SECONDS');
    }
  }
  config.plugins.push(
    { id: 'sandboxes-tools', name: '@merv/sandboxes/tools' },
    { id: 'sandboxes-ui', name: '@merv/sandboxes/ui', required: false },
    {
      id: 'sandboxes',
      name: '@merv/sandboxes',
      // Only names: the origin and each project's consumer grant stay in the environment.
      config: { urlEnv: 'MERV_SANDBOXES_URL', connections, ...(runtime ? { runtime } : {}) },
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
  set('sessions', { managedSecretEnv });
  config.plugins.push(
    { id: 'fleet-tools', name: '@merv/fleet/tools' },
    { id: 'fleet-ui', name: '@merv/fleet/ui', required: false },
    {
      id: 'fleet',
      name: '@merv/fleet',
      config: {
        enabled: true,
        globalLimit: integer('MERV_FLEET_GLOBAL_LIMIT', 3, 1, 32),
        projectLimit: integer('MERV_FLEET_PROJECT_LIMIT', 1, 1, 32),
      },
    },
  );
  if (workflowEnabled) {
    const projectId = required('MERV_FLEET_WORKFLOW_PROJECT_ID');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(projectId)) {
      throw new Error('Invalid MERV_FLEET_WORKFLOW_PROJECT_ID');
    }
    const connections = config.plugins.find((entry) => entry.id === 'sandboxes').config.connections;
    if (!connections.some((entry) => entry.projectId === projectId)) {
      throw new Error('Fleet workflow project has no sandbox connection');
    }
    const sourceCredentialEnv = envName('MERV_FLEET_WORKFLOW_SOURCE_CREDENTIAL_ENV');
    const modelApiKeyEnv = envName('MERV_FLEET_WORKFLOW_MODEL_API_KEY_ENV');
    for (const name of [sourceCredentialEnv, modelApiKeyEnv]) {
      if (!process.env[name]) throw new Error('Fleet workflow credential is unavailable');
    }
    config.plugins.push({
      id: 'fleet-workflow',
      name: '@merv/fleet/workflow',
      config: {
        enabled: true,
        projectId,
        sourceCredentialEnv,
        modelApiKeyEnv,
        baseUrl: httpsOrigin('MERV_FLEET_WORKFLOW_BASE_URL'),
      },
    });
  }
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
