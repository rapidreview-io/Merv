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

test('deployment config keeps history opt-in and binds a validated isolated schema/source', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'merv-render-config-')));
  try {
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
    const run = (extra = {}) =>
      spawnSync(process.execPath, [join(directory, 'deploy/render-config.mjs'), output], {
        env: { ...env, ...extra },
        encoding: 'utf8',
      });
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
    assert.equal(
      history.name,
      pathToFileURL(join(directory, 'dist/src/legacy-history-ui.js')).href,
    );
    assert.notEqual(run({ MERV_TS_DB_SCHEMA: 'public' }).status, 0);
    assert.notEqual(run({ MERV_TS_LEGACY_SOURCE_ID: '../source' }).status, 0);

    const connected = {
      MERV_SANDBOXES_URL: 'https://sandboxes.example',
      MERV_SANDBOXES_CONNECTIONS: JSON.stringify([
        { projectId: 'project_1', namespace: 'research', tokenEnv: 'SANDBOX_GRANT' },
      ]),
      SANDBOX_GRANT: 'sbxt_fixture',
    };
    assert.equal(run(connected).status, 0);
    config = JSON.parse(readFileSync(output));
    assert.equal(config.plugins.length, 12);
    assert.equal(config.plugins.find((p) => p.id === 'sandboxes').config.runtime, undefined);
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
    assert.equal(run(fleet).status, 0);
    assert.notEqual(run({ MERV_PI_ENABLED: 'true' }).status, 0);
    assert.notEqual(run({ ...fleet, MERV_PI_ENABLED: 'true' }).status, 0);
    const pi = {
      ...fleet,
      MERV_PI_ENABLED: 'true',
      MERV_PI_SECRET_ENV: 'PI_PRIVATE_SECRET',
      MERV_PI_MODEL_API_KEY_ENV: 'PI_PROVIDER_KEY',
      PI_PRIVATE_SECRET: 'p'.repeat(40),
      PI_PROVIDER_KEY: 'fixture-provider-key',
    };
    assert.equal(run(pi).status, 0);
    const piConfig = JSON.parse(readFileSync(output));
    assert.deepEqual(piConfig.plugins.find((entry) => entry.id === 'pi').config, {
      enabled: true,
      secretEnv: 'PI_PRIVATE_SECRET',
      modelApiKeyEnv: 'PI_PROVIDER_KEY',
      model: 'gpt-6-luna',
      baseUrl: 'https://merv.example',
      turnTimeoutSeconds: 300,
      idleTimeoutSeconds: 30,
    });
    assert.equal(JSON.stringify(piConfig).includes(pi.PI_PRIVATE_SECRET), false);
    assert.equal(JSON.stringify(piConfig).includes(pi.PI_PROVIDER_KEY), false);
    assert.ok(piConfig.plugins.some((entry) => entry.id === 'pi-api'));
    assert.ok(piConfig.plugins.some((entry) => entry.id === 'pi-ui'));
    assert.notEqual(run({ ...pi, MERV_PI_MODEL: 'https://untrusted.example' }).status, 0);
    assert.equal(run(fleet).status, 0);
    config = JSON.parse(readFileSync(output));
    assert.deepEqual(config.plugins.find((p) => p.id === 'sandboxes').config.runtime, {
      provider: 'cloudflare',
      offerId: 'standard-1:cloudflare',
      releaseId: fleet.MERV_FLEET_RUNTIME_RELEASE_ID,
      leaseSeconds: 900,
    });
    assert.deepEqual(config.plugins.find((p) => p.id === 'fleet').config, {
      enabled: true,
      globalLimit: 3,
      projectLimit: 1,
      allocationTimeoutSeconds: 3600,
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
      MERV_FLEET_WORKFLOW_PROJECT_ID: 'project_1',
      MERV_FLEET_WORKFLOW_SOURCE_CREDENTIAL_ENV: 'WORKFLOW_SOURCE',
      MERV_FLEET_WORKFLOW_MODEL_API_KEY_ENV: 'MODEL_KEY',
      MERV_FLEET_WORKFLOW_BASE_URL: 'https://merv.example',
      WORKFLOW_SOURCE: 'source-secret',
      MODEL_KEY: 'model-secret',
    };
    assert.equal(run(workflow).status, 0);
    config = JSON.parse(readFileSync(output));
    assert.deepEqual(config.plugins.find((p) => p.id === 'fleet').config, {
      enabled: true,
      globalLimit: 2,
      projectLimit: 2,
      allocationTimeoutSeconds: 3600,
    });
    assert.equal(run({ ...workflow, MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS: '1800' }).status, 0);
    config = JSON.parse(readFileSync(output));
    assert.equal(
      config.plugins.find((p) => p.id === 'fleet').config.allocationTimeoutSeconds,
      1800,
    );
    assert.deepEqual(config.plugins.find((p) => p.id === 'fleet-workflow').config, {
      enabled: true,
      projectId: 'project_1',
      sourceCredentialEnv: 'WORKFLOW_SOURCE',
      modelApiKeyEnv: 'MODEL_KEY',
      baseUrl: 'https://merv.example',
      maxAgents: 1,
    });
    assert.ok(!readFileSync(output, 'utf8').includes(workflow.WORKFLOW_SOURCE));
    assert.ok(!readFileSync(output, 'utf8').includes(workflow.MODEL_KEY));
    assert.equal(run({ ...workflow, MERV_FLEET_WORKFLOW_MAX_AGENTS: '2' }).status, 0);
    config = JSON.parse(readFileSync(output));
    assert.equal(config.plugins.find((p) => p.id === 'fleet-workflow').config.maxAgents, 2);
    for (const broken of [
      { MERV_FLEET_ENABLED: 'true' },
      { ...fleet, MERV_FLEET_RUNTIME_RELEASE_ID: 'latest' },
      { ...fleet, MERV_FLEET_RUNTIME_LEASE_SECONDS: '0' },
      { ...fleet, MERV_FLEET_GLOBAL_LIMIT: '65' },
      { ...fleet, MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS: '59' },
      { ...fleet, MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS: '86401' },
      { ...fleet, MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS: '1.5' },
      { ...fleet, MERV_FLEET_MANAGED_SECRET_ENV: 'bad-name' },
      { ...fleet, MANAGED_SECRET: 'short' },
      { ...fleet, MERV_FLEET_WORKFLOW_ENABLED: 'true' },
      { ...workflow, MERV_FLEET_WORKFLOW_PROJECT_ID: 'other_project' },
      { ...workflow, MERV_FLEET_WORKFLOW_SOURCE_CREDENTIAL_ENV: 'missing_secret' },
      { ...workflow, MERV_FLEET_WORKFLOW_MAX_AGENTS: '0' },
      { ...workflow, MERV_FLEET_WORKFLOW_MAX_AGENTS: '33' },
    ]) {
      assert.notEqual(run(broken).status, 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
