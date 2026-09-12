import assert from 'node:assert/strict';
import test from 'node:test';

import { bootErrorView, retryDelayMs } from './bootError.js';

test('typed gates ask for a reload, never a retry loop', () => {
  assert.equal(bootErrorView({ code: 'unauthorized' }).reload, true);
  assert.equal(bootErrorView({ code: 'client_too_old' }).reload, true);
  assert.equal(bootErrorView({ code: 'unauthorized' }).retry, undefined);
});

test('a wrong-body 200 and a 404 both read as "not the Merv API"', () => {
  for (const err of [{ code: 'not_api', status: 200 }, { status: 404 }]) {
    assert.match(bootErrorView(err).title, /not with the Merv API/);
    assert.equal(bootErrorView(err).retry, true);
  }
});

test('5xx is a server error; anything untyped is unreachable', () => {
  assert.equal(bootErrorView({ status: 502 }).title, 'Server error');
  assert.equal(bootErrorView(new TypeError('Failed to fetch')).title, 'Backend not reachable');
  assert.equal(bootErrorView(null).title, 'Backend not reachable');
});

test('the local-server hint only appears in dev builds', () => {
  assert.equal(bootErrorView({}, false).hint, null);
  assert.match(bootErrorView({}, true).hint, /dev_http_reload/);
});

test('retry backoff doubles and caps at 30 s', () => {
  assert.deepEqual([1, 2, 3, 10].map(retryDelayMs), [2000, 4000, 8000, 30_000]);
});
