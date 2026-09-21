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
// Rows and acts published by merv-sandboxes. Absent until the operator names the service, so
// a deployment that has not connected one composes exactly the plugins it composed before.
if (process.env.MERV_SANDBOXES_URL !== undefined) {
  httpsOrigin('MERV_SANDBOXES_URL');
  const connections = sandboxConnections();
  config.plugins.push(
    { id: 'sandboxes-tools', name: '@merv/sandboxes/tools' },
    { id: 'sandboxes-ui', name: '@merv/sandboxes/ui', required: false },
    {
      id: 'sandboxes',
      name: '@merv/sandboxes',
      // Only names: the origin and each project's consumer grant stay in the environment.
      config: { urlEnv: 'MERV_SANDBOXES_URL', connections },
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
