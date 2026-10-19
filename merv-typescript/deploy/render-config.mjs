import { readFileSync, writeFileSync } from 'node:fs';
import { deploymentSchema, fleetRuntimes, piModels } from './schema.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value?.trim() || value.trim() !== value) throw new Error(`Missing or invalid ${name}`);
  return value;
};
const origin = (name, protocol = 'https:') => {
  const value = required(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
  if (url.protocol !== protocol || url.origin !== value) throw new Error(`Invalid ${name}`);
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
const sandboxesEnabled = !!process.env.SANDBOXES_DATABASE_URL;
const fleetEnabled = sandboxesEnabled && optIn('MERV_FLEET_ENABLED');
const workflowEnabled = sandboxesEnabled && optIn('MERV_FLEET_WORKFLOW_ENABLED');
// MERV_FLEET_WORKFLOW_REUSE_WORK_HOSTS and MERV_FLEET_WORKFLOW_REUSABLE_RUNTIME_PROFILE_IDS are
// ignored, whatever their value: every workflow machine is a work host, and the hosted release's
// workflow gate proves each image can be one before it is switched in (PI_OPERATIONS.md).
const piEnabled = sandboxesEnabled && optIn('MERV_PI_ENABLED');
const customerExperimentsEnabled = optIn('MERV_CUSTOMER_EXPERIMENTS_ENABLED');
if (customerExperimentsEnabled && (!piEnabled || !workflowEnabled))
  throw new Error('Customer experiments require Pi and Fleet workflow');
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
  ...(sandboxesEnabled ? ['SANDBOXES_DATABASE_URL', 'SANDBOXES_VAULT_KEY'] : []),
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
set('secrets', {
  encryptionKeyEnv: 'MERV_SECRETS_ENCRYPTION_KEY',
  huggingFaceEndpoint: `${origin('MERV_TS_PUBLIC_ORIGIN')}/hf`,
});
const projectInvitations = optIn('MERV_PROJECT_INVITATIONS');
if (projectInvitations) {
  required('SUPABASE_SERVICE_KEY');
  const resendKeyEnv = process.env.MERV_INVITATION_RESEND_KEY_ENV
    ? envName('MERV_INVITATION_RESEND_KEY_ENV')
    : 'RESEND_API_KEY';
  required(resendKeyEnv);
  set('scope-api', {
    invitations: {
      apiKeyEnv: resendKeyEnv,
      from: process.env.MERV_INVITATION_FROM?.trim() || 'Merv <invites@rapidreview.io>',
      publicOrigin: origin('MERV_TS_PUBLIC_ORIGIN'),
    },
  });
}
set('identity', {
  supabaseUrl: origin('SUPABASE_URL'),
  mode,
  publishableKeyEnv: 'SUPABASE_ANON_KEY',
  ...(projectInvitations ? { directoryKeyEnv: 'SUPABASE_SERVICE_KEY' } : {}),
  ...(mode === 'hs256' ? { secretEnv: 'SUPABASE_JWT_SECRET' } : {}),
});
set('api', {
  host: '0.0.0.0',
  port: 3081,
  allowedOrigins: [origin('MERV_TS_PUBLIC_ORIGIN')],
});
// The served UI bundle: on a VM the directory both release scripts write, else the image's own.
const uiAssets = process.env.MERV_UI_ASSETS;
if (uiAssets !== undefined && !/^\/[\w./-]*\/$/.test(uiAssets))
  throw new Error('Invalid MERV_UI_ASSETS');
set('ui', uiAssets ? { assets: uiAssets } : {});
set('admin', { admins: process.env.MERV_ADMIN_IDENTITIES ? json('MERV_ADMIN_IDENTITIES') : [] });
// Code keeps one Git repository per project beside the state, on the data volume: /tmp is a
// small tmpfs, and the repositories must survive the container.
set('code', { repositories: { root: '/var/lib/merv-ts/code' } });
// Accepted work lands on Merv's main in projects without GitHub, once this is `on`.
const landing = process.env.MERV_CODE_MAIN_LANDING;
if (landing !== undefined && !['on', 'off'].includes(landing))
  throw new Error('Invalid MERV_CODE_MAIN_LANDING');
set('code-work', landing === 'on' ? { mainLanding: true } : {});
// Code's HTTP routes: without them a deployment that runs Code serves no /code at all.
set('code-work-api', {});
// Positive USD, to 6 places, each verified person's own Sandboxes account is granted once per
// provider; none if unset.
const newPersonCredits =
  process.env.MERV_NEW_PERSON_CREDITS === undefined ? {} : json('MERV_NEW_PERSON_CREDITS');
if (
  typeof newPersonCredits !== 'object' ||
  !newPersonCredits ||
  Array.isArray(newPersonCredits) ||
  Object.entries(newPersonCredits).some(
    ([provider, usd]) =>
      !/^[a-z][a-z0-9_-]{0,63}$/.test(provider) ||
      !/^(?=.*[1-9])\d{1,9}(\.\d{1,6})?$/.test(typeof usd === 'string' ? usd : ''),
  )
)
  throw new Error('Invalid MERV_NEW_PERSON_CREDITS');
if (sandboxesEnabled)
  config.plugins.push(
    {
      id: 'sandboxes-host',
      name: '@merv/sandboxes/host',
      config: {
        databaseUrlEnv: 'SANDBOXES_DATABASE_URL',
        schema: 'public',
        vaultKeyEnv: 'SANDBOXES_VAULT_KEY',
        dataDir: '/data',
        publicOrigin: 'https://sandboxes.rapidreview.io',
        registerUi: true,
        registerTools: true,
        relayEvents: true,
        // The console's Providers page offers these top-ups, the only amounts Merv sells.
        ...(process.env.MERV_CUSTOMER_STRIPE_SECRET_KEY !== undefined && {
          settings: { console: { top_ups: [25, 50, 100, 250] } },
        }),
      },
    },
    {
      id: 'sandboxes-integration',
      name: '@merv/sandboxes/integration',
      config: { legacyCaptures: { namespace: 'merv-ml' }, newPersonCredits },
    },
    {
      id: 'sandboxes-console',
      name: '@merv/sandboxes/console',
      config: { upstream: origin('MERV_SANDBOXES_PROXY_URL', 'http:') },
    },
  );
let runtimes = [];
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
  // Host rentals default to Pi's linked project.
  const host = process.env.MERV_FLEET_HOST_PROJECT_ID ?? process.env.MERV_PI_HOST_PROJECT_ID;
  config.plugins.push(
    { id: 'fleet-tools', name: '@merv/fleet/tools' },
    { id: 'fleet-ui', name: '@merv/fleet/ui', required: false },
    {
      id: 'fleet',
      name: '@merv/fleet',
      config: {
        profiles: runtimes.map(({ label, slots, agent, ...profile }) => profile),
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
        // Founder ruling 2026-09-25: $20 of machines per person per day, Agent machines included.
        dailyUsdPerPerson: integer('MERV_FLEET_DAILY_USD_PER_PERSON', 20, 1, 100_000),
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
        ...(customerExperimentsEnabled && { astraMediumEnabled: true }),
        people,
        modelApiKeyEnv,
        baseUrl: origin('MERV_FLEET_WORKFLOW_BASE_URL'),
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
  // link; each turn's reads still run as the person who sent it.
  const hostProjectId = required('MERV_PI_HOST_PROJECT_ID');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(hostProjectId)) {
    throw new Error('Invalid MERV_PI_HOST_PROJECT_ID');
  }
  const hostKeyEnv = envName('MERV_PI_HOST_KEY_ENV');
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(process.env[hostKeyEnv] ?? '')) {
    throw new Error(`Missing or invalid ${hostKeyEnv}`);
  }
  config.plugins.push(
    { id: 'pi-tools', name: '@merv/pi/tools' },
    { id: 'pi-api', name: '@merv/pi/api' },
    { id: 'pi-ui', name: '@merv/pi/ui', required: false },
    {
      id: 'pi',
      name: '@merv/pi',
      config: {
        secretEnv,
        modelApiKeyEnv,
        // Checked as Main checks it, so a dry run catches what would stop Main; the older
        // MERV_PI_MODEL is ignored.
        ...(process.env.MERV_PI_MODELS !== undefined && {
          models: piModels(json('MERV_PI_MODELS'), 'MERV_PI_MODELS'),
        }),
        baseUrl: origin('MERV_TS_PUBLIC_ORIGIN'),
        turnTimeoutSeconds: integer('MERV_PI_TURN_TIMEOUT_SECONDS', 300, 10, 900),
        idleTimeoutSeconds: integer('MERV_PI_IDLE_TIMEOUT_SECONDS', 600, 5, 3600),
        host: { projectId: hostProjectId, credentialEnv: hostKeyEnv },
        machines: runtimes.map(({ key, label, slots, agent }) => ({ key, label, slots, agent })),
        agentMoves: optIn('MERV_PI_AGENT_MOVES'),
      },
    },
  );
}
// Internet search for every agent, as Nisa's agents search: Tavily, then OpenAI's hosted web
// search when Tavily refuses. Absent until the operator installs a key, so a deployment without
// one composes exactly the plugins it composed before.
const webFallbackKeyEnv = process.env.MERV_WEB_FALLBACK_KEY_ENV;
if (process.env.MERV_TAVILY_API_KEY || webFallbackKeyEnv !== undefined) {
  const tavily = process.env.MERV_TAVILY_API_KEY;
  if (tavily !== undefined && tavily !== '' && !/^tvly-[A-Za-z0-9_-]{8,256}$/.test(tavily)) {
    throw new Error('Missing or invalid MERV_TAVILY_API_KEY');
  }
  let fallback;
  if (webFallbackKeyEnv !== undefined) {
    // Only a name: MERV_PI_MODEL_API_KEY spends Pi's key, or name one of the fallback's own.
    const keyEnv = envName('MERV_WEB_FALLBACK_KEY_ENV');
    if (!process.env[keyEnv]?.trim()) throw new Error('Web search fallback key is unavailable');
    const model = process.env.MERV_WEB_FALLBACK_MODEL;
    if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
      throw new Error('Invalid MERV_WEB_FALLBACK_MODEL');
    }
    fallback = { keyEnv, ...(model !== undefined && { model }) };
  }
  config.plugins.push(
    { id: 'web-tools', name: '@merv/web/tools' },
    {
      id: 'web',
      name: '@merv/web',
      config: {
        keyEnv: 'MERV_TAVILY_API_KEY',
        ...(fallback && { fallback }),
        maxInFlight: integer('MERV_WEB_MAX_IN_FLIGHT', 8, 1, 64),
        dailyCallsPerProject: integer('MERV_WEB_DAILY_CALLS_PER_PROJECT', 200, 1, 100_000),
        // Projects are free to make: the deployment's day is what bounds the spend.
        dailyCalls: integer('MERV_WEB_DAILY_CALLS', 1000, 1, 1_000_000),
        ...(fallback && {
          fallbackDailyCalls: integer('MERV_WEB_FALLBACK_DAILY_CALLS', 200, 1, 1_000_000),
        }),
      },
    },
  );
}
// Nisa's literature search (nisa.*) for every agent, over Nisa's public API with the deployment's
// one rr_sk_ key. Absent until the operator installs the key, like web search.
const nisaKey = process.env.MERV_NISA_API_KEY;
if (nisaKey) {
  if (!/^rr_sk_[A-Za-z0-9_-]{32,128}$/.test(nisaKey)) {
    throw new Error('Missing or invalid MERV_NISA_API_KEY');
  }
  config.plugins.push(
    { id: 'nisa-tools', name: '@merv/nisa/tools' },
    {
      id: 'nisa',
      name: '@merv/nisa',
      config: {
        keyEnv: 'MERV_NISA_API_KEY',
        ...(process.env.MERV_NISA_ORIGIN !== undefined && {
          origin: origin('MERV_NISA_ORIGIN'),
        }),
      },
    },
  );
}
// Stripe for every plugin that sells, under the names production first gave customer checkout.
const livePayments = optIn('MERV_CUSTOMER_STRIPE_LIVE');
if (process.env.MERV_CUSTOMER_STRIPE_SECRET_KEY !== undefined) {
  required('MERV_CUSTOMER_STRIPE_WEBHOOK_SECRET');
  config.plugins.push({
    id: 'payments',
    name: '@merv/payments',
    config: {
      secretKeyEnv: 'MERV_CUSTOMER_STRIPE_SECRET_KEY',
      webhookSecretEnv: 'MERV_CUSTOMER_STRIPE_WEBHOOK_SECRET',
      live: livePayments,
      publicOrigin: origin('MERV_TS_PUBLIC_ORIGIN'),
    },
  });
}
if (customerExperimentsEnabled) {
  if (!sandboxesEnabled)
    throw new Error('Customer experiments require native Sandboxes with managed ML funding');
  const models = piModels(json('MERV_PI_MODELS'), 'MERV_PI_MODELS');
  if (!models.some((model) => model.id === 'gpt-6-astra'))
    throw new Error('Customer experiments require gpt-6-astra in MERV_PI_MODELS');
  const sponsor = {
    issuer: required('MERV_CUSTOMER_SPONSOR_ISSUER'),
    subject: required('MERV_CUSTOMER_SPONSOR_SUBJECT'),
  };
  const people = json('MERV_FLEET_WORKFLOW_PEOPLE');
  if (!people.includes('*') && !people.includes(`${sponsor.issuer} ${sponsor.subject}`))
    throw new Error('Customer sponsor must be served by Fleet workflow');
  for (const name of ['MERV_CUSTOMER_ACCESS_KEY', 'MERV_CUSTOMER_INTAKE_KEY'])
    if (Buffer.byteLength(required(name)) < 32)
      throw new Error(`${name} requires at least 32 bytes`);
  const customer = {
    publicOrigin: origin('MERV_TS_PUBLIC_ORIGIN'),
    sponsor,
    computeProjectId: required('MERV_CUSTOMER_COMPUTE_PROJECT_ID'),
    computeBudgetUsd:
      process.env.MERV_CUSTOMER_COMPUTE_BUDGET_USD === undefined
        ? null
        : integer('MERV_CUSTOMER_COMPUTE_BUDGET_USD', 1000, 1, 100000),
    computeProviders: json('MERV_CUSTOMER_COMPUTE_PROVIDERS'),
    publicIntake: process.env.MERV_CUSTOMER_PUBLIC_INTAKE === 'true',
    maxRequestsPerDay: integer('MERV_CUSTOMER_REQUESTS_PER_DAY', 25, 1, 1000),
  };
  if (process.env.MERV_CUSTOMER_DATA_ENDPOINT !== undefined) {
    required('MERV_CUSTOMER_DATA_ACCESS_KEY_ID');
    required('MERV_CUSTOMER_DATA_SECRET_ACCESS_KEY');
    customer.storage = {
      endpoint: origin('MERV_CUSTOMER_DATA_ENDPOINT'),
      region: process.env.MERV_CUSTOMER_DATA_REGION ?? 'us-east-1',
      bucketPrefix: required('MERV_CUSTOMER_DATA_BUCKET_PREFIX'),
      accessKeyIdEnv: 'MERV_CUSTOMER_DATA_ACCESS_KEY_ID',
      secretAccessKeyEnv: 'MERV_CUSTOMER_DATA_SECRET_ACCESS_KEY',
    };
  }
  if (process.env.MERV_CUSTOMER_RESEND_KEY !== undefined) {
    customer.email = { from: required('MERV_CUSTOMER_EMAIL_FROM') };
  }
  if (process.env.MERV_CUSTOMER_STRIPE_SECRET_KEY !== undefined && livePayments && !customer.email)
    throw new Error('Live customer checkout requires a results email sender');
  config.plugins.push({
    id: 'customer-experiments',
    name: '@merv/customer-experiments',
    config: customer,
  });
}
const legacySourceId = process.env.MERV_TS_LEGACY_SOURCE_ID;
if (legacySourceId !== undefined) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(legacySourceId)) {
    throw new Error('Invalid MERV_TS_LEGACY_SOURCE_ID');
  }
  config.plugins.push(
    { id: 'legacy-history', name: '@merv/legacy-history' },
    {
      id: 'legacy-history-ui',
      name: '@merv/legacy-history/ui',
      config: { sourceId: legacySourceId },
    },
  );
}
writeFileSync(process.argv[2] ?? '/tmp/merv-config.json', JSON.stringify(config), { mode: 0o600 });
