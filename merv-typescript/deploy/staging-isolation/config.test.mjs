import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, APPS, parseEnv } from './config.mjs';
const keys = ['FLEET_CLOUDFLARE_BRIDGE_STAGING', 'FLEET_CLOUDFLARE_BRIDGE_STAGING_LARGE'];
const providers = Object.entries(APPS).map(([name, application_id], i) => ({
  name,
  settings: { application_id, account_id: 'ac27350cd4a42855004ab960c906b6d5' },
  access: 'tunnel',
  credential: 'env:' + keys[i],
  namespaces: ['legacy'],
}));
const source =
  Object.entries({
    SANDBOXES_PROVIDERS: JSON.stringify([...providers, { name: 'customer' }]),
    SANDBOXES_STORAGE__BUCKET: 'source-customer-bucket',
    SANDBOXES_SUPABASE: '{}',
    SANDBOXES_VAULT_KEY: 'production-vault',
    CUSTOMER_SECRET: 'must-not-copy',
    ...Object.fromEntries(
      keys.map((k) => [
        k,
        JSON.stringify({
          bridge_url: 'https://bridge.example',
          bridge_token: 'secret',
          cloudflare_api_token: 'secret',
        }),
      ]),
    ),
  })
    .map(([k, v]) => k + '=' + v)
    .join('\n') + '\n';
const main =
  'MERV_TS_DB_SCHEMA=merv_ts_staging\nMERV_DB_URL=postgresql://host/postgres\nMERV_BOOT_MAINTENANCE=1\nUNRELATED=preserve bytes\n';
const spec = {
  publicOrigin: 'https://dev-experiments.rapidreview.io:8443',
  mainOrigin: 'https://dev-experiments.rapidreview.io',
  databaseUrl: 'postgresql://staging@db/sandboxes_staging',
  vaultKey: 'new-vault',
  namespaces: ['merv-stg-native-1111111111111111', 'merv-stg-native-2222222222222222'],
  runnerImage: 'registry/example@sha256:' + 'a'.repeat(64),
  catalog: Object.keys(APPS).map((provider) => ({
    provider,
    image_digest: 'sha256:' + 'a'.repeat(64),
  })),
  storage: {
    endpoint: 'https://isolated.example',
    bucket: 'existing',
    accessKey: 'scoped',
    secretKey: 'scoped',
  },
};
test('private candidate copies only two reviewed secrets and binds staging callback/gateway origins', () => {
  const out = candidates(source, main, spec),
    env = parseEnv(out.enabled);
  assert.ok(!out.enabled.includes('must-not-copy'));
  assert.ok(!out.enabled.includes('production-vault'));
  assert.ok(out.main.includes('UNRELATED=preserve bytes\n'));
  assert.equal(env.SANDBOXES_AGENT_BINARY_URL, spec.publicOrigin + '/agent');
  assert.equal(env.SANDBOXES_AUTH_MERV_ORIGIN, spec.mainOrigin);
  assert.equal(env.SANDBOXES_GATEWAY__PUBLIC_HOST, 'dev-experiments.rapidreview.io');
  assert.ok(
    JSON.parse(parseEnv(out.disabled).SANDBOXES_PROVIDERS).every((p) => p.enabled === false),
  );
  assert.ok(
    JSON.parse(env.SANDBOXES_PROVIDERS).every(
      (p) => p.enabled === true && !p.namespaces.includes('*'),
    ),
  );
  for (const change of [
    { publicOrigin: 'https://sandboxes.rapidreview.io' },
    { publicOrigin: spec.publicOrigin + '/sbx' },
    { databaseUrl: main.match(/MERV_DB_URL=(.*)/)[1] },
    { namespaces: ['*', 'customer'] },
    { vaultKey: 'production-vault' },
  ])
    assert.throws(() => candidates(source, main, { ...spec, ...change }));
  assert.throws(() =>
    candidates(source.replace('ac27350cd4a42855004ab960c906b6d5', 'customer-account'), main, spec),
  );
  assert.throws(() => parseEnv('KEY=one\nKEY=two\n'), /duplicate/);
});
