import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from 'cordis';
import { createService, uiManifestSchema } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ToolRegistry } from '@merv/api/registry';
import { UiRegistry } from '@merv/ui';
import type { Sandboxes } from '@merv/sandboxes';
import { fleetPlugin } from '../packages/fleet/src/index.js';
import { fleetToolsPlugin } from '../packages/fleet/src/tools.js';
import { fleetUiPlugin } from '../packages/fleet/src/ui.js';
import { openState } from './fixtures/state.js';

test('Fleet is optional and its row and controls install without research or Sessions', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await state.close();
  });
  const ui = new UiRegistry();
  const tools = new ToolRegistry(scope, scope.toolPolicy, (fn) => state.snapshot(fn));
  ctx.provide('state', state);
  ctx.provide('scope', scope);
  ctx.provide('ui', ui);
  ctx.provide('tools', tools);
  ctx.provide('sandboxes', {} as Sandboxes);
  const boot = await scope.bootstrap({
    projectName: 'Fleet optional composition',
    actorName: 'Operator',
  });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  assert.equal(ctx.get('fleet'), undefined);
  assert.equal((await scope.project(caller)).id, boot.project.id);
  await ctx.plugin(fleetPlugin, {});
  const uiFiber = ctx.plugin(fleetUiPlugin);
  const toolsFiber = ctx.plugin(fleetToolsPlugin);
  await Promise.all([uiFiber, toolsFiber]);
  assert.deepEqual(await ctx.fleet.list(caller), []);
  await assert.rejects(
    ctx.fleet.request(caller, {
      requestId: 'request',
      owner: { kind: 'chat', id: 'conversation' },
    }),
    { code: 'fleet_disabled' },
  );
  const row = ui.rows().find((row) => row.id === 'fleet')!;
  assert.ok(row);
  assert.equal(row.view.kind, 'collection');
  // The shipped browser accepts the manifest; no new browser renderer is required.
  uiManifestSchema.parse({
    version: 1,
    rows: [
      {
        id: row.id,
        label: row.label,
        group: row.group,
        order: row.order,
        collection: row.view.spec,
        record: row.view.record,
      },
    ],
  });
  assert.deepEqual(await ui.read(caller, 'fleet'), []);
  await assert.rejects(ui.read(caller, 'fleet', { id: '../outside' }), { code: 'fleet_not_found' });
  assert.deepEqual(await tools.call('fleet.list', caller, {}), []);
  assert.equal(
    (await tools.list()).some((tool) => tool.name === 'fleet.request'),
    false,
  );
  assert.equal(ctx.get('sessions'), undefined);
  assert.equal(ctx.get('research'), undefined);
  await uiFiber.dispose();
  await toolsFiber.dispose();
  assert.equal(
    ui.rows().some((row) => row.id === 'fleet'),
    false,
  );
  assert.equal(
    (await tools.list()).some((tool) => tool.name.startsWith('fleet.')),
    false,
  );
});
