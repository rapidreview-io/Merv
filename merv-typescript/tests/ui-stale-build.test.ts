import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadStaleBuild } from '../packages/ui/web/stale-build.js';

test('a chunk a release renamed reloads the page once a minute at most', () => {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  let reloads = 0;
  const event = () => new Event('vite:preloadError', { cancelable: true });
  const first = event();
  assert.equal(
    reloadStaleBuild(first, storage, () => reloads++, 1_000_000),
    true,
  );
  assert.equal(first.defaultPrevented, true);
  // Still failing right after the reload: the error shows instead of a loop.
  const again = event();
  assert.equal(
    reloadStaleBuild(again, storage, () => reloads++, 1_030_000),
    false,
  );
  assert.equal(again.defaultPrevented, false);
  // A later release, later on: reload again.
  assert.equal(
    reloadStaleBuild(event(), storage, () => reloads++, 1_100_000),
    true,
  );
  assert.equal(reloads, 2);
  // Storage refused (a private window): never reload blind.
  const refused = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {},
  };
  assert.equal(
    reloadStaleBuild(event(), refused, () => reloads++, 2_000_000),
    false,
  );
  assert.equal(reloads, 2);
});
