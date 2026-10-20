import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from 'cordis';
import { createService, MervError } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { describeTool, ToolRegistry } from '@merv/api/registry';
import { piTool } from '@merv/pi/relay-schema';
import host from '@merv/sandboxes/host';
import { migrate, openDatabase } from '@sandboxes/db';
import { releaseId } from '@sandboxes/runtimes';
import { validateRuntimeRelease } from '@sandboxes/kernel/settings';
import { MachineViews } from '@sandboxes/merv-host';
import { FleetService, type FleetAllocation } from '@merv/fleet';
import { openState, postgresUrl, schemaFor } from './fixtures/state.js';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('Fleet recovers a lost create under its stable profile id and create key through the real host, renting in the host project, with the machine protected from tools and views', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const source = await scope.credentials.bootstrap({ projectName: 'Work', actorName: 'Owner' });
  const rental = await scope.credentials.bootstrap({ projectName: 'Rental', actorName: 'Host' });
  const caller = {
    projectId: source.project.id,
    actorId: source.actor.id,
    credentialId: source.credential.id,
  };
  const schema = schemaFor();
  const dataDir = mkdtempSync(join(tmpdir(), 'merv-fleet-host-'));
  const db = await openDatabase({ url: postgresUrl, schema });
  await migrate(db, { schemaExplicit: true });
  const previousKey = process.env.MERV_TEST_FLEET_VAULT_KEY;
  process.env.MERV_TEST_FLEET_VAULT_KEY = Buffer.alloc(32, 7).toString('base64url');
  const ctx = new Context();
  ctx.provide('state', state);
  ctx.provide('scope', scope);
  const tools = new ToolRegistry(scope, scope.toolPolicy, (fn) => state.snapshot(fn));
  ctx.provide('tools', tools);
  const release = validateRuntimeRelease({
    provider: 'fake',
    image_digest: `sha256:${'a'.repeat(64)}`,
    executable: '/opt/merv/supervisor',
    executable_sha256: 'b'.repeat(64),
  });
  const profile = {
    key: 'standard',
    provider: 'fake',
    offerId: 'tiny:east',
    releaseId: releaseId(release),
    leaseSeconds: 600,
  };
  const fiber = ctx.plugin(
    host,
    host.Config.parse({
      databaseUrlEnv: 'MERV_TEST_POSTGRES_URL',
      schema,
      vaultKeyEnv: 'MERV_TEST_FLEET_VAULT_KEY',
      publicOrigin: 'https://sandboxes.example',
      dataDir,
      relayEvents: false,
      registerTools: true,
      settings: { providers: [{ name: 'fake', plugin: 'fake' }], runtime_releases: [release] },
    }),
  );
  let fleet: FleetService | undefined;
  t.after(async () => {
    await fleet?.close();
    await ctx.fiber.dispose();
    await state.close();
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.MERV_TEST_FLEET_VAULT_KEY;
    else process.env.MERV_TEST_FLEET_VAULT_KEY = previousKey;
  });
  await fiber.await();
  // Seven Sandboxes tools: readOnly where every action reads, SSH certificates out of conversations.
  assert.deepEqual(
    (await tools.list()).flatMap((tool) =>
      'readOnly' in tool && tool.name.startsWith('sandboxes.')
        ? [[tool.name.slice(10), tool.readOnly, tool.conversation ?? null]]
        : [],
    ),
    [
      ['access', false, 'never'],
      ['job', false, null],
      ['sandbox', false, null],
      ['snapshot', false, null],
      ['spend', true, null],
      ['storage', false, null],
      ['workflow', false, null],
    ],
  );
  // Each reaches an agent conversation as the relay accepts it.
  for (const tool of await tools.list())
    if (tool.name.startsWith('sandboxes.') && 'handler' in tool && tool.conversation !== 'never')
      assert.ok(piTool(describeTool(tool), tool.conversation), tool.name);
  const link = async (namespace: string, projectId: string) => {
    const ns = await ctx.sbxAccounts.ensureNativeNamespace(namespace);
    await ctx.sbxDb.transaction(async (tx) => {
      await ctx.sbxAccounts.lock(tx, ns.account_id);
      await ctx.sbxAccounts.setLink(tx, namespace, { projectId, memberId: ns.default_member_id });
    });
    return ns;
  };
  await link('work', caller.projectId);
  const ns = await link('rental', rental.project.id);
  fleet = await createService(
    new FleetService(state, scope, ctx.sbxMerv, {
      profiles: [profile, { ...profile, key: 'missing', offerId: 'missing' }],
      hostProjectId: rental.project.id,
    }),
  );
  fleet.registerOwner('workflow', {
    rentsInHost: true,
    keepsRunning: true,
    valid: async () => true,
    bootstrap: async () => 'secret',
    observe: async () => 'running',
  });
  await fleet.tick();
  assert.equal(await fleet.connected(rental.project.id), true);
  assert.ok(await state.snapshot(() => fleet!.describe(rental.project.id, 'standard')));
  assert.equal(await fleet.describe(rental.project.id, 'missing'), null);
  const allocation = await fleet.request(caller, {
    requestId: 'lost',
    owner: { kind: 'workflow', id: 'work' },
  });
  const profileId = `srp_${sha(['fake', 'tiny:east', profile.releaseId, 600, 300])}`;
  assert.equal(allocation.profileId, profileId);
  const renter = await scope.serviceActor('fleet', rental.project.id);
  const runtime = ctx.sbxMerv.runtimes(renter);
  const operationKey = `runtime:${sha([rental.project.id, `${allocation.id}:create`])}`;
  const machine = await runtime.provision({ ...profile, operationKey });
  // A create whose reply was lost before it was stored.
  const lost: FleetAllocation = {
    ...allocation,
    phase: 'provisioning',
    createAttempted: true,
    runtime: null,
  };
  await state.transaction((tx) =>
    tx.run(
      'UPDATE fleet_allocations SET phase=?,data_json=? WHERE id=?',
      lost.phase,
      JSON.stringify(lost),
      lost.id,
    ),
  );
  await fleet.tick();
  const resumed = await fleet.inspect(caller, lost.id);
  assert.deepEqual(resumed.runtime, {
    sandboxId: machine.id,
    state: 'provisioning',
    ready: false,
    leaseExpiresAt: machine.lease_expires_at?.toJSON() ?? null,
    revision: machine.revision,
    launch: null,
  });
  assert.equal((await ctx.sbxRegistry.list('rental')).length, 1);
  assert.equal((await ctx.sbxRegistry.list('work')).length, 0);
  await assert.rejects(
    tools.call('sandboxes.sandbox', renter, { action: 'delete', sandbox_id: machine.id }),
    (error) => error instanceof MervError && error.code === 'sandbox_protected',
  );
  const views = new MachineViews({
    registry: ctx.sbxRegistry,
    db: ctx.sbxDb,
    clock: ctx.sbxClock,
    settings: ctx.sbxSettings,
  });
  assert.deepEqual(await views.list('rental'), { sandboxes: [] });
  await fleet.tick();
  assert.deepEqual((await fleet.inspect(caller, lost.id)).runtime, resumed.runtime);
  await ctx.sbxDb.transaction(async (tx) => {
    await ctx.sbxAccounts.lock(tx, ns.account_id);
    await ctx.sbxAccounts.setLink(tx, 'rental', null);
  });
  await fleet.tick();
  assert.equal(await fleet.connected(rental.project.id), false);
});
