import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '@merv/contracts';
import { legacyHistoryToolsPlugin } from '@merv/legacy-history/tools';
import { createApp } from './fixtures/app.js';
import { seedLegacyHistory } from './fixtures/legacy-history.js';
import { stateConfig } from './fixtures/state.js';

test('agents and readers discover, read and script imported history through its noun', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-history-tools-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'tools', name: '@merv/api/tools-plugin' },
        { id: 'identity', name: '@merv/identity' },
        { id: 'api', name: '@merv/api', config: { host: '127.0.0.1', port: 0 } },
        { id: 'history', name: '@merv/legacy-history' },
        { id: 'scripts', name: '@merv/scripts' },
        { id: 'scripts-tools', name: '@merv/scripts/tools' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const imported = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Imported history',
    actorName: 'Operator',
  });
  const owner = { actorId: imported.actor.id, projectId: imported.project.id };
  const { sourceId } = await seedLegacyHistory(
    app.ctx.state,
    ['exp-a', 'exp-b'].map((id) => ({
      projectId: owner.projectId,
      type: 'experiments',
      id,
      data: { id, name: id, conclusion: 'Preserved conclusion' },
    })),
  );
  const fiber = app.ctx.plugin(legacyHistoryToolsPlugin, { sourceId });
  await fiber;
  const invoke = async (caller: Caller, name: string, input: Record<string, unknown>) =>
    (await app.ctx.tools.invoke(name, caller, input, true)).value as any;
  const read = (caller: Caller, input: Record<string, unknown>) =>
    invoke(caller, 'history.read', input);
  for (const role of ['producer', 'reader'] as const) {
    const actor = await app.ctx.scope.credentials.issueActor(owner, { name: role, role });
    const caller = { ...owner, actorId: actor.actor.id, credentialId: actor.credential.id };
    const description = (await app.ctx.tools.describe(caller, true)).find(
      ({ name }) => name === 'history.read',
    );
    assert.equal(description?.annotations?.readOnlyHint, true);
    assert.equal(description?._meta, undefined, 'history stays deferred');
    assert.equal(app.ctx.tools.tool('history.read')?.tier, 'deferred');
    assert.equal(app.ctx.tools.tool('history.read')?.worker, 'never');
    const summary = await read(caller, { action: 'summary' });
    assert.equal(summary.counts.experiments, 2);
    assert.equal(summary.tabs, undefined);
    const first = await read(caller, { action: 'list', list: { type: 'experiments', limit: 1 } });
    assert.deepEqual(
      first.records.map(({ id }: { id: string }) => id),
      ['exp-a'],
    );
    const second = await read(caller, {
      action: 'list',
      list: { type: 'experiments', limit: 1, after: first.next },
    });
    assert.equal(second.records[0].id, 'exp-b');
    const detail = await read(caller, { action: 'get', get: { type: 'experiments', id: 'exp-b' } });
    assert.equal(detail.data.conclusion, 'Preserved conclusion');
    assert.equal(detail.historical, true);
    const described = await invoke(caller, 'script.tools', { names: ['history.read'] });
    assert.equal(described.tools[0].scriptable, true);
    assert.match(described.tools[0].declaration, /tools\.history\.read\(/);
    const script = await invoke(caller, 'script.run', {
      code: 'return await tools.history.read({ action: "summary" });',
    });
    assert.equal(script.ok, true);
    assert.deepEqual(script.result, summary);
  }
  for (const input of [
    { action: 'list', list: { type: 'project_api_keys' } },
    { action: 'list', list: { type: 'experiments', limit: 101 } },
    { action: 'get', get: { type: 'experiments', id: '' } },
    { action: 'summary', summary: { sourceId: 'another-source' } },
    { action: 'detail', detail: { type: 'experiments', id: 'exp-a' } },
  ])
    await assert.rejects(read(owner, input), { code: 'invalid_input' });
  const empty = await app.ctx.scope.credentials.bootstrap({
    projectName: 'No import',
    actorName: 'Other',
  });
  const other = { actorId: empty.actor.id, projectId: empty.project.id };
  assert.deepEqual(await read(other, { action: 'list', list: { type: 'experiments' } }), {
    records: [],
  });
  for (const input of [
    { action: 'summary' },
    { action: 'get', get: { type: 'experiments', id: 'exp-a' } },
  ])
    await assert.rejects(read(other, input), {
      code: 'legacy_history_not_found',
    });
  await fiber.dispose();
  assert.equal(app.ctx.tools.tool('history.read'), undefined);
});
