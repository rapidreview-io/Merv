import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('hosted canary mint uses the Scope credential API and safely replays private credentials', () => {
  const result = spawnSync(
    'python3',
    [fileURLToPath(new URL('./test_hosted_canary_mint.py', import.meta.url))],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
