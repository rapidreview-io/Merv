import assert from 'node:assert/strict';
import { register } from 'tsx/esm/api';
import test from 'node:test';
import { releaseEntry, releaseId } from './hosted-release.mjs';
register();
const { applicationStatus, probe } = await import('./hosted-sandboxes-probe.mjs');
const provider = { settings: { account_id: 'a'.repeat(32), application_id: 'b'.repeat(36) } };
const credential = { cloudflare_api_token: 'secret' };
const result = {
  id: provider.settings.application_id,
  version: 7,
  configuration: { image: 'registry@sha256:abc' },
  health: { errors: [] },
};

test('TS catalog IDs match the hosted manifest, including fixed arguments', async () => {
  const entry = releaseEntry('registry@sha256:' + 'a'.repeat(64), 'b'.repeat(64));
  entry.arguments = ['--serve'];
  assert.deepEqual(await probe({ MERV_RELEASES: JSON.stringify([entry]) }), [releaseId(entry)]);
  await assert.rejects(probe({ MERV_RELEASES: '[{}]' }));
});

test('native status retries transient GETs, checks identity, and returns only release facts', async () => {
  const calls = [],
    sleeps = [],
    statuses = [429, 503, 200];
  const status = await applicationStatus(provider, credential, {
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ success: true, result }), { status: statuses.shift() });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(([url]) => url)).size, 1);
  assert.equal(status.image, result.configuration.image);
  assert.equal(status.keys, 0);
  assert.equal(status.ssh, false);
  for (const code of [401, 403, 404, 503]) {
    let count = 0;
    await assert.rejects(
      applicationStatus(provider, credential, {
        fetcher: async () => {
          count++;
          return new Response('do not log secrets', { status: code });
        },
        sleep: async () => {},
      }),
      new RegExp(`HTTP ${code}, attempt ${code === 503 ? 3 : 1}/3`),
    );
    assert.equal(count, code === 503 ? 3 : 1);
  }
  await assert.rejects(
    applicationStatus(provider, credential, {
      fetcher: async () => Response.json({ success: true, result: { ...result, id: 'other' } }),
    }),
    /identity/,
  );
});

test('native status cancels an expired request without retrying', async () => {
  let count = 0;
  const controller = new AbortController();
  const pending = applicationStatus(provider, credential, {
    signal: controller.signal,
    fetcher: async (_, { signal }) => {
      count++;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    },
  });
  controller.abort(new Error('deadline'));
  await assert.rejects(pending, /deadline/);
  assert.equal(count, 1);
});
