import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './fixtures/app.js';

test('the release identity canary passes against a running server', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-identity-canary-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { runCanary } = await import('../deploy/identity-auth-canary.mjs');
  const result = await runCanary({
    state: app.ctx.state,
    scope: app.ctx.scope,
    origin: app.ctx.api.url!,
  });
  assert.deepEqual(
    { ...result, projectId: undefined, actorId: undefined, identityMigrationHash: '' },
    {
      result: 'pass',
      projectId: undefined,
      actorId: undefined,
      registration: 200,
      wrongProject: 403,
      oldAfterRotation: 401,
      rotatedSelf: 200,
      retiredSelf: 401,
      identityMigrationHash: '',
    },
  );
});
