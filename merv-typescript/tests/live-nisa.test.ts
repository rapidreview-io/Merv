import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSavedToken, runLiveNisa } from '../scripts/live-nisa.js';

test('Nisa live preparation does not resolve a credential or open network connections', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('Network is forbidden');
  };
  try {
    const report = await runLiveNisa('--check');
    assert.equal(report.status, 'prepared');
    assert.equal(requests, 0);
    assert.equal('credentialRead' in report && report.credentialRead, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('Nisa live selection refuses expired OAuth without refresh or ambient fallback', () => {
  for (const saved of [
    null,
    {},
    { access_token: 'synthetic', expires_at: 1299 },
    { access_token: 'synthetic', expires_at: 1300 },
    { access_token: 'Bearer bad', expires_at: 1400 },
  ])
    assert.throws(() => freshSavedToken(saved, 1000), /^Error: nisa_/);
  assert.equal(
    freshSavedToken({ access_token: 'synthetic-fresh', expires_at: 1301 }, 1000),
    'synthetic-fresh',
  );
  assert.throws(
    () =>
      freshSavedToken({ api_key: 'rr_sk_synthetic', access_token: 'expired', expires_at: 0 }, 1000),
    /nisa_saved_token_expired/,
  );
});
