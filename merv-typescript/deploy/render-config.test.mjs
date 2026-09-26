import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const env = {
  MERV_TS_AUTH_MODE: 'hs256',
  MERV_BLOB_PREFIX: 'merv-ts',
  MERV_DB_URL: 'postgresql://unused',
  MERV_BLOB_BUCKET: 'unused',
  MERV_BLOB_ENDPOINT_URL: 'https://storage.example',
  MERV_BLOB_ACCESS_KEY_ID: 'fixture',
  MERV_BLOB_SECRET_ACCESS_KEY: 'fixture',
  SUPABASE_ANON_KEY: 'fixture',
  SUPABASE_JWT_SECRET: 'fixture',
  SUPABASE_URL: 'https://identity.example',
  MERV_TS_PUBLIC_ORIGIN: 'https://merv.example',
};
const connected = {
  MERV_SANDBOXES_URL: 'https://sandboxes.example',
  MERV_SANDBOXES_CONNECTIONS: JSON.stringify([
    { projectId: 'project_1', namespace: 'research', tokenEnv: 'SANDBOX_GRANT' },
  ]),
  SANDBOX_GRANT: 'sbxt_fixture',
};
const fleet = {
  ...connected,
  MERV_FLEET_ENABLED: 'true',
  MERV_FLEET_RUNTIME_PROVIDER: 'cloudflare',
  MERV_FLEET_RUNTIME_OFFER_ID: 'standard-1:cloudflare',
  MERV_FLEET_RUNTIME_RELEASE_ID: `rt1_${'a'.repeat(64)}`,
  MERV_FLEET_RUNTIME_LEASE_SECONDS: '900',
  MERV_FLEET_MANAGED_SECRET_ENV: 'MANAGED_SECRET',
  MANAGED_SECRET: 's'.repeat(32),
};
const pi = {
  ...fleet,
  MERV_SANDBOXES_CONNECTIONS: JSON.stringify([
    { projectId: 'project_1', namespace: 'research', tokenEnv: 'SANDBOX_GRANT' },
    { projectId: 'project_host', namespace: 'merv-pi-host', tokenEnv: 'HOST_GRANT' },
  ]),
  HOST_GRANT: 'sbxt_host_fixture',
  MERV_PI_ENABLED: 'true',
  MERV_PI_SECRET_ENV: 'PI_PRIVATE_SECRET',
  MERV_PI_MODEL_API_KEY_ENV: 'PI_PROVIDER_KEY',
  PI_PRIVATE_SECRET: 'p'.repeat(40),
  PI_PROVIDER_KEY: 'fixture-provider-key',
  MERV_PI_HOST_PROJECT_ID: 'project_host',
  MERV_PI_HOST_KEY_ENV: 'PI_HOST_KEY',
  PI_HOST_KEY: 'h'.repeat(43),
};

test('ML config renders only a valid consumer grant, switch-on time, and optional storage origin', (t) => {
  const { run, plugin } = renderer(t);
  assert.equal(run(connected).status, 0);
  assert.equal(plugin('sandboxes').config.ml, undefined);
  const ml = {
    ...connected,
    MERV_SANDBOXES_ML_NAMESPACE: 'merv-ml',
    MERV_SANDBOXES_ML_TOKEN: 'sbxt_fixture_ml',
    MERV_SANDBOXES_ML_SINCE: '2026-09-25T12:00:00+00:00',
    MERV_SANDBOXES_ML_STORAGE_ORIGIN: 'https://objects.example',
  };
  assert.equal(run(ml).status, 0);
  assert.deepEqual(plugin('sandboxes').config.ml, {
    namespace: 'merv-ml',
    tokenEnv: 'MERV_SANDBOXES_ML_TOKEN',
    since: ml.MERV_SANDBOXES_ML_SINCE,
    storageOrigins: ['https://objects.example'],
  });
  for (const invalid of [
    { MERV_SANDBOXES_ML_TOKEN: 'bad' },
    { MERV_SANDBOXES_ML_SINCE: 'yesterday' },
    { MERV_SANDBOXES_ML_STORAGE_ORIGIN: 'http://objects.example' },
  ])
    assert.notEqual(run({ ...ml, ...invalid }).status, 0);
});

