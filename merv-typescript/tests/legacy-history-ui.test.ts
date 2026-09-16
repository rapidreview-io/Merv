import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { legacyHistoryUiPlugin } from '../src/legacy-history-ui.js';
import { importLegacyHistory } from '../src/legacy-history.js';
import { emptyLegacyHistorySnapshot, legacyHistoryRow } from './fixtures/legacy-history.js';

test('history UI paginates through authenticated ui.read and withdraws cleanly', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-history-ui-'));
  const secret = 'synthetic-history-ui-secret-for-local-tests-only';
  const variable = 'MERV_HISTORY_UI_TEST_SECRET';
  process.env[variable] = secret;
  t.after(() => {
    delete process.env[variable];
    rmSync(directory, { recursive: true, force: true });
  });
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: { path: ':memory:' } },
        { id: 'scope', name: '@merv/scope' },
        {
          id: 'identity',
          name: '@merv/identity',
          config: {
            supabaseUrl: 'https://history-ui.example',
            mode: 'hs256',
            secretEnv: variable,
          },
        },
        { id: 'tools', name: '@merv/api/tools-plugin' },
        { id: 'api', name: '@merv/api', config: { host: '127.0.0.1', port: 0 } },
        { id: 'ui', name: '@merv/ui' },
      ],
    },
  });
  t.after(() => app.stop());
  const token = await new SignJWT({ role: 'authenticated', is_anonymous: false })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://history-ui.example/auth/v1')
    .setSubject('history-member')
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  const human = await app.ctx.scope.acceptVerifiedIdentity(await app.ctx.identity.verify(token));
  const project = await app.ctx.scope.createProject(human, {
    name: 'Imported research',
    requestId: 'history-ui-project',
  });
  const another = await app.ctx.scope.createProject(human, {
    name: 'Other research',
    requestId: 'other-ui-project',
  });
  const snapshot = emptyLegacyHistorySnapshot([project.id], 'history-ui-test');
  snapshot.tables.projects = [
    legacyHistoryRow('projects', {
      id: project.id,
      name: project.name,
      summary: '',
      status: 'active',
      created_at: snapshot.capturedAt,
    }),
  ];
  snapshot.tables.experiments = ['exp-a', 'exp-b'].map((id) =>
    legacyHistoryRow('experiments', {
      id,
      project_id: project.id,
      name: id,
      details: 'Preserved experiment',
      status: 'complete',
      intent: 'exploratory',
      conclusion: 'Completed in the previous backend',
      revision_context: null,
      attempt_index: 1,
      created_at: snapshot.capturedAt,
      updated_at: snapshot.capturedAt,
    }),
  );
  await importLegacyHistory(app.ctx.state, snapshot);
  const fiber = app.ctx.plugin(legacyHistoryUiPlugin, { sourceId: snapshot.sourceId });
  await fiber;
  const request = async (
    params: Record<string, unknown>,
    projectId = project.id,
    bearer = token,
  ) => {
    const response = await fetch(`${app.ctx.api.url}/tools/ui.read`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-merv-project-id': projectId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ rowId: 'legacy-history', params }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const summary = await request({ action: 'summary' });
  assert.equal(summary.status, 200);
  assert.equal(summary.body.result.counts.experiments, 2);
  const first = await request({ action: 'list', type: 'experiments', limit: 1 });
  assert.equal(first.status, 200);
  assert.equal(first.body.result.records.length, 1);
  assert.equal(first.body.result.records[0].id, 'exp-a');
  const second = await request({
    action: 'list',
    type: 'experiments',
    limit: 1,
    after: first.body.result.next,
  });
  assert.equal(second.body.result.records[0].id, 'exp-b');
  const detail = await request({ action: 'detail', type: 'experiments', id: 'exp-b' });
  assert.equal(detail.body.result.data.conclusion, 'Completed in the previous backend');
  assert.equal(
    (await request({ action: 'detail', type: 'experiments', id: 'exp-b' }, another.id)).status,
    404,
  );
  assert.equal((await request({ action: 'list', type: 'project_api_keys' })).status, 400);
  assert.equal(
    (await request({ action: 'list', type: 'experiments', sourceId: 'other-snapshot' })).status,
    400,
  );
  const machine = await app.ctx.scope.bootstrap({
    projectName: 'Machine only',
    actorName: 'Operator',
  });
  assert.equal(
    (await request({ action: 'summary' }, machine.project.id, machine.token)).status,
    403,
  );
  await fiber.dispose();
  assert.equal((await request({ action: 'summary' })).status, 404);
});
