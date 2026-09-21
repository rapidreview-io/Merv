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
        plugins: ['state', 'scope', 'blobs', 'identity', 'api', 'ui', 'code'].map((id) => ({
          id,
          name: id,
        })),
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
    assert.equal(config.plugins.length, 7);
    assert.deepEqual(config.plugins.find((p) => p.id === 'code').config, {
      repositories: { root: '/var/lib/merv-ts/code' },
    });
    assert.equal(config.plugins.find((p) => p.id === 'state').config.schema, 'merv_ts');
    assert.equal(statSync(output).mode & 0o077, 0);
    assert.equal(
      run({ MERV_TS_DB_SCHEMA: 'merv_ts_rehearsal', MERV_TS_LEGACY_SOURCE_ID: 'source-v2' }).status,
      0,
    );
    config = JSON.parse(readFileSync(output));
    assert.equal(config.plugins.length, 8);
    assert.equal(config.plugins.find((p) => p.id === 'state').config.schema, 'merv_ts_rehearsal');
    const history = config.plugins.find((p) => p.id === 'legacy-history-ui');
    assert.deepEqual(history.config, { sourceId: 'source-v2' });
    assert.equal(
      history.name,
      pathToFileURL(join(directory, 'dist/src/legacy-history-ui.js')).href,
    );
    assert.notEqual(run({ MERV_TS_DB_SCHEMA: 'public' }).status, 0);
    assert.notEqual(run({ MERV_TS_LEGACY_SOURCE_ID: '../source' }).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