/** render-config.mjs beside a fixture default.json, run with `env` plus the given variables. */
function renderer(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'merv-render-config-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'deploy'));
  mkdirSync(join(directory, 'dist/config'), { recursive: true });
  for (const name of ['render-config.mjs', 'schema.mjs'])
    copyFileSync(new URL(name, import.meta.url), join(directory, 'deploy', name));
  writeFileSync(
    join(directory, 'dist/config/default.json'),
    JSON.stringify({
      plugins: 'state scope blobs identity api ui code code-research sessions'
        .split(' ')
        .map((id) => ({ id, name: id })),
    }),
  );
  const output = join(directory, 'rendered.json');
  const run = (extra = {}) =>
    spawnSync(process.execPath, [join(directory, 'deploy/render-config.mjs'), output], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  const plugin = (id) => JSON.parse(readFileSync(output)).plugins.find((p) => p.id === id);
  return { directory, output, run, plugin };
}

test('deployment config keeps history opt-in and binds a validated isolated schema/source', (t) => {
  const { directory, output, run } = renderer(t);
  assert.equal(run().status, 0);
  let config = JSON.parse(readFileSync(output));
  assert.equal(config.plugins.length, 9);
  assert.deepEqual(config.plugins.find((p) => p.id === 'code').config, {
    repositories: { root: '/var/lib/merv-ts/code' },
  });
  assert.equal(config.plugins.find((p) => p.id === 'code-research').required, true);
  assert.equal(config.plugins.find((p) => p.id === 'state').config.schema, 'merv_ts');
  assert.equal(statSync(output).mode & 0o077, 0);
  assert.equal(
    run({ MERV_TS_DB_SCHEMA: 'merv_ts_rehearsal', MERV_TS_LEGACY_SOURCE_ID: 'source-v2' }).status,
    0,
  );
  config = JSON.parse(readFileSync(output));
  assert.equal(config.plugins.length, 10);
  assert.equal(config.plugins.find((p) => p.id === 'state').config.schema, 'merv_ts_rehearsal');
  const history = config.plugins.find((p) => p.id === 'legacy-history-ui');
  assert.deepEqual(history.config, { sourceId: 'source-v2' });
  assert.equal(history.name, pathToFileURL(join(directory, 'dist/src/legacy-history-ui.js')).href);
  assert.notEqual(run({ MERV_TS_DB_SCHEMA: 'public' }).status, 0);
  assert.notEqual(run({ MERV_TS_LEGACY_SOURCE_ID: '../source' }).status, 0);

  assert.equal(run(connected).status, 0);
  config = JSON.parse(readFileSync(output));
  assert.equal(config.plugins.length, 12);
  assert.equal(config.plugins.find((p) => p.id === 'sandboxes').config.runtimes, undefined);
  assert.equal(
    config.plugins.find((p) => p.id === 'fleet'),
    undefined,
  );

  const projectConnections = (count) =>
    Array.from({ length: count }, (_, index) => ({
      projectId: `project_${index}`,
      namespace: `namespace_${index}`,
      tokenEnv: `SANDBOX_GRANT_${index}`,
    }));
  const listed = (connections) => ({
    ...connected,
    ...Object.fromEntries(connections.map((entry) => [entry.tokenEnv, 'sbxt_fixture'])),
    MERV_SANDBOXES_CONNECTIONS: JSON.stringify(connections),
  });
  for (const count of [33, 256]) {
    const connections = projectConnections(count);
    assert.equal(run(listed(connections)).status, 0);
    config = JSON.parse(readFileSync(output));
    assert.deepEqual(
      config.plugins.find((p) => p.id === 'sandboxes').config.connections,
      connections,
    );
  }
  for (const connections of [
    projectConnections(257),
    [...projectConnections(32), projectConnections(1)[0]],
  ]) {
    assert.notEqual(run(listed(connections)).status, 0);
  }
  // A connection whose grant variable is unset, empty or not a grant fails the render, naming
  // only the variable, instead of starting healthy and wedging the first send.
  for (const [broken, name] of [
    [{ SANDBOX_GRANT: undefined }, 'SANDBOX_GRANT'],
    [{ SANDBOX_GRANT: '' }, 'SANDBOX_GRANT'],
    [{ SANDBOX_GRANT: "'sbxt_quoted'" }, 'SANDBOX_GRANT'],
    [{ ...listed(projectConnections(2)), SANDBOX_GRANT_1: 'secret-value' }, 'SANDBOX_GRANT_1'],
  ]) {
    const result = run({ ...connected, ...broken });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Error: Missing or invalid ${name}\\n`));
    assert.ok(!/sbxt_quoted|secret-value/.test(result.stderr));
  }

  assert.equal(run(fleet).status, 0);
  assert.notEqual(run({ MERV_PI_ENABLED: 'true' }).status, 0);
  assert.notEqual(run({ ...fleet, MERV_PI_ENABLED: 'true' }).status, 0);
  assert.equal(run(pi).status, 0);
  const piConfig = JSON.parse(readFileSync(output));
  assert.equal(JSON.stringify(piConfig).includes(pi.PI_PRIVATE_SECRET), false);
  assert.equal(JSON.stringify(piConfig).includes(pi.PI_PROVIDER_KEY), false);
  assert.ok(piConfig.plugins.some((entry) => entry.id === 'pi-api'));
  assert.ok(piConfig.plugins.some((entry) => entry.id === 'pi-ui'));
  // The catalog is checked as Main checks it, so a dry run refuses what would stop Main; the
  // older single model is ignored.
  const models = [
    {
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      inputUsdPerM: 0.1,
      outputUsdPerM: 0.5,
      effort: 'none',
    },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', inputUsdPerM: 2, outputUsdPerM: 10, effort: 'none' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', inputUsdPerM: 10, outputUsdPerM: 50, effort: 'low' },
  ];
  assert.equal(run({ ...pi, MERV_PI_MODELS: JSON.stringify(models) }).status, 0);
  const rendered = JSON.parse(readFileSync(output)).plugins.find((p) => p.id === 'pi').config;
  assert.deepEqual(rendered.models, models);
  assert.notEqual(run({ ...pi, MERV_PI_MODELS: 'gpt-6-sol' }).status, 0);
  const [luna] = models;
  for (const catalog of [
    [],
    [{ ...luna, effort: 'medium' }],
    [{ ...luna, label: 'GPT-6 Luna, the quick one' }],
    [{ ...luna, id: '-luna' }],
    [{ ...luna, inputUsdPerM: '0.1' }],
    [{ ...luna, provider: 'openai' }],
    [luna, luna],
    Array.from({ length: 9 }, (_, index) => ({ ...luna, id: `model-${index}` })),
  ]) {
    const refused = run({ ...pi, MERV_PI_MODELS: JSON.stringify(catalog) });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /MERV_PI_MODELS/);
  }
  assert.equal(run({ ...pi, MERV_PI_MODEL: 'https://untrusted.example' }).status, 0);
  assert.equal(
    'models' in JSON.parse(readFileSync(output)).plugins.find((p) => p.id === 'pi').config,
    false,
  );
  assert.equal(run(fleet).status, 0);
  config = JSON.parse(readFileSync(output));
  assert.deepEqual(config.plugins.find((p) => p.id === 'fleet').config, {
    enabled: true,
    globalLimit: 50,
    projectLimit: 5,
    projectLimits: {},
    allocationTimeoutSeconds: 86_400,
    dailyUsdPerPerson: 20,
  });
  assert.deepEqual(config.plugins.find((p) => p.id === 'sessions').config, {
    managedSecretEnv: 'MANAGED_SECRET',
  });
  assert.ok(config.plugins.some((p) => p.id === 'fleet-ui'));
  assert.ok(config.plugins.some((p) => p.id === 'fleet-tools'));
  assert.equal(
    config.plugins.find((p) => p.id === 'fleet-workflow'),
    undefined,
  );
  assert.ok(!readFileSync(output, 'utf8').includes(fleet.MANAGED_SECRET));
  assert.ok(!readFileSync(output, 'utf8').includes(fleet.SANDBOX_GRANT));

  const workflow = {
    ...fleet,
    MERV_FLEET_GLOBAL_LIMIT: '2',
    MERV_FLEET_PROJECT_LIMIT: '2',
    MERV_FLEET_WORKFLOW_ENABLED: 'true',
    MERV_FLEET_WORKFLOW_PEOPLE: JSON.stringify(['https://identity.example/auth/v1 founder']),
    MERV_FLEET_WORKFLOW_MODEL_API_KEY_ENV: 'MODEL_KEY',
    MERV_FLEET_WORKFLOW_BASE_URL: 'https://merv.example',
    MODEL_KEY: 'model-secret',
  };
  assert.equal(run(workflow).status, 0);
  config = JSON.parse(readFileSync(output));
  assert.equal(config.plugins.find((p) => p.id === 'sessions').config.dispatchByDefault, true);
  // A workflow machine may outlive Main, so no machine is leased for more than 15 minutes.
  const leases = config.plugins
    .find((p) => p.id === 'sandboxes')
    .config.runtimes.map((profile) => profile.leaseSeconds);
  assert.ok(leases.length && leases.every((seconds) => seconds <= 900), String(leases));
  assert.equal(run({ ...workflow, MERV_FLEET_RUNTIME_LEASE_SECONDS: '3600' }).status, 0);
  assert.equal(
    JSON.parse(readFileSync(output)).plugins.find((p) => p.id === 'sandboxes').config.runtimes[0]
      .leaseSeconds,
    900,
  );
  assert.equal(run(workflow).status, 0);
  config = JSON.parse(readFileSync(output));
  assert.deepEqual(config.plugins.find((p) => p.id === 'fleet').config, {
    enabled: true,
    globalLimit: 2,
    projectLimit: 2,
    projectLimits: {},
    allocationTimeoutSeconds: 86_400,
    dailyUsdPerPerson: 20,
  });
  assert.equal(run({ ...workflow, MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS: '1800' }).status, 0);
  config = JSON.parse(readFileSync(output));
  assert.equal(config.plugins.find((p) => p.id === 'fleet').config.allocationTimeoutSeconds, 1800);
  assert.deepEqual(config.plugins.find((p) => p.id === 'fleet-workflow').config, {
    enabled: true,
    people: ['https://identity.example/auth/v1 founder'],
    modelApiKeyEnv: 'MODEL_KEY',
    baseUrl: 'https://merv.example',
    maxAgents: 10,
    dailyTokensPerPerson: 20_000_000,
  });
  assert.ok(!readFileSync(output, 'utf8').includes(workflow.MODEL_KEY));
  // The retired single-project source is ignored if an old environment still names it.
  const retired = {
    MERV_FLEET_WORKFLOW_PROJECT_ID: 'project_1',
    MERV_FLEET_WORKFLOW_SOURCE_CREDENTIAL_ENV: 'WORKFLOW_SOURCE',
    WORKFLOW_SOURCE: 'source-secret',
  };
  const everyone = {
    MERV_FLEET_WORKFLOW_PEOPLE: '["*"]',
    MERV_FLEET_WORKFLOW_MAX_AGENTS: '64',
  };
  assert.equal(run({ ...workflow, ...retired, ...everyone }).status, 0);
  assert.ok(!readFileSync(output, 'utf8').includes(retired.WORKFLOW_SOURCE));
  config = JSON.parse(readFileSync(output));
  const { people, maxAgents } = config.plugins.find((p) => p.id === 'fleet-workflow').config;
  assert.deepEqual([people, maxAgents], [['*'], 64]);
  assert.notEqual(run({ ...workflow, MERV_FLEET_WORKFLOW_DAILY_TOKENS_PER_PERSON: '0' }).status, 0);
  for (const broken of [
    { MERV_FLEET_ENABLED: 'true' },
    { ...fleet, MERV_FLEET_RUNTIME_RELEASE_ID: 'latest' },
    { ...fleet, MERV_FLEET_RUNTIME_LEASE_SECONDS: '0' },
    { ...fleet, MERV_FLEET_RUNTIME_LEASE_SECONDS: undefined },
    { ...fleet, MERV_FLEET_GLOBAL_LIMIT: '65' },
    { ...fleet, MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS: '59' },
    { ...fleet, MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS: '86401' },
    { ...fleet, MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS: '1.5' },
    { ...fleet, MERV_FLEET_MANAGED_SECRET_ENV: 'bad-name' },
    { ...fleet, MANAGED_SECRET: 'short' },
    { ...fleet, MERV_FLEET_WORKFLOW_ENABLED: 'true' },
    { ...workflow, MERV_FLEET_WORKFLOW_PEOPLE: undefined },
    { ...workflow, MERV_FLEET_WORKFLOW_PEOPLE: '[]' },
    { ...workflow, MERV_FLEET_WORKFLOW_PEOPLE: '["founder"]' },
    { ...workflow, MERV_FLEET_WORKFLOW_PEOPLE: '*' },
    { ...workflow, MODEL_KEY: undefined },
    { ...workflow, MERV_FLEET_WORKFLOW_MAX_AGENTS: '0' },
    { ...workflow, MERV_FLEET_WORKFLOW_MAX_AGENTS: '65' },
  ]) {
    assert.notEqual(run(broken).status, 0);
  }
});

test('Pi rents its machines from one catalog in a connected host project', (t) => {
  const { output, run, plugin } = renderer(t);
  // The single-profile variables render as the Standard machine.
  const standard = {
    key: 'standard',
    provider: 'cloudflare',
    offerId: 'standard-1:cloudflare',
    releaseId: fleet.MERV_FLEET_RUNTIME_RELEASE_ID,
    leaseSeconds: 900,
  };
  assert.equal(run(pi).status, 0);
  assert.deepEqual(plugin('sandboxes').config.runtimes, [standard]);
  assert.deepEqual(plugin('pi').config, {
    enabled: true,
    secretEnv: 'PI_PRIVATE_SECRET',
    modelApiKeyEnv: 'PI_PROVIDER_KEY',
    baseUrl: 'https://merv.example',
    turnTimeoutSeconds: 300,
    idleTimeoutSeconds: 600,
    runtimeKey: 'project',
    host: { projectId: 'project_host', credentialEnv: 'PI_HOST_KEY' },
    machines: [{ key: 'standard', label: 'Standard', slots: 3, agent: false }],
    agentMoves: false,
  });
  assert.ok(!readFileSync(output, 'utf8').includes(pi.PI_HOST_KEY));
  // Fleet rents through Pi's host unless another connected project is named.
  assert.equal(plugin('fleet').config.hostProjectId, 'project_host');
  assert.equal(run({ ...fleet, MERV_FLEET_HOST_PROJECT_ID: 'project_1' }).status, 0);
  assert.equal(plugin('fleet').config.hostProjectId, 'project_1');

  // The catalog replaces the single-profile variables, which stay only for an older image.
  const large = {
    key: 'large',
    provider: 'cloudflare-fleet-large',
    offerId: 'standard-3:cloudflare',
    releaseId: `rt1_${'b'.repeat(64)}`,
    leaseSeconds: 900,
    ttlSeconds: 120,
  };
  const current = { ...standard, releaseId: `rt1_${'c'.repeat(64)}` };
  const catalog = [
    { ...current, label: 'Standard', slots: 3 },
    { ...large, label: 'Large', slots: 4, agent: true },
  ];
  const machines = {
    ...pi,
    MERV_FLEET_RUNTIMES: JSON.stringify(catalog),
    MERV_FLEET_PROJECT_LIMITS: '{"project_host":50}',
    MERV_PI_RUNTIME_KEY: 'person',
    MERV_PI_AGENT_MOVES: 'true',
  };
  assert.equal(run(machines).status, 0);
  assert.deepEqual(plugin('sandboxes').config.runtimes, [current, large]);
  assert.equal(plugin('sandboxes').config.runtime, undefined);
  assert.deepEqual(plugin('fleet').config.projectLimits, { project_host: 50 });
  assert.deepEqual(
    (({ runtimeKey, machines, agentMoves }) => ({ runtimeKey, machines, agentMoves }))(
      plugin('pi').config,
    ),
    {
      runtimeKey: 'person',
      machines: [
        { key: 'standard', label: 'Standard', slots: 3, agent: false },
        { key: 'large', label: 'Large', slots: 4, agent: true },
      ],
      agentMoves: true,
    },
  );
  // A Fleet without Pi still rents from the catalog.
  assert.equal(run({ ...fleet, MERV_FLEET_RUNTIMES: machines.MERV_FLEET_RUNTIMES }).status, 0);
  assert.deepEqual(plugin('sandboxes').config.runtimes, [current, large]);

  const entry = (change) => JSON.stringify([{ ...catalog[0], ...change }]);
  for (const broken of [
    { MERV_FLEET_RUNTIMES: 'standard' },
    { MERV_FLEET_RUNTIMES: '[]' },
    { MERV_FLEET_RUNTIMES: JSON.stringify(Array(9).fill(catalog[0])) },
    { MERV_FLEET_RUNTIMES: JSON.stringify([catalog[0], catalog[0]]) },
    { MERV_FLEET_RUNTIMES: entry({ image: 'latest' }) },
    { MERV_FLEET_RUNTIMES: entry({ key: 'Large' }) },
    { MERV_FLEET_RUNTIMES: entry({ label: ' ' }) },
    { MERV_FLEET_RUNTIMES: entry({ slots: 0 }) },
    { MERV_FLEET_RUNTIMES: entry({ slots: 9 }) },
    { MERV_FLEET_RUNTIMES: entry({ agent: 'true' }) },
    { MERV_FLEET_RUNTIMES: entry({ provider: ['cloudflare'] }) },
    { MERV_FLEET_RUNTIMES: entry({ releaseId: 'latest' }) },
    { MERV_FLEET_RUNTIMES: entry({ leaseSeconds: 59 }) },
    { MERV_FLEET_RUNTIMES: entry({ ttlSeconds: 3601 }) },
    { MERV_FLEET_PROJECT_LIMITS: '[50]' },
    { MERV_FLEET_PROJECT_LIMITS: 'null' },
    { MERV_FLEET_PROJECT_LIMITS: '{"project_host":0}' },
    { MERV_FLEET_PROJECT_LIMITS: '{"project_host":65}' },
    { MERV_FLEET_PROJECT_LIMITS: '{"../host":5}' },
    { MERV_PI_RUNTIME_KEY: 'user' },
    { MERV_PI_AGENT_MOVES: 'yes' },
    { MERV_PI_HOST_PROJECT_ID: undefined },
    { MERV_PI_HOST_PROJECT_ID: 'project.host' },
    // The host must be connected to Sandboxes: its grant rents every machine.
    { MERV_PI_HOST_PROJECT_ID: 'project_other' },
    { MERV_FLEET_HOST_PROJECT_ID: 'project_other' },
    { MERV_SANDBOXES_CONNECTIONS: connected.MERV_SANDBOXES_CONNECTIONS },
    { MERV_PI_HOST_KEY_ENV: undefined },
    { MERV_PI_HOST_KEY_ENV: 'bad-name' },
  ]) {
    assert.notEqual(run({ ...machines, ...broken }).status, 0, JSON.stringify(broken));
  }
  // An unset or malformed host key fails the render, naming only its variable.
  for (const key of [undefined, '', 'short', `${'h'.repeat(42)} `]) {
    const result = run({ ...machines, PI_HOST_KEY: key });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Error: Missing or invalid PI_HOST_KEY\n/);
    assert.ok(!result.stderr.includes('h'.repeat(42)));
  }
});

test('web search is composed only from a Tavily key or a named fallback key, and renders names only', (t) => {
  const { output, run, plugin } = renderer(t);
  const key = 'tvly-dev-fixtureKey123';
  const provider = 'fixture-provider-key';
  const secrets = () => {
    const rendered = readFileSync(output, 'utf8');
    return rendered.includes(key) || rendered.includes(provider);
  };
  // No key, or an empty one, composes nothing.
  for (const extra of [{}, { MERV_TAVILY_API_KEY: '' }]) {
    assert.equal(run(extra).status, 0);
    assert.equal(plugin('web'), undefined);
    assert.equal(plugin('web-tools'), undefined);
  }
  assert.equal(run({ MERV_TAVILY_API_KEY: key }).status, 0);
  assert.deepEqual(plugin('web-tools'), { id: 'web-tools', name: '@merv/web/tools' });
  assert.deepEqual(plugin('web'), {
    id: 'web',
    name: '@merv/web',
    config: {
      keyEnv: 'MERV_TAVILY_API_KEY',
      maxInFlight: 8,
      dailyCallsPerProject: 200,
      dailyCalls: 1000,
    },
  });
  assert.equal(secrets(), false);
  // The fallback spends the key a variable names, Pi's here, which the render never copies.
  const fallback = {
    MERV_WEB_FALLBACK_KEY_ENV: 'PI_PROVIDER_KEY',
    PI_PROVIDER_KEY: provider,
  };
  assert.equal(
    run({
      MERV_TAVILY_API_KEY: key,
      ...fallback,
      MERV_WEB_FALLBACK_MODEL: 'gpt-6-sol',
      MERV_WEB_MAX_IN_FLIGHT: '2',
      MERV_WEB_DAILY_CALLS_PER_PROJECT: '50',
      MERV_WEB_DAILY_CALLS: '400',
      MERV_WEB_FALLBACK_DAILY_CALLS: '40',
    }).status,
    0,
  );
  assert.deepEqual(plugin('web').config, {
    keyEnv: 'MERV_TAVILY_API_KEY',
    fallback: { keyEnv: 'PI_PROVIDER_KEY', model: 'gpt-6-sol' },
    maxInFlight: 2,
    dailyCallsPerProject: 50,
    dailyCalls: 400,
    fallbackDailyCalls: 40,
  });
  assert.equal(secrets(), false);
  // The fallback alone serves search.
  assert.equal(run(fallback).status, 0);
  assert.deepEqual(plugin('web').config.fallback, { keyEnv: 'PI_PROVIDER_KEY' });
  assert.equal(plugin('web').config.fallbackDailyCalls, 200);
  // A refusal names the variable, never its value.
  for (const [broken, message] of [
    [{ MERV_TAVILY_API_KEY: 'sk-not-a-tavily-key' }, 'Missing or invalid MERV_TAVILY_API_KEY'],
    [{ MERV_TAVILY_API_KEY: `${key} ` }, 'Missing or invalid MERV_TAVILY_API_KEY'],
    [{ MERV_WEB_FALLBACK_KEY_ENV: 'PI_PROVIDER_KEY' }, 'Web search fallback key is unavailable'],
    [{ MERV_WEB_FALLBACK_KEY_ENV: 'PI PROVIDER KEY' }, 'Invalid MERV_WEB_FALLBACK_KEY_ENV'],
    [{ ...fallback, MERV_WEB_FALLBACK_MODEL: 'gpt 6' }, 'Invalid MERV_WEB_FALLBACK_MODEL'],
    [
      { MERV_TAVILY_API_KEY: key, MERV_WEB_DAILY_CALLS_PER_PROJECT: '0' },
      'Invalid MERV_WEB_DAILY_CALLS_PER_PROJECT',
    ],
    [{ MERV_TAVILY_API_KEY: key, MERV_WEB_MAX_IN_FLIGHT: '65' }, 'Invalid MERV_WEB_MAX_IN_FLIGHT'],
    [{ MERV_TAVILY_API_KEY: key, MERV_WEB_DAILY_CALLS: '0' }, 'Invalid MERV_WEB_DAILY_CALLS'],
    [
      { ...fallback, MERV_WEB_FALLBACK_DAILY_CALLS: 'many' },
      'Invalid MERV_WEB_FALLBACK_DAILY_CALLS',
    ],
  ]) {
    const result = run(broken);
    assert.notEqual(result.status, 0, message);
    assert.match(result.stderr, new RegExp(`Error: ${message}\\n`));
    assert.ok(!/sk-not-a-tavily-key|tvly-dev-fixture|fixture-provider-key/.test(result.stderr));
  }
});

test('Nisa is composed only from its rr_sk_ key, and renders the variable name only', (t) => {
  const { output, run, plugin } = renderer(t);
  const key = `rr_sk_${'k'.repeat(43)}`;
  for (const extra of [{}, { MERV_NISA_API_KEY: '' }]) {
    assert.equal(run(extra).status, 0);
    assert.equal(plugin('nisa'), undefined);
    assert.equal(plugin('nisa-tools'), undefined);
  }
  assert.equal(run({ MERV_NISA_API_KEY: key }).status, 0);
  assert.deepEqual(plugin('nisa-tools'), { id: 'nisa-tools', name: '@merv/nisa/tools' });
  assert.deepEqual(plugin('nisa'), {
    id: 'nisa',
    name: '@merv/nisa',
    config: { keyEnv: 'MERV_NISA_API_KEY' },
  });
  assert.equal(readFileSync(output, 'utf8').includes(key), false);
  // Another Nisa, a staging one say, by its https origin only.
  assert.equal(
    run({ MERV_NISA_API_KEY: key, MERV_NISA_ORIGIN: 'https://nisa-staging.example' }).status,
    0,
  );
  assert.equal(plugin('nisa').config.origin, 'https://nisa-staging.example');
  for (const [broken, message] of [
    [{ MERV_NISA_API_KEY: 'sk-not-a-nisa-key' }, 'Missing or invalid MERV_NISA_API_KEY'],
    [{ MERV_NISA_API_KEY: `${key} ` }, 'Missing or invalid MERV_NISA_API_KEY'],
    [
      { MERV_NISA_API_KEY: key, MERV_NISA_ORIGIN: 'http://nisa.example' },
      'Invalid MERV_NISA_ORIGIN',
    ],
  ]) {
    const result = run(broken);
    assert.notEqual(result.status, 0, message);
    assert.match(result.stderr, new RegExp(`Error: ${message}\\n`));
    assert.ok(!/sk-not-a-nisa-key|rr_sk_k/.test(result.stderr));
  }
});
