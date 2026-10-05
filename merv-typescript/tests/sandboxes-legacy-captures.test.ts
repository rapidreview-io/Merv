import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyCaptureDownloads } from '../packages/sandboxes/src/legacy-captures.js';

test('files the retired compute path captured stay downloadable, only from configured storage', async (t) => {
  const original = globalThis.fetch;
  const tokenEnv = 'MERV_SANDBOXES_LEGACY_CAPTURE_TEST_GRANT';
  process.env[tokenEnv] = 'sbxt_test_legacy_capture_grant';
  t.after(() => {
    globalThis.fetch = original;
    delete process.env[tokenEnv];
  });
  const record = { id: 'obj_model', kind: 'file', state: 'available' };
  let downloadUrl =
    'https://bucket.example/model?X-Amz-Date=20261004T120000Z&X-Amz-Expires=3600&signature=s';
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-sandbox-subject'), 'project_capture');
    assert.equal(headers.get('x-sandbox-namespace'), 'merv-ml');
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/auth/me') return json({ role: 'consumer', namespace: 'merv-ml' });
    if (url.pathname === '/v1/storage/objects/obj_model/download')
      return json({ object: record, url: downloadUrl });
    throw new Error(`Unexpected legacy capture route: ${url.pathname}`);
  };
  const download = legacyCaptureDownloads('https://sandboxes.example', 5_000, {
    namespace: 'merv-ml',
    tokenEnv,
    storageOrigins: ['https://bucket.example'],
  });

  assert.deepEqual(await download('project_capture', 'obj_model'), {
    url: downloadUrl,
    expiresAt: '2026-10-04T13:00:00.000Z',
  });
  assert.ok(
    paths.every((path) => path.startsWith('GET ')),
    'downloads only read',
  );

  downloadUrl = 'https://elsewhere.example/model?signature=s';
  await assert.rejects(download('project_capture', 'obj_model'), {
    code: 'sandbox_unavailable',
  });
});
