import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const env = {
  MERV_TS_AUTH_MODE: 'hs256',
  MERV_BLOB_PREFIX: 'merv-ts',
  MERV_DB_URL: 'postgresql://unused',
  SANDBOXES_DATABASE_URL: 'postgresql://sandboxes:fixture@sbx-db/sandboxes',
  SANDBOXES_VAULT_KEY: 'fixture-vault-key',
  MERV_SANDBOXES_PROXY_URL: 'http://sbx-control:8000',
  MERV_BLOB_BUCKET: 'unused',
  MERV_BLOB_ENDPOINT_URL: 'https://storage.example',
  MERV_BLOB_ACCESS_KEY_ID: 'fixture',
  MERV_BLOB_SECRET_ACCESS_KEY: 'fixture',
  SUPABASE_ANON_KEY: 'fixture',
  SUPABASE_JWT_SECRET: 'fixture',
  SUPABASE_URL: 'https://identity.example',
  MERV_TS_PUBLIC_ORIGIN: 'https://merv.example',
};
test('deployment loads the in-process host, integration and standalone console', (t) => {
  const { run, plugin, output } = renderer(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(plugin('sandboxes-host'), {
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
    },
  });
  assert.deepEqual(plugin('sandboxes-integration'), {
    id: 'sandboxes-integration',
    name: '@merv/sandboxes/integration',
    config: { legacyCaptures: { namespace: 'merv-ml' }, newPersonCredits: {} },
  });
  assert.deepEqual(plugin('sandboxes-console'), {
    id: 'sandboxes-console',
    name: '@merv/sandboxes/console',
    config: { upstream: 'http://sbx-control:8000' },
  });
  const rendered = readFileSync(output, 'utf8');
  assert.ok(!rendered.includes(env.SANDBOXES_DATABASE_URL));
  assert.ok(!rendered.includes(env.SANDBOXES_VAULT_KEY));
  for (const name of ['SANDBOXES_VAULT_KEY', 'MERV_SANDBOXES_PROXY_URL']) {
    const refused = run({ [name]: undefined });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, new RegExp(`Missing or invalid ${name}`));
  }
  for (const upstream of [
    'https://sbx-control:8000',
    'http://user:pass@sbx-control:8000',
    'http://sbx-control:8000/ui/',
  ])
    assert.notEqual(run({ MERV_SANDBOXES_PROXY_URL: upstream }).status, 0);
});

test('deployment without a Sandboxes database omits Sandboxes, Fleet and Pi', (t) => {
  const { run, output } = renderer(t);
  const result = run({
    SANDBOXES_DATABASE_URL: undefined,
    SANDBOXES_VAULT_KEY: undefined,
    MERV_SANDBOXES_PROXY_URL: undefined,
    MERV_FLEET_ENABLED: 'false',
    MERV_FLEET_WORKFLOW_ENABLED: 'false',
    MERV_PI_ENABLED: 'false',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(output)).plugins.length, 14);
  assert.ok(
    JSON.parse(readFileSync(output)).plugins.every((p) => !/^(sandboxes|fleet|pi)/.test(p.id)),
  );
});

test('explicit hosted enablement without a Sandboxes database fails before writing config', (t) => {
  const { run } = renderer(t);
  for (const flag of ['MERV_FLEET_ENABLED', 'MERV_FLEET_WORKFLOW_ENABLED', 'MERV_PI_ENABLED']) {
    const result = run({ SANDBOXES_DATABASE_URL: undefined, [flag]: 'true' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${flag}=true requires SANDBOXES_DATABASE_URL`));
  }
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
      plugins:
        'state scope scope-api blobs secrets identity api ui admin code code-work code-work-api sessions issues'
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

test('OAuth trusts only explicitly configured proxy IP addresses', (t) => {
  const { run, plugin } = renderer(t);
  assert.equal(
    run({ MERV_MCP_OAUTH: 'true', MERV_OAUTH_TRUSTED_PROXY_IPS: '127.0.0.1,::1,172.18.0.1' })
      .status,
    0,
  );
  assert.deepEqual(plugin('scope-api').config.oauth.trustedProxyIps, [
    '127.0.0.1',
    '::1',
    '172.18.0.1',
  ]);
  assert.notEqual(
    run({ MERV_MCP_OAUTH: 'true', MERV_OAUTH_TRUSTED_PROXY_IPS: '172.18.0.0/16' }).status,
    0,
  );
});

test('isolated staging requires an explicit standalone HTTPS origin', (t) => {
  const { run, plugin } = renderer(t);
  let result = run({ MERV_TS_DB_SCHEMA: 'merv_ts_staging' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit MERV_SANDBOXES_PUBLIC_ORIGIN/);
  result = run({
    MERV_TS_DB_SCHEMA: 'merv_ts_staging',
    MERV_SANDBOXES_PUBLIC_ORIGIN: 'https://staging.example:8443',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(plugin('sandboxes-host').config.publicOrigin, 'https://staging.example:8443');
  for (const origin of [
    'https://staging.example/sbx',
    'http://staging.example',
    'https://staging.example/',
  ]) {
    assert.notEqual(run({ MERV_SANDBOXES_PUBLIC_ORIGIN: origin }).status, 0);
  }
});
